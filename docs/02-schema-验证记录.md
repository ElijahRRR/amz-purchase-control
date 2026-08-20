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
