import { SonarConfig } from './SonarConfig';

/**
 * 地图可见性系统：管理"未知 / 当前显现 / 探索记忆"三种状态。
 *
 * - 未知：alpha = 0，不绘制任何布局信息；
 * - 当前显现：脉冲到达后 alpha 接近 1，持续 revealDuration；
 * - 探索记忆：显现结束后回落到 memoryAlpha，保留结构轮廓。
 */
export class VisibilitySystem {
  /** 是否曾经被发现过 */
  private explored: Uint8Array;
  /** 明亮显现结束时刻（使用会话内部时钟） */
  private brightUntil: Float32Array;
  /** 最近一次被发现时的、用于闪烁反馈的时间戳 */
  private lastRevealAt: Float32Array;
  /**
   * 已经"看清是陷阱"的格子标记。
   *
   * 这一层是刻意独立于 explored 的：普通地面在显现结束后会回落到 memoryAlpha 的暗色，
   * 几十格地面混在一起玩家根本记不住；而陷阱必须能被记住，否则在看不见的地图里
   * 踩陷阱就成了纯运气。所以只要声波扫到过，陷阱就永久保留警示标记，
   * 连力竭重开也不清除（"你记住了危险的位置"）。
   */
  private knownTraps: Uint8Array;
  /**
   * 每个格子最近一次被照亮时的照度（0~1）。
   *
   * bfs 模型下恒为 1；field 模型下是真实的能量值。
   * 渲染层用它做"越远越模糊"的渐变，所以这里只记录、不做阈值判断 ——
   * 能不能"算看见"由 PulseSystem 按 `fieldThreshold` 决定，
   * 到了这一层的事件都是已经判定为"看见了"的。
   */
  private lastIntensity: Float32Array;
  /** 会话内部时钟（秒），暂停时不推进 */
  private clock = 0;
  private config: SonarConfig;

  constructor(size: number, config: SonarConfig) {
    this.explored = new Uint8Array(size);
    this.brightUntil = new Float32Array(size);
    this.lastRevealAt = new Float32Array(size).fill(-999);
    this.knownTraps = new Uint8Array(size);
    this.lastIntensity = new Float32Array(size).fill(1);
    this.config = config;
  }

  configure(config: SonarConfig): void {
    this.config = config;
  }

  get time(): number {
    return this.clock;
  }

  /**
   * 探索记忆的透明度下限。
   * 渲染层做"越远越模糊"时需要一个下限：照亮强度只能在这条线以上做衰减，
   * 不能把已经看清过的地形压到线以下。
   */
  get memoryAlpha(): number {
    return this.config.memoryAlpha;
  }

  /**
   * 清空可见性。
   * @param keepTrapMemory 是否保留"已知陷阱"标记（力竭重开时为 true）
   */
  reset(keepTrapMemory = false): void {
    this.explored.fill(0);
    this.brightUntil.fill(0);
    this.lastRevealAt.fill(-999);
    this.lastIntensity.fill(1);
    if (!keepTrapMemory) this.knownTraps.fill(0);
    this.clock = 0;
  }

  /** 标记一个格子已经被识别为陷阱（永久，直到主动重开） */
  markTrapKnown(index: number): void {
    this.knownTraps[index] = 1;
  }

  /** 该格子的陷阱是否已被识别 */
  isTrapKnown(index: number): boolean {
    return this.knownTraps[index] === 1;
  }

  /**
   * 清除一个格子的探索记忆（回声干扰器用）。
   * 陷阱标记不会被清除 —— 干扰器的惩罚是"重新迷路"，不是"重新挨打"。
   * @returns 是否真的清掉了一个已探索格
   */
  forget(index: number): boolean {
    if (this.explored[index] === 0) return false;
    this.explored[index] = 0;
    this.brightUntil[index] = 0;
    return true;
  }

  tick(dt: number): void {
    this.clock += dt;
  }

  isExplored(index: number): boolean {
    return this.explored[index] === 1;
  }

  /**
   * 显现一个格子。
   * @param bright 是否进入明亮显现状态（脉冲到达为 true，脚下提示为 false）
   * @param intensity 该次照亮的能量 0~1（bfs 模型传 1）
   */
  reveal(index: number, bright = true, intensity = 1): void {
    this.explored[index] = 1;
    this.lastRevealAt[index] = this.clock;
    // 同一格被反复照亮时取最亮的一次：远处补一枪不该把近处的清晰度冲淡
    if (intensity > this.lastIntensity[index]) this.lastIntensity[index] = intensity;
    if (bright) {
      this.brightUntil[index] = this.clock + this.config.revealDuration;
    }
  }

  /** 该格最近一次被照亮时的照度 0~1（未探索过时返回 0） */
  intensityFor(index: number): number {
    return this.explored[index] === 1 ? this.lastIntensity[index] : 0;
  }

  /** 只标记为已探索，不产生明亮显现（例如玩家脚下的格子） */
  markExplored(index: number): void {
    this.explored[index] = 1;
    this.lastRevealAt[index] = this.clock;
    this.brightUntil[index] = Math.max(this.brightUntil[index], this.clock + 0.35);
  }

  /**
   * 返回格子当前的显现强度 0~1。
   * 0 表示完全未知，1 表示刚被脉冲点亮。
   */
  alphaFor(index: number): number {
    if (this.explored[index] === 0) return 0;

    const remaining = this.brightUntil[index] - this.clock;
    if (remaining <= 0) return this.config.memoryAlpha;

    // 前 62.5% 的时间保持全亮，之后平滑淡出到记忆透明度
    const t = remaining / this.config.revealDuration;
    const hold = Math.min(1, t * 1.6);
    return this.config.memoryAlpha + (1 - this.config.memoryAlpha) * hold;
  }

  /** 刚刚被点亮的一瞬间（用于描边闪烁） */
  flashFor(index: number): number {
    const since = this.clock - this.lastRevealAt[index];
    if (since < 0 || since > 0.28) return 0;
    return 1 - since / 0.28;
  }
}
