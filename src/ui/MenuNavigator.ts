/**
 * 界面焦点导航（手柄菜单操作）。
 *
 * 手柄玩家如果打完一关却点不到"下一关"，等于被卡在结算面板上下不来 ——
 * 所以菜单导航**不是锦上添花，是手柄适配的必要部分**。
 *
 * 实现刻意选择"线性循环"而不是空间寻路：
 * 空间寻路要针对每个界面单独处理布局（两列关卡网格、三页签、动态生成的
 * 结算按钮），规则又长又脆，还很难向玩家解释"为什么按左跳到了这里"。
 * 线性循环只看 DOM 顺序，永远可预测、可复现、可测试。
 *
 * 焦点环复用界面里既有的 `:focus-visible` 视觉（1px 琥珀描边），
 * 让"鼠标点中的"和"手柄选中的"看起来是同一件事。
 */

/** 覆盖层按 DOM 顺序排列，最后一个可见的就是最上层（分享弹窗压在其它界面之上） */
const OVERLAY_IDS = [
  'overlay-title',
  'overlay-levels',
  'overlay-editor',
  'overlay-share',
  'overlay-pause',
  'overlay-complete',
  'overlay-exhausted',
  'overlay-final'
] as const;

/**
 * 可聚焦的交互元素。
 * 刻意**不含** `.custom-item`：那是个 `<div>` 容器，
 * 真正能点的是它内部的 `.mini-btn`，把容器当焦点会变成一个按了没反应的死站。
 */
const FOCUSABLE_SELECTOR = [
  '.btn',
  '.tab',
  '.chip',
  '.mode-card',
  '.level-card',
  '.mini-btn',
  '.palette-item'
]
  .map((selector) => `${selector}:not([disabled])`)
  .join(', ');

const FOCUS_CLASS = 'pad-focus';

export class MenuNavigator {
  private index = -1;
  /** 上一次看到的覆盖层，用来在界面切换时把焦点归零 */
  private overlayId: string | null = null;

  /** 状态切换时调用：焦点不能跨界面残留 */
  reset(): void {
    this.index = -1;
    this.applyFocus(null);
  }

  /** 移动焦点（delta = ±1）；首次移动时落到第一个元素 */
  move(delta: number): void {
    const list = this.collect();
    if (list.length === 0) return;
    const next = this.index < 0 ? 0 : (this.index + delta + list.length) % list.length;
    this.index = next;
    this.applyFocus(list[next] ?? null);
  }

  /**
   * 确认：点击当前焦点元素；还没有焦点时点第一个。
   * 返回是否真的点到了东西（调用方用来决定要不要给"无可选项"的反馈）。
   */
  activate(): boolean {
    const list = this.collect();
    if (list.length === 0) return false;
    const target = this.index >= 0 && this.index < list.length ? list[this.index] : list[0];
    if (!target) return false;
    target.click();
    return true;
  }

  /** 当前焦点元素（调试与验收用） */
  get focused(): HTMLElement | null {
    const list = this.collect();
    if (this.index < 0 || this.index >= list.length) return null;
    return list[this.index] ?? null;
  }

  /** 最上层可见覆盖层的 id */
  activeOverlayId(): string | null {
    let found: string | null = null;
    for (const id of OVERLAY_IDS) {
      const el = document.getElementById(id);
      if (el && !el.classList.contains('hidden')) found = id;
    }
    return found;
  }

  // ==================== 内部 ====================

  /**
   * 收集当前可聚焦元素。
   * 用 `getClientRects()` 而不是 `offsetParent` 判可见：
   * 覆盖层本身是 fixed 定位，`offsetParent` 对它内部的元素不可靠。
   * 隐藏页签里的按钮因此会被自动排除，不会把焦点送进看不见的地方。
   */
  private collect(): HTMLElement[] {
    const id = this.activeOverlayId();
    if (id !== this.overlayId) {
      // 界面换了（打开分享弹窗也算），旧索引对新列表没有意义
      this.overlayId = id;
      this.index = -1;
      this.applyFocus(null);
    }
    if (!id) return [];
    const root = document.getElementById(id);
    if (!root) return [];
    return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
      (el) => el.getClientRects().length > 0
    );
  }

  private applyFocus(el: HTMLElement | null): void {
    document.querySelectorAll(`.${FOCUS_CLASS}`).forEach((node) => {
      node.classList.remove(FOCUS_CLASS);
    });
    if (el) el.classList.add(FOCUS_CLASS);
  }
}
