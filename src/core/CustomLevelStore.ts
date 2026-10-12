/**
 * 自定义关卡的本地仓库（localStorage）。
 *
 * 只负责"存、取、删、记录成绩"，不做任何合法性判断——
 * 合法性由 src/levels/mapAnalysis.ts 统一裁决。
 */

import { normalizeTitle } from '../levels/mapAnalysis';

export interface CustomLevelRecord {
  id: string;
  title: string;
  map: string[];
  createdAt: number;
  updatedAt: number;
  /** 是否通关过 */
  cleared: boolean;
  /** 最佳用时（秒），在"最佳星级"并列时取更快的 */
  bestTime?: number;
  /** 最佳脉冲次数 */
  bestPulses?: number;
  /** 历史最佳星级（0~3），未通关为 0 */
  bestStars?: number;
  /** 来源：editor 自己画的 / shared 由分享码导入 */
  origin: 'editor' | 'shared';
}

const STORAGE_KEY = 'resonance-field:custom:v1';

function newId(): string {
  return `L${Date.now().toString(36)}${Math.floor(Math.random() * 1296).toString(36)}`;
}

function isRecord(value: unknown): value is CustomLevelRecord {
  if (!value || typeof value !== 'object') return false;
  const r = value as Partial<CustomLevelRecord>;
  return (
    typeof r.id === 'string' &&
    typeof r.title === 'string' &&
    Array.isArray(r.map) &&
    r.map.every((row) => typeof row === 'string')
  );
}

export class CustomLevelStore {
  private records: CustomLevelRecord[];

  constructor() {
    this.records = this.load();
  }

  private load(): CustomLevelRecord[] {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return [];
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(isRecord)
        .map((r) => ({
          ...r,
          title: normalizeTitle(r.title),
          createdAt: typeof r.createdAt === 'number' ? r.createdAt : Date.now(),
          updatedAt: typeof r.updatedAt === 'number' ? r.updatedAt : Date.now(),
          cleared: r.cleared === true,
          bestStars: typeof r.bestStars === 'number' ? r.bestStars : 0,
          origin: r.origin === 'shared' ? ('shared' as const) : ('editor' as const)
        }));
    } catch {
      return [];
    }
  }

  private save(): void {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(this.records));
    } catch {
      // 存储不可用时静默忽略：自定义关卡只在本次会话内有效
    }
  }

  /** 按修改时间倒序返回 */
  list(): CustomLevelRecord[] {
    return this.records.slice().sort((a, b) => b.updatedAt - a.updatedAt);
  }

  get(id: string): CustomLevelRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  /** 新建或更新一条记录 */
  upsert(input: {
    id?: string;
    title: string;
    map: string[];
    origin?: 'editor' | 'shared';
  }): CustomLevelRecord {
    const now = Date.now();
    const existing = input.id ? this.get(input.id) : undefined;
    if (existing) {
      existing.title = normalizeTitle(input.title);
      existing.map = input.map.slice();
      existing.updatedAt = now;
      this.save();
      return existing;
    }
    const record: CustomLevelRecord = {
      id: input.id ?? newId(),
      title: normalizeTitle(input.title),
      map: input.map.slice(),
      createdAt: now,
      updatedAt: now,
      cleared: false,
      origin: input.origin ?? 'editor'
    };
    this.records.push(record);
    this.save();
    return record;
  }

  remove(id: string): void {
    this.records = this.records.filter((r) => r.id !== id);
    this.save();
  }

  /**
   * 记录一次通关成绩。
   *
   * 只保留"更好"的那次：星级更高就整组替换，星级并列时保留更快的用时。
   * 这样"用更少脉冲换更低用时"的取舍不会互相覆盖。
   */
  markCleared(id: string, seconds: number, pulses: number, stars: number): void {
    const record = this.get(id);
    if (!record) return;
    const prevStars = record.bestStars ?? 0;
    const better = !record.cleared || stars > prevStars;
    const sameTier =
      record.cleared && stars === prevStars && (record.bestTime === undefined || seconds < record.bestTime);

    record.cleared = true;
    if (better || sameTier) {
      record.bestStars = stars;
      record.bestPulses = pulses;
      if (better || record.bestTime === undefined || seconds < record.bestTime) {
        record.bestTime = seconds;
      }
    }
    this.save();
  }

  clearAll(): void {
    this.records = [];
    this.save();
  }
}
