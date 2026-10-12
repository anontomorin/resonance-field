/**
 * 关卡编辑器。
 *
 * 用 DOM 网格（而不是 canvas）承载绘制：命中测试简单、移动端也能直接拖着画。
 * 网格只维护一份 TileCode 数组，所有按钮都围绕它操作，
 * 校验统一交给 src/levels/mapAnalysis.ts，保证"编辑器说能玩"就一定能在游戏里跑通。
 */

import { TileCode } from '../world/TileType';
import { analyzeRows, MAP_LIMITS, MapReport } from '../levels/mapAnalysis';
import { LevelDefinition } from '../levels/levelData';
import { encodeMapCode, encodeMapShareText } from '../levels/shareCode';
import { CustomLevelRecord } from '../core/CustomLevelStore';
import { buildRandomMap } from '../gen/LevelGenerator';
import { randomSeed } from '../gen/randomParams';
import { ShareDialog } from '../ui/ShareDialog';

/** 编辑器的保存请求（id 为空表示新建） */
export interface EditorSaveRequest {
  id: string;
  title: string;
  map: string[];
}

export interface EditorCallbacks {
  onBack: () => void;
  /** 试玩：把当前编辑内容作为一局游戏打开 */
  onTest: (level: LevelDefinition) => void;
  /** 保存：由 GameApp 写入本地仓库 */
  onSaved: (request: EditorSaveRequest) => void;
}

interface PaletteItem {
  code: TileCode;
  label: string;
  className: string;
}

const PALETTE: PaletteItem[] = [
  { code: '#', label: '墙', className: 'wall' },
  { code: '.', label: '地面', className: 'floor' },
  { code: 'S', label: '出生点', className: 'start' },
  { code: 'R', label: '共振节点', className: 'node' },
  { code: 'E', label: '出口', className: 'exit' },
  { code: '^', label: '尖刺', className: 'spike' },
  { code: '*', label: '干扰器', className: 'jammer' }
];

const GRID_GAP = 2;

function requireEl(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少界面元素 #${id}`);
  return el;
}

export class EditorScreen {
  private root: HTMLElement;
  private gridWrap: HTMLElement;
  private grid: HTMLElement;
  private palette: HTMLElement;
  private issueList: HTMLElement;
  private statsEl: HTMLElement;
  private headEl: HTMLElement;
  private titleInput: HTMLInputElement;
  private widthInput: HTMLInputElement;
  private heightInput: HTMLInputElement;

  private width = 21;
  private height = 15;
  private cells: TileCode[] = [];
  private cellEls: HTMLElement[] = [];
  private tool: TileCode = '#';
  private painting = false;
  private editingId: string | null = null;
  private report: MapReport | null = null;

  constructor(
    private callbacks: EditorCallbacks,
    private shareDialog: ShareDialog
  ) {
    this.root = requireEl('overlay-editor');
    this.gridWrap = requireEl('editor-grid-wrap');
    this.grid = requireEl('editor-grid');
    this.palette = requireEl('editor-palette');
    this.issueList = requireEl('editor-issues');
    this.statsEl = requireEl('editor-stats');
    this.headEl = requireEl('editor-head');
    this.titleInput = requireEl('editor-title') as HTMLInputElement;
    this.widthInput = requireEl('editor-width') as HTMLInputElement;
    this.heightInput = requireEl('editor-height') as HTMLInputElement;

    this.buildPalette();
    this.bindEvents();
  }

  // ==================== 初始化 ====================

  private buildPalette(): void {
    this.palette.innerHTML = '';
    for (const item of PALETTE) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'palette-item';
      btn.dataset.code = item.code;
      const swatch = document.createElement('span');
      swatch.className = `swatch ${item.className}`;
      const text = document.createElement('span');
      text.textContent = item.label;
      btn.appendChild(swatch);
      btn.appendChild(text);
      btn.addEventListener('click', () => this.setTool(item.code));
      this.palette.appendChild(btn);
    }
    this.setTool('#');
  }

  private bindEvents(): void {
    requireEl('btn-editor-back').addEventListener('click', this.callbacks.onBack);
    requireEl('btn-editor-maze').addEventListener('click', () => this.fillMaze());
    requireEl('btn-editor-clear').addEventListener('click', () => this.clearFloor());
    requireEl('btn-editor-border').addEventListener('click', () => this.fillBorder());
    requireEl('btn-editor-resize').addEventListener('click', () => this.applySize());
    requireEl('btn-editor-test').addEventListener('click', () => this.test());
    requireEl('btn-editor-save').addEventListener('click', () => this.save());
    requireEl('btn-editor-share').addEventListener('click', () => this.share());

    // 绘制：按下开始，拖动持续，抬起结束（触屏拖动同样有效）
    this.grid.addEventListener('pointerdown', (event) => {
      this.painting = true;
      this.grid.setPointerCapture(event.pointerId);
      this.paintAt(event);
      event.preventDefault();
    });
    this.grid.addEventListener('pointermove', (event) => {
      if (!this.painting) return;
      this.paintAt(event);
    });
    const stop = (): void => {
      this.painting = false;
    };
    this.grid.addEventListener('pointerup', stop);
    this.grid.addEventListener('pointercancel', stop);
    window.addEventListener('pointerup', stop);
    this.grid.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  private setTool(code: TileCode): void {
    this.tool = code;
    this.palette.querySelectorAll<HTMLButtonElement>('.palette-item').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.code === code);
    });
  }

  // ==================== 打开 / 关闭 ====================

  /** 新建一张空白地图（带外边框，中间是地面） */
  openNew(): void {
    this.editingId = null;
    this.headEl.textContent = '新建关卡';
    this.titleInput.value = '';
    this.width = 21;
    this.height = 15;
    this.resetBlank();
    this.show();
  }

  /** 编辑已有记录 */
  openRecord(record: CustomLevelRecord): void {
    this.editingId = record.id;
    this.headEl.textContent = '编辑关卡';
    this.titleInput.value = record.title;
    this.height = record.map.length;
    this.width = record.map[0]?.length ?? 21;
    this.cells = [];
    for (const row of record.map) {
      for (const ch of row) this.cells.push((ch as TileCode) ?? '.');
    }
    this.buildGrid();
    this.show();
  }

  show(): void {
    this.root.classList.remove('hidden');
    this.widthInput.value = String(this.width);
    this.heightInput.value = String(this.height);
    this.buildGrid();
    this.refresh();
  }

  hide(): void {
    this.root.classList.add('hidden');
  }

  /** 窗口尺寸变化后重新计算格子边长 */
  layout(): void {
    if (this.root.classList.contains('hidden')) return;
    const maxW = this.gridWrap.clientWidth - 28;
    const maxH = Math.max(180, this.gridWrap.clientHeight - 28);
    const size = Math.max(
      8,
      Math.min(30, Math.floor(Math.min(maxW / this.width, maxH / this.height)))
    );
    this.grid.style.setProperty('--cell', `${size}px`);
  }

  // ==================== 网格操作 ====================

  private resetBlank(): void {
    this.cells = new Array(this.width * this.height).fill('.');
    for (let x = 0; x < this.width; x += 1) {
      this.cells[x] = '#';
      this.cells[(this.height - 1) * this.width + x] = '#';
    }
    for (let y = 0; y < this.height; y += 1) {
      this.cells[y * this.width] = '#';
      this.cells[y * this.width + this.width - 1] = '#';
    }
    this.buildGrid();
  }

  private buildGrid(): void {
    this.grid.style.gridTemplateColumns = `repeat(${this.width}, var(--cell))`;
    this.grid.style.gridTemplateRows = `repeat(${this.height}, var(--cell))`;
    this.grid.innerHTML = '';
    this.cellEls = [];
    for (let i = 0; i < this.width * this.height; i += 1) {
      const cell = document.createElement('div');
      cell.className = 'editor-cell';
      this.grid.appendChild(cell);
      this.cellEls.push(cell);
    }
    this.layout();
    this.syncCells();
  }

  private syncCells(): void {
    for (let i = 0; i < this.cellEls.length; i += 1) {
      const code = this.cells[i];
      const el = this.cellEls[i];
      el.className = `editor-cell ${classOf(code)}`;
    }
  }

  private cellIndexFromEvent(event: PointerEvent): number | null {
    const rect = this.grid.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return null;
    const pitchX = (rect.width + GRID_GAP) / this.width;
    const pitchY = (rect.height + GRID_GAP) / this.height;
    const x = Math.floor((event.clientX - rect.left) / pitchX);
    const y = Math.floor((event.clientY - rect.top) / pitchY);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return null;
    return y * this.width + x;
  }

  private paintAt(event: PointerEvent): void {
    const index = this.cellIndexFromEvent(event);
    if (index === null) return;
    if (this.cells[index] === this.tool) return;

    // 出生点与出口唯一：放置时把原来的那个抹成地面
    if (this.tool === 'S' || this.tool === 'E') {
      for (let i = 0; i < this.cells.length; i += 1) {
        if (this.cells[i] === this.tool) this.cells[i] = '.';
      }
    }
    this.cells[index] = this.tool;
    this.syncCells();
    this.refresh();
  }

  private applySize(): void {
    const width = clampInt(this.widthInput.value, MAP_LIMITS.minWidth, MAP_LIMITS.maxWidth, this.width);
    const height = clampInt(
      this.heightInput.value,
      MAP_LIMITS.minHeight,
      MAP_LIMITS.maxHeight,
      this.height
    );
    this.widthInput.value = String(width);
    this.heightInput.value = String(height);
    if (width === this.width && height === this.height) return;
    this.resizeGrid(width, height);
  }

  private resizeGrid(width: number, height: number): void {
    const next: TileCode[] = new Array(width * height).fill('#');
    for (let y = 0; y < Math.min(height, this.height); y += 1) {
      for (let x = 0; x < Math.min(width, this.width); x += 1) {
        next[y * width + x] = this.cells[y * this.width + x];
      }
    }
    this.width = width;
    this.height = height;
    this.cells = next;
    this.buildGrid();
    this.refresh();
  }

  private fillBorder(): void {
    for (let x = 0; x < this.width; x += 1) {
      this.cells[x] = '#';
      this.cells[(this.height - 1) * this.width + x] = '#';
    }
    for (let y = 0; y < this.height; y += 1) {
      this.cells[y * this.width] = '#';
      this.cells[y * this.width + this.width - 1] = '#';
    }
    this.syncCells();
    this.refresh();
  }

  private clearFloor(): void {
    this.cells = new Array(this.width * this.height).fill('.');
    this.syncCells();
    this.refresh();
  }

  /** 一键生成迷宫：按当前尺寸换算迷宫单元数，随机种子 */
  private fillMaze(): void {
    const cols = Math.max(3, Math.floor((this.width - 1) / 2));
    const rows = Math.max(3, Math.floor((this.height - 1) / 2));
    const nodes = Math.min(4, Math.max(1, Math.round((cols + rows) / 6)));
    // 必须走 buildRandomMap 而不是 generateMapRows：
    // 后者只管挖迷宫撒陷阱，不检查"人类打不打得过"，
    // 于是有概率生成一张分析器判定为"必死"的图，
    // 编辑器自己的 refresh() 会立刻报"无法通关"，让"一键生成"看起来像坏掉了。
    // buildRandomMap 内部会重掷种子直到最优代价 <= 生命上限 - 安全余量。
    const generated = buildRandomMap({
      seed: randomSeed(),
      cols,
      rows,
      nodes,
      braid: 0.14
    });
    this.height = generated.rows.length;
    this.width = generated.rows[0].length;
    this.cells = [];
    for (const row of generated.rows) {
      for (const ch of row) this.cells.push(ch as TileCode);
    }
    this.widthInput.value = String(this.width);
    this.heightInput.value = String(this.height);
    this.buildGrid();
    this.refresh();
  }

  // ==================== 校验与输出 ====================

  private get rows(): string[] {
    const rows: string[] = [];
    for (let y = 0; y < this.height; y += 1) {
      rows.push(this.cells.slice(y * this.width, (y + 1) * this.width).join(''));
    }
    return rows;
  }

  private refresh(): void {
    const rows = this.rows;
    this.report = analyzeRows(rows);
    const report = this.report;

    this.issueList.innerHTML = '';
    // 有错才拦人；只有警告时也要给出"可以玩"的明确反馈，
    // 否则尖刺的提醒（"最优路线仍需踩中 N 次尖刺"）会把唯一的正面信号挤掉，
    // 让人误以为这张图不能玩。
    if (report.errors.length === 0) {
      this.issueList.appendChild(
        issueItem(
          'ok',
          report.warnings.length === 0 ? '校验通过，可以试玩 / 分享。' : '校验通过（有提醒），可以试玩 / 分享。'
        )
      );
    }
    for (const error of report.errors) this.issueList.appendChild(issueItem('error', error.message));
    for (const warn of report.warnings) this.issueList.appendChild(issueItem('warn', warn.message));

    this.statsEl.innerHTML = '';
    this.statsEl.appendChild(statItem('尺寸', `${report.width} × ${report.height}`));
    this.statsEl.appendChild(statItem('节点', String(report.nodes)));
    this.statsEl.appendChild(statItem('可通行', String(report.floors)));
    this.statsEl.appendChild(
      statItem('到出口', report.exitDistance >= 0 ? `${report.exitDistance} 步` : '不可达')
    );
  }

  private get title(): string {
    return this.titleInput.value.trim();
  }

  /** 构造关卡定义；同时写入分享码，便于保存后直接分享 */
  private buildLevel(): LevelDefinition {
    const rows = this.rows;
    const nodes = rows.join('').split('R').length - 1;
    const title = this.title.length > 0 ? this.title : '未命名关卡';
    return {
      id: 0,
      source: 'custom',
      customId: this.editingId ?? undefined,
      code: encodeMapCode(title, rows),
      title,
      subtitle: `${rows[0].length} × ${rows.length} · ${nodes} 节点`,
      requiredResonators: nodes,
      hint: [],
      map: rows
    };
  }

  // ==================== 底部操作 ====================

  private test(): void {
    if (!this.report?.playable) {
      this.flashIssues('还有问题没解决，先看右侧校验结果。');
      return;
    }
    this.callbacks.onTest(this.buildLevel());
  }

  private save(): void {
    if (!this.report?.playable) {
      this.flashIssues('地图还不完整，保存前请先修好报错项。');
      return;
    }
    this.callbacks.onSaved({
      id: this.editingId ?? '',
      title: this.title.length > 0 ? this.title : '未命名关卡',
      map: this.rows
    } satisfies EditorSaveRequest);
  }

  private share(): void {
    if (!this.report?.playable) {
      this.flashIssues('地图还不完整，导出前请先修好报错项。');
      return;
    }
    // 导出的是**可读化外形**（RESO·…），不走 buildLevel()：
    // buildLevel().code 是内部格式，给解析用；弹窗里展示的必须是给用户看的那串。
    const title = this.title.length > 0 ? this.title : '未命名关卡';
    this.shareDialog.show(
      '导出分享码',
      '把这串文字发给朋友，对方在「我的关卡 → 导入分享码」粘贴即可玩到这张地图。',
      encodeMapShareText(title, this.rows)
    );
  }

  private flashIssues(message: string): void {
    this.issueList.innerHTML = '';
    this.issueList.appendChild(issueItem('error', message));
    for (const error of this.report?.errors ?? []) {
      this.issueList.appendChild(issueItem('error', error.message));
    }
  }
}

function classOf(code: TileCode): string {
  if (code === '#') return 'wall';
  if (code === 'S') return 'start';
  if (code === 'R') return 'node';
  if (code === 'E') return 'exit';
  if (code === '^') return 'spike';
  if (code === '*') return 'jammer';
  return 'floor';
}

function issueItem(kind: 'ok' | 'warn' | 'error', text: string): HTMLElement {
  const li = document.createElement('li');
  li.className = kind;
  li.textContent = text;
  return li;
}

function statItem(label: string, value: string): HTMLElement {
  const span = document.createElement('span');
  span.innerHTML = `${label} <b>${value}</b>`;
  return span;
}

function clampInt(raw: string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
