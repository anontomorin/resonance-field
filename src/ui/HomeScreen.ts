/** 首页：三个模式入口 + 操作说明 + 声音开关 */

export interface HomeCallbacks {
  onCampaign: () => void;
  onRandom: () => void;
  onCustom: () => void;
  onToggleSound: () => void;
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少界面元素 #${id}`);
  return el;
}

export class HomeScreen {
  private root: HTMLElement;
  private helpBox: HTMLElement;
  private soundButton: HTMLButtonElement;
  private campaignMeta: HTMLElement;
  private customMeta: HTMLElement;

  constructor(callbacks: HomeCallbacks) {
    this.root = requireEl('overlay-title');
    this.helpBox = requireEl('help-box');
    this.soundButton = requireEl('btn-sound-title') as HTMLButtonElement;
    this.campaignMeta = requireEl('mode-campaign-meta');
    this.customMeta = requireEl('mode-custom-meta');

    requireEl('mode-campaign').addEventListener('click', callbacks.onCampaign);
    requireEl('mode-random').addEventListener('click', callbacks.onRandom);
    requireEl('mode-custom').addEventListener('click', callbacks.onCustom);
    this.soundButton.addEventListener('click', callbacks.onToggleSound);
    requireEl('btn-help').addEventListener('click', () => {
      this.helpBox.classList.toggle('hidden');
    });
  }

  show(): void {
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  setSoundLabel(muted: boolean): void {
    this.soundButton.textContent = `声音：${muted ? '关' : '开'}`;
  }

  /** 主线进度与自定义关卡数量 */
  setStats(clearedCount: number, total: number, customCount: number): void {
    this.campaignMeta.textContent = `已通关 ${clearedCount} / ${total}`;
    this.customMeta.textContent = `${customCount} 张`;
  }
}
