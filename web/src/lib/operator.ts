/** 「操作人」—— 自己填的名字,**不是身份认证**。
 *
 * 这套东西不做鉴权(所有者定稿,服务端只监听 127.0.0.1)。所以这里没有、
 * 也不打算有一个可信的身份。但人工动作会写进事件流,而事件流的用处正是
 * 事后回答「这个地址是谁改的」—— 一律记成 null 的话,那句话永远答不上来。
 *
 * 自己填的名字答得上这句话,前提是**别把它当成鉴权**:
 * 它拦不住任何人,也不该被用来做任何判断,只是让审计记录带上一个人名。
 * 界面上必须写清楚这一点,否则迟早有人把它当成登录。
 *
 * 存在浏览器本地:换台机器要重填,这是对的 —— 它本来就是「这台机器前面坐着谁」。
 */

const KEY = "amz.operator";

export function getOperator(): string | undefined {
  try {
    return localStorage.getItem(KEY)?.trim() || undefined;
  } catch {
    // 隐私模式 / 禁用存储时读不到。不报错,退回匿名 —— 记不上名字总比点不动强。
    return undefined;
  }
}

export function setOperator(name: string): void {
  try {
    const v = name.trim();
    if (v) localStorage.setItem(KEY, v);
    else localStorage.removeItem(KEY);
  } catch {
    /* 存不下就算了,本次会话仍然可以用 —— 调用方自己持有 state */
  }
}
