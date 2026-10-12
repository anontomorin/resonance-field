/**
 * 星级评分：以"本局用了多少次声波"为唯一依据。
 *
 * 为什么只盯脉冲次数？
 * 这一作的核心资源就是"看得见多少"——脉冲是唯一的照明手段。
 * 用得多说明你在摸黑乱撞，用得少说明你真的把回波记进了脑子里、规划过路线。
 * 用时和踩刺数都受地图长度与运气影响，脉冲次数才直接反映"有没有在动脑"。
 *
 * ## 三星线为什么是 par + 1
 *
 * `par` 是 mapAnalysis 按真实传播规则算出的**理论最少脉冲数**，
 * 也就是"把所有节点照亮、并且不为找路多打一发"的绝对下限。
 *
 * 这里踩过两次坑，都值得记下来：
 *
 * 1. 最初三星线设成 `par + 1`，但当时 `par` 的口径是"节点 + 出口各算一次"，
 *    而主线五关的 `par` 恰好等于"走到每个节点各发一次"的朴素打法
 *    （L1~L4 = 2 次、L5 = 3 次），于是**任何正常通关都直接三星**，评分没有区分度。
 * 2. 收紧成严格的 `par` 之后又走到另一个极端：`par=2` 意味着玩家
 *    "照到节点与出口后各只发一次波，并且一次走对位置"，真人首通几乎必然 1~2 星。
 *
 * 最终定在 `par + 1`：既保留"你得真的规划过"这条底线，
 * 又给一次探路的容错——因为 `par` 是在"每次发波都落在最优位置"的理想条件下
 * 算出来的，而真人不知道最优位置在哪，那一发试错是合理成本。
 *
 * ## 档位
 *
 * - ★★★  脉冲 <= par + 1   —— 会规划，最多只多打一次探路
 * - ★★   脉冲 <= par * 2   —— 合理水平：探索得多一些，但仍有章法
 * - ★    其余              —— 通关了，但基本是一发一发试出来的
 *
 * 重玩的主要动力是**刷新最佳脉冲次数**这个具体数字（会记录并展示历史最佳），
 * 星级只是它的粗略档位。
 *
 * 该模块不依赖 DOM，可在 Node 中直接用于关卡校验。
 */

/** 单关星级（0 表示未通关） */
export type Stars = 0 | 1 | 2 | 3;

/** 评分档位阈值（相对理论下界 par） */
export interface StarThresholds {
  /** 三星所需的最大脉冲数 */
  three: number;
  /** 二星所需的最大脉冲数 */
  two: number;
}

/**
 * 由理论下界算出三 / 二星的脉冲阈值。
 *
 * @param par 理论最少脉冲数（mapAnalysis.minPulsesToClear 的结果）
 */
export function thresholdsFor(par: number): StarThresholds {
  const base = Math.max(1, Math.floor(par));
  return {
    // 三星 = 下界 + 1 次探路容错。
    // 之所以不直接用 base：真人不知道最优发射点在哪，
    // 至少要多花一发去确认出口方位，拿 base 当线会让三星变成事实上的"不可能"。
    three: base + 1,
    // 二星给到两倍：地图越大下界越高，容错空间也该越大，
    // 否则大图会因为"多探两次"就直接掉到一星，手感很冤。
    two: Math.max(base + 2, base * 2)
  };
}

/**
 * 算一次评分的星级。
 * @param pulses 本局实际脉冲次数
 * @param par 理论最少脉冲数
 */
export function starsFor(pulses: number, par: number): Stars {
  const { three, two } = thresholdsFor(par);
  if (pulses <= three) return 3;
  if (pulses <= two) return 2;
  return 1;
}

/** 星级对应的说明文案（结算面板用） */
export function starComment(stars: Stars): string {
  switch (stars) {
    case 3:
      return '几乎没浪费一声回响，路线像是提前画好的。';
    case 2:
      return '规划得不错，只有几次必要的探路。';
    case 1:
      return '通关了。试着少发几次声波，先记住再走。';
    default:
      return '';
  }
}

/**
 * 距离下一档星级还需要减少多少次脉冲；已满三星返回 null。
 * need 为 0 时表示"当前已是该档上限"（例如刚跨过二星线）。
 */
export function pulsesToNextStar(
  pulses: number,
  par: number
): { next: Stars; need: number } | null {
  const stars = starsFor(pulses, par);
  if (stars >= 3) return null;
  const { three, two } = thresholdsFor(par);
  if (stars === 1) return { next: 2, need: Math.max(0, pulses - two) };
  return { next: 3, need: Math.max(0, pulses - three) };
}

/** 把星级渲染成 ★☆ 文本（用于纯文本场景，如结算列表） */
export function starsToText(stars: Stars): string {
  return '★'.repeat(stars) + '☆'.repeat(3 - stars);
}

/** 总星级 / 满星级（用于最终结算汇总） */
export function totalStars(all: ReadonlyArray<Stars>): { got: number; max: number } {
  let got = 0;
  for (const s of all) got += s;
  return { got, max: all.length * 3 };
}
