/**
 * 随机关卡的参数定义。
 *
 * 单独成文件是为了让 levelData、LevelGenerator、shareCode 都能引用这些类型，
 * 而不会形成循环依赖。
 */

/** 随机关卡的生成参数 */
export interface RandomLevelParams {
  /** 随机种子（相同种子必定生成同一张地图） */
  seed: number;
  /** 迷宫单元列数，实际地图宽 = cols * 2 + 1 */
  cols: number;
  /** 迷宫单元行数，实际地图高 = rows * 2 + 1 */
  rows: number;
  /** 共振节点数量 */
  nodes: number;
  /** 编织比例（0 ~ 0.4）：额外打通一部分墙，形成回路与小空地 */
  braid: number;
}

/** 难度预设（不含种子） */
export interface RandomPreset {
  id: string;
  label: string;
  desc: string;
  params: Omit<RandomLevelParams, 'seed'>;
}

export const RANDOM_PRESETS: RandomPreset[] = [
  { id: 'small', label: '小巧', desc: '9 × 7 · 1 节点', params: { cols: 4, rows: 3, nodes: 1, braid: 0.18 } },
  { id: 'normal', label: '标准', desc: '15 × 11 · 2 节点', params: { cols: 7, rows: 5, nodes: 2, braid: 0.15 } },
  { id: 'wide', label: '宽阔', desc: '21 × 15 · 3 节点', params: { cols: 10, rows: 7, nodes: 3, braid: 0.13 } },
  { id: 'deep', label: '深渊', desc: '29 × 19 · 4 节点', params: { cols: 14, rows: 9, nodes: 4, braid: 0.11 } }
];

export const DEFAULT_PRESET_ID = 'normal';

/** 参数的安全范围（分享码解码后也会用同一套范围夹紧） */
export const RANDOM_LIMITS = {
  minCols: 3,
  maxCols: 20,
  minRows: 3,
  maxRows: 14,
  minNodes: 1,
  maxNodes: 6,
  minBraid: 0,
  maxBraid: 0.4
};

/** 取预设参数（未命中时回退到标准） */
export function presetParams(id: string): Omit<RandomLevelParams, 'seed'> {
  const preset = RANDOM_PRESETS.find((p) => p.id === id);
  return preset ? preset.params : RANDOM_PRESETS[1].params;
}

export function presetLabel(id: string): string {
  const preset = RANDOM_PRESETS.find((p) => p.id === id);
  return preset ? preset.label : '标准';
}

/** 生成一个 1 ~ 2^31-1 的随机种子 */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0x7ffffffe) + 1;
}

/** 把任意数值夹紧到安全范围，返回合法参数（分享码解码后必须调用） */
export function clampParams(params: RandomLevelParams): RandomLevelParams {
  const { minCols, maxCols, minRows, maxRows, minNodes, maxNodes, minBraid, maxBraid } =
    RANDOM_LIMITS;
  const clamp = (v: number, lo: number, hi: number): number =>
    Number.isFinite(v) ? Math.max(lo, Math.min(hi, Math.round(v))) : lo;
  return {
    seed: Math.abs(Math.floor(params.seed)) >>> 0 || 1,
    cols: clamp(params.cols, minCols, maxCols),
    rows: clamp(params.rows, minRows, maxRows),
    nodes: clamp(params.nodes, minNodes, maxNodes),
    braid: Math.max(minBraid, Math.min(maxBraid, params.braid))
  };
}

/** 种子转成便于口头传播的短字符串（base36 大写） */
export function seedToText(seed: number): string {
  return (seed >>> 0).toString(36).toUpperCase();
}
