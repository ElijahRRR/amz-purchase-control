// 把 .dc.html 渲染成静态 HTML:跑一遍 renderVals(),把 {{holes}}/sc-for/sc-if 展开。
// 只为了截图核对布局,不是 DC 运行时的替代品。
import { readFileSync, writeFileSync } from 'node:fs'
import { basename } from 'node:path'

const file = process.argv[2]
const out  = process.argv[3]
const src  = readFileSync(file, 'utf8')

const head = src.split('<helmet>')[1].split('</helmet>')[0]
const body = src.split('</helmet>')[1].split('</x-dc>')[0]
const code = src.split('<script data-dc-script')[1].split('>').slice(1).join('>').split('</script>')[0]

class DCLogic { constructor(p){ this.props = p } setState(o){ Object.assign(this.state, o) } }
let vals = {}
if (/class\s+Component\b/.test(code)) {
  const Component = new Function('DCLogic', code + '; return Component')(DCLogic)
  const inst = new Component({})
  // 允许命令行覆盖初始 state:render.mjs f.html out.html '{"sel":"UP-20841"}'
  if (process.argv[4]) Object.assign(inst.state, JSON.parse(process.argv[4]))
  vals = inst.renderVals ? inst.renderVals() : {}
}

const get = (scope, path) => path.split('.').reduce((o,k) => (o == null ? o : o[k]), scope)

function fill(str, scope) {
  return str.replace(/\{\{([^}]+)\}\}/g, (_, p) => {
    const v = get(scope, p.trim())
    return v == null || typeof v === 'function' ? '' : String(v)
  })
}

// 找到与 open 位置配对的闭合标签(支持同名嵌套)
function matchEnd(s, tag, from) {
  const re = new RegExp(`<${tag}\\b|</${tag}>`, 'g')
  re.lastIndex = from
  let depth = 0, m
  while ((m = re.exec(s))) {
    if (m[0][1] === '/') { if (depth === 0) return [m.index, re.lastIndex]; depth-- }
    else depth++
  }
  throw new Error('unbalanced ' + tag)
}

function expand(s, scope) {
  // sc-if
  let i
  while ((i = s.search(/<sc-if\b/)) !== -1) {
    const openEnd = s.indexOf('>', i) + 1
    const attrs = s.slice(i, openEnd)
    const [endStart, endEnd] = matchEnd(s, 'sc-if', openEnd)
    const inner = s.slice(openEnd, endStart)
    const key = /value="\{\{([^}]+)\}\}"/.exec(attrs)[1].trim()
    s = s.slice(0, i) + (get(scope, key) ? expand(inner, scope) : '') + s.slice(endEnd)
  }
  // sc-for
  while ((i = s.search(/<sc-for\b/)) !== -1) {
    const openEnd = s.indexOf('>', i) + 1
    const attrs = s.slice(i, openEnd)
    const [endStart, endEnd] = matchEnd(s, 'sc-for', openEnd)
    const inner = s.slice(openEnd, endStart)
    const key = /list="\{\{([^}]+)\}\}"/.exec(attrs)[1].trim()
    const as  = /as="([^"]+)"/.exec(attrs)[1]
    const list = get(scope, key) || []
    s = s.slice(0, i) + list.map(it => expand(inner, { ...scope, [as]: it })).join('') + s.slice(endEnd)
  }
  return fill(s, scope)
}

let html = expand(body, vals)
html = html.replace(/\sonClick="[^"]*"/g, '')

writeFileSync(out, `<!doctype html><html><head><meta charset="utf-8">${head}</head><body style="margin:0">${html}</body></html>`)
console.log('rendered', basename(file), '→', out)
