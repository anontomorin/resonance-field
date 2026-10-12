/**
 * 统一视觉主题。
 *
 * 设计口径：
 * - 底色走**中性近黑**（不是墨蓝），界面与画布用同一套灰阶，
 *   这样 HUD 压在画布上不会显得是"两个 app 拼起来"；
 * - 颜色克制：地面/墙/未知区全部低饱和，唯一的高饱和色留给声波与玩家，
 *   玩家一眼就知道"亮起来的那部分才是信息"；
 * - 地面上加一层极淡的网格纹理，让"这是一张格子地图"一眼可见，
 *   但透明度低到不会在未知区域泄露任何布局。
 */

/** 十六进制色 + 透明度 → rgba()，避免到处手写一串数字 */
export function alpha(hex: string, a: number): string {
  const v = hex.replace('#', '');
  const r = parseInt(v.slice(0, 2), 16);
  const g = parseInt(v.slice(2, 4), 16);
  const b = parseInt(v.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

export const Theme = {
  /** 背景渐变（由内到外）：中心稍亮，四周压到近黑，形成"洞窟感" */
  backgroundInner: '#191d21',
  backgroundMid: '#111417',
  backgroundOuter: '#0b0c0e',

  /** 未知区域的背景纹理 */
  unknownBase: '#0e1013',
  unknownGrid: 'rgba(216, 220, 224, 0.05)',

  /** 地面：可通行区域，中等冷灰，读起来是"能走的平面" */
  floorFill: '#2b323a',
  floorStroke: 'rgba(216, 220, 224, 0.32)',
  floorGlow: 'rgba(95, 201, 221, 0.14)',
  /** 地面内部细网格，让格子边界可见 */
  floorGrid: 'rgba(216, 220, 224, 0.07)',

  /** 墙壁：比地面**明显更暗**，并且填满，读起来是"实心障碍"。
   *  重绘时墙被调得和地面太接近，玩家分不清能不能走，这里把对比拉回来。 */
  wallFill: '#080a0c',
  wallStroke: 'rgba(216, 220, 224, 0.6)',
  /** 墙面顶部亮边，让墙有一点体积而不是一块纯色 */
  wallHighlight: 'rgba(216, 220, 224, 0.13)',
  /** 墙面斜纹：给实心墙加一层"砌体"质感，和地面网格彻底区分 */
  wallHatch: 'rgba(216, 220, 224, 0.09)',

  /** 声波：唯一的高饱和色，是"信息"本身。重绘时压得太暗，这里恢复亮度 */
  pulseRing: 'rgba(95, 201, 221,',
  pulseCore: '#c8f2fa',
  pulseHalo: 'rgba(95, 201, 221, 0.16)',

  /** 玩家 */
  player: '#7ad8ea',
  playerCore: '#eefbfd',
  playerHalo: 'rgba(95, 201, 221, 0.24)',

  /** 共振节点 */
  nodeInactive: '#d9a441',
  nodeActive: '#e8c477',
  nodeGlow: 'rgba(217, 164, 65, 0.3)',

  /** 出口 */
  exitClosed: '#4a5a62',
  exitOpen: '#7fb79b',
  exitGlow: 'rgba(127, 183, 155, 0.3)',

  /** 陷阱：尖刺（扣血，硬惩罚） */
  hazardSpike: '#cf5f5a',
  hazardSpikeFill: '#3a1614',
  hazardSpikeStroke: 'rgba(207, 95, 90, 0.85)',
  hazardSpikeGlow: 'rgba(207, 95, 90, 0.16)',

  /** 陷阱：回声干扰器（清除记忆，软惩罚，视觉上与尖刺区分） */
  hazardJammer: '#9a7bc0',
  hazardJammerFill: '#2a1f38',
  hazardJammerStroke: 'rgba(154, 123, 192, 0.85)',
  hazardJammerGlow: 'rgba(154, 123, 192, 0.16)',

  /** 陷阱在探索记忆层保留的警示标记 */
  trapMemoryMark: 'rgba(207, 95, 90, 0.9)',
  jammerMemoryMark: 'rgba(154, 123, 192, 0.9)',

  /** 文字与 HUD */
  text: '#d8dce0',
  textDim: 'rgba(139, 147, 156, 0.9)'
} as const;
