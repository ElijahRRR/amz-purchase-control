# Schema 与队列的实测记录

> 环境：PostgreSQL **17.11**（与 `WalmartAPI-Contral` 对齐）
> 对象：`refdata/schema.sql`、`services/task_queue.py`、`cli.py`

## 当前状态（P0 完成时）

| 验证项 | 结果 |
|---|---|
| `cli.py db_init` 建库 | ✅ 9 张表（procure 5 / logistics 2 / ops 2） |
| 重复执行（幂等） | ✅ 第二次执行同样返回 9 张表，无报错 |
| `--dry-run` 不触库 | ✅ 只报将执行的文件与字节数 |
| 未知工作流 | ✅ 在跑第一步**之前**报错退出（exit 1），不会跑到一半才发现 |
| `ops.runs` 留痕 | ✅ 每次执行写一行，含 workflow / status / summary |
| pytest | ✅ **17 passed** |

复现：

```bash
createdb amz_purchase
python cli.py db_init                       # 建库
python cli.py db_init                       # 再跑一次,验证幂等
export AMZ_TEST_ADMIN_DSN="dbname=postgres"
python -m pytest -q                         # 17 passed
```

---

## P1 实测（2026-08-21）

起真实 uvicorn + PostgreSQL 17，用 `tools/mock_plugin.py` 跑四个场景（全程不碰 Amazon）：

| 场景 | 终态 | error_code | 单号 |
|---|---|---|---|
| happy | `purchased` | — | `111-0000001-0000001` |
| over_cap（实付 99.00 > 限价 12.50） | `manual` | `PRICE_CAP_EXCEEDED` | — |
| oos（缺货） | `exception` | `OUT_OF_STOCK` | — |
| wrong_asin（订单卡 ASIN 不符） | `manual` | `ORDER_NO_AMBIGUOUS` | **未写入** |

pytest：**74 passed**。

### 实跑抓到一个 pytest 假通过的 bug

第一轮实跑时，`wrong_asin` 场景的任务**卡死在 `claimed`**，本该是 `manual`。

根因：`complete` 路由的 ASIN 断言失败路径先调 `task_queue.fail()` 写「转 manual」，
再 `raise HTTPException(409)`。而 `registry/db.py` 的 `pg_conn` 遇异常会 rollback ——
刚写的状态被一起回滚了。

**pytest 当时是通过的**，因为测试夹具把裸连接直接交给路由，没有复刻 `pg_conn`
的「正常提交、异常回滚」语义。夹具给了假象。

两处都修了：

1. 路由改成 `return JSONResponse(status_code=409, ...)`，不再 raise
2. `tests/conftest.py` 的 `client` 夹具改为复刻 `pg_conn` 事务语义，
   这类 bug 以后在测试里就能暴露

由此立的铁律（已写进 `CLAUDE.md`）：**路由里只要已经写过库，就不许再
`raise HTTPException`**。

> 这条和本文档下面那条历史结论是同一类问题：**测试/护栏「看起来覆盖了」比没覆盖更危险**。
> 一个是 `NOT EXISTS` 让人以为防住了并发，一个是夹具让人以为测过了回滚路径。

---

## 历史结论：一句 `NOT EXISTS` 挡不住并发（v0.2 → v0.3 已移除该需求，结论保留）

设计 v0.2 曾把租约简化成「`status='claimed'` + 认领 SQL 里一句 `NOT EXISTS` 检查该环境
有没有在执行的任务」，用来实现跨实例互斥。**实测证明这是错的。**

READ COMMITTED 下每个事务读自己的快照，**看不见对方未提交的写**。两个并发认领会双双
通过 `NOT EXISTS`，再被 `SKIP LOCKED` 分到**不同的两条**任务上：

```
[B] BEGIN → 认领 task 2 → COMMIT
[A] BEGIN → 认领 task 1 → COMMIT

claimed 任务数(同一环境) = 2      ❌
```

当时的修复是一条部分唯一索引：

```sql
CREATE UNIQUE INDEX uq_tasks_one_claimed_per_env
    ON procure.tasks (buyer_env_id) WHERE status = 'claimed';
```

同样并发下 B 被数据库拒绝并回滚，`claimed = 1`。

**v0.3 起这条需求不存在了**——所有者确认同一买家号不会在两处同时登录拍单，跨实例互斥
整体删除，索引与 `NOT EXISTS` 一并移除。

结论仍然值得留档，因为它是一条通用教训：

> **「看起来有护栏、实际防不住」比没有护栏更危险。**
> 留着那句 `NOT EXISTS` 会让人以为已经防住了。这和厂商那套 50% 价格护栏是同一种毛病——
> 它比较的是结账页自身的两个数，看着像涨价保护，实际发现不了涨价。
>
> 所以：要么真防住（约束落到数据库），要么明确写清「这里不防，因为前提是 X」。
> `services/task_queue.py` 的模块 docstring 采用了后者。

---

## 全链路实跑(2026-08-21,空库起)

按 README 的快速开始从一个**全新的库**走了一遍,验的是「文档写的步骤真能跑通」,
以及各层拼起来之后行为是否还对。环境:PostgreSQL 17 + uvicorn + 插件自己的
`Loop`/`runTask`(页面动作走模拟驱动,不碰 Amazon)。

```
createdb amz_fresh → cli.py db_init → 9 张表
建 env-172 → cli.py task_intake(5 行,1 行 price_cap=0)
```

| 步骤 | 结果 |
|---|---|
| `task_intake --dry-run` | 5 行 → 将新增 4,拒收 1(`#4 UP-F900: price_cap 必须大于 0`) |
| `task_intake` 真跑 | 新增 4,拒收 1 —— **与空跑逐字一致** |
| 认领 → 拍单(happy) | `purchased`,单号已回填 |
| 超限价 | `manual` / `PRICE_CAP_EXCEEDED` |
| 订单卡 ASIN 不符 | `manual` / `ORDER_NO_AMBIGUOUS`,**单号未写入** |
| 下单后未见确认页 | `manual` / `ORDER_CONFIRM_TIMEOUT` |
| 物流同步 | `delivered`,4 条轨迹,`delivered_at` 已落 |

后台接口(curl 直打):

| 动作 | 结果 |
|---|---|
| 状态桶计数 | manual 3 / purchased 1 / exception 0 / ready 0 |
| 批量单号(上游号 + AMZ 号 + 一个查不到的) | 盖过状态桶,命中 2,`missing_order_numbers` 报出那一个 |
| 实例判活 | `env-172 online 可派单=True 队列=0 今日=1 待人工=3`,阈值 60 秒 |
| 详情 | 商品 1 / 事件 9 / 物流无,事件类型序列完整 |
| 重置一条 `ORDER_CONFIRM_TIMEOUT` | **拒绝**:`NEEDS_ACK` |
| 带 `acknowledged` 再来 | `ready` |
| 强制回填不写说明 | **拒绝**:`NOTE_REQUIRED` |
| 强制回填一个已被占用的单号 | **拒绝**:`ORDER_NO_TAKEN`,并指出挂在哪条任务上 |
| 强制回填正常 | `purchased`,事件里留下 `assertion_skipped: true` + 说明 + 操作人 |

### 这一轮验到的、单元测试验不到的东西

**空跑与真跑逐字一致。** 这一条只有整条链路跑起来才看得出来 ——
`dry_run` 与 `ingest` 是两个函数,单元测试里各自都对,但「同一份输入进去,
人看到的两段输出是不是同一回事」得端到端才成立。之前它们**不一致**过
(空跑不查库,少报了一行拒收),那时两边的单元测试都是绿的。

**拒绝路径不改库。** `NEEDS_ACK` / `NOTE_REQUIRED` / `ORDER_NO_TAKEN` 三条拒绝之后,
任务状态原样不动。这一点在路由层是靠「拒绝判定一律发生在写库之前」保证的,
而不是靠事务回滚 —— 后者在 `pg_conn` 的语义下会把同一次请求里**更早的**写也一起吞掉
(见本文档上面那条 2026-08-21 的记录)。

**留痕能追到人。** 强制回填这个动作在库里留下的是:谁(operator)、
凭什么(note)、跳过了什么闸(assertion_skipped)、原来卡在哪个码(was_error_code)。
事后追责时这四样缺一不可。
