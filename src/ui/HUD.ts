/** 游戏内 HUD：只负责展示状态，不修改任何游戏数据 */

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export interface HudCallbacks {
  onPause: () => void;
  onRestart: () => void;
  onToggleSound: () => void;
}

export class HUD {
  private root: HTMLElement;
  private levelName: HTMLElement;
  private levelSub: HTMLElement;
  private nodes: HTMLElement;
  private health: HTMLElement;
  private time: HTMLElement;
  private pulses: HTMLElement;
  private cooldownFill: HTMLElement;
  private toast: HTMLElement;
  private tip: HTMLElement;
  private soundButton: HTMLButtonElement;
  private toastTimer = 0;
  /** 上一次渲染的生命值，避免每帧重复重建心形 DOM */
  private lastHealth = -1;
  private lastMaxHealth = -1;

  constructor(callbacks: HudCallbacks) {
    this.root = this.require('hud');
    this.levelName = this.require('hud-level-name');
    this.levelSub = this.require('hud-level-sub');
    this.nodes = this.require('hud-nodes');
    this.health = this.require('hud-health');
    this.time = this.require('hud-time');
    this.pulses = this.require('hud-pulses');
    this.cooldownFill = this.require('cooldown-fill');
    this.toast = this.require('hud-toast');
    this.tip = this.require('hud-tip');
    this.soundButton = this.require('btn-sound') as HTMLButtonElement;

    this.require('btn-pause').addEventListener('click', callbacks.onPause);
    this.require('btn-restart').addEventListener('click', callbacks.onRestart);
    this.soundButton.addEventListener('click', callbacks.onToggleSound);
  }

  private require(id: string): HTMLElement {
    const el = document.getElementById(id);
    if (!el) throw new Error(`缺少界面元素 #${id}`);
    return el;
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  setLevel(title: string, subtitle: string): void {
    this.levelName.textContent = title;
    this.levelSub.textContent = subtitle;
  }

  setSoundLabel(muted: boolean): void {
    this.soundButton.textContent = `声音：${muted ? '关' : '开'}`;
  }

  /**
   * 渲染生命值。
   * 用实心 / 空心方块表示，已失去的格子变暗，挨打时整块闪一下红。
   */
  private renderHealth(health: number, maxHealth: number, invulnerable: boolean): void {
    if (health !== this.lastHealth || maxHealth !== this.lastMaxHealth) {
      this.lastHealth = health;
      this.lastMaxHealth = maxHealth;
      let html = '';
      for (let i = 0; i < maxHealth; i += 1) {
        html += `<i class="heart${i < health ? '' : ' lost'}"></i>`;
      }
      this.health.innerHTML = html;
    }
    this.health.classList.toggle('hurt', invulnerable);
  }

  update(sessionLike: {
    activatedCount: number;
    requiredCount: number;
    elapsed: number;
    pulsesUsed: number;
    cooldownRatio: number;
    health: number;
    maxHealth: number;
    invulnerableTimer: number;
  }): void {
    this.nodes.textContent = `${sessionLike.activatedCount} / ${sessionLike.requiredCount}`;
    this.renderHealth(sessionLike.health, sessionLike.maxHealth, sessionLike.invulnerableTimer > 0);
    this.time.textContent = formatTime(sessionLike.elapsed);
    this.pulses.textContent = String(sessionLike.pulsesUsed);
    this.cooldownFill.style.width = `${Math.round(sessionLike.cooldownRatio * 100)}%`;
    // 未充满时压暗进度条，让"还不能发射"这件事不需要试错就能看出来
    this.cooldownFill.classList.toggle('charging', sessionLike.cooldownRatio < 0.999);
  }

  /** 教学关的分步提示条；传 null 隐藏 */
  setTip(text: string | null): void {
    if (text === null) {
      this.tip.classList.add('hidden');
      this.tip.textContent = '';
      return;
    }
    this.tip.textContent = text;
    this.tip.classList.remove('hidden');
  }

  showToast(message: string): void {
    this.toast.textContent = message;
    this.toast.classList.add('show');
    window.clearTimeout(this.toastTimer);
    this.toastTimer = window.setTimeout(() => {
      this.toast.classList.remove('show');
    }, 2200);
  }
}
