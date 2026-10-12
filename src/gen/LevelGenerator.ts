/**
 * 运行时随机关卡生成器。
 *
 * 算法与 scripts/generateMaps.mjs 一致（递归回溯迷宫 -> 编织 -> BFS 布点），
 * 但改为参数化、可复现（依赖种子），并在生成后立刻用地图分析器自检：
 * 不自洽就换一个衍生种子重来，确保玩家拿到的每一张随机图都能通关。
 *
 * 该模块不依赖 DOM，可在 Node 中直接用于批量校验。
 */

import { Rng } from './Rng';
import {
  RandomLevelParams,
  RANDOM_PRESETS,
  clampParams,
  presetLabel,
  seedToText
} from './randomParams';
import { analyzeRows } from '../levels/mapAnalysis';
import { LevelDefinition } from '../levels/levelData';
import { DEFAULT_HAZARD } from '../game/HazardConfig';

export interface GeneratedMap {
  rows: string[];
  start: { x: number; y: number };
  exit: { x: number; y: number };
  nodes: Array<{ x: number; y: number }>;
  /** 出生点到出口的最短步数 */
  distance: number;
}

type Grid = number[][];
type CharGrid = string[][];

const DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

/** 递归回溯生成迷宫：grid[y][x]=1 表示单元已访问，links 保存已打通的相邻单元对 */
function carveMaze(cols: number, rows: number, rng: Rng): { grid: Grid; links: Set<string> } {
  const grid: Grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const visited: boolean[][] = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const links = new Set<string>();
  const stack: Array<[number, number]> = [[0, 0]];
  visited[0][0] = true;
  grid[0][0] = 1;

  const key = (ax: number, ay: number, bx: number, by: number): string =>
    `${ax},${ay}|${bx},${by}`;

  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const options: Array<[number, number]> = [];
    if (cy > 0 && !visited[cy - 1][cx]) options.push([cx, cy - 1]);
    if (cy < rows - 1 && !visited[cy + 1][cx]) options.push([cx, cy + 1]);
    if (cx > 0 && !visited[cy][cx - 1]) options.push([cx - 1, cy]);
    if (cx < cols - 1 && !visited[cy][cx + 1]) options.push([cx + 1, cy]);

    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const pick = options[rng.int(options.length)];
    visited[pick[1]][pick[0]] = true;
    grid[pick[1]][pick[0]] = 1;
    links.add(key(cx, cy, pick[0], pick[1]));
    links.add(key(pick[0], pick[1], cx, cy));
    stack.push(pick);
  }
  return { grid, links };
}

/** 把迷宫放大成字符地图（墙厚度为 1 格），并按比例编织出回路 */
function toCharGrid(grid: Grid, links: Set<string>, rng: Rng, braidRatio: number): CharGrid {
  const rows = grid.length;
  const cols = grid[0].length;
  const h = rows * 2 + 1;
  const w = cols * 2 + 1;
  const out: CharGrid = Array.from({ length: h }, () => new Array(w).fill('#'));

  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (grid[y][x] === 1) out[y * 2 + 1][x * 2 + 1] = '.';
    }
  }
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (grid[y][x] !== 1) continue;
      if (x < cols - 1 && links.has(`${x},${y}|${x + 1},${y}`)) out[y * 2 + 1][x * 2 + 2] = '.';
      if (y < rows - 1 && links.has(`${x},${y}|${x},${y + 1}`)) out[y * 2 + 2][x * 2 + 1] = '.';
    }
  }

  const candidates: Array<[number, number]> = [];
  for (let y = 1; y < h - 1; y += 1) {
    for (let x = 1; x < w - 1; x += 1) {
      if (out[y][x] !== '#') continue;
      const horizontal = out[y][x - 1] === '.' && out[y][x + 1] === '.';
      const vertical = out[y - 1][x] === '.' && out[y + 1][x] === '.';
      if (horizontal || vertical) candidates.push([x, y]);
    }
  }
  const braidCount = Math.floor(candidates.length * braidRatio);
  for (let i = 0; i < braidCount; i += 1) {
    if (candidates.length === 0) break;
    const idx = rng.int(candidates.length);
    const [x, y] = candidates[idx];
    candidates.splice(idx, 1);
    out[y][x] = '.';
  }
  return out;
}

/** BFS 距离场（-1 表示不可达） */
function distanceField(out: CharGrid, sx: number, sy: number): number[][] {
  const h = out.length;
  const w = out[0].length;
  const dist: number[][] = Array.from({ length: h }, () => new Array(w).fill(-1));
  dist[sy][sx] = 0;
  const queue: Array<[number, number]> = [[sx, sy]];
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head];
    head += 1;
    for (const [dx, dy] of DIRS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
      if (out[ny][nx] === '#') continue;
      if (dist[ny][nx] !== -1) continue;
      dist[ny][nx] = dist[y][x] + 1;
      queue.push([nx, ny]);
    }
  }
  return dist;
}

function floorCells(out: CharGrid): Array<[number, number]> {
  const cells: Array<[number, number]> = [];
  for (let y = 0; y < out.length; y += 1) {
    for (let x = 0; x < out[0].length; x += 1) {
      if (out[y][x] !== '#') cells.push([x, y]);
    }
  }
  return cells;
}

function neighborCount(out: CharGrid, x: number, y: number): number {
  let n = 0;
  for (const [dx, dy] of DIRS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= out[0].length || ny >= out.length) continue;
    if (out[ny][nx] !== '#') n += 1;
  }
  return n;
}

function minGap(cols: number, rows: number): number {
  return Math.max(4, Math.floor((cols + rows) / 4));
}

/**
 * 生成一张随机地图。
 * 只负责"造图"，不做合法性兜底——需要保证可玩请用 buildRandomLevel。
 */
export function generateMapRows(params: RandomLevelParams): GeneratedMap {
  const p = clampParams(params);
  const rng = new Rng(p.seed);
  const maze = carveMaze(p.cols, p.rows, rng);
  const out = toCharGrid(maze.grid, maze.links, rng, p.braid);
  const cells = floorCells(out);

  // 出生点：最靠左上的通道格
  let start: [number, number] = cells[0] ?? [1, 1];
  for (const cell of cells) {
    if (cell[0] + cell[1] < start[0] + start[1]) start = cell;
  }

  const dist = distanceField(out, start[0], start[1]);

  // 出口：离出生点最远的格子
  let exitCell: [number, number] = start;
  for (const cell of cells) {
    if (dist[cell[1]][cell[0]] > dist[exitCell[1]][exitCell[0]]) exitCell = cell;
  }

  // 共振节点：优先死路末端，且离出生点足够远、彼此保持间隔
  const minStartDist = Math.max(6, Math.floor((p.cols + p.rows) * 0.4));
  const farCells = cells.filter((cell) => dist[cell[1]][cell[0]] >= minStartDist);
  const deadEnds = farCells.filter((cell) => neighborCount(out, cell[0], cell[1]) === 1);
  const pool = (deadEnds.length >= p.nodes ? deadEnds : farCells)
    .slice()
    .sort((a, b) => dist[b[1]][b[0]] - dist[a[1]][a[0]]);

  const gap = minGap(p.cols, p.rows);
  const tooClose = (a: [number, number], b: [number, number]): boolean =>
    Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < gap;

  const chosen: Array<[number, number]> = [];
  for (const cell of pool) {
    if (cell[0] === start[0] && cell[1] === start[1]) continue;
    if (cell[0] === exitCell[0] && cell[1] === exitCell[1]) continue;
    if (tooClose(cell, start) || tooClose(cell, exitCell)) continue;
    if (chosen.some((c) => tooClose(c, cell))) continue;
    chosen.push(cell);
    if (chosen.length === p.nodes) break;
  }
  // 死路不够分散时退化为"由远及近"补足
  if (chosen.length < p.nodes) {
    for (const cell of farCells) {
      if (chosen.length === p.nodes) break;
      if (cell[0] === start[0] && cell[1] === start[1]) continue;
      if (cell[0] === exitCell[0] && cell[1] === exitCell[1]) continue;
      if (chosen.some((c) => c[0] === cell[0] && c[1] === cell[1])) continue;
      chosen.push(cell);
    }
  }

  const result = out.map((row) => row.slice());
  result[start[1]][start[0]] = 'S';
  result[exitCell[1]][exitCell[0]] = 'E';
  for (const cell of chosen) result[cell[1]][cell[0]] = 'R';

  // 撒陷阱：必须在 S / E / R 都落位之后，才能安全跳过这些关键格
  const withTraps = scatterTraps(result, rng, cells.length, start);

  return {
    rows: withTraps.map((row) => row.join('')),
    start: { x: start[0], y: start[1] },
    exit: { x: exitCell[0], y: exitCell[1] },
    nodes: chosen.map((c) => ({ x: c[0], y: c[1] })),
    distance: dist[exitCell[1]][exitCell[0]]
  };
}

/**
 * 随机地图的"人类可通关"安全余量。
 *
 * 分析器算出的 minSpikeCost 是**最优路线**的代价——它假设玩家每一步都踩在最优点上，
 * 这不现实。实测发现：有些随机图 minSpikeCost=1，但玩家按直觉走最短路径会连踩 3 次。
 * 只按 minSpikeCost < maxHealth 放行，会产出"理论上能过、实际像运气"的地图，
 * 这正是设计上要避免的失败模式。
 *
 * 因此随机图额外要求最优代价也别贴着上限：至少要留出 safetyMargin 点容错。
 */
const RANDOM_SAFETY_MARGIN = 2;

/** 随机地图的陷阱密度配置：按档位与尺寸决定撒几颗 */
const TRAP_DENSITY = {
  /** 每 N 个可通行格撒 1 颗尖刺（越小越密） */
  cellsPerSpike: 42,
  /** 每 N 个可通行格撒 1 个干扰器 */
  cellsPerJammer: 120,
  /** 单个地图的尖刺数量下限 / 上限 */
  minSpikes: 0,
  maxSpikes: 8,
  minJammers: 0,
  maxJammers: 3,
  /** 陷阱与出生点的最小曼哈顿距离，避免一出生就踩 */
  minStartGap: 3
};

/**
 * 在地图上撒陷阱。
 * 约束：
 * - 不放在出生点、出口、节点上（否则会干扰既有的推进节奏）；
 * - 不放在玩家"唯一通道"上（这里不做严格判断，靠下面的自检兜底：
 *   分析器会算出最优路线的最少尖刺代价，超限就整体重生成）；
 * - 离出生点至少 minStartGap 格，避免开局零反应时间就掉血。
 *
 * 返回新的字符网格，不修改入参。
 */
function scatterTraps(
  out: CharGrid,
  rng: Rng,
  floors: number,
  start: [number, number]
): CharGrid {
  const h = out.length;
  const w = out[0].length;
  const result = out.map((row) => row.slice());

  const available: Array<[number, number]> = [];
  for (let y = 0; y < h; y += 1) {
    for (let x = 0; x < w; x += 1) {
      if (result[y][x] !== '.') continue;
      if (Math.abs(x - start[0]) + Math.abs(y - start[1]) < TRAP_DENSITY.minStartGap) continue;
      available.push([x, y]);
    }
  }
  // 打乱，避免陷阱总是落在扫描顺序靠前的位置
  for (let i = available.length - 1; i > 0; i -= 1) {
    const j = rng.int(i + 1);
    const tmp = available[i];
    available[i] = available[j];
    available[j] = tmp;
  }

  const wantSpikes = Math.min(
    TRAP_DENSITY.maxSpikes,
    Math.max(TRAP_DENSITY.minSpikes, Math.floor(floors / TRAP_DENSITY.cellsPerSpike))
  );
  const wantJammers = Math.min(
    TRAP_DENSITY.maxJammers,
    Math.max(TRAP_DENSITY.minJammers, Math.floor(floors / TRAP_DENSITY.cellsPerJammer))
  );

  let spikes = 0;
  let jammers = 0;
  for (const [x, y] of available) {
    if (spikes >= wantSpikes && jammers >= wantJammers) break;
    if (result[y][x] !== '.') continue;
    // 先撒干扰器（数量少），再撒尖刺
    if (jammers < wantJammers && spikes >= wantSpikes) {
      result[y][x] = '*';
      jammers += 1;
      continue;
    }
    if (spikes < wantSpikes) {
      result[y][x] = '^';
      spikes += 1;
    }
  }
  return result;
}

/** 兜底房间：当多次生成都不自洽时使用，结构上必定可通关 */
function buildFallbackRoom(params: RandomLevelParams): GeneratedMap {
  const p = clampParams(params);
  const w = Math.max(9, p.cols * 2 + 1);
  const h = Math.max(7, p.rows * 2 + 1);
  const rows: string[][] = Array.from({ length: h }, (_, y) =>
    Array.from({ length: w }, (_, x) => (x === 0 || y === 0 || x === w - 1 || y === h - 1 ? '#' : '.'))
  );
  rows[1][1] = 'S';
  rows[h - 2][w - 2] = 'E';

  const nodes: Array<{ x: number; y: number }> = [];
  const wanted = Math.min(p.nodes, 4);
  const spots: Array<[number, number]> = [
    [w - 2, 1],
    [1, h - 2],
    [Math.floor(w / 2), Math.floor(h / 2)],
    [Math.floor(w / 2), 1]
  ];
  for (let i = 0; i < wanted; i += 1) {
    const [x, y] = spots[i % spots.length];
    if (rows[y][x] !== '.') continue;
    rows[y][x] = 'R';
    nodes.push({ x, y });
  }

  return {
    rows: rows.map((row) => row.join('')),
    start: { x: 1, y: 1 },
    exit: { x: w - 2, y: h - 2 },
    nodes,
    distance: w + h - 4
  };
}

/**
 * 生成一张保证可玩的随机地图。
 * 先按种子生成，再用地图分析器自检；不自洽就换衍生种子重试。
 *
 * "自检通过"的标准比分析器的 playable 更严一档：
 * 除了结构合法、节点与出口可达之外，还要求最优尖刺代价留出安全余量
 * （见 RANDOM_SAFETY_MARGIN）。这样产出的图才是"人类真的打得过"，
 * 而不是"存在一条完美路线"。
 */
export function buildRandomMap(params: RandomLevelParams): GeneratedMap {
  let last = generateMapRows(params);
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const candidate =
      attempt === 0
        ? last
        : generateMapRows({
            ...params,
            seed: (params.seed + attempt * 7919) >>> 0,
            braid: Math.min(0.4, params.braid + attempt * 0.03)
          });
    last = candidate;
    const report = analyzeRows(candidate.rows);
    const maxHealth = DEFAULT_HAZARD.maxHealth;
    // 最优代价也必须留出余量：minSpikeCost <= maxHealth - safetyMargin
    const withinBudget =
      report.minSpikeCost >= 0 && report.minSpikeCost <= maxHealth - RANDOM_SAFETY_MARGIN;
    if (report.playable && withinBudget) return candidate;
  }
  // 极端情况下（参数过界导致布点失败）退化为必定可玩的简单房间
  return buildFallbackRoom(params);
}

/** 把随机地图包装成关卡定义 */
export function buildRandomLevel(params: RandomLevelParams): LevelDefinition {
  const generated = buildRandomMap(params);
  const nodeCount = generated.rows.join('').split('R').length - 1;
  const trapText = countTraps(generated.rows);
  const width = generated.rows[0].length;
  const height = generated.rows.length;
  const sizeText = `${width} × ${height}`;

  return {
    id: 0,
    source: 'random',
    random: clampParams(params),
    title: `随机回声 · ${seedToText(params.seed)}`,
    subtitle: `${presetLabel(describePreset(params))} · ${sizeText} · ${nodeCount} 节点${trapText}`,
    requiredResonators: nodeCount,
    hint: [
      '随机生成的迷宫：先发一次脉冲看清周围。',
      '红色三角是尖刺，紫色波纹是回声干扰器；声波扫过的陷阱会被记住，绕开它们。'
    ],
    map: generated.rows
  };
}

/** 统计陷阱数量并生成副标题文案（没有陷阱就返回空串） */
function countTraps(rows: string[]): string {
  let spikes = 0;
  let jammers = 0;
  for (const row of rows) {
    for (const ch of row) {
      if (ch === '^') spikes += 1;
      else if (ch === '*') jammers += 1;
    }
  }
  if (spikes === 0 && jammers === 0) return '';
  if (jammers === 0) return ` · ${spikes} 尖刺`;
  if (spikes === 0) return ` · ${jammers} 干扰`;
  return ` · ${spikes} 尖刺 / ${jammers} 干扰`;
}

/** 依据尺寸反查最接近的预设，仅用于关卡副标题的展示文案 */
function describePreset(params: RandomLevelParams): string {
  const { cols, rows } = clampParams(params);
  let bestId = 'normal';
  let bestGap = Number.POSITIVE_INFINITY;
  for (const preset of RANDOM_PRESETS) {
    const gap = Math.abs(preset.params.cols - cols) + Math.abs(preset.params.rows - rows);
    if (gap < bestGap) {
      bestGap = gap;
      bestId = preset.id;
    }
  }
  return bestId;
}
