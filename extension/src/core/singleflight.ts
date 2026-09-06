/** 单飞闸:同一时刻只允许一件事在跑,配置替换要等在跑的那一件结束。
 *
 * 为什么单独拎成一个文件:这道闸原先挂在 Loop 实例上(`private busy`),
 * 而 content/runner.ts 在服务端地址或实例身份变化时会**重建 Loop** ——
 * 新 Loop 的 busy 是 false,于是 10 秒后的定时器又认领了第二单,
 * 两条 runTask 在同一个买家号上并行:第二单的第一步 clearCart 会把第一单
 * 已经加好的商品全删掉(第一单随后报 CART_MISMATCH),更糟的一种是两单商品
 * 混在一张结算页上过护栏 —— 那时护栏拿整单实付去比第一单的限价。
 * 厂商用 purchaseBatchInProgress 堵的正是这个坑。
 *
 * 闸放在这里还有一个好处:它不碰任何 chrome API,所以能在 Node 里直接驱动
 * (extension/test/unit.test.mjs)。MV3 那一侧的东西验不了,这一侧能验。
 */

export class SingleFlight<P> {
  private inFlight = false;
  private pending: P | null = null;

  /** `apply` 是「配置真正生效」的动作。在跑的时候不会被调用,等这一轮结束再补。 */
  constructor(private readonly apply: (p: P) => void) {}

  get busy(): boolean {
    return this.inFlight;
  }

  /** 输入:一份新配置 → 输出:是不是被推迟了。
   *
   *  在跑就先收着 —— 只留最后一份:中途来三次配置广播,该生效的是最后那份。 */
  offer(p: P): boolean {
    if (this.inFlight) {
      this.pending = p;
      return true;
    }
    this.apply(p);
    return false;
  }

  /** 输入:一件要干的活 → 输出:干了没有(被闸挡下时是 false)。
   *
   *  **检查与置位之间一个 await 都不许有。** 中间只要夹一次 await,两个定时器
   *  就能双双通过检查(JS 是单线程,但 await 会让出执行权)——
   *  这正是 background/loop.tickOnce 的形状,照抄它。 */
  async run(job: () => Promise<void>): Promise<boolean> {
    if (this.inFlight) return false;
    this.inFlight = true;
    try {
      await job();
    } finally {
      this.inFlight = false;
      const p = this.pending;
      if (p !== null) {
        this.pending = null;
        this.apply(p);
      }
    }
    return true;
  }
}
