/**
 * 共振节点：只有当脉冲实际抵达节点所在格时才会被激活，且只激活一次。
 */
export class Resonator {
  readonly x: number;
  readonly y: number;
  readonly index: number;
  /** 是否已激活（激活后永久保持） */
  active = false;
  /** 激活时刻，用于动画反馈 */
  activatedAt = -1;

  constructor(x: number, y: number, index: number) {
    this.x = x;
    this.y = y;
    this.index = index;
  }

  /** 尝试激活，返回是否本次调用真正触发了激活 */
  activate(now: number): boolean {
    if (this.active) return false;
    this.active = true;
    this.activatedAt = now;
    return true;
  }

  reset(): void {
    this.active = false;
    this.activatedAt = -1;
  }
}
