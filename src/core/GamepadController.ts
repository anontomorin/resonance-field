/**
 * 手柄输入控制器（Gamepad API）。
 *
 * 与键盘不同，Gamepad API 是**轮询式**的：没有 keydown 那样的事件回调，
 * 只有 `navigator.getGamepads()` 的"当下快照"。因此本类不注册监听，
 * 而是由 GameApp 在每帧 update() 开头调用 `poll()` 主动读取。
 *
 * 对外的动作集合与键盘的 InputController 完全一致（GameAction），
 * 这样 GameApp 里两套输入可以走同一条"优先级链"，不需要为手柄分叉逻辑。
 *
 * 按键映射（标准布局 mapping === 'standard'）：
 *   十字键 / 左摇杆  → 移动
 *   A / RT           → 发射声波
 *   Y                → 重开本关
 *   Start            → 暂停 / 继续
 *
 * 为什么重开放在 Y 而不是更顺手的 B：B 与 A 相邻，
 * 而"重开"是不可逆的（丢掉本局已探索的记忆），
 * 放在离拇指更远的 Y 上可以显著降低误触代价。
 *
 * 摇杆给的是连续值，而本游戏是四向网格移动，所以取"位移较大的轴"
 * 并加死区过滤，判定方式与虚拟摇杆 TouchControls 保持一致。
 */

import type { GameAction } from './InputController';

/** 左摇杆死区：低于此值视为回中，避免廉价手柄的漂移让角色自己走 */
const STICK_DEAD_ZONE = 0.42;

/** 模拟扳机阈值：扳机的模拟量很少精确到 1，用半程作为"按下" */
const TRIGGER_THRESHOLD = 0.5;

/** 标准映射下的按钮索引（W3C Gamepad 规范） */
const BUTTON = {
  A: 0,
  Y: 3,
  RT: 7,
  MENU: 9,
  DPAD_UP: 12,
  DPAD_DOWN: 13,
  DPAD_LEFT: 14,
  DPAD_RIGHT: 15
} as const;

/** 直接对应动作的按键 */
const BUTTON_ACTIONS: Array<[number, GameAction]> = [
  [BUTTON.A, 'pulse'],
  [BUTTON.RT, 'pulse'],
  [BUTTON.Y, 'restart'],
  [BUTTON.MENU, 'pause']
];

export interface PadDirection {
  dx: number;
  dy: number;
}

function defaultSnapshot(): Array<Gamepad | null> {
  const read = navigator.getGamepads;
  if (typeof read !== 'function') return [];
  return Array.from(read.call(navigator));
}

export class GamepadController {
  /** 本帧刚按下的动作（读取后清除，语义同 InputController） */
  private pressed = new Set<GameAction>();
  /** 上一帧仍按住的动作，用来做边沿检测 */
  private prevDown = new Set<GameAction>();
  private dir: PadDirection | null = null;
  private connectedFlag = false;
  private padName = '';
  private onChange: ((padName: string | null) => void) | null;

  /**
   * 手柄快照来源。
   * 默认读真实的 `navigator.getGamepads()`；自动化验收里可以换成假手柄，
   * 否则"手柄适配"就只能靠插真机去测，回归时无法复现。
   */
  private snapshotProvider: (() => Array<Gamepad | null>) | null = null;

  constructor(onChange?: (padName: string | null) => void) {
    this.onChange = onChange ?? null;
  }

  /** 仅供自动化测试：注入假手柄快照；传 null 恢复真实设备 */
  setSnapshotProvider(provider: (() => Array<Gamepad | null>) | null): void {
    this.snapshotProvider = provider;
  }

  get isConnected(): boolean {
    return this.connectedFlag;
  }

  get name(): string {
    return this.padName;
  }

  /** 当前移动方向；无输入时为 null（调用方可继续回落到键盘） */
  get direction(): PadDirection | null {
    return this.dir;
  }

  /**
   * 每帧调用一次：读快照 → 更新连接态 → 算方向 → 生成"刚按下"边沿。
   * 只在连接状态**发生变化**时回调，避免每帧都去改 DOM。
   */
  poll(): void {
    const pad = this.pick();
    if (!pad) {
      if (this.connectedFlag) {
        this.connectedFlag = false;
        this.padName = '';
        this.dir = null;
        this.prevDown.clear();
        this.onChange?.(null);
      }
      return;
    }

    if (!this.connectedFlag || this.padName !== pad.id) {
      this.connectedFlag = true;
      this.padName = pad.id;
      // 换手柄时清掉上一只手柄的按住状态，避免把"新柄没按"误判成"刚松开"
      this.prevDown.clear();
      this.onChange?.(pad.id);
    }

    const down = this.readDown(pad);
    // 边沿检测：只有"这一帧才按下去"的动作才算一次按下，
    // 否则按住不放会在每帧都触发一次声波 / 重开。
    for (const action of down) {
      if (!this.prevDown.has(action)) this.pressed.add(action);
    }
    this.prevDown = down;
    this.dir = this.readDirection(pad);
  }

  consumePress(action: GameAction): boolean {
    if (!this.pressed.has(action)) return false;
    this.pressed.delete(action);
    return true;
  }

  /**
   * 清空未消费的输入（切换界面 / 暂停 / 重开时调用）。
   *
   * 刻意**不清** `prevDown`：玩家往往是按着 A 确认"下一关"，
   * 如果连按住状态一起忘掉，新关卡的第一帧就会再发一次声波。
   */
  reset(): void {
    this.pressed.clear();
    this.dir = null;
  }

  /** 每帧结束清理未被消费的按下事件（与 InputController.endFrame 对称） */
  endFrame(): void {
    this.pressed.clear();
  }

  // ==================== 内部 ====================

  private pick(): Gamepad | null {
    const source = this.snapshotProvider ? this.snapshotProvider() : defaultSnapshot();
    for (const pad of source) {
      if (pad && pad.connected) return pad;
    }
    return null;
  }

  /** 按键是否按下：数字键看 pressed，模拟扳机再看一眼模拟量 */
  private isDown(pad: Gamepad, index: number): boolean {
    const button = pad.buttons[index];
    if (!button) return false;
    return button.pressed || button.value > TRIGGER_THRESHOLD;
  }

  /**
   * 本帧所有"方向 / 动作"的按住集合。
   * 方向也放进来，是因为菜单导航需要"推一下走一格"的边沿语义，
   * 而游玩状态只读 direction，两边共用同一份按下状态。
   */
  private readDown(pad: Gamepad): Set<GameAction> {
    const down = new Set<GameAction>();
    for (const [index, action] of BUTTON_ACTIONS) {
      if (this.isDown(pad, index)) down.add(action);
    }
    if (this.isDown(pad, BUTTON.DPAD_UP)) down.add('up');
    if (this.isDown(pad, BUTTON.DPAD_DOWN)) down.add('down');
    if (this.isDown(pad, BUTTON.DPAD_LEFT)) down.add('left');
    if (this.isDown(pad, BUTTON.DPAD_RIGHT)) down.add('right');

    const dir = this.readDirection(pad);
    if (dir) {
      down.add(dir.dy === -1 ? 'up' : dir.dy === 1 ? 'down' : dir.dx === -1 ? 'left' : 'right');
    }
    return down;
  }

  /** 十字键优先于摇杆：十字键是"明确输入"，不该被摇杆漂移盖掉 */
  private readDirection(pad: Gamepad): PadDirection | null {
    return this.readDpad(pad) ?? this.readStick(pad);
  }

  private readDpad(pad: Gamepad): PadDirection | null {
    if (this.isDown(pad, BUTTON.DPAD_UP)) return { dx: 0, dy: -1 };
    if (this.isDown(pad, BUTTON.DPAD_DOWN)) return { dx: 0, dy: 1 };
    if (this.isDown(pad, BUTTON.DPAD_LEFT)) return { dx: -1, dy: 0 };
    if (this.isDown(pad, BUTTON.DPAD_RIGHT)) return { dx: 1, dy: 0 };
    return null;
  }

  private readStick(pad: Gamepad): PadDirection | null {
    const x = pad.axes[0] ?? 0;
    const y = pad.axes[1] ?? 0;
    if (Math.abs(x) < STICK_DEAD_ZONE && Math.abs(y) < STICK_DEAD_ZONE) return null;
    // 四向网格移动：只取位移较大的那个轴，斜推不会变成"斜着走"
    if (Math.abs(x) >= Math.abs(y)) return { dx: x > 0 ? 1 : -1, dy: 0 };
    return { dx: 0, dy: y > 0 ? 1 : -1 };
  }
}

/**
 * 手柄名往往长这样：
 *   "Xbox 360 Controller (XInput STANDARD GAMEPAD Vendor: 045e Product: 028e)"
 * 直接塞进提示条会撑爆一行，取括号前的主体部分即可。
 */
export function shortPadName(id: string): string {
  const cut = id.split('(')[0]?.trim();
  const name = cut && cut.length > 0 ? cut : id;
  return name.length > 28 ? `${name.slice(0, 27)}…` : name;
}
