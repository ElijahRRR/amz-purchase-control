"""任务 ↔ 上游那一行的对照(procure.task_sources)。

回写要知道「这张任务对应飞书里哪几行」。**一张任务对多行** ——
飞书里一行一个商品,同一张上游订单占好几行,落库时合并成一张任务。
回写时这几行都要写:只写第一行的话,上游在表里看到的是
「第一个商品有单号,其余几个还没动静」,而它们本来就是同一次下单。
"""

from typing import Any

_LINK = """
INSERT INTO procure.task_sources (task_id, source, external_id)
VALUES (%(task_id)s, %(source)s, %(external_id)s)
ON CONFLICT (source, external_id) DO UPDATE
   SET task_id = EXCLUDED.task_id,
       -- 改挂到别的任务上时,把回写状态清掉:这一行现在代表另一张单了,
       -- 留着旧摘要会让回写以为「已经写过了」,于是新单号永远不写过去。
       pushed_hash = CASE WHEN procure.task_sources.task_id = EXCLUDED.task_id
                          THEN procure.task_sources.pushed_hash ELSE NULL END,
       pushed_at   = CASE WHEN procure.task_sources.task_id = EXCLUDED.task_id
                          THEN procure.task_sources.pushed_at ELSE NULL END,
       push_error  = NULL,
       -- 又拉到它了,说明没被删(或者从回收站恢复了)。清掉 gone_at,
       -- 这条链因此自愈:不用人去库里手工改一行。
       gone_at     = NULL
RETURNING id
"""


def link(conn, task_id: int, external_ids: list[str], *, source: str = "feishu") -> int:
    """输入:任务 id + 上游行 id → 输出:建立了几条对照。

    上游把某一行的单号改掉时,这一行会**改挂**到新任务上,而不是报错 ——
    那是上游的合法操作(把一个商品从这张单挪到那张单)。
    """
    n = 0
    for external_id in external_ids:
        if not external_id:
            continue
        conn.execute(_LINK, {"task_id": task_id, "source": source,
                             "external_id": external_id})
        n += 1
    return n


_PENDING = """
SELECT s.id, s.task_id, s.external_id, s.pushed_hash,
       t.upstream_order_no, t.status, t.amazon_order_no, t.purchased_at,
       t.error_code, t.actual_total,
       sh.carrier, sh.tracking_no, sh.status AS shipment_status
  FROM procure.task_sources s
  JOIN procure.tasks t ON t.id = s.task_id
  LEFT JOIN LATERAL (
      SELECT carrier, tracking_no, status
        FROM logistics.shipments
       WHERE task_id = t.id ORDER BY id DESC LIMIT 1
  ) sh ON TRUE
 WHERE s.source = %(source)s
   -- 只回写「已经有结果」的单。pending / ready / claimed 还在路上,
   -- 每次状态变化都往上游表里写一次,只会把那张表刷得没法看。
   AND t.status IN ('purchased', 'exception', 'manual', 'cancelled')
   -- 上游删掉的行不再重试。留着的话每轮一次注定失败的请求,
   -- 「失败 N 行」会变成永久噪音,然后没人再看那个数字 ——
   -- 而那个数字正是用来发现「列名建错了」这类真问题的。
   AND s.gone_at IS NULL
 ORDER BY s.task_id, s.id
"""


def pending(conn, *, source: str = "feishu") -> list[dict[str, Any]]:
    """输入:连接 → 输出:候选回写行(**还没跟上次写过的内容比对**)。

    比对交给调用方 —— 「写什么」是业务判断,归 services/feishu_writeback。
    这里只负责把「有结果的单 + 它对应的上游行」捞出来。
    """
    return [dict(r) for r in conn.execute(_PENDING, {"source": source}).fetchall()]


def mark_pushed(conn, source_id: int, *, pushed_hash: str) -> None:
    """输入:对照 id + 内容摘要 → 输出:无。写成功了才调。"""
    conn.execute(
        """UPDATE procure.task_sources
              SET pushed_hash = %s, pushed_at = now(), push_error = NULL
            WHERE id = %s""",
        (pushed_hash, source_id))


def mark_failed(conn, source_id: int, *, error: str, gone: bool = False) -> None:
    """输入:对照 id + 失败原因(+ 上游是不是把这行删了)→ 输出:无。

    **失败也要落库**,而且不清 pushed_hash —— 下一轮还会再试。
    单选列里没有这个选项、列名建错了,这类错重试多少次都一样,
    但把原因记下来,运维在库里一句 SQL 就能看到「哪些行写不进去、为什么」,
    而不是去翻日志。这类错是要人去改配置的,所以要一直提醒。

    `gone=True` 是另一回事:上游把那一行删了,它不会自己回来。
    继续重试只是每轮多一次注定失败的请求,而「失败 N 行」会变成永久噪音,
    然后没人再看那个数字 —— 那个数字正是用来发现「列名建错了」这类真问题的。
    所以标记一下不再试;下次拉单又看见它(从回收站恢复了)会自动清空。
    """
    conn.execute(
        """UPDATE procure.task_sources
              SET push_error = %s,
                  gone_at = CASE WHEN %s THEN now() ELSE gone_at END
            WHERE id = %s""",
        (error[:500], gone, source_id))
