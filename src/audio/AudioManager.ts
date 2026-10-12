/**
 * 程序生成的音效（Web Audio API）。
 *
 * 全部音效由振荡器实时合成，不依赖任何远程音频文件。
 * 默认静音；浏览器未授权播放时游戏仍可完整运行（所有调用都会静默失败）。
 */
export class AudioManager {
  private ctx: AudioContext | null = null;
  private muted = true;

  constructor(muted: boolean) {
    this.muted = muted;
  }

  get isMuted(): boolean {
    return this.muted;
  }

  setMuted(muted: boolean): void {
    this.muted = muted;
    if (!muted) this.ensureContext();
  }

  /** 在用户手势中调用，解锁音频上下文 */
  private ensureContext(): AudioContext | null {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return this.ctx;
    }
    try {
      const Ctor: typeof AudioContext | undefined =
        window.AudioContext ??
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return null;
      this.ctx = new Ctor();
      return this.ctx;
    } catch {
      return null;
    }
  }

  /** 合成一个短音 */
  private tone(
    startFreq: number,
    endFreq: number,
    duration: number,
    type: OscillatorType,
    gainValue: number,
    delay = 0
  ): void {
    if (this.muted) return;
    const ctx = this.ensureContext();
    if (!ctx) return;
    try {
      const startTime = ctx.currentTime + delay;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(startFreq, startTime);
      if (endFreq !== startFreq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, endFreq), startTime + duration);
      }
      gain.gain.setValueAtTime(0.0001, startTime);
      gain.gain.exponentialRampToValueAtTime(gainValue, startTime + Math.min(0.02, duration * 0.2));
      gain.gain.exponentialRampToValueAtTime(0.0001, startTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(startTime);
      osc.stop(startTime + duration + 0.02);
    } catch {
      // 音频不可用时忽略
    }
  }

  /** 发射声波：下滑的短促脉冲音 */
  playPulse(): void {
    this.tone(760, 240, 0.32, 'sine', 0.14);
    this.tone(1200, 400, 0.18, 'triangle', 0.05);
  }

  /** 节点激活：上行的双音 */
  playNode(): void {
    this.tone(520, 780, 0.16, 'sine', 0.12);
    this.tone(780, 1040, 0.22, 'sine', 0.1, 0.12);
  }

  /** 出口开启：明亮的三音 */
  playExitOpen(): void {
    this.tone(660, 660, 0.14, 'triangle', 0.1);
    this.tone(880, 880, 0.14, 'triangle', 0.1, 0.12);
    this.tone(1320, 1320, 0.3, 'sine', 0.09, 0.24);
  }

  /** 通关：上行琶音 */
  playWin(): void {
    const notes = [523, 659, 784, 1046];
    notes.forEach((freq, i) => {
      this.tone(freq, freq, 0.26, 'sine', 0.1, i * 0.13);
    });
  }

  /** 撞墙：低沉闷响 */
  playBump(): void {
    this.tone(180, 90, 0.1, 'square', 0.05);
  }

  /** 踩中尖刺受伤：刺耳的下坠锯齿音 */
  playHurt(): void {
    this.tone(320, 70, 0.28, 'sawtooth', 0.13);
    this.tone(140, 60, 0.22, 'square', 0.06);
  }

  /** 踩中回声干扰器：记忆被抹掉的"倒吸"感，用上行再落回的音型 */
  playJammed(): void {
    this.tone(900, 300, 0.34, 'sine', 0.09);
    this.tone(300, 820, 0.26, 'triangle', 0.06, 0.1);
  }

  /** 生命耗尽：三声下行，明确宣告本局失败 */
  playExhausted(): void {
    this.tone(420, 400, 0.3, 'sine', 0.11);
    this.tone(330, 310, 0.3, 'sine', 0.11, 0.22);
    this.tone(220, 130, 0.5, 'sine', 0.1, 0.44);
  }
}
