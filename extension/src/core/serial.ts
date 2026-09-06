/** 串行闸:把一串异步动作排成**一条队**,同一时刻只有一个在跑。
 *
 * 与 core/singleflight.ts 的分工:SingleFlight 把第二件事**挡掉**(认领这一轮
 * 正在跑,下一轮就别来了);Serial 让第二件事**排队等**(两条租约请求都要有答复,
 * 只是不许同时读写那一份租约)。
 *
 * 为什么需要它:service worker 里的租约裁决是「读存储 → 裁决 → 写存储」,
 * 中间夹着两次 await —— chrome.storage.session 是异步的。两条 amz.acquireRunner
 * 消息前后脚进来(SW 被唤醒,或者两个标签页的 10 秒定时器对齐),各自在
 * `await readLease()` 上让出执行权,读到的是**同一个**旧值,decideLease 各自
 * 返回 granted,两次 writeLease 后一个覆盖前一个 —— 而两个标签页都收到了
 * granted:true,于是各自领一单,两条 runTask 动同一个购物车。
 * singleflight.ts 那句「检查与置位之间一个 await 都不许有」在那里被破掉了。
 *
 * 它不碰任何 chrome API,所以能在 Node 里直接驱动(extension/test/unit.test.mjs)。
 */

export class Serial {
  /** 队尾。**已经被吞过异常**——排在后面的活不该因为前一件失败而永远等不到。 */
  private tail: Promise<unknown> = Promise.resolve();

  /** 输入:一件要干的活 → 输出:它的结果(排在前面的都跑完之后才开始)。
   *
   *  失败会原样抛回给调用方,但不会堵住队列。 */
  run<T>(job: () => Promise<T>): Promise<T> {
    const next = this.tail.then(job, job);
    this.tail = next.then(() => undefined, () => undefined);
    return next;
  }
}
