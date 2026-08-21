/** 面板样式。逐值对齐设计画布(design/DesignSystem.dc.html):
 *  zinc 中性色 + Inter/JetBrains Mono + 中间态虚线/终态实心。 */

export const PANEL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; margin: 0; padding: 0; }
.wrap { position: fixed; top: 0; right: 0; width: 380px; height: 100vh; z-index: 2147483000;
        font-family: Inter, 'Noto Sans SC', system-ui, sans-serif; font-size: 13px; color: #18181b;
        background: #fff; border-left: 1px solid #e4e4e7; box-shadow: -1px 0 0 #e4e4e7;
        display: flex; flex-direction: column; }
.mono, .id { font-family: 'JetBrains Mono', ui-monospace, monospace; }
.hd { height: 48px; flex: none; border-bottom: 1px solid #f4f4f5; display: flex; align-items: center; gap: 8px; padding: 0 14px; }
.brand { width: 20px; height: 20px; border-radius: 5px; background: #18181b; color: #fff;
         display: inline-flex; align-items: center; justify-content: center; font-size: 11px; }
.dot { width: 8px; height: 8px; border-radius: 99px; display: inline-block; flex: none; }
.dothollow { width: 9px; height: 9px; border-radius: 99px; background: #fff; border: 2px solid #f59e0b; display: inline-block; flex: none; }
.tag { display: inline-flex; align-items: center; gap: 4px; padding: 0 6px; height: 20px; border-radius: 4px;
       font-size: 11px; font-weight: 500; border: 1px solid; white-space: nowrap; }
.tagdash { border-style: dashed; }
.band { flex: none; padding: 11px 14px; border-bottom: 1px solid #f4f4f5; display: flex; align-items: center; gap: 8px; }
.body { flex: 1; min-height: 0; overflow: auto; }
.sec { padding: 11px 14px 4px; font-size: 10px; font-weight: 500; text-transform: uppercase;
       letter-spacing: .05em; color: #a1a1aa; }
.kv { display: flex; gap: 8px; font-size: 12.5px; line-height: 1.7; padding: 0 14px; }
.kvk { width: 62px; flex: none; color: #a1a1aa; font-size: 12px; }
.kvv { color: #27272a; min-width: 0; }
.copy { cursor: pointer; border-bottom: 1px dashed #e4e4e7; }
.copy:hover { border-bottom-color: #a1a1aa; }
.steps { padding: 2px 14px 8px; display: flex; flex-direction: column; gap: 5px; }
.stp { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: #a1a1aa; }
.stp.done { color: #27272a; } .stp.cur { color: #18181b; font-weight: 500; }
.log { font-family: 'JetBrains Mono', ui-monospace, monospace; font-size: 11.5px; line-height: 1.65;
       color: #d4d4d8; background: #18181b; border-radius: 6px; padding: 10px 12px; margin: 6px 14px 12px;
       max-height: 220px; overflow: auto; }
.log .ok { color: #34d399; } .log .warn { color: #fbbf24; } .log .err { color: #f87171; } .log .dim { color: #71717a; }
.ft { flex: none; border-top: 1px solid #f4f4f5; padding: 11px 14px; display: flex; gap: 8px; align-items: center; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 28px; padding: 0 9px;
       border-radius: 6px; font-size: 12px; font-weight: 500; border: 1px solid transparent; cursor: pointer;
       font-family: inherit; }
.bp { background: #18181b; color: #fff; } .bs { background: #fff; color: #18181b; border-color: #d4d4d8; }
.bghost { background: transparent; color: #3f3f46; } .bdanger { background: #dc2626; color: #fff; }
.seg { display: inline-flex; border: 1px solid #e4e4e7; border-radius: 6px; overflow: hidden; }
.seg button { height: 26px; padding: 0 9px; font-size: 12px; border: 0; background: #fff; color: #71717a;
              cursor: pointer; font-family: inherit; }
.seg button.on { background: #18181b; color: #fff; }
input { height: 28px; border: 1px solid #e4e4e7; border-radius: 6px; padding: 0 8px; font-size: 12px;
        font-family: 'JetBrains Mono', monospace; width: 110px; }
.toast { position: fixed; right: 396px; bottom: 24px; background: #18181b; color: #fff; font-size: 12px;
         padding: 7px 11px; border-radius: 6px; display: flex; align-items: center; gap: 6px; opacity: 0;
         transition: opacity .15s; pointer-events: none; }
.toast.show { opacity: 1; }
.warnbar { background: #fffbeb; border-bottom: 1px solid #fde68a; color: #b45309; font-size: 12px;
           padding: 8px 14px; line-height: 1.6; }
`;
