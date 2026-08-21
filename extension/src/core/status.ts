/** 任务状态的界面标签。词沿用厂商面板的说法(docs/03 §3.9)。 */

export const STATUS_LABEL: Record<string, string> = {
  pending: "待放行",
  ready: "待拍单",
  claimed: "拍单中",
  purchased: "已拍单",
  exception: "拍单异常",
  manual: "待人工",
  cancelled: "已取消",
};

/** 插件面板自己的相位,和任务状态不是一回事:
 *  任务状态是库里的,相位是这台机器此刻在干什么。 */
export type Phase =
  | "off"        // 没开工:只注册与心跳,不认领
  | "idle"       // 待命:已注册,队列里没有属于本买家号的单
  | "claimed"    // 领到一单,还没动页面
  | "running"    // 正在跑
  | "confirm"    // 护栏放行,停在下单前等人按
  | "blocked"    // 被护栏拦下,已上报
  | "done";      // 这一单完了

export const PHASE_LABEL: Record<Phase, string> = {
  off: "未开工",
  idle: "待命",
  claimed: "已认领",
  running: "执行中",
  confirm: "下单确认",
  blocked: "护栏拦截",
  done: "已完成",
};
