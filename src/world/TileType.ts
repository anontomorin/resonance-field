/**
 * 地图格子的字符编码与类型定义。
 * 关卡使用等宽字符串数组配置，这里负责字符 -> 类型的映射。
 *
 * 陷阱字符的选择受分享码格式约束：
 * 分享码用 ~ 作字段分隔符，计数用小写 36 进制，因此陷阱字符只能用
 * 不属于 [0-9a-z] 也不等于 ~ 的符号。这里选 ^ 与 *。
 */

/** 关卡字符串中允许出现的字符 */
export type TileCode = '#' | '.' | 'S' | 'R' | 'E' | '^' | '*';

/** 格子的逻辑类型 */
export type TileKind = 'wall' | 'floor' | 'start' | 'resonator' | 'exit' | 'spike' | 'jammer';

/** 字符到类型的映射表 */
export const TILE_CODE_TO_KIND: Record<TileCode, TileKind> = {
  '#': 'wall',
  '.': 'floor',
  S: 'start',
  R: 'resonator',
  E: 'exit',
  '^': 'spike',
  '*': 'jammer'
};

/** 判断一个字符是否为合法地图字符 */
export function isTileCode(ch: string): ch is TileCode {
  return ch === '#' || ch === '.' || ch === 'S' || ch === 'R' || ch === 'E' || ch === '^' || ch === '*';
}

/** 是否为陷阱格（可通行，但踩上去有代价） */
export function isTrapKind(kind: TileKind): boolean {
  return kind === 'spike' || kind === 'jammer';
}

/**
 * 声波与玩家可以通过的格子类型。
 * 陷阱是可通行的：踩上去会付出代价，但不会挡路，
 * 因此陷阱不改变关卡的可达性（可达性校验无需为陷阱调整）。
 *
 * 注意：出口格在声波层面是可穿过的，但在玩家层面需要"出口已开启"才可进入，
 * 该判定由 LevelSession 单独处理。
 */
export function isPassableKind(kind: TileKind): boolean {
  return kind !== 'wall';
}
