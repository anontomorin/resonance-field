/** 分享码弹窗：展示码并提供一键复制 */

import { copyText } from './clipboard';

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少界面元素 #${id}`);
  return el;
}

export class ShareDialog {
  private root: HTMLElement;
  private titleEl: HTMLElement;
  private descEl: HTMLElement;
  private codeEl: HTMLTextAreaElement;
  private msgEl: HTMLElement;
  private msgTimer = 0;

  constructor() {
    this.root = requireEl('overlay-share');
    this.titleEl = requireEl('share-title');
    this.descEl = requireEl('share-desc');
    this.codeEl = requireEl('share-code') as HTMLTextAreaElement;
    this.msgEl = requireEl('share-msg');

    requireEl('btn-share-close').addEventListener('click', () => this.hide());
    requireEl('btn-share-copy').addEventListener('click', () => {
      void this.copy();
    });
  }

  get visible(): boolean {
    return !this.root.classList.contains('hidden');
  }

  show(title: string, desc: string, code: string): void {
    this.titleEl.textContent = title;
    this.descEl.textContent = desc;
    this.codeEl.value = code;
    this.setMessage('');
    this.root.classList.remove('hidden');
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  private async copy(): Promise<void> {
    const ok = await copyText(this.codeEl.value);
    if (ok) {
      this.setMessage('已复制到剪贴板。', 'ok');
      return;
    }
    // 复制失败时把内容选中，方便手动 Ctrl+C
    this.codeEl.focus();
    this.codeEl.select();
    this.setMessage('自动复制失败，已选中内容，请按 Ctrl / Cmd + C 手动复制。', 'error');
  }

  private setMessage(text: string, kind: 'ok' | 'error' | 'plain' = 'plain'): void {
    this.msgEl.textContent = text;
    this.msgEl.className = `field-msg${kind === 'plain' ? '' : ` ${kind}`}`;
    window.clearTimeout(this.msgTimer);
    if (text) {
      this.msgTimer = window.setTimeout(() => this.setMessage(''), 3200);
    }
  }
}
