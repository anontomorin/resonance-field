/**
 * 陷阱与生命值参数集中配置。
 *
 * 与 SonarConfig 一样，所有与陷阱有关的数值只允许在这里定义，禁止散落到其它模块硬编码，
 * 方便统一调难度，也方便校验脚本直接引用同一份默认值。
 */
export interface HazardConfig {
  /** 生命上限，默认 3 */
  maxHealth: number;
  /** 踩中一次尖刺扣除的生命，默认 1 */
  spikeDamage: number;
  /** 受伤后的无敌时间（秒），防止连踩陷阱瞬间暴毙，默认 1 */
  invulnerableTime: number;
  /** 回声干扰器清除探索记忆的半径（格），默认 4 */
  jammerRadius: number;
  /** 受伤时的屏幕震动时长（秒），默认 0.35 */
  shakeDuration: number;
  /** 力竭重开本关时是否保留"已发现的陷阱"标记，默认 true */
  rememberTrapsOnDeath: boolean;
  /** 每激活一个共振节点回复的生命，0 表示不回复，默认 0 */
  healOnResonator: number;
}

/** 默认陷阱参数 */
export const DEFAULT_HAZARD: HazardConfig = {
  maxHealth: 3,
  spikeDamage: 1,
  invulnerableTime: 1,
  jammerRadius: 4,
  shakeDuration: 0.35,
  rememberTrapsOnDeath: true,
  healOnResonator: 0
};

/** 合并关卡覆盖参数 */
export function resolveHazardConfig(override?: Partial<HazardConfig>): HazardConfig {
  if (!override) return { ...DEFAULT_HAZARD };
  return { ...DEFAULT_HAZARD, ...override };
}
