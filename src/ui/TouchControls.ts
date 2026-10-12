/**
 * 触摸控制：虚拟摇杆 + 声波按钮（移动端适配）。
 *
 * 使用 Pointer Events，因此触屏与鼠标都能用；
 * 只产生"方向"和"发射请求"两种输入，不改任何游戏数据，
 * 移动节流仍由 LevelSession 统一处理。
 */

export interface TouchDirection {
  dx: number;
  dy: number;
}

const DEAD_ZONE = 14;

export class TouchControls {
  private stick: HTMLElement;
  private knob: HTMLElement;
  private pulseButton: HTMLButtonElement;

  private dir: TouchDirection | null = null;
  private activePointer: number | null = null;
  private pendingPulse = false;
  private enabled = false;

  constructor() {
    // 校验元素存在（触摸控件容器由 CSS 控制显隐）
    this.require('touch-controls');
    this.stick = this.require('joystick');
    this.knob = this.require('joystick-knob');
    this.pulseButton = this.require('touch-pulse') as HTMLButtonElement;

    this.stick.addEventListener('pointerdown', this.handlePointerDown);
    this.stick.addEventListener('pointermove', this.handlePointerMove);
    this.stick.addEventListener('pointerup', this.handlePointerUp);
    this.stick.addEventListener('pointercancel', this.handlePointerUp);
    this.stick.addEventListener('lostpointercapture', this.handlePointerUp);

    // 用 pointerdown 而不是 click，避免触摸设备上 300ms 延迟与重复触发
    this.pulseButton.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      this.pendingPulse = true;
    });
  }

  private require(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`缺少界面元素 #${id}`);
    return el;
  }

  /**
   * 根据设备能力决定是否显示触摸控件。
   *
   * 判定顺序：
   * 1. 主指针是粗指针（手机 / 平板）→ 开启；
   * 2. 设备只有触摸、没有精确指针（无鼠标的纯触屏设备）→ 开启；
   * 3. 视口很窄（窄窗口 / 竖屏小窗）→ 开启，方便临时用触摸操作。
   *
   * 注意：这里刻意不用 navigator.maxTouchPoints > 0 —— 带触摸屏的笔记本
   * 也会返回大于 0，那样会把桌面玩家误判成移动端。
   */
  applyDeviceMode(): void {
    const mq = (query: string): boolean => window.matchMedia(query).matches;
    const coarsePrimary = mq('(pointer: coarse)');
    const touchOnly = mq('(any-pointer: coarse)') && !mq('(any-pointer: fine)');
    const narrow = window.innerWidth < 860;
    this.enabled = coarsePrimary || touchOnly || narrow;
    document.body.classList.toggle('touch-enabled', this.enabled);
    if (!this.enabled) this.reset();
  }

  /** 首次真实触摸时强制开启（部分设备初始查询不到 coarse pointer） */
  enableOnFirstTouch(): void {
    window.addEventListener(
      'touchstart',
      () => {
        this.enabled = true;
        document.body.classList.add('touch-enabled');
      },
      { once: true }
    );
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  get direction(): TouchDirection | null {
    return this.enabled ? this.dir : null;
  }

  /** 取出一次发射请求（读取后清除） */
  consumePulse(): boolean {
    if (!this.enabled) return false;
    if (!this.pendingPulse) return false;
    this.pendingPulse = false;
    return true;
  }

  /** 松开摇杆并清空未消费的输入（切换界面 / 暂停 / 重开时调用） */
  reset(): void {
    this.dir = null;
    this.pendingPulse = false;
    this.activePointer = null;
    this.setKnob(0, 0);
  }

  private setKnob(offsetX: number, offsetY: number): void {
    this.knob.style.transform = `translate(${offsetX}px, ${offsetY}px)`;
  }

  private handlePointerDown = (event: PointerEvent): void => {
    if (!this.enabled) return;
    event.preventDefault();
    this.activePointer = event.pointerId;
    this.stick.setPointerCapture(event.pointerId);
    this.updateFromPointer(event);
  };

  private handlePointerMove = (event: PointerEvent): void => {
    if (!this.enabled) return;
    if (this.activePointer !== event.pointerId) return;
    event.preventDefault();
    this.updateFromPointer(event);
  };

  private handlePointerUp = (event: PointerEvent): void => {
    if (this.activePointer !== null && this.activePointer !== event.pointerId) return;
    this.activePointer = null;
    this.dir = null;
    this.setKnob(0, 0);
  };

  private updateFromPointer(event: PointerEvent): void {
    const rect = this.stick.getBoundingClientRect();
    const cx = rect.left + rect.width / 2;
    const cy = rect.top + rect.height / 2;
    let dx = event.clientX - cx;
    let dy = event.clientY - cy;
    const maxRadius = rect.width / 2 - 18;

    const length = Math.hypot(dx, dy);
    if (length > maxRadius) {
      dx = (dx / length) * maxRadius;
      dy = (dy / length) * maxRadius;
    }
    this.setKnob(dx, dy);

    if (Math.hypot(dx, dy) < DEAD_ZONE) {
      this.dir = null;
      return;
    }
    // 四方向摇杆：取位移较大的轴
    if (Math.abs(dx) >= Math.abs(dy)) {
      this.dir = { dx: dx > 0 ? 1 : -1, dy: 0 };
    } else {
      this.dir = { dx: 0, dy: dy > 0 ? 1 : -1 };
    }
  }
}
