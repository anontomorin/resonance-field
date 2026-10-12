/**
 * 地图合法性分析。
 *
 * 编辑器实时校验、自定义关卡导入、随机生成自检、开发期校验脚本共用这一份实现，
 * 保证"编辑器说能玩"和"校验脚本说能玩"是同一套标准。
 *
 * 该模块不依赖 DOM，可在 Node 中直接运行。
 */

import { TileMap } from '../world/TileMap';
import { isTileCode } from '../world/TileType';
import { DEFAULT_HAZARD, HazardConfig } from '../game/HazardConfig';
import { propagate, propagateField } from '../sonar/Propagation';
import { DEFAULT_SONAR, SonarConfig } from '../sonar/SonarConfig';

export interface MapIssue {
  level: 'error' | 'warn';
  message: string;
}

export interface MapReport {
  width: number;
  height: number;
  /** 可通行格数量（含出生点、节点、出口、陷阱） */
  floors: number;
  nodes: number;
  /** 尖刺数量 */
  spikes: number;
  /** 回声干扰器数量 */
  jammers: number;
  start: { x: number; y: number } | null;
  exit: { x: number; y: number } | null;
  /** 把出口当墙时能到达的格子数（拿节点的真实条件） */
  reachableWithoutExit: number;
  /** 出口可通行时能到达的格子数 */
  reachableWithExit: number;
  /** 出生点到出口的最短步数（-1 表示不可达） */
  exitDistance: number;
  /**
   * 走完所有节点再到出口，理论最少需要踩中几次尖刺。
   * -1 表示不可达。用来判断这一关在给定的生命上限下是否根本打不过去。
   */
  minSpikeCost: number;
  errors: MapIssue[];
  warnings: MapIssue[];
  /** 无错误即视为结构合法 */
  valid: boolean;
  /** 结构合法 + 节点与出口都可达 + 陷阱代价不超过生命上限 = 可以开玩 */
  playable: boolean;
}

export const MAP_LIMITS = {
  minWidth: 5,
  maxWidth: 61,
  minHeight: 5,
  maxHeight: 41,
  maxNodes: 8
};

const DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

/** 从起点做 BFS，返回访问标记；blockExit 为真时把出口当作墙 */
function floodFill(
  map: TileMap,
  from: { x: number; y: number },
  blockExit: boolean
): { visited: boolean[]; count: number } {
  const visited = new Array(map.width * map.height).fill(false);
  const startIndex = map.index(from.x, from.y);
  visited[startIndex] = true;
  const queue: number[] = [startIndex];
  let head = 0;
  let count = 1;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    const cx = cur % map.width;
    const cy = Math.floor(cur / map.width);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!map.inBounds(nx, ny)) continue;
      if (map.isWall(nx, ny)) continue;
      if (blockExit && map.kindAt(nx, ny) === 'exit') continue;
      const ni = map.index(nx, ny);
      if (visited[ni]) continue;
      visited[ni] = true;
      count += 1;
      queue.push(ni);
    }
  }
  return { visited, count };
}

function distanceTo(map: TileMap, from: { x: number; y: number }, targetIndex: number): number {
  const dist = new Array(map.width * map.height).fill(-1);
  const startIndex = map.index(from.x, from.y);
  dist[startIndex] = 0;
  const queue: number[] = [startIndex];
  let head = 0;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    if (cur === targetIndex) return dist[cur];
    const cx = cur % map.width;
    const cy = Math.floor(cur / map.width);
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!map.inBounds(nx, ny)) continue;
      if (map.isWall(nx, ny)) continue;
      const ni = map.index(nx, ny);
      if (dist[ni] !== -1) continue;
      dist[ni] = dist[cur] + 1;
      queue.push(ni);
    }
  }
  return dist[targetIndex];
}

const EMPTY_REPORT: MapReport = {
  width: 0,
  height: 0,
  floors: 0,
  nodes: 0,
  spikes: 0,
  jammers: 0,
  start: null,
  exit: null,
  reachableWithoutExit: 0,
  reachableWithExit: 0,
  exitDistance: -1,
  minSpikeCost: -1,
  errors: [{ level: 'error', message: '地图为空。' }],
  warnings: [],
  valid: false,
  playable: false
};

/**
 * 0-1 BFS：求从 start 走到每个格子的"最少踩尖刺次数"。
 *
 * 尖刺格权重 1，其它可通行格权重 0。用双端队列（0 走队首、1 走队尾）实现，
 * 复杂度 O(V+E)，对最大 61×41 的地图完全够用。
 * 出口在 blockExit 为真时视作墙体，与可玩性判定口径保持一致。
 */
function spikeCostField(
  map: TileMap,
  start: { x: number; y: number },
  blockExit: boolean
): Int32Array {
  const size = map.width * map.height;
  const INF = 1 << 28;
  const dist = new Int32Array(size).fill(INF);
  const startIndex = map.index(start.x, start.y);
  dist[startIndex] = 0;

  /**
   * 0-1 BFS 的双端队列。
   *
   * 用"以中间为起点的环形缓冲区"实现：head 只增不减，
   * 需要压到队首的 0 权边会写进缓冲区前半段（由 front 指针向前移动）。
   * 关键点是 head 与 front 各自独立：
   * 两者混用会让"已经被消费"的下标被重新读回，或让节点永远读不到。
   */
  const capacity = size * 4 + 16;
  const deque = new Int32Array(capacity);
  const mid = Math.floor(capacity / 2);
  let front = mid;
  let back = mid;
  // 约定 [front, back) 为待处理区间
  deque[back] = startIndex;
  back += 1;

  while (front < back) {
    const cur = deque[front];
    front += 1;
    const cx = cur % map.width;
    const cy = Math.floor(cur / map.width);
    const baseCost = dist[cur];

    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!map.inBounds(nx, ny)) continue;
      if (map.isWall(nx, ny)) continue;
      if (blockExit && map.kindAt(nx, ny) === 'exit') continue;
      const ni = map.index(nx, ny);
      const step = map.kindAt(nx, ny) === 'spike' ? 1 : 0;
      const next = baseCost + step;
      if (next >= dist[ni]) continue;
      dist[ni] = next;
      if (step === 0) {
        // 0 权边：插到队首，保证出队顺序单调不减
        front -= 1;
        deque[front] = ni;
      } else {
        deque[back] = ni;
        back += 1;
      }
    }
  }
  return dist;
}

/**
 * 计算"从出生点出发，走遍所有共振节点，最后进入出口"所需的最少踩尖刺次数。
 *
 * 这是个带权路径规划：先用 0-1 BFS 求出关键点两两之间的最少尖刺代价，
 * 再用 bitmask DP 在节点集合上求最优顺序（节点数上限 8，状态量 ≤ 2^8 × 8）。
 *
 * 意义：陷阱不改变可达性（踩得上去），但可能让一关"理论上就打不过去"——
 * 比如最优路线也必须挨 5 次尖刺，而生命上限只有 3。这种关卡必须被拦下来。
 *
 * @returns 最少尖刺代价；不可达返回 -1
 */
export function minSpikeCostToClear(map: TileMap): number {
  const nodes = map.resonators;
  const n = nodes.length;
  if (n === 0) {
    const field = spikeCostField(map, map.start, false);
    const cost = field[map.index(map.exit.x, map.exit.y)];
    return cost >= 1 << 28 ? -1 : cost;
  }

  // 关键点：0 = 出生点，1..n = 各节点，n+1 = 出口
  const waypoints = [map.start, ...nodes.map((c) => ({ x: c.x, y: c.y })), map.exit];
  const waypointCount = waypoints.length;

  /**
   * 距离场分两套，区别只在"出口能不能走"：
   * - blockedFrom[i]：以第 i 个关键点为起点、把出口当墙。用于算"激活节点阶段"的代价
   *   （节点必须在出口关闭时就拿得到，这也是可玩性判定的口径）；
   * - openFrom[i]：以第 i 个关键点为起点、出口可通行。只在"最后一个节点 -> 出口"这一段用。
   *
   * 混用这两套是这里唯一容易错的点：如果最后一段也拿 blocked 的场去查出口，
   * 出口永远是 INF，会被误判成"打不过去"。
   */
  const blockedFrom: Int32Array[] = [];
  const openFrom: Int32Array[] = [];
  for (let i = 0; i < waypointCount; i += 1) {
    blockedFrom.push(spikeCostField(map, waypoints[i], true));
    openFrom.push(spikeCostField(map, waypoints[i], false));
  }

  const INF = 1 << 28;
  const exitIndex = map.index(map.exit.x, map.exit.y);

  // dp[mask][i] = 已访问节点集合 mask、当前停在节点 i 时的最少尖刺数
  const full = 1 << n;
  const dp = new Int32Array(full * n).fill(INF);
  const at = (mask: number, i: number): number => mask * n + i;

  for (let i = 0; i < n; i += 1) {
    const c = blockedFrom[0][map.index(nodes[i].x, nodes[i].y)];
    if (c < INF) dp[at(1 << i, i)] = c;
  }

  for (let mask = 1; mask < full; mask += 1) {
    for (let i = 0; i < n; i += 1) {
      const cur = dp[at(mask, i)];
      if (cur >= INF) continue;
      if ((mask & (1 << i)) === 0) continue;
      for (let j = 0; j < n; j += 1) {
        if (mask & (1 << j)) continue;
        // 节点之间：仍在"出口关闭"阶段，用 blocked 场
        const step = blockedFrom[i + 1][map.index(nodes[j].x, nodes[j].y)];
        if (step >= INF) continue;
        const nm = mask | (1 << j);
        const cand = cur + step;
        if (cand < dp[at(nm, j)]) dp[at(nm, j)] = cand;
      }
    }
  }

  let best = INF;
  for (let i = 0; i < n; i += 1) {
    const cur = dp[at(full - 1, i)];
    if (cur >= INF) continue;
    // 最后一个节点走到出口：此时节点已集齐、出口已开启，用 open 场
    const last = openFrom[i + 1][exitIndex];
    if (last >= INF) continue;
    best = Math.min(best, cur + last);
  }

  return best >= INF ? -1 : best;
}

/**
 * 求"最少踩尖刺"的节点访问顺序（含出生点与出口）。
 *
 * 与 minSpikeCostToClear 用的是同一套 DP，只是顺带把路径还原出来。
 * 校验脚本需要它：要真实模拟一次通关，就必须按分析器认可的最优顺序走，
 * 否则会误判（比如按数组顺序走会多踩几次尖刺，看起来像"分析器算错了"）。
 *
 * @returns 按访问顺序排列的关键点；不可达时返回空数组
 */
export function optimalVisitOrder(map: TileMap): Array<{ x: number; y: number }> {
  const nodes = map.resonators;
  const n = nodes.length;
  if (n === 0) return [map.start, map.exit];

  const waypoints = [map.start, ...nodes.map((c) => ({ x: c.x, y: c.y })), map.exit];
  const blockedFrom = waypoints.map((p) => spikeCostField(map, p, true));
  const openFrom = waypoints.map((p) => spikeCostField(map, p, false));

  const INF = 1 << 28;
  const exitIndex = map.index(map.exit.x, map.exit.y);
  const full = 1 << n;
  const dp = new Int32Array(full * n).fill(INF);
  const parent = new Int32Array(full * n).fill(-1);
  const at = (mask: number, i: number): number => mask * n + i;

  for (let i = 0; i < n; i += 1) {
    const c = blockedFrom[0][map.index(nodes[i].x, nodes[i].y)];
    if (c < INF) dp[at(1 << i, i)] = c;
  }

  for (let mask = 1; mask < full; mask += 1) {
    for (let i = 0; i < n; i += 1) {
      const cur = dp[at(mask, i)];
      if (cur >= INF) continue;
      if ((mask & (1 << i)) === 0) continue;
      for (let j = 0; j < n; j += 1) {
        if (mask & (1 << j)) continue;
        const step = blockedFrom[i + 1][map.index(nodes[j].x, nodes[j].y)];
        if (step >= INF) continue;
        const nm = mask | (1 << j);
        const cand = cur + step;
        if (cand < dp[at(nm, j)]) {
          dp[at(nm, j)] = cand;
          parent[at(nm, j)] = i;
        }
      }
    }
  }

  let best = INF;
  let bestLast = -1;
  for (let i = 0; i < n; i += 1) {
    const cur = dp[at(full - 1, i)];
    if (cur >= INF) continue;
    const last = openFrom[i + 1][exitIndex];
    if (last >= INF) continue;
    if (cur + last < best) {
      best = cur + last;
      bestLast = i;
    }
  }
  if (bestLast < 0) return [];

  // 还原节点顺序
  const nodeOrder: number[] = [];
  let mask = full - 1;
  let cursor = bestLast;
  while (cursor !== -1) {
    nodeOrder.push(cursor);
    const p = parent[at(mask, cursor)];
    mask &= ~(1 << cursor);
    cursor = p;
  }
  nodeOrder.reverse();

  return [map.start, ...nodeOrder.map((i) => ({ x: nodes[i].x, y: nodes[i].y })), map.exit];
}

/**
 * 一次脉冲的覆盖查询表。
 *
 * 之所以返回一个**函数**而不是距离数组：两种模型的"看得见"判据不同——
 * - `bfs`：距离 `!== -1`（是/否，整数步）
 * - `field`：照度 `>= fieldThreshold`（连续能量）
 *
 * 调用方只关心"这一格有没有被照到"，把判据封在函数里，
 * 上面那两处消费点（节点命中、出口是否被顺带覆盖）就不必各自写一遍分支。
 */
type CoverageProbe = (index: number) => boolean;

/**
 * 算出从某个起点发一次脉冲的覆盖判据。
 *
 * 关键约束：这里**必须**用与真实玩法完全相同的传播模型与参数，
 * 否则评分会用旧模型算 `par`、游戏用新模型跑，两者悄悄不一致——
 * 玩家明明按最优解打完了却拿不到三星。所以模型直接从 `SonarConfig` 取，
 * 不在这里写死，也不允许调用方传一个"另一套"的 maxRange。
 */
function pulseCoverage(
  map: TileMap,
  from: { x: number; y: number },
  sonar: SonarConfig
): CoverageProbe {
  if (sonar.model === 'field') {
    const field = propagateField(map, from.x, from.y, sonar.maxRange, sonar.fieldFalloff);
    const threshold = sonar.fieldThreshold;
    return (index) => field.intensity[index] >= threshold;
  }
  const distances = propagate(map, from.x, from.y, sonar.maxRange).distances;
  return (index) => distances[index] !== -1;
}

/**
 * 清空这一关在理论上最少需要发射几次脉冲。
 *
 * 评分必须有据可依，所以这里不是拍脑袋给一个"≤3 次算三星"，
 * 而是按游戏真实规则算出一个下界：
 *
 * - 每个共振节点都必须被某次脉冲"扫到"才会激活，所以节点是硬指标；
 * - 节点的激活数量由 `requiredResonators` 决定；
 * - 最后一次脉冲若顺带覆盖了出口，就省掉了"为找出口单独发一次"的成本
 *   （这也是玩家真实会做的事：站在最后一个节点旁边直接发波看路）。
 *
 * 于是问题变成：用最少的脉冲覆盖「requiredResonators 个节点」，
 * 再看这些脉冲里有没有哪一发也覆盖了出口；没有的话出口要额外算一发。
 *
 * 这是一个**下界**：真实玩家还要等冷却、绕路、重复探路，实际一定更多。
 * 所以星级阈值是在这个下界上加余量，而不是直接拿它当三星线。
 *
 * @param map 地图
 * @param sonar 声波参数。**必须**与关卡实际使用的配置一致，否则 `par` 会算错。
 * @param requiredResonators 需要激活的节点数（默认全部）
 * @returns 最少脉冲次数；无节点时返回 1（至少要发一次声波）
 */
export function minPulsesToClear(
  map: TileMap,
  sonar: SonarConfig = DEFAULT_SONAR,
  requiredResonators?: number
): number {
  const nodes = map.resonators;
  if (nodes.length === 0) return 1;

  const required = Math.min(requiredResonators ?? nodes.length, nodes.length);
  const exitIndex = map.index(map.exit.x, map.exit.y);

  // 每个可通行格都可能是发射点，先算出它的覆盖判据（以及是否覆盖出口）
  const launchSites: Array<{ hit: number[]; coversExit: boolean }> = [];
  for (const cell of map.floorCells()) {
    const covered = pulseCoverage(map, cell, sonar);
    const hit: number[] = [];
    for (let i = 0; i < required; i += 1) {
      const ni = map.index(nodes[i].x, nodes[i].y);
      if (covered(ni)) hit.push(i);
    }
    launchSites.push({ hit, coversExit: covered(exitIndex) });
  }

  /**
   * 贪心集合覆盖：每轮选"能新覆盖最多未覆盖节点"的发射点，并把已覆盖的划掉。
   *
   * 脉冲覆盖本质是集合覆盖问题（NP-hard），精确解在这个规模上不值得；
   * 贪心给出的下界足够紧，而且结果稳定可复现（评分不能随机抖动）。
   */
  const remaining = new Set<number>();
  for (let i = 0; i < required; i += 1) remaining.add(i);

  let pulses = 0;
  let anyLandedOnExit = false;
  while (remaining.size > 0) {
    let bestSite: (typeof launchSites)[number] | null = null;
    let bestGain = 0;
    let bestPeekExit = false;
    for (const site of launchSites) {
      let gain = 0;
      for (const i of site.hit) if (remaining.has(i)) gain += 1;
      // 同收益时优先选"顺手覆盖出口"的点，省掉最后探出口那一发
      const peekExit = site.coversExit && !anyLandedOnExit;
      if (gain > bestGain || (gain === bestGain && peekExit && !bestPeekExit)) {
        bestGain = gain;
        bestSite = site;
        bestPeekExit = peekExit;
      }
    }
    if (!bestSite || bestGain === 0) break;
    for (const i of bestSite.hit) remaining.delete(i);
    if (bestSite.coversExit) anyLandedOnExit = true;
    pulses += 1;
  }

  // 所有必需的发射点都够不到出口 -> 还得为出口补一发
  if (!anyLandedOnExit) pulses += 1;
  return Math.max(1, pulses);
}

/**
 * 分析一张由等宽字符串描述的地图。
 * 任何结构性错误都会记录为 error；体验层面的问题记录为 warn。
 *
 * @param rows 地图行
 * @param hazard 陷阱参数（决定"最少尖刺代价"是否超限，以及干扰器半径的合理性）
 */
export function analyzeRows(rows: string[], hazard: HazardConfig = DEFAULT_HAZARD): MapReport {
  if (rows.length === 0) return EMPTY_REPORT;

  const errors: MapIssue[] = [];
  const warnings: MapIssue[] = [];
  const height = rows.length;
  const width = rows[0].length;

  if (width === 0) {
    return { ...EMPTY_REPORT, errors: [{ level: 'error', message: '地图首行长度为 0。' }] };
  }

  if (width < MAP_LIMITS.minWidth || width > MAP_LIMITS.maxWidth) {
    errors.push({
      level: 'error',
      message: `宽度 ${width} 超出范围（${MAP_LIMITS.minWidth} ~ ${MAP_LIMITS.maxWidth}）。`
    });
  }
  if (height < MAP_LIMITS.minHeight || height > MAP_LIMITS.maxHeight) {
    errors.push({
      level: 'error',
      message: `高度 ${height} 超出范围（${MAP_LIMITS.minHeight} ~ ${MAP_LIMITS.maxHeight}）。`
    });
  }

  let badChar = '';
  for (let y = 0; y < height; y += 1) {
    if (rows[y].length !== width) {
      errors.push({ level: 'error', message: `第 ${y + 1} 行宽度 ${rows[y].length}，应为 ${width}。` });
    }
    for (let x = 0; x < rows[y].length; x += 1) {
      if (!isTileCode(rows[y][x])) badChar = rows[y][x];
    }
  }
  if (badChar) {
    errors.push({ level: 'error', message: `存在非法字符 "${badChar}"。` });
    return build(errors, warnings, null, width, height, rows);
  }

  let starts = 0;
  let exits = 0;
  let nodes = 0;
  let floors = 0;
  let spikes = 0;
  let jammers = 0;
  for (const row of rows) {
    for (const ch of row) {
      if (ch === 'S') starts += 1;
      else if (ch === 'E') exits += 1;
      else if (ch === 'R') nodes += 1;
      else if (ch === '^') spikes += 1;
      else if (ch === '*') jammers += 1;
      if (ch !== '#') floors += 1;
    }
  }

  if (starts !== 1) errors.push({ level: 'error', message: `出生点 S 的数量为 ${starts}，必须恰好 1 个。` });
  if (exits !== 1) errors.push({ level: 'error', message: `出口 E 的数量为 ${exits}，必须恰好 1 个。` });
  if (nodes < 1) errors.push({ level: 'error', message: '至少需要 1 个共振节点 R。' });
  if (nodes > MAP_LIMITS.maxNodes) {
    errors.push({ level: 'error', message: `共振节点最多 ${MAP_LIMITS.maxNodes} 个，当前 ${nodes} 个。` });
  }
  if (floors === 0) errors.push({ level: 'error', message: '地图没有任何可通行格。' });

  if (errors.length > 0) return build(errors, warnings, null, width, height, rows);

  let map: TileMap | null = null;
  try {
    map = TileMap.fromStrings(rows, '自定义地图');
  } catch (error) {
    errors.push({ level: 'error', message: (error as Error).message });
    return build(errors, warnings, null, width, height, rows);
  }

  const withoutExit = floodFill(map, map.start, true);
  const withExit = floodFill(map, map.start, false);

  const unreachableNodes = map.resonators.filter(
    (r) => !withoutExit.visited[map.index(r.x, r.y)]
  ).length;
  if (unreachableNodes > 0) {
    errors.push({
      level: 'error',
      message: `有 ${unreachableNodes} 个共振节点无法从出生点抵达（出口关闭时）。`
    });
  }

  const exitIndex = map.index(map.exit.x, map.exit.y);
  if (!withExit.visited[exitIndex]) {
    errors.push({ level: 'error', message: '出口无法从出生点抵达。' });
  }

  // 陷阱代价：最优路线也扛不住的话，这一关实际上打不过去
  const minSpikeCost = minSpikeCostToClear(map);
  const startIsSpike = map.kindAt(map.start.x, map.start.y) === 'spike';
  if (errors.length === 0) {
    if (minSpikeCost < 0) {
      errors.push({ level: 'error', message: '无法在出口关闭的前提下走遍所有节点。' });
    } else if (minSpikeCost >= hazard.maxHealth) {
      errors.push({
        level: 'error',
        message:
          `最优路线也至少踩中 ${minSpikeCost} 次尖刺，达到生命上限 ${hazard.maxHealth}，` +
          '这一关无法通关。请减少尖刺或调高生命上限。'
      });
    } else if (minSpikeCost > 0) {
      warnings.push({
        level: 'warn',
        message: `最优路线仍需踩中 ${minSpikeCost} 次尖刺（生命 ${hazard.maxHealth}）。`
      });
    }
  }

  if (map.traps.length > 0 && hazard.jammerRadius < 1) {
    warnings.push({ level: 'warn', message: '干扰器半径为 0，回声干扰器不会产生任何效果。' });
  }
  if (startIsSpike) {
    warnings.push({ level: 'warn', message: '出生点就是尖刺，玩家开局即受伤。' });
  }

  // 体验层面的提醒：不影响可玩性
  if (nodes === 0) warnings.push({ level: 'warn', message: '没有共振节点，出口会一直开启。' });
  if (floors < 12) warnings.push({ level: 'warn', message: '可通行区域很小，可能一两步就走完了。' });
  const isolated = floors - withExit.count;
  if (isolated > 0) {
    warnings.push({ level: 'warn', message: `有 ${isolated} 个格子与主区域不连通，玩家到不了。` });
  }
  const nearStart = map.resonators.filter(
    (r) => Math.abs(r.x - map.start.x) + Math.abs(r.y - map.start.y) <= 2
  ).length;
  if (nearStart > 0) {
    warnings.push({ level: 'warn', message: '有节点紧贴出生点，探索感会弱一些。' });
  }

  return {
    width,
    height,
    floors,
    nodes,
    spikes,
    jammers,
    start: map.start,
    exit: map.exit,
    reachableWithoutExit: withoutExit.count,
    reachableWithExit: withExit.count,
    exitDistance: distanceTo(map, map.start, exitIndex),
    minSpikeCost,
    errors,
    warnings,
    valid: errors.length === 0,
    playable: errors.length === 0
  };
}

function build(
  errors: MapIssue[],
  warnings: MapIssue[],
  _map: TileMap | null,
  width: number,
  height: number,
  rows: string[]
): MapReport {
  let nodes = 0;
  let floors = 0;
  let spikes = 0;
  let jammers = 0;
  for (const row of rows) {
    for (const ch of row) {
      if (ch === 'R') nodes += 1;
      else if (ch === '^') spikes += 1;
      else if (ch === '*') jammers += 1;
      if (ch !== '#') floors += 1;
    }
  }
  return {
    width,
    height,
    floors,
    nodes,
    spikes,
    jammers,
    start: null,
    exit: null,
    reachableWithoutExit: 0,
    reachableWithExit: 0,
    exitDistance: -1,
    minSpikeCost: -1,
    errors,
    warnings,
    valid: errors.length === 0,
    playable: false
  };
}

/** 只取第一条错误，方便编辑器 / 弹窗提示 */
export function firstError(report: MapReport): string | null {
  return report.errors.length > 0 ? report.errors[0].message : null;
}

/** 校验自定义关卡的标题 */
export function normalizeTitle(title: string, fallback = '未命名关卡'): string {
  const trimmed = title.trim().slice(0, 24);
  return trimmed.length > 0 ? trimmed : fallback;
}
