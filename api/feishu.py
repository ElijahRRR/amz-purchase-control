"""飞书多维表格(Bitable)读取适配。

**铁律 2:这一层只做接口适配,不写业务判断。**
所以这里只负责:换 token、翻页、把飞书那套字段值形状摊平成普通 Python 标量、
把错误码翻译成异常。「哪一列是限价」「什么样的行该拒收」属于业务,
在 services/feishu_intake.py。

飞书字段值的形状是个坑:同一个「文本」字段,可能回一个字符串,
也可能回一串富文本片段 `[{"type":"text","text":"..."}]` —— 取决于这一格里
有没有链接、@人、公式。照着某一天看到的形状写取值,换一格数据就 None。
摊平放在这一层,是因为它是**接口的形状问题**,不是业务问题。

接口文档:https://open.feishu.cn/document/server-docs/docs/bitable-v1/app-table-record/list
"""

import json
import time
import urllib.error
import urllib.request
from typing import Any, Callable, Iterator

from registry import settings


class FeishuError(RuntimeError):
    """飞书返回了非 0 的 code,或者 HTTP 层就没通。

    带上 code 是为了让上面能分辨「配错了」和「暂时不通」——
    前者重试一万次也一样,后者下一轮就好了。把两者混成一个「同步失败」,
    运维只能靠猜。
    """

    def __init__(self, code: int, msg: str, *, retryable: bool = False):
        super().__init__(f"飞书接口返回 code={code}: {msg}")
        self.code = code
        self.msg = msg
        self.retryable = retryable


#: 这些码是**暂时的**,值得重试:频控、内部错误。
#: 其余(参数错、权限不足、表不存在)重试多少次结果都一样,立刻抛出去。
_RETRYABLE_CODES = frozenset({
    99991400,   # 频控:too many request
    1254290,    # Bitable 频控
    99991661,   # 内部错误
})

_RETRYABLE_HTTP = frozenset({429, 500, 502, 503, 504})


def _default_transport(url: str, *, method: str, headers: dict[str, str],
                       body: bytes | None, timeout: int) -> tuple[int, bytes]:
    """输入:请求四要素 → 输出:(HTTP 状态码, 响应体)。

    单独抽出来是为了让测试能塞一个假的进去 —— 一个必须联网才能跑的测试,
    等于没有测试:CI 上一断网就红,人就会开始忽略它。
    """
    req = urllib.request.Request(url, method=method, headers=headers, data=body)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except urllib.error.HTTPError as exc:      # 4xx/5xx 也要把 body 读出来:飞书把 code 写在里面
        return exc.code, exc.read()


class Client:
    """飞书开放平台客户端。一个实例缓存一个 tenant_access_token。

    token 有效期两小时,过期前 5 分钟就换 —— 掐着秒换会在换的那一刻撞上
    「刚好过期」,而那次失败会被记成一次同步失败。
    """

    def __init__(self, *, app_id: str | None = None, app_secret: str | None = None,
                 base: str | None = None, timeout: int | None = None,
                 transport: Callable[..., tuple[int, bytes]] | None = None):
        self.app_id = app_id if app_id is not None else settings.feishu_app_id()
        self.app_secret = (app_secret if app_secret is not None
                           else settings.feishu_app_secret())
        self.base = (base or settings.feishu_base()).rstrip("/")
        self.timeout = timeout or settings.feishu_timeout_seconds()
        self._transport = transport or _default_transport
        self._token = ""
        self._token_expires_at = 0.0

    # ── 底层 ────────────────────────────────────────────────────────────

    def _call(self, path: str, *, method: str = "GET", body: dict | None = None,
              auth: bool = True, retries: int = 3) -> dict[str, Any]:
        """输入:接口路径 → 输出:**整个响应体**。非 0 code 抛 FeishuError。

        返回整体而不是 `data` —— 飞书不是所有接口都把结果放在 `data` 里:
        换 token 那个接口把 `tenant_access_token` 直接放在响应根上。
        在这里替调用方剥一层 `data`,那个接口就永远拿不到 token,
        而报出来的错是「换 token 成功但响应里没有 token」,读的人一头雾水。
        """
        url = f"{self.base}{path}"
        payload = json.dumps(body, ensure_ascii=False).encode() if body is not None else None

        last: FeishuError | None = None
        for attempt in range(retries):
            headers = {"Content-Type": "application/json; charset=utf-8"}
            if auth:
                headers["Authorization"] = f"Bearer {self._ensure_token()}"

            status, raw = self._transport(url, method=method, headers=headers,
                                          body=payload, timeout=self.timeout)
            try:
                got = json.loads(raw or b"{}")
            except json.JSONDecodeError:
                # 网关抽风时会回一段 HTML。原样截一小段带上 —— 只说「解析失败」
                # 的话,排查的人还得自己去复现一次才看得到那段 HTML。
                snippet = (raw or b"")[:200].decode("utf-8", "replace")
                got, status = {}, status or 599
                last = FeishuError(status, f"响应不是 JSON:{snippet}",
                                   retryable=status in _RETRYABLE_HTTP)
                if not last.retryable:
                    raise last
                time.sleep(2 ** attempt)
                continue

            code = int(got.get("code", 0))
            if code == 0:
                return got

            retryable = code in _RETRYABLE_CODES or status in _RETRYABLE_HTTP
            last = FeishuError(code, got.get("msg", ""), retryable=retryable)
            if not retryable:
                raise last
            # 指数退避。频控时立刻重试只会把自己再撞一次。
            time.sleep(2 ** attempt)

        assert last is not None
        raise last

    def _ensure_token(self) -> str:
        """输入:无 → 输出:tenant_access_token(过期前 5 分钟自动续)。"""
        if self._token and time.time() < self._token_expires_at:
            return self._token
        if not self.app_id or not self.app_secret:
            raise FeishuError(
                0, "没配 AMZ_FEISHU_APP_ID / AMZ_FEISHU_APP_SECRET —— "
                   "凭据放 <DATA_ROOT>/.env,不要写进代码或仓库")
        # 这个接口把 token 放在响应根上,不在 data 里。
        got = self._call("/open-apis/auth/v3/tenant_access_token/internal",
                         method="POST", auth=False,
                         body={"app_id": self.app_id, "app_secret": self.app_secret})
        self._token = got.get("tenant_access_token") or ""
        if not self._token:
            raise FeishuError(0, f"换 token 成功但响应里没有 tenant_access_token:{got}")
        # 提前 5 分钟过期。掐着秒换会在换的那一刻撞上「刚好过期」。
        self._token_expires_at = time.time() + max(60, int(got.get("expire", 7200)) - 300)
        return self._token

    # ── 多维表格 ────────────────────────────────────────────────────────

    def list_fields(self, app_token: str, table_id: str) -> list[dict[str, Any]]:
        """输入:表标识 → 输出:字段清单 [{field_name, type, ...}]。

        给 `cli.py feishu_probe` 用:接表之前先把列名打出来,照着写映射。
        比对着截图猜列名靠谱 —— 飞书的列名可以带空格、emoji、看不见的零宽字符。
        """
        out: list[dict[str, Any]] = []
        page_token = ""
        while True:
            q = f"?page_size=100" + (f"&page_token={page_token}" if page_token else "")
            data = self._call(
                f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/fields{q}"
            ).get("data") or {}
            out.extend(data.get("items") or [])
            if not data.get("has_more"):
                return out
            page_token = data.get("page_token") or ""
            if not page_token:
                return out

    def iter_records(self, app_token: str, table_id: str, *, view_id: str = "",
                     page_size: int | None = None,
                     max_records: int | None = None) -> Iterator[dict[str, Any]]:
        """输入:表标识(+可选视图)→ 输出:逐条产出 {record_id, fields}(fields 已摊平)。

        `max_records` 是兜底:表被人误操作灌成十万行时,宁可这一轮报错停下,
        也不要闷头拉半小时再把十万行怼进库。到上限会抛 FeishuError,
        **不是静默截断** —— 静默截断会让上游以为单子都同步了。
        """
        page_size = page_size or settings.feishu_page_size()
        cap = settings.feishu_max_records() if max_records is None else max_records
        seen = 0
        page_token = ""

        while True:
            q = f"?page_size={page_size}"
            if page_token:
                q += f"&page_token={page_token}"
            if view_id:
                q += f"&view_id={view_id}"
            data = self._call(
                f"/open-apis/bitable/v1/apps/{app_token}/tables/{table_id}/records{q}"
            ).get("data") or {}

            for item in data.get("items") or []:
                seen += 1
                if cap and seen > cap:
                    raise FeishuError(
                        0, f"表里的记录超过上限 {cap} 条,这一轮没有同步。"
                           f"确认表没被误操作,或调大 AMZ_FEISHU_MAX_RECORDS")
                yield {
                    "record_id": item.get("record_id"),
                    "fields": {k: flatten(v) for k, v in (item.get("fields") or {}).items()},
                }

            if not data.get("has_more"):
                return
            page_token = data.get("page_token") or ""
            if not page_token:
                # has_more 说还有,却不给 page_token —— 再翻就是死循环。
                # 这种情况宁可报错,也不要静默停在这里让人以为拉全了。
                raise FeishuError(0, "飞书说还有下一页,却没给 page_token")


def flatten(value: Any) -> Any:
    """输入:飞书的一格值 → 输出:普通 Python 标量 / 列表。

    飞书同一个「文本」字段可能回:
      · 字符串 `"UP-20841"`
      · 富文本片段 `[{"type":"text","text":"UP-20841"}]`(格里有链接/@人/公式时)
      · 超链接 `{"text":"点我","link":"https://…"}`
      · 人员 `[{"id":"ou_x","name":"张三"}]`
    照着某一天看到的形状写取值,换一格数据就 None ——
    而 None 在落库那一层会变成「缺字段」,一整批单被拒收,原因看着毫无道理。

    这里只统一形状,不判断内容 —— 内容是业务,归 services。
    """
    if isinstance(value, list):
        # **只有富文本片段才拼成一个字符串。**
        #
        # 判据是「每一项都是带 text 键的 dict」—— 富文本片段总是那个形状。
        # 不能拿「摊平后都是字符串」当判据:多选字段 `["加急","补发"]` 摊平后
        # 也都是字符串,那样会被拼成 `"加急补发"` —— 一个既不是「加急」
        # 也不是「补发」的值,而且看起来完全正常。
        # 人员字段 `[{"id":..,"name":..}]` 同理:没有 text 键,保持列表。
        if value and all(isinstance(v, dict) and "text" in v for v in value):
            return "".join(str(v["text"]) for v in value)
        return [flatten(v) for v in value]
    if isinstance(value, dict):
        for key in ("text", "name", "value"):
            if key in value and isinstance(value[key], (str, int, float)):
                return value[key]
        return value
    return value
