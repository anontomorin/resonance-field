import { LEVELS, LEVEL_COUNT, LevelDefinition } from './levelData';
import { resolveSonarConfig, SonarConfig } from '../sonar/SonarConfig';
import { ProgressStorage } from '../core/GameState';

/**
 * 关卡管理：主线关卡按索引切换，随机 / 自定义关卡直接装载关卡定义。
 *
 * 主线进度（解锁、最佳用时）只记录在 ProgressStorage；
 * 随机与自定义关卡不写入主线进度，因此不影响"解锁到第几关"。
 */
export class LevelManager {
  private index = 0;
  /** 当前实际装载的关卡 */
  private active: LevelDefinition = LEVELS[0];
  /** 当前是否为主线关卡 */
  private campaign = true;
  private storage: ProgressStorage;

  constructor(storage: ProgressStorage) {
    this.storage = storage;
  }

  get currentIndex(): number {
    return this.index;
  }

  get current(): LevelDefinition {
    return this.active;
  }

  /** 当前关是否来自主线关卡表（决定通关后是否推进解锁与结算） */
  get isCampaign(): boolean {
    return this.campaign;
  }

  get count(): number {
    return LEVEL_COUNT;
  }

  get levelList(): LevelDefinition[] {
    return LEVELS;
  }

  /** 当前关的声波参数（关卡可覆盖默认值） */
  currentSonarConfig(): SonarConfig {
    return resolveSonarConfig(this.active.sonar);
  }

  /** 装载主线关卡 */
  selectCampaign(index: number): boolean {
    if (index < 0 || index >= LEVEL_COUNT) return false;
    this.index = index;
    this.active = LEVELS[index];
    this.campaign = true;
    return true;
  }

  /** 装载随机 / 自定义关卡 */
  selectExternal(level: LevelDefinition): void {
    this.active = level;
    this.campaign = false;
  }

  /** 进入下一关（只用于主线），返回是否还有下一关 */
  next(): boolean {
    if (!this.campaign) return false;
    if (this.index + 1 >= LEVEL_COUNT) return false;
    this.index += 1;
    this.active = LEVELS[this.index];
    return true;
  }

  isUnlocked(index: number): boolean {
    return index + 1 <= this.storage.unlocked;
  }

  isCleared(levelId: number): boolean {
    return this.storage.isCleared(levelId);
  }

  /** 某关的最佳用时（秒），未通关返回 undefined */
  bestTimeOf(levelId: number): number | undefined {
    return this.storage.bestTimes[String(levelId)];
  }

  /** 某关的历史最佳星级（0 表示还没通关过） */
  starsOf(levelId: number): number {
    return this.storage.starsOf(levelId);
  }

  /** 某关达成最佳星级时的脉冲次数 */
  bestPulsesOf(levelId: number): number | undefined {
    return this.storage.bestPulsesOf(levelId);
  }

  /** 主线全部关卡的历史最佳星级（最终结算汇总用） */
  campaignStars(): number[] {
    return LEVELS.map((level) => this.storage.starsOf(level.id));
  }

  markCleared(levelId: number, seconds: number, pulses: number, stars: number): void {
    this.storage.markCleared(levelId, seconds, pulses, stars);
  }

  /** "已是最后一关"：主线看索引，随机 / 自定义关卡一律视为单关 */
  isLast(): boolean {
    return this.campaign ? this.index === LEVEL_COUNT - 1 : true;
  }
}
