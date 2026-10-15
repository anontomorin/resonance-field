/**
 * 关卡中心：三个分区（主线 / 随机 / 我的关卡）。
 *
 * 界面只负责展示与收集输入，真正的"生成随机关卡 / 解析分享码 / 保存关卡"
 * 都由 GameApp 完成，这里通过回调交出去。
 */

import { LevelManager } from '../levels/LevelManager';
import { CustomLevelStore, CustomLevelRecord } from '../core/CustomLevelStore';
import {
  RANDOM_PRESETS,
  RandomLevelParams,
  clampParams,
  presetParams,
  randomSeed
} from '../gen/randomParams';
import { copyText } from './clipboard';
import { renderStars } from './stars';
import { encodeRandomCode } from '../levels/shareCode';
import { campaignKnowledgeCard } from '../content/oceanKnowledge';

export type TabKey = 'campaign' | 'random' | 'custom';

export interface LevelCenterCallbacks {
  onBack: () => void;
  onPickCampaign: (index: number) => void;
  onResetProgress: () => void;
  onRandomPlay: (params: RandomLevelParams) => void;
  onCustomNew: () => void;
  onCustomPlay: (id: string) => void;
  onCustomEdit: (id: string) => void;
  onCustomShare: (id: string) => void;
  onCustomDelete: (id: string) => void;
  /**
   * 导入分享码。
   * @param play 为真表示"导入并游玩"（随机页），为假表示只入库（我的关卡页）
   */
  onImportCode: (code: string, play: boolean) => { ok: boolean; message: string };
}

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少界面元素 #${id}`);
  return el;
}

function formatTime(seconds: number): string {
  const total = Math.floor(seconds);
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** 把玩家输入的种子文本转成数值：纯数字直接取，其它文本用哈希，方便口头传播 */
function parseSeed(text: string): number {
  const trimmed = text.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const n = Number(trimmed);
    return Number.isFinite(n) ? (Math.abs(Math.floor(n)) % 0x7ffffffe) + 1 : randomSeed();
  }
  if (trimmed.length === 0) return randomSeed();
  let hash = 0x811c9dc5;
  for (let i = 0; i < trimmed.length; i += 1) {
    hash ^= trimmed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return (hash % 0x7ffffffe) + 1;
}

export class LevelCenter {
  private root: HTMLElement;
  private manager: LevelManager;
  private store: CustomLevelStore;
  private callbacks: LevelCenterCallbacks;

  private tab: TabKey = 'campaign';
  private presetId = 'normal';
  private seedInput: HTMLInputElement;
  private randomCodeInput: HTMLInputElement;
  private customCodeInput: HTMLInputElement;
  private randomMsg: HTMLElement;
  private customMsg: HTMLElement;
  private levelGrid: HTMLElement;
  private presetRow: HTMLElement;
  private customList: HTMLElement;
  private customEmpty: HTMLElement;
  private levelsSub: HTMLElement;

  constructor(
    manager: LevelManager,
    store: CustomLevelStore,
    callbacks: LevelCenterCallbacks
  ) {
    this.manager = manager;
    this.store = store;
    this.callbacks = callbacks;

    this.root = requireEl('overlay-levels');
    this.levelGrid = requireEl('level-grid');
    this.presetRow = requireEl('random-presets');
    this.seedInput = requireEl('random-seed') as HTMLInputElement;
    this.randomCodeInput = requireEl('random-code') as HTMLInputElement;
    this.customCodeInput = requireEl('custom-code') as HTMLInputElement;
    this.randomMsg = requireEl('random-import-msg');
    this.customMsg = requireEl('custom-import-msg');
    this.customList = requireEl('custom-list');
    this.customEmpty = requireEl('custom-empty');
    this.levelsSub = requireEl('levels-sub');

    requireEl('btn-levels-back').addEventListener('click', callbacks.onBack);
    requireEl('btn-reset-progress').addEventListener('click', callbacks.onResetProgress);

    // 分区切换
    this.root.querySelectorAll<HTMLButtonElement>('#level-tabs .tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        this.show((tab.dataset.tab as TabKey) ?? 'campaign');
      });
    });

    // 随机页
    requireEl('btn-random-dice').addEventListener('click', () => {
      this.seedInput.value = String(randomSeed());
      this.setMessage('random', '');
    });
    requireEl('btn-random-start').addEventListener('click', () => {
      callbacks.onRandomPlay(this.currentRandomParams());
    });
    requireEl('btn-random-copy').addEventListener('click', () => {
      void this.copyRandomCode();
    });
    requireEl('btn-random-import').addEventListener('click', () => {
      const result = callbacks.onImportCode(this.randomCodeInput.value, true);
      this.setMessage('random', result.message, result.ok ? 'ok' : 'error');
      if (result.ok) this.randomCodeInput.value = '';
    });

    // 我的关卡页
    requireEl('btn-editor-new').addEventListener('click', callbacks.onCustomNew);
    requireEl('btn-custom-import').addEventListener('click', () => {
      const result = callbacks.onImportCode(this.customCodeInput.value, false);
      this.setMessage('custom', result.message, result.ok ? 'ok' : 'error');
      if (result.ok) this.customCodeInput.value = '';
      if (!result.ok) this.renderCustom();
    });

    this.buildPresets();
  }

  private buildPresets(): void {
    this.presetRow.innerHTML = '';
    for (const preset of RANDOM_PRESETS) {
      const chip = document.createElement('button');
      chip.type = 'button';
      chip.className = 'chip';
      chip.dataset.preset = preset.id;
      chip.innerHTML = `${preset.label}<small>${preset.desc}</small>`;
      chip.addEventListener('click', () => {
        this.presetId = preset.id;
        this.syncPresets();
      });
      this.presetRow.appendChild(chip);
    }
    this.syncPresets();
  }

  private syncPresets(): void {
    this.presetRow.querySelectorAll<HTMLButtonElement>('.chip').forEach((chip) => {
      chip.classList.toggle('active', chip.dataset.preset === this.presetId);
    });
  }

  private currentRandomParams(): RandomLevelParams {
    const text = this.seedInput.value.trim();
    if (text.length === 0) {
      // 没填种子就随机一个并回填，方便玩家之后复现同一张图
      this.seedInput.value = String(randomSeed());
    }
    return clampParams({ ...presetParams(this.presetId), seed: parseSeed(this.seedInput.value) });
  }

  private async copyRandomCode(): Promise<void> {
    const code = encodeRandomCode(this.currentRandomParams());
    const ok = await copyText(code);
    this.setMessage(
      'random',
      ok ? `种子码已复制：${code}` : `复制失败，请手动复制：${code}`,
      ok ? 'ok' : 'error'
    );
  }

  /** 外部提示：'random' 随机页，'custom' 我的关卡页 */
  setMessage(
    where: 'random' | 'custom',
    text: string,
    kind: 'ok' | 'error' | 'plain' = 'plain'
  ): void {
    const el = where === 'random' ? this.randomMsg : this.customMsg;
    el.textContent = text;
    el.className = `field-msg${kind === 'plain' ? '' : ` ${kind}`}`;
  }

  /**
   * 供外部在数据变化后刷新"我的关卡"列表。
   *
   * show() 只在切页签时渲染，而编辑器保存后并不一定会重新 show()，
   * 于是列表会停在旧内容上——明明已存进 localStorage，玩家看到的却是空列表。
   * 这里提供一个不切页签、只重画列表的入口。
   */
  refreshCustom(): void {
    this.renderCustom();
  }

  show(tab: TabKey = this.tab): void {
    this.tab = tab;
    this.root.classList.remove('hidden');
    this.root.querySelectorAll<HTMLButtonElement>('#level-tabs .tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tab);
    });
    for (const key of ['campaign', 'random', 'custom'] as TabKey[]) {
      requireEl(`tab-${key}`).classList.toggle('hidden', key !== tab);
    }
    this.levelsSub.textContent =
      tab === 'campaign'
        ? '按顺序解锁，声波半径固定 8 格'
        : tab === 'random'
          ? '用种子生成新的迷宫，同一种子必定同一张图'
          : '自己画的关卡与朋友分享来的关卡都在这里';

    if (tab === 'campaign') this.renderCampaign();
    if (tab === 'custom') this.renderCustom();
    if (tab === 'random' && this.seedInput.value.trim().length === 0) {
      this.seedInput.value = String(randomSeed());
    }
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  private renderCampaign(): void {
    this.levelGrid.innerHTML = '';
    this.manager.levelList.forEach((level, index) => {
      const unlocked = this.manager.isUnlocked(index);
      const cleared = this.manager.isCleared(level.id);

      const card = document.createElement('button');
      card.type = 'button';
      card.className = 'level-card';
      card.disabled = !unlocked;

      const idx = document.createElement('div');
      idx.className = 'lc-index';
      idx.textContent = `LEVEL ${level.id}`;

      const title = document.createElement('div');
      title.className = 'lc-title';
      title.textContent = unlocked ? level.title : '未解锁';

      const sub = document.createElement('div');
      sub.className = 'lc-sub';
      sub.textContent = unlocked ? level.subtitle : '完成上一关后开放';

      card.appendChild(idx);
      card.appendChild(title);
      card.appendChild(sub);

      // 档案角标：这一关对应首页档案条里的哪一份公开资料，来源在进关前就摆出来
      const knowledge = campaignKnowledgeCard(level.id);
      if (knowledge) {
        const archive = document.createElement('div');
        archive.className = 'lc-archive';
        const code = document.createElement('span');
        code.className = 'lc-archive-code';
        code.textContent = `ARCHIVE 0${level.id}`;
        const org = document.createElement('span');
        org.className = 'lc-archive-org';
        org.textContent = unlocked ? knowledge.sourceName : '—';
        archive.appendChild(code);
        archive.appendChild(org);
        card.appendChild(archive);
      }

      if (cleared) {
        const best = this.manager.bestTimeOf(level.id);
        const stars = this.manager.starsOf(level.id);
        const clear = document.createElement('div');
        clear.className = 'lc-clear';
        // 星级单独占一行、用 ★ 字形而不是 emoji：既好识别，也不会被字体降级成方框
        clear.innerHTML = `<span class="lc-stars" aria-label="${stars} 星">${renderStars(stars)}</span>`;
        if (best !== undefined) {
          const time = document.createElement('span');
          time.className = 'lc-best';
          time.textContent = `最佳 ${formatTime(best)}`;
          clear.appendChild(time);
        }
        // 通关过的关卡带上「已归档」状态标记：和首页档案条同一口径
        const archived = document.createElement('span');
        archived.className = 'lc-archived';
        archived.textContent = '已归档';
        clear.appendChild(archived);
        card.appendChild(clear);
      } else if (!unlocked) {
        const lock = document.createElement('div');
        lock.className = 'lc-lock';
        // 用 ▲ 形状字而不是 🔒 emoji：emoji 在各系统字体下渲染差异极大，
        // 在等宽/无 emoji 字体里还会退化成方框。
        lock.innerHTML = '<i class="lc-lock-icon">▲</i>锁定中';
        card.appendChild(lock);
      }

      card.addEventListener('click', () => {
        if (!unlocked) return;
        this.callbacks.onPickCampaign(index);
      });

      this.levelGrid.appendChild(card);
    });
  }

  private renderCustom(): void {
    const records = this.store.list();
    this.customList.innerHTML = '';
    this.customEmpty.classList.toggle('hidden', records.length > 0);

    for (const record of records) {
      this.customList.appendChild(this.buildCustomItem(record));
    }
  }

  private buildCustomItem(record: CustomLevelRecord): HTMLElement {
    const item = document.createElement('div');
    item.className = 'custom-item';

    const main = document.createElement('div');
    main.className = 'custom-main';
    const title = document.createElement('div');
    title.className = 'custom-title';
    title.textContent = record.title;
    const meta = document.createElement('div');
    meta.className = 'custom-meta';
    const width = record.map[0]?.length ?? 0;
    const nodeCount = record.map.join('').split('R').length - 1;
    const best =
      record.bestTime !== undefined ? ` · 最佳 ${formatTime(record.bestTime)}` : '';
    meta.textContent = `${width} × ${record.map.length} · ${nodeCount} 节点${
      record.cleared ? `${best}` : ''
    }${record.origin === 'shared' ? ' · 来自分享码' : ''}`;

    // 通关过的自定义关卡也带上星级：和主线用同一套标准，方便横向比较难度
    if (record.cleared && (record.bestStars ?? 0) > 0) {
      const stars = document.createElement('div');
      stars.className = 'custom-stars';
      stars.innerHTML = renderStars(record.bestStars ?? 0);
      stars.setAttribute('aria-label', `${record.bestStars} 星`);
      main.appendChild(stars);
    }

    main.appendChild(title);
    main.appendChild(meta);

    const actions = document.createElement('div');
    actions.className = 'custom-actions';
    actions.appendChild(this.miniButton('试玩', () => this.callbacks.onCustomPlay(record.id)));
    actions.appendChild(this.miniButton('编辑', () => this.callbacks.onCustomEdit(record.id)));
    actions.appendChild(this.miniButton('分享码', () => this.callbacks.onCustomShare(record.id)));
    actions.appendChild(
      this.miniButton('删除', () => this.confirmDelete(record, item), true)
    );

    item.appendChild(main);
    item.appendChild(actions);
    return item;
  }

  private miniButton(label: string, onClick: () => void, danger = false): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = `mini-btn${danger ? ' danger' : ''}`;
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  /** 删除需要二次确认：第一次点击变成"确认删除"，3 秒后自动还原 */
  private confirmDelete(record: CustomLevelRecord, item: HTMLElement): void {
    const btn = item.querySelector<HTMLButtonElement>('.mini-btn.danger');
    if (!btn) return;
    if (btn.dataset.armed === '1') {
      this.callbacks.onCustomDelete(record.id);
      this.renderCustom();
      return;
    }
    btn.dataset.armed = '1';
    btn.textContent = '确认删除';
    window.setTimeout(() => {
      btn.dataset.armed = '0';
      btn.textContent = '删除';
    }, 3000);
  }
}
