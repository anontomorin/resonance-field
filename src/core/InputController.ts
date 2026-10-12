/**
 * 键盘输入控制器。
 *
 * 整个应用只在这里注册一次 window 监听，避免切换关卡 / 返回标题时重复绑定事件。
 * 对外提供"持续按住"和"单次按下"两种查询方式。
 */

export type GameAction =
  | 'up'
  | 'down'
  | 'left'
  | 'right'
  | 'pulse'
  | 'restart'
  | 'pause';

const KEY_MAP: Record<string, GameAction> = {
  ArrowUp: 'up',
  KeyW: 'up',
  ArrowDown: 'down',
  KeyS: 'down',
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  Space: 'pulse',
  KeyR: 'restart',
  Escape: 'pause'
};

export class InputController {
  private held = new Set<GameAction>();
  private pressed = new Set<GameAction>();
  private attached = false;

  private handleKeyDown = (event: KeyboardEvent): void => {
    const action = KEY_MAP[event.code];
    if (!action) return;
    // 阻止空格滚动页面、方向键滚动页面
    event.preventDefault();
    if (!this.held.has(action)) {
      this.pressed.add(action);
    }
    this.held.add(action);
  };

  private handleKeyUp = (event: KeyboardEvent): void => {
    const action = KEY_MAP[event.code];
    if (!action) return;
    event.preventDefault();
    this.held.delete(action);
  };

  /** 窗口失焦时清空按键，防止"卡住"持续移动 */
  private handleBlur = (): void => {
    this.clearAll();
  };

  attach(): void {
    if (this.attached) return;
    window.addEventListener('keydown', this.handleKeyDown);
    window.addEventListener('keyup', this.handleKeyUp);
    window.addEventListener('blur', this.handleBlur);
    this.attached = true;
  }

  detach(): void {
    if (!this.attached) return;
    window.removeEventListener('keydown', this.handleKeyDown);
    window.removeEventListener('keyup', this.handleKeyUp);
    window.removeEventListener('blur', this.handleBlur);
    this.attached = false;
  }

  isHeld(action: GameAction): boolean {
    return this.held.has(action);
  }

  /** 消费一次"刚按下"事件（读取后清除） */
  consumePress(action: GameAction): boolean {
    if (this.pressed.has(action)) {
      this.pressed.delete(action);
      return true;
    }
    return false;
  }

  /** 每帧结束清理未被消费的按下事件 */
  endFrame(): void {
    this.pressed.clear();
  }

  clearAll(): void {
    this.held.clear();
    this.pressed.clear();
  }
}
