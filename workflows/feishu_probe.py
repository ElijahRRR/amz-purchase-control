"""接飞书表之前先看一眼:这张表到底有哪些列、值长什么样、按现在的映射能读出什么。

    python cli.py feishu_probe                 # 列名 + 前 3 条按当前映射的读数
    python cli.py feishu_probe -p rows=10      # 多看几条

**不写库,永远不写库。**(所以它没有 dry_run 分支 —— 它本身就是。)

为什么要有这么个东西:飞书的列名可以带空格、emoji、看不见的零宽字符,
对着截图猜列名一定会猜错;而猜错的表现是「全表 300 行全部拒收:缺字段 xxx」,
看的人第一反应是上游把表填坏了,而不是我们的列名写错了一个空格。
"""

from api import feishu
from registry import settings
from services import feishu_intake


def run(params: dict) -> str:
    """输入:params(rows 可选,默认 3)→ 输出:字段清单与试读结果。"""
    app_token = settings.feishu_app_token()
    table_id = settings.feishu_table_id()
    if not app_token or not table_id:
        raise ValueError(
            "没配 AMZ_FEISHU_APP_TOKEN / AMZ_FEISHU_TABLE_ID。"
            "表格 URL 形如 https://xxx.feishu.cn/base/<app_token>?table=<table_id>")

    want = max(1, int(params.get("rows") or 3))
    client = feishu.Client()

    out = ["表里的列(左边是飞书里的真实列名,原样复制到 refdata/feishu_fields.json):"]
    names = []
    for f in client.list_fields(app_token, table_id):
        name = f.get("field_name", "")
        names.append(name)
        # 列名两边加引号打印:名字里有首尾空格或零宽字符时,只有这样看得出来
        quoted = '"' + name + '"'
        out.append(f"    {quoted:<28} {f.get('type')}  {f.get('ui_type', '')}")

    records = []
    for rec in client.iter_records(app_token, table_id,
                                   view_id=settings.feishu_view_id(),
                                   max_records=want):
        records.append(rec)
        if len(records) >= want:
            break

    out.append(f"\n前 {len(records)} 条记录的原始值:")
    for rec in records:
        out.append(f"    record {rec['record_id']}")
        for k, v in rec["fields"].items():
            out.append(f"        {k:<24} {v!r}")

    # 按当前映射试读一遍:列名对不上会在这里立刻现形
    try:
        mapping = feishu_intake.load_mapping()
    except feishu_intake.MappingError as exc:
        out.append(f"\n当前映射文件有问题:{exc}")
        return "\n".join(out)

    missing = [f"{ours} → {theirs!r}" for ours, theirs in mapping["fields"].items()
               if theirs and theirs not in names]
    if missing:
        out.append("\n⚠ 映射里这些列在表里找不到(对不上就会整表拒收):")
        out.extend(f"    {m}" for m in missing)

    mapped = feishu_intake.to_rows(records, mapping)
    out.append(f"\n按当前映射读出来({mapping['row_is']} 模式,"
               f"{len(records)} 条记录 → {len(mapped['rows'])} 张订单):")
    for row in mapped["rows"]:
        out.append(f"    {row['upstream_order_no']} · {row['buyer_env_code']} · "
                   f"限价 {row['price_cap']} · {row['ship_name']} "
                   f"{row['ship_city']},{row['ship_state']} {row['ship_postcode']} · "
                   f"商品 {row['products']}")
    if mapped["skipped"]:
        out.append(f"    (另有 {len(mapped['skipped'])} 条被 take_when 滤掉)")
    return "\n".join(out)
