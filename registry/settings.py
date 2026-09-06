"""配置接线盒(铁律 3:任何可调参数只准从这里取,不准散落在业务代码里)。"""

import os


def claim_timeout_minutes() -> int:
    """输入:无 → 输出:claimed 超时分钟数,超过则由 task_sweep 转 manual。

    插件领走任务后若这么久还没回传,判定为异常中断。保守起见转 manual 而不是
    退回 ready —— 插件可能已经在 Amazon 上真下了单,只是没来得及回传。
    """
    return int(os.environ.get("AMZ_CLAIM_TIMEOUT_MIN", "15"))


def server_host() -> str:
    """输入:无 → 输出:HTTP 服务监听地址(默认仅本机,不做鉴权的前提)。"""
    return os.environ.get("AMZ_SERVER_HOST", "127.0.0.1")


def server_port() -> int:
    """输入:无 → 输出:HTTP 服务端口。"""
    return int(os.environ.get("AMZ_SERVER_PORT", "8781"))


def heartbeat_stale_seconds() -> int:
    """输入:无 → 输出:多久没心跳算离线(秒)。

    插件默认 20 秒一次心跳,连续三次没到才判离线 —— 一次网络抖动不该让运营
    看到一排红点,那样红点就不再有意义了。

    这个值在设计画布上曾标着「等 admin 列表接口落地时一起定」,现在定了。
    """
    return int(os.environ.get("AMZ_HEARTBEAT_STALE_SEC", "60"))


def admin_page_size_max() -> int:
    """输入:无 → 输出:后台列表单页最大条数。

    厂商面板给了 1000~5000 条每页的选项,那不是给人看的,是给浏览器上刑的。
    """
    return int(os.environ.get("AMZ_ADMIN_PAGE_SIZE_MAX", "200"))


def shipment_resync_minutes() -> int:
    """输入:无 → 输出:同一条物流多久之后才值得再同步一次(分钟)。

    Amazon 的轨迹一天更新不了几次,盯太紧只是白开 iframe。
    已签收/已取消的不再进队列,所以这个值只影响在途单。
    """
    return int(os.environ.get("AMZ_SHIPMENT_RESYNC_MIN", "360"))


def shipment_batch_size() -> int:
    """输入:无 → 输出:一次给插件多少条待同步的单。

    每条都要开一次订单详情页 + 一次跟踪页,给太多会让插件在一轮里跑很久。
    """
    return int(os.environ.get("AMZ_SHIPMENT_BATCH", "20"))


# ── 有界自动重试(默认关)────────────────────────────────────────────

def auto_retry_max() -> int:
    """输入:无 → 输出:同一张任务最多被系统自动重拍几次,**0 = 关(默认)**。

    默认关,因为自动重试写错方向就是自动重复下单 —— 这套系统里唯一
    「宁可卡住也不自动往前走」的地方就是花过钱的那一步。要开就得有人明确
    在 .env 里写一个数,而不是因为「代码里有这个功能」就默认发生
    (与 feishu_writeback 同一条理由)。

    上限的含义是**这一张任务一生里被机器自动重拍的总次数**,不是每轮几次:
    retry_count 只增不清,人工重置不动它。

    负数按 0 算 —— 一个负的上限跟「关」是同一个意思,但显示成「最多 -1 次」
    会让人以为界面坏了。
    """
    return max(0, int(os.environ.get("AMZ_AUTO_RETRY_MAX", "0")))


def auto_retry_backoff_minutes() -> int:
    """输入:无 → 输出:失败后至少隔多少分钟才允许自动重试(默认 10)。

    页面慢、结构没等到这类失败往往是一阵一阵的(亚马逊那边正卡、代理正抖)。
    立刻重拍只是拿同一个坏环境再撞一次,还会把错误码分布刷成一片同样的码。

    负数按 0 算:make_interval 收负数会把窗口变成「未来」,于是**每一条
    exception 都立刻满足条件** —— 一个手滑的负号会把这道闸整个抹掉,
    而现象是「自动重试怎么这么积极」,没人会想到是配置写反了。
    """
    return max(0, int(os.environ.get("AMZ_AUTO_RETRY_BACKOFF_MIN", "10")))


def auto_retry_batch() -> int:
    """输入:无 → 输出:一轮最多自动重几条(默认 20)。

    `auto_retry_max()` 界的是**同一张单**重几次,界不住**一轮放几张单**。
    把 `AMZ_AUTO_RETRY_MAX` 从 0 改成 2 的那一轮,库里积着的历史 exception
    会一次性全部退回队列,插件挨个在亚马逊上重拍一遍 —— retry_count 在那里
    一点忙都帮不上,它们的 retry_count 都是 0。
    分批与 `AMZ_SHIPMENT_BATCH` 同一条理由:有副作用的批量动作得能一眼看完。

    **0 和负数按 1 算,不当成「关」。** 这条链要么关着(`AMZ_AUTO_RETRY_MAX=0`,
    界面跟着改口说「需人工重置」),要么真的在重。一个每轮安静地什么都不做、
    而界面还在替它对运营承诺「系统最多自动重试 N 次」的状态,正是本项目最防的
    那种「看起来有护栏、实际防不住」的反面 —— 看起来有功能、实际没在跑。
    """
    return max(1, int(os.environ.get("AMZ_AUTO_RETRY_BATCH", "20")))


def auto_retry_max_age_minutes() -> int:
    """输入:无 → 输出:失败超过多久就不再自动重(分钟,默认 1440 = 24 小时)。

    与 backoff 一起把「够格」夹成一个**窗口**:太新的等一等,太旧的交给人。
    一条 120 天前失败的单还留在 exception 里,通常说明它早就在别处被处置掉了
    (上游取消了、有人手工买了、运营记着这一单不要了),这时自动再拍一次,
    买回来的既不是当初要的东西,也没人在等它。而这正是开关刚从 0 改成 N 的
    那一轮会撞上的场景 —— 一轮条数上限只能把它摊到几轮里,拦住的是这道年龄闸。

    0 和负数按 1 算,理由同 `auto_retry_batch()`:0 的含义是「没有一条够新」,
    闸门就此永远关着,而现象与「这条链停了」一模一样,只是工作流记录页还是绿的。
    """
    return max(1, int(os.environ.get("AMZ_AUTO_RETRY_MAX_AGE_MIN", "1440")))


# ── 飞书多维表格(上游订单来源)─────────────────────────────────────────

def feishu_app_id() -> str:
    """输入:无 → 输出:飞书自建应用的 App ID。

    凭据放 <DATA_ROOT>/.env,不进 git(registry/paths.env_file)。
    """
    return os.environ.get("AMZ_FEISHU_APP_ID", "")


def feishu_app_secret() -> str:
    """输入:无 → 输出:飞书自建应用的 App Secret。"""
    return os.environ.get("AMZ_FEISHU_APP_SECRET", "")


def feishu_base() -> str:
    """输入:无 → 输出:飞书开放平台域名。

    国际版是 open.larksuite.com,国内版是 open.feishu.cn。做成可配的,
    免得哪天换版本要去代码里翻域名。
    """
    return os.environ.get("AMZ_FEISHU_BASE", "https://open.feishu.cn")


def feishu_app_token() -> str:
    """输入:无 → 输出:多维表格的 app_token(表格 URL 里 /base/ 后面那一段)。"""
    return os.environ.get("AMZ_FEISHU_APP_TOKEN", "")


def feishu_table_id() -> str:
    """输入:无 → 输出:数据表 id(URL 里 ?table= 后面那一段,形如 tblXXXX)。"""
    return os.environ.get("AMZ_FEISHU_TABLE_ID", "")


def feishu_view_id() -> str:
    """输入:无 → 输出:视图 id(可选,形如 vewXXXX)。

    给了就只拉这个视图里的记录 —— 让运营在飞书里用一个「待采购」视图
    圈定范围,比我们在代码里写死筛选条件灵活得多,改条件不用发版。
    """
    return os.environ.get("AMZ_FEISHU_VIEW_ID", "")


def feishu_page_size() -> int:
    """输入:无 → 输出:一次翻多少条(飞书上限 500)。"""
    return min(int(os.environ.get("AMZ_FEISHU_PAGE_SIZE", "500")), 500)


def feishu_timeout_seconds() -> int:
    """输入:无 → 输出:单次 HTTP 超时(秒)。"""
    return int(os.environ.get("AMZ_FEISHU_TIMEOUT_SEC", "20"))


def feishu_max_records() -> int:
    """输入:无 → 输出:一次同步最多读多少条,0 = 不限。

    不是为了省流量,是**兜底**:表被人误操作灌成十万行时,
    宁可这一轮报「超过上限,没同步」,也不要闷头拉半小时再把十万行怼进库。
    """
    return int(os.environ.get("AMZ_FEISHU_MAX_RECORDS", "5000"))


def feishu_field_map_path() -> str:
    """输入:无 → 输出:列名映射文件路径(默认 refdata/feishu_fields.json)。

    放 refdata/ 而不是 .env:列名变了应该有人 review,而不是某天有人悄悄
    改了一个环境变量,然后整批单开始被拒收,而 git 里什么痕迹都没有。
    """
    from registry import paths

    return os.environ.get("AMZ_FEISHU_FIELD_MAP",
                          str(paths.repo_root() / "refdata" / "feishu_fields.json"))


def feishu_sync_max_age_minutes() -> int:
    """输入:无 → 输出:feishu_sync 多久没跑算不正常(分钟)。

    做成可配的,是因为拉单频率是运维决定的:有人 10 分钟一轮,有人一小时一轮。
    默认 120 分钟(比推荐的 */10 宽松得多)—— 阈值卡太紧的话,
    改成低频跑的人会得到一格**永远红着的卡片**,而一格永远红着的卡片
    会把人训练成忽略红色,等真出事时没人看。
    """
    return int(os.environ.get("AMZ_FEISHU_SYNC_MAX_AGE_MIN", "120"))


def feishu_table_url() -> str:
    """输入:无 → 输出:多维表格的**人看的** URL 前缀(可选)。

    与 feishu_base() 不是一回事:那个是 API 域名(open.feishu.cn),
    这个是租户自己的域名(xxx.feishu.cn),运营点进去看表用的。
    形如 https://xxx.feishu.cn/base/basXXXX

    没配就只显示 record_id,不拼一个点不开的链接 ——
    一个点了没反应的链接比没有链接更让人恼火。
    """
    return os.environ.get("AMZ_FEISHU_TABLE_URL", "").rstrip("/")
