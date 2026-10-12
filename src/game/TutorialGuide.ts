/**
 * 教学引导：按顺序推进的分步提示。
 *
 * 每个步骤绑定一个游戏事件，只有玩家真正做出对应操作后才推进到下一条，
 * 因此不会一次性刷出一堆文字，也不会提前剧透。
 */

export type TutorialTrigger =
  | 'start'
  | 'move'
  | 'pulse'
  | 'node'
  | 'exitOpen'
  | 'hurt'
  | 'jam'
  | 'complete';

export interface TutorialStep {
  /** 触发该条提示的游戏事件 */
  trigger: TutorialTrigger;
  /** 提示文案 */
  text: string;
}

export class TutorialGuide {
  private steps: TutorialStep[];
  private index = 0;

  constructor(steps: TutorialStep[]) {
    this.steps = steps;
  }

  get finished(): boolean {
    return this.index >= this.steps.length;
  }

  /** 当前正在等待的提示（尚未触发时不返回内容） */
  get current(): TutorialStep | null {
    return this.finished ? null : this.steps[this.index];
  }

  /**
   * 通知一个游戏事件发生。
   * 若该事件正是下一条提示的触发条件，返回提示文案并推进；否则返回 null。
   */
  notify(trigger: TutorialTrigger): string | null {
    if (this.finished) return null;
    const step = this.steps[this.index];
    if (step.trigger !== trigger) return null;
    this.index += 1;
    return step.text;
  }

  /** 关卡开始时取出第一条（trigger 为 start 的步骤） */
  start(): string | null {
    return this.notify('start');
  }

  reset(): void {
    this.index = 0;
  }
}
