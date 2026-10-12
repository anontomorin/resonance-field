/**
 * 声波系统参数集中配置。
 * 所有与声波有关的数值只允许在这里集中定义，禁止散落到其它模块硬编码。
 */

/**
 * 声波传播模型。
 *
 * - `bfs`：四方向网格 BFS，距离是整数"走几步"。规则纯粹、可预测，
 *   但波纹是一圈等亮的环，没有远近明暗。
 * - `field`：八方向射线照度场，距离是 0~1 的连续能量值。
 *   能表达"距离衰减"，视觉上是"越远越模糊"；
 *   代价是"可见"从布尔判断变成了阈值判断（见 `fieldThreshold`）。
 */
export type SonarModel = 'bfs' | 'field';

export interface SonarConfig {
  /**
   * 传播模型。默认 `field`。
   *
   * 之所以做成开关而不是直接替换：两个模型的"可见范围"不同，
   * 会直接影响理论最优脉冲数 `par` 与星级阈值。
   * 保留开关才能用同一套校验脚本跑 A/B 对比，确认差异后再定默认值。
   */
  model: SonarModel;
  /** 单次脉冲的最大传播步数（bfs 为 BFS 层数，field 为射线格距），默认 8 */
  maxRange: number;
  /**
   * field 模型：沿射线每前进一个"半格"的能量衰减系数，默认 0.86。
   *
   * 一个整格 ≈ 两次半步，所以整格衰减约 0.74。
   * 调小 → 远处更暗、感知范围收缩；调大 → 看得更远。
   */
  fieldFalloff: number;
  /**
   * field 模型：照度低于此值即视为"看不见"，默认 0.3。
   *
   * 这个阈值决定实际感知半径：
   * 0.86^(2n) >= 0.3 解得 n ≈ 3.6 格，
   * 也就是照度模型下实际只能看清约 4 格 —— 比 BFS 的 8 格明显更近。
   * 这是刻意的：能量随距离骤降，才谈得上"距离衰减"。
   */
  fieldThreshold: number;
  /** 每传播一格的动画间隔（秒），默认 0.055 */
  stepDelay: number;
  /** 明亮显现持续时间（秒），默认 2.2 */
  revealDuration: number;
  /** 探索记忆的透明度，默认 0.2 */
  memoryAlpha: number;
  /** 发射冷却（秒），默认 0.6 */
  cooldown: number;
  /** 玩家踏入新格时是否点亮脚下这一格（仅脚下 1 格，不揭示周围） */
  revealPlayerTile: boolean;
}

/** 默认声波参数 */
export const DEFAULT_SONAR: SonarConfig = {
  model: 'field',
  maxRange: 8,
  fieldFalloff: 0.86,
  fieldThreshold: 0.3,
  stepDelay: 0.055,
  revealDuration: 2.2,
  memoryAlpha: 0.2,
  cooldown: 0.6,
  revealPlayerTile: true
};

/** 合并关卡覆盖参数 */
export function resolveSonarConfig(override?: Partial<SonarConfig>): SonarConfig {
  if (!override) return { ...DEFAULT_SONAR };
  return { ...DEFAULT_SONAR, ...override };
}
