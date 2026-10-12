/** 应用级状态机状态 */
export type AppState =
  | 'title'
  | 'levelSelect'
  | 'editor'
  | 'playing'
  | 'paused'
  | 'levelComplete'
  | 'exhausted'
  | 'gameComplete';

/** 本地存档数据结构 */
export interface ProgressData {
  /** 已解锁到第几关（1 表示只解锁第一关） */
  unlocked: number;
  /** 是否静音 */
  muted: boolean;
  /** 已通关的关卡 id 列表 */
  cleared: number[];
  /** 每关最佳用时（秒） */
  bestTimes: Record<string, number>;
  /**
   * 每关历史最佳星级（0~3）。
   * 单独存星级而不是"用最佳脉冲实时反推"，是因为地图规则以后可能改动
   * （比如声波范围调整），旧记录若靠反推会被新规则重新解释，玩家会莫名掉星。
   */
  bestStars: Record<string, number>;
  /** 每关达成最佳星级时用的脉冲次数（结算面板做对比用） */
  bestPulses: Record<string, number>;
}

// v2：教学关加入后关卡 id 顺延，旧存档不再兼容，因此使用新的键
const STORAGE_KEY = 'resonance-field:progress:v2';

const DEFAULT_PROGRESS: ProgressData = {
  unlocked: 1,
  muted: true,
  cleared: [],
  bestTimes: {},
  bestStars: {},
  bestPulses: {}
};

/** 每次返回全新的容器，避免默认对象被调用方改写 */
function emptyProgress(): ProgressData {
  return { ...DEFAULT_PROGRESS, cleared: [], bestTimes: {}, bestStars: {}, bestPulses: {} };
}

/** 只保留"键为字符串、值为有限数字"的条目，防止存档被写坏后污染界面 */
function numberRecord(value: unknown): Record<string, number> {
  if (!value || typeof value !== 'object') return {};
  const out: Record<string, number> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw === 'number' && Number.isFinite(raw)) out[key] = raw;
  }
  return out;
}

/**
 * 进度存档读写（localStorage）。
 * 任何读取异常都会回退到默认存档，保证刷新页面后不会出现空白画面。
 */
export class ProgressStorage {
  private data: ProgressData;

  constructor() {
    this.data = this.load();
  }

  private load(): ProgressData {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return emptyProgress();
      const parsed = JSON.parse(raw) as Partial<ProgressData>;
      return {
        unlocked: typeof parsed.unlocked === 'number' ? Math.max(1, parsed.unlocked) : 1,
        muted: typeof parsed.muted === 'boolean' ? parsed.muted : true,
        cleared: Array.isArray(parsed.cleared) ? parsed.cleared.filter((n) => typeof n === 'number') : [],
        bestTimes:
          parsed.bestTimes && typeof parsed.bestTimes === 'object' ? parsed.bestTimes : {},
        bestStars: numberRecord(parsed.bestStars),
        bestPulses: numberRecord(parsed.bestPulses)
      };
    } catch {
      return emptyProgress();
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.data));
    } catch {
      // localStorage 不可用时静默忽略，游戏仍可完整游玩
    }
  }

  get unlocked(): number {
    return this.data.unlocked;
  }

  get muted(): boolean {
    return this.data.muted;
  }

  get cleared(): number[] {
    return this.data.cleared;
  }

  get bestTimes(): Record<string, number> {
    return this.data.bestTimes;
  }

  get bestStars(): Record<string, number> {
    return this.data.bestStars;
  }

  get bestPulses(): Record<string, number> {
    return this.data.bestPulses;
  }

  setMuted(muted: boolean): void {
    this.data.muted = muted;
    this.save();
  }

  /**
   * 标记某关通关，并解锁下一关。
   *
   * 星级与用时各自独立记录"历史最好"：
   * 一次低脉冲但慢的打法，不该把之前的快纪录抹掉，反之亦然。
   */
  markCleared(levelId: number, timeSeconds: number, pulses: number, stars: number): void {
    if (!this.data.cleared.includes(levelId)) {
      this.data.cleared.push(levelId);
    }
    const key = String(levelId);
    const best = this.data.bestTimes[key];
    if (best === undefined || timeSeconds < best) {
      this.data.bestTimes[key] = timeSeconds;
    }
    const prevStars = this.data.bestStars[key] ?? 0;
    if (stars > prevStars) {
      this.data.bestStars[key] = stars;
    }
    // 与"最佳星级"配套：记下达成该星级时的脉冲数（并列时取更少的）
    const prevPulses = this.data.bestPulses[key];
    if (stars >= prevStars && (prevPulses === undefined || pulses < prevPulses)) {
      this.data.bestPulses[key] = pulses;
    }
    if (levelId + 1 > this.data.unlocked) {
      this.data.unlocked = levelId + 1;
    }
    this.save();
  }

  /** 某关历史最佳星级（未通关返回 0） */
  starsOf(levelId: number): number {
    return this.data.bestStars[String(levelId)] ?? 0;
  }

  /** 某关历史最佳脉冲次数（未记录返回 undefined） */
  bestPulsesOf(levelId: number): number | undefined {
    return this.data.bestPulses[String(levelId)];
  }

  isCleared(levelId: number): boolean {
    return this.data.cleared.includes(levelId);
  }

  reset(): void {
    this.data = emptyProgress();
    this.save();
  }
}
