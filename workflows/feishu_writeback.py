"""把采购结果写回飞书那张表。

    python cli.py feishu_writeback --dry-run    # 看这一轮会写哪几行、写什么
    python cli.py feishu_writeback

**默认关着**(refdata/feishu_fields.json 里 writeback.enabled)。
往别人的表里写字是有副作用的动作,不该因为「代码里有这个功能」就默认发生。

与拉单分成两条链,不合在一起:回写失败不该挡住拉单。
上游那几列建错了、单选没有对应选项 —— 这类问题会让回写一直失败,
如果它们同在一条链里,新单就跟着一起进不来了。
"""

from api import feishu
from registry import db, settings
from services import feishu_intake, feishu_writeback, task_source

#: 一批多少条。飞书上限 1000,这里刻意用小批 ——
#: batch_update 是**整批一起生效**的,一条写不进去整批都失败。
#: 批越大,一行坏数据能连累的行就越多。
_BATCH = 50


def _push(client, app_token: str, table_id: str, chunk: list[dict], conn) -> tuple[int, int]:
    """输入:一批更新 → 输出:(成功数, 失败数)。

    先整批发。整批失败就**逐条重发** —— 飞书这个接口是整批生效的,
    一条坏行(比如上游把那一行删了)会让整批失败;不降级重试的话,
    那一条坏行会永远挡住同批的其它行,而且每一轮都挡。
    """
    try:
        client.batch_update(app_token, table_id,
                            [{"record_id": u["record_id"], "fields": u["fields"]}
                             for u in chunk])
    except feishu.FeishuError:
        ok = bad = 0
        for u in chunk:
            try:
                client.batch_update(app_token, table_id,
                                    [{"record_id": u["record_id"], "fields": u["fields"]}])
            except feishu.FeishuError as exc:
                task_source.mark_failed(conn, u["_source_id"], error=str(exc),
                                        gone=exc.code in feishu.RECORD_GONE_CODES)
                bad += 1
            else:
                task_source.mark_pushed(conn, u["_source_id"], pushed_hash=u["_hash"])
                ok += 1
        return ok, bad

    for u in chunk:
        task_source.mark_pushed(conn, u["_source_id"], pushed_hash=u["_hash"])
    return len(chunk), 0


def run(params: dict) -> str:
    """输入:params(dry_run 可选)→ 输出:结果摘要。"""
    mapping = feishu_intake.load_mapping()
    try:
        fields = feishu_writeback.load_config(mapping)
    except feishu_writeback.WritebackDisabled as exc:
        # 不是错误,是配置。安静地跳过,但把原因说出来 ——
        # 一条「跳过」的链在运行记录里必须解释自己为什么跳过,
        # 否则运维只会看到一条每 10 分钟成功一次、什么也没干的记录。
        return f"跳过:{exc}"

    app_token = settings.feishu_app_token()
    table_id = settings.feishu_table_id()
    if not app_token or not table_id:
        raise ValueError("没配 AMZ_FEISHU_APP_TOKEN / AMZ_FEISHU_TABLE_ID")

    with db.pg_conn() as conn:
        rows = task_source.pending(conn)
        got = feishu_writeback.plan(rows, fields)
        updates = got["updates"]

        head = (f"{len(rows)} 行有结果的上游数据 → 需要写 {len(updates)} 行"
                f",内容没变跳过 {got['skipped']} 行")

        if params.get("dry_run"):
            preview = "\n".join(
                f"    {u['_upstream']} · record {u['record_id']} → {u['fields']}"
                for u in updates[:10])
            more = f"\n    …另有 {len(updates) - 10} 行" if len(updates) > 10 else ""
            body = f"dry-run:{head}" + (f"\n  将写入:\n{preview}{more}" if updates else "")
            return body + _tail(conn, bad=0)

        ok = bad = 0
        if updates:
            client = feishu.Client()
            for i in range(0, len(updates), _BATCH):
                a, b = _push(client, app_token, table_id, updates[i:i + _BATCH], conn)
                ok += a
                bad += b
            head = f"回写完成:成功 {ok} 行,失败 {bad} 行(共 {len(rows)} 行候选)"

        # 尾巴在**每一条路径**上都要拼。早先「没什么可写」那条路直接 return 了,
        # 于是「有 N 行上游已删除」在全都写完的那一轮反而看不见 ——
        # 而那正是最该看见它的时候。
        return head + _tail(conn, bad=bad)


def _tail(conn, *, bad: int) -> str:
    """输入:连接 + 本轮失败数 → 输出:摘要末尾那几句(已删除 / 去哪儿看失败原因)。"""
    row = conn.execute(
        """SELECT count(*) FILTER (WHERE gone_at IS NOT NULL) AS gone,
                  count(*) FILTER (WHERE gone_at IS NULL
                                     AND push_error IS NOT NULL) AS stuck
             FROM procure.task_sources""").fetchone()
    out = ""
    if row["gone"]:
        out += (f"\n  另有 {row['gone']} 行上游已删除,不再重试"
                f"(下次拉单又看见它会自动恢复)")
    if bad or row["stuck"]:
        # 只说「失败 3 行」而不说去哪儿看,等于让人去翻日志。
        out += ("\n  失败原因逐条记在 procure.task_sources.push_error:"
                "\n    SELECT external_id, push_error FROM procure.task_sources"
                " WHERE push_error IS NOT NULL AND gone_at IS NULL;")
    return out
