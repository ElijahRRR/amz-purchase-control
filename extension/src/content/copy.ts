/** 点一下就复制。
 *
 * 规则定在样式上,不是一个字段一个字段挂:`.copy` = 标识符 = 可复制。
 * 新加一个 mono 字段带上这个类就自动有行为,不用记得去补事件。
 *
 * 复制必须有反馈 —— 没有那句「已复制」的复制等于没复制,人会点第二次,
 * 然后开始怀疑这个按钮坏了。反过来复制不算危险动作,不需要确认步:它不改任何东西。
 */

export function wireCopy(root: ShadowRoot, toast: HTMLElement): void {
  root.addEventListener("click", (ev) => {
    const el = (ev.target as HTMLElement)?.closest<HTMLElement>(".copy");
    if (!el) return;
    const text = el.dataset.copy ?? el.textContent?.trim() ?? "";
    if (!text || text === "—") return;
    void navigator.clipboard.writeText(text).then(
      () => flash(toast, "已复制 " + text),
      () => flash(toast, "复制失败(页面没有剪贴板权限)"),
    );
  });
}

let timer: ReturnType<typeof setTimeout> | undefined;

function flash(toast: HTMLElement, text: string): void {
  toast.textContent = text;
  toast.classList.add("show");
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => toast.classList.remove("show"), 1400);
}
