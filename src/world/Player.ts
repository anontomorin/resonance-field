/**
 * 玩家：逻辑位置保持离散网格坐标，视觉位置做插值平滑。
 * 逻辑判定全部使用整数坐标，动画不会影响碰撞与关卡规则。
 */
export class Player {
  /** 逻辑格坐标 */
  x: number;
  y: number;
  /** 视觉插值坐标（单位：格） */
  visualX: number;
  visualY: number;
  /** 撞击反馈计时（秒） */
  bumpTimer = 0;
  /** 撞击方向，用于抖动表现 */
  bumpDirX = 0;
  bumpDirY = 0;

  constructor(x: number, y: number) {
    this.x = x;
    this.y = y;
    this.visualX = x;
    this.visualY = y;
  }

  setTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
    this.visualX = x;
    this.visualY = y;
    this.bumpTimer = 0;
    this.bumpDirX = 0;
    this.bumpDirY = 0;
  }

  moveTo(x: number, y: number): void {
    this.x = x;
    this.y = y;
  }

  bump(dx: number, dy: number): void {
    this.bumpTimer = 0.22;
    this.bumpDirX = dx;
    this.bumpDirY = dy;
  }

  update(dt: number): void {
    const k = Math.min(1, dt * 16);
    this.visualX += (this.x - this.visualX) * k;
    this.visualY += (this.y - this.visualY) * k;
    if (this.bumpTimer > 0) {
      this.bumpTimer = Math.max(0, this.bumpTimer - dt);
    }
  }
}
