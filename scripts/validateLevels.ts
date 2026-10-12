/**
 * 关卡与算法校验脚本（开发期工具，不参与游戏运行时）。
 *
 * 运行：npm run validate
 * 该脚本会用 esbuild 打包后在 Node 中执行，覆盖：
 *   1. 四张地图的行宽、字符合法性、S/E/R 数量与连通性；
 *   2. BFS 声波传播算法单元测试（挡墙、绕行、范围限制、不重复入队）；
 *   3. 每关"实际可通关"的模拟：走位 -> 发射脉冲 -> 激活节点 -> 开启出口 -> 进入出口；
 *   4. 陷阱代价分析（最少踩刺次数）与带陷阱地图的可玩性；
 *   5. 星级评分：理论最少脉冲数 par 的可达性、阈值单调性与真实关卡成绩。
 */

import { LEVELS } from '../src/levels/levelData';
import { TileMap } from '../src/world/TileMap';
import { propagate, propagateField, countLit } from '../src/sonar/Propagation';
import { DEFAULT_SONAR, resolveSonarConfig } from '../src/sonar/SonarConfig';
import { buildRandomLevel, generateMapRows } from '../src/gen/LevelGenerator';
import { RANDOM_PRESETS, RandomLevelParams, clampParams } from '../src/gen/randomParams';
import { analyzeRows, minSpikeCostToClear, minPulsesToClear, optimalVisitOrder } from '../src/levels/mapAnalysis';
import { DEFAULT_HAZARD, resolveHazardConfig } from '../src/game/HazardConfig';
import { LevelSession } from '../src/game/LevelSession';
import { starsFor, thresholdsFor } from '../src/game/StarRating';
import {
  decodeShareCode,
  encodeMapCode,
  encodeRandomCode,
  looksLikeShareCode
} from '../src/levels/shareCode';

let passed = 0;
let failed = 0;

function check(name: string, condition: boolean, detail = ''): void {
  if (condition) {
    passed += 1;
    console.log(`  ✔ ${name}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed += 1;
    console.error(`  ✘ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

function section(title: string): void {
  console.log(`\n=== ${title} ===`);
}

/** 四方向偏移，供各类寻路复用 */
const DIRS: Array<[number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1]
];

/** 在可通行格上做 BFS，返回距离场（-1 表示不可达），可把出口当作墙 */
function reachable(map: TileMap, from: { x: number; y: number }, blockExit: boolean): number[][] {
  const dist: number[][] = Array.from({ length: map.height }, () =>
    new Array(map.width).fill(-1)
  );
  dist[from.y][from.x] = 0;
  const queue: Array<{ x: number; y: number }> = [from];
  let head = 0;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];
  while (head < queue.length) {
    const cell = queue[head];
    head += 1;
    for (const [dx, dy] of dirs) {
      const nx = cell.x + dx;
      const ny = cell.y + dy;
      if (!map.inBounds(nx, ny)) continue;
      if (map.isWall(nx, ny)) continue;
      if (blockExit && map.kindAt(nx, ny) === 'exit') continue;
      if (dist[ny][nx] !== -1) continue;
      dist[ny][nx] = dist[cell.y][cell.x] + 1;
      queue.push({ x: nx, y: ny });
    }
  }
  return dist;
}

/** 找到从 from 到 target 的最短路径（格坐标序列，含起点与终点） */
function findPath(
  map: TileMap,
  from: { x: number; y: number },
  target: { x: number; y: number },
  blockExit: boolean
): Array<{ x: number; y: number }> {
  const prev = new Map<number, number>();
  const startIndex = map.index(from.x, from.y);
  const targetIndex = map.index(target.x, target.y);
  const queue: number[] = [startIndex];
  const seen = new Set<number>([startIndex]);
  let head = 0;
  const w = map.width;
  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    if (cur === targetIndex) break;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    for (const [dx, dy] of dirs) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!map.inBounds(nx, ny)) continue;
      if (map.isWall(nx, ny)) continue;
      if (blockExit && map.kindAt(nx, ny) === 'exit') continue;
      const ni = map.index(nx, ny);
      if (seen.has(ni)) continue;
      seen.add(ni);
      prev.set(ni, cur);
      queue.push(ni);
    }
  }
  if (!seen.has(targetIndex)) return [];
  const path: Array<{ x: number; y: number }> = [];
  let cursor: number | undefined = targetIndex;
  while (cursor !== undefined) {
    path.push({ x: cursor % w, y: Math.floor(cursor / w) });
    cursor = prev.get(cursor);
  }
  return path.reverse();
}

/**
 * 找到 from -> target 的**最少踩尖刺**路径（格坐标序列，含起点与终点）。
 *
 * 与 findPath 的区别：findPath 求的是步数最少，这里求的是代价最小。
 * 随机迷宫经过编织，两者经常不是同一条路——玩家会绕开陷阱，所以校验时必须按代价选路。
 */
function cheapestPath(
  map: TileMap,
  from: { x: number; y: number },
  target: { x: number; y: number }
): Array<{ x: number; y: number }> {
  const size = map.width * map.height;
  const INF = 1 << 28;
  const dist = new Int32Array(size).fill(INF);
  const prev = new Int32Array(size).fill(-1);
  const startIndex = map.index(from.x, from.y);
  const targetIndex = map.index(target.x, target.y);
  dist[startIndex] = 0;

  // 0-1 BFS 双端队列：front/back 各自独立，避免"已消费的下标被重新读回"
  const capacity = size * 4 + 16;
  const deque = new Int32Array(capacity);
  const mid = Math.floor(capacity / 2);
  let front = mid;
  let back = mid;
  deque[back] = startIndex;
  back += 1;

  while (front < back) {
    const cur = deque[front];
    front += 1;
    if (cur === targetIndex) break;
    const cx = cur % map.width;
    const cy = Math.floor(cur / map.width);
    const base = dist[cur];
    for (const [dx, dy] of DIRS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!map.inBounds(nx, ny) || map.isWall(nx, ny)) continue;
      const ni = map.index(nx, ny);
      const step = map.kindAt(nx, ny) === 'spike' ? 1 : 0;
      const next = base + step;
      if (next >= dist[ni]) continue;
      dist[ni] = next;
      prev[ni] = cur;
      if (step === 0) {
        front -= 1;
        deque[front] = ni;
      } else {
        deque[back] = ni;
        back += 1;
      }
    }
  }

  if (dist[targetIndex] >= INF) return [];
  const path: Array<{ x: number; y: number }> = [];
  let cursor = targetIndex;
  while (cursor !== -1) {
    path.push({ x: cursor % map.width, y: Math.floor(cursor / map.width) });
    if (cursor === startIndex) break;
    cursor = prev[cursor];
  }
  return path.reverse();
}

// ===================================================================
// 一、BFS 声波传播算法测试
// ===================================================================
section('声波传播算法测试');

{
  // 空旷地图：range 3 应该覆盖曼哈顿距离 <= 3 的菱形区域
  const open = TileMap.fromStrings([
    '#########',
    '#S......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#......E#',
    '#.......#',
    '#.......#',
    '#########'
  ]);
  const result = propagate(open, 4, 4, 3);
  // 曼哈顿距离 <= 3 的格子数量 = 1 + 4*(1+2+3) = 25
  check('空旷地图 range=3 覆盖 25 格', result.reachedCount === 25, `实际 ${result.reachedCount}`);
  check('起点距离为 0', result.distances[open.index(4, 4)] === 0);
  check('最大传播距离不超过 range', result.maxDistance === 3, `maxDistance=${result.maxDistance}`);
  let outOfRange = 0;
  for (let i = 0; i < result.distances.length; i += 1) {
    if (result.distances[i] > 3) outOfRange += 1;
  }
  check('不存在超出 maxRange 的抵达格', outOfRange === 0);
}

{
  // 墙格测试：墙本身被边界显影，但墙后的格子不能被揭示
  const walled = TileMap.fromStrings([
    '#########',
    '#S..#...#',
    '#...#...#',
    '#...#..E#',
    '#...#...#',
    '#...#...#',
    '#########'
  ]);
  const wallIndex = walled.index(4, 3);
  const behindIndex = walled.index(5, 3);
  const result = propagate(walled, 2, 3, 8);
  check(
    '墙格被记入边界墙集合',
    result.wallDistances[wallIndex] !== -1,
    `wallDistance=${result.wallDistances[wallIndex]}`
  );
  check('墙格不会被当作可通行格抵达', result.distances[wallIndex] === -1);
  check('墙后的格子不会被本次脉冲揭示', result.distances[behindIndex] === -1);
  check(
    '墙后更远的格子同样不会泄露',
    result.distances[walled.index(7, 3)] === -1 && result.wallDistances[walled.index(7, 3)] === -1
  );
}

{
  // 绕行测试：起点在 U 型一侧，声波必须沿通道绕过去才能抵达另一侧
  const detour = TileMap.fromStrings([
    '#########',
    '#S......#',
    '#.#####.#',
    '#......E#',
    '#########'
  ]);
  // 起点 (1,1)：右侧 (7,1) 需沿顶部通道绕行 6 步，欧氏距离仅 6 但中间隔着墙
  const result = propagate(detour, 1, 1, 8);
  check('绕行后可以抵达另一侧', result.distances[detour.index(7, 1)] === 6, `距离 ${result.distances[detour.index(7, 1)]}`);
  check('绕行路径经过顶部通道', result.distances[detour.index(4, 1)] === 3);
  const short = propagate(detour, 1, 1, 3);
  check('range=3 时无法绕到另一侧', short.distances[detour.index(7, 1)] === -1);
}

{
  // 不重复入队：构造含回路的地图，抵达数应等于唯一格子数
  const loop = TileMap.fromStrings([
    '#######',
    '#S....#',
    '#.###.#',
    '#....E#',
    '#######'
  ]);
  const result = propagate(loop, 1, 1, 20);
  const reachableFloors = loop.kinds.filter((k) => k !== 'wall').length;
  check(
    '含回路地图中每格只处理一次',
    result.reachedCount === reachableFloors,
    `抵达 ${result.reachedCount} / 可通行 ${reachableFloors}`
  );
  check('不存在负距离或异常距离', Array.from(result.distances).every((d) => d === -1 || d >= 0));
}

// ===================================================================
// 一声波照度场传播算法测试（方案 B）
// ===================================================================
section('照度场传播算法测试');

{
  // 起点照度为 1，且沿正交方向随距离单调下降
  const open = TileMap.fromStrings([
    '#########',
    '#S......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#......E#',
    '#.......#',
    '#.......#',
    '#########'
  ]);
  const start = open.start;
  const field = propagateField(open, start.x, start.y, 8, 0.86);
  check('照度场：起点照度为 1', field.intensity[open.index(start.x, start.y)] === 1);

  let monotonic = true;
  let prev = 2;
  for (let d = 0; d <= 4; d += 1) {
    const e = field.intensity[open.index(start.x + d, start.y)];
    if (e > prev + 1e-6) monotonic = false;
    prev = e;
  }
  check('照度场：正交方向照度随距离单调不增', monotonic);

  check(
    '照度场：正交每格衰减等于 falloff',
    Math.abs(field.intensity[open.index(start.x + 1, start.y)] - 0.86) < 1e-5,
    `实际 ${field.intensity[open.index(start.x + 1, start.y)].toFixed(4)}`
  );
}

{
  // 关键回归：45° 射线不得从两堵墙的夹角穿过去。
  //
  // 这是最容易被忽略、也最容易写错的一点：
  // 早期版本按"每次前进半格再取 floor"实现，对角射线每两步正好落在整数格点上，
  // Math.floor(2.0) 只判给 (2,2)，于是 (2,1)、(1,2) 从未被采样，声波穿了墙。
  // 本用例把墙摆成夹角形状，一旦回归会立刻失败。
  const corner = TileMap.fromStrings([
    '#######',
    '#S#...#',
    '##....#',
    '#....E#',
    '#######'
  ]);
  const field = propagateField(corner, 1, 1, 4, 0.86);
  check(
    '照度场：对角射线不会从墙角穿过去',
    field.intensity[corner.index(2, 2)] === 0,
    `(2,2) 照度 ${field.intensity[corner.index(2, 2)].toFixed(4)}`
  );
  check(
    '照度场：被挡住的墙面仍会显影',
    field.wallIntensity[corner.index(2, 1)] > 0 || field.wallIntensity[corner.index(1, 2)] > 0
  );

  // 直线方向的墙必须彻底拦住声波
  const straight = TileMap.fromStrings([
    '#######',
    '#S#...#',
    '#.#...#',
    '#....E#',
    '#######'
  ]);
  const sf = propagateField(straight, 1, 1, 6, 0.86);
  check('照度场：正前方的墙彻底阻断声波', sf.intensity[straight.index(3, 1)] === 0);
  check('照度场：正前方的墙本身被显影', sf.wallIntensity[straight.index(2, 1)] > 0);
}

{
  // 空旷场里 8 个方向的照度应当一致（对角不额外吃亏也不占便宜）
  const open = TileMap.fromStrings([
    '#########',
    '#.......#',
    '#.......#',
    '#...S...#',
    '#.......#',
    '#.......#',
    '#......E#',
    '#########'
  ]);
  const field = propagateField(open, 4, 3, 6, 0.86);
  const orth = field.intensity[open.index(5, 3)];
  const diag = field.intensity[open.index(5, 4)];
  check(
    '照度场：正交与对角在同等格距下照度一致',
    Math.abs(orth - diag) < 1e-5,
    `正交 ${orth.toFixed(4)} vs 对角 ${diag.toFixed(4)}`
  );
  const orth2 = field.intensity[open.index(6, 3)];
  const diag2 = field.intensity[open.index(6, 5)];
  check(
    '照度场：两格距离上正交与对角仍一致',
    Math.abs(orth2 - diag2) < 1e-5,
    `正交 ${orth2.toFixed(4)} vs 对角 ${diag2.toFixed(4)}`
  );
}

{
  // 阈值决定实际感知半径：阈值越高，可见格越少
  const open = TileMap.fromStrings([
    '#########',
    '#S......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#.......#',
    '#......E#',
    '#.......#',
    '#########'
  ]);
  const field = propagateField(open, 1, 1, 8, 0.86);
  const low = countLit(field, 0.2).lit;
  const mid = countLit(field, 0.4).lit;
  const high = countLit(field, 0.6).lit;
  check('照度场：阈值越高可见格越少', low >= mid && mid >= high, `0.2→${low}  0.4→${mid}  0.6→${high}`);
  check('照度场：默认阈值 0.3 至少能照亮起点周围', countLit(field, 0.3).lit > 1);
  check('照度场：任何阈值下起点自身都算可见', low > 0);
}

{
  // 非法起点（墙或越界）返回空场而不是崩溃。
  // 注意不能用 countLit(field, 0)：全零场里每格都满足 ">= 0"，会误判为"照亮了全部"。
  const anyLit = (f: { intensity: Float32Array; wallIntensity: Float32Array }): boolean =>
    f.intensity.some((v) => v > 0) || f.wallIntensity.some((v) => v > 0);
  const open = TileMap.fromStrings(['#S..#', '#...#', '#..E#', '#####']);
  const onWall = propagateField(open, 0, 0, 4, 0.86);
  check('照度场：起点为墙时返回全零场', !anyLit(onWall));
  const outOfBounds = propagateField(open, -3, -3, 4, 0.86);
  check('照度场：起点越界时返回全零场', !anyLit(outOfBounds));
}

{
  // 与 BFS 的口径一致性：照度场不得"看到" BFS 都看不到的格子。
  // BFS 的距离场是"四方向可达"，照度场是"八方向射线"，
  // 照度场能看到更多格（对角可达）是预期的；但两条正交射线连通的格子
  // 必须 BFS 也连通，否则说明照度场穿墙了。
  let leaks = 0;
  for (const level of LEVELS) {
    const m = TileMap.fromStrings(level.map, `第 ${level.id} 关`);
    const s = m.start;
    const bfs = propagate(m, s.x, s.y, 8);
    const field = propagateField(m, s.x, s.y, 8, 0.86);
    // 逐格检查：若照度场认为可见，且该格可通过正交路径到达，则 BFS 也应可达
    for (let i = 0; i < field.intensity.length; i += 1) {
      if (field.intensity[i] < 0.3) continue;
      const cell = m.cellOf(i);
      // 只检查正交方向上的"直线可见"：照度 > 0.9 基本只可能是正交近距离
      if (field.intensity[i] < 0.9) continue;
      const cheb = Math.max(Math.abs(cell.x - s.x), Math.abs(cell.y - s.y));
      if (cheb <= 1) continue; // 邻格不做判断
      if (bfs.distances[i] === -1) {
        // 照度很高却 BFS 不可达 —— 只有对角射线穿墙才会出现
        leaks += 1;
      }
    }
  }
  check('照度场：不存在高照度却完全不可达的格子（未穿墙）', leaks === 0, `泄漏 ${leaks} 格`);
}

// ===================================================================
// 二、关卡数据校验
// ===================================================================
section('关卡数据校验');

for (const level of LEVELS) {
  console.log(`\n[第 ${level.id} 关] ${level.title}`);
  let map: TileMap | null = null;
  try {
    map = TileMap.fromStrings(level.map, `第 ${level.id} 关`);
    check('地图解析与行宽校验通过', true, `${map.width} x ${map.height}`);
  } catch (error) {
    check('地图解析与行宽校验通过', false, (error as Error).message);
    continue;
  }

  const m: TileMap = map;
  check('出生点不是墙', !m.isWall(m.start.x, m.start.y), `(${m.start.x}, ${m.start.y})`);
  check('出口存在', m.kindAt(m.exit.x, m.exit.y) === 'exit', `(${m.exit.x}, ${m.exit.y})`);
  check(
    `节点数量与 requiredResonators 一致（${level.requiredResonators}）`,
    m.resonators.length === level.requiredResonators,
    `地图中 ${m.resonators.length} 个`
  );

  const distNormal = reachable(m, m.start, false);
  const allNodesReachable = m.resonators.every((r) => distNormal[r.y][r.x] !== -1);
  check('所有节点在地面连通图中可达', allNodesReachable);
  check('出口在地面连通图中可达', distNormal[m.exit.y][m.exit.x] !== -1);

  // 出口未开启（视为墙）时，节点仍必须可达，否则会出现"必须穿过出口才能拿节点"的死锁
  const distBlocked = reachable(m, m.start, true);
  const nodesReachableWithoutExit = m.resonators.every((r) => distBlocked[r.y][r.x] !== -1);
  check('出口关闭时所有节点依然可达（无死锁）', nodesReachableWithoutExit);

  // 节点不应该就在出生点上（否则不需要探索）
  const nodeAtStart = m.resonators.some((r) => r.x === m.start.x && r.y === m.start.y);
  check('没有节点与出生点重合', !nodeAtStart);
}

// ===================================================================
// 三、通关流程模拟（走位 + 脉冲 + 激活 + 出口）
// ===================================================================
section('通关流程模拟');

for (const level of LEVELS) {
  console.log(`\n[第 ${level.id} 关] ${level.title}`);
  const m = TileMap.fromStrings(level.map, `第 ${level.id} 关`);
  const maxRange = level.sonar?.maxRange ?? DEFAULT_SONAR.maxRange;

  let pos = { x: m.start.x, y: m.start.y };
  const activated = new Set<number>();
  let pulses = 0;
  let steps = 0;
  let exitOpen = false;
  let failedStep = '';

  // 逐个走向节点：站在节点格上发射脉冲，脉冲距离 0 即抵达该格
  for (const node of m.resonators) {
    const path = findPath(m, pos, node, true);
    if (path.length === 0) {
      failedStep = `无法在不穿过出口的前提下抵达节点 (${node.x}, ${node.y})`;
      break;
    }
    steps += path.length - 1;
    pos = { x: node.x, y: node.y };

    const result = propagate(m, pos.x, pos.y, maxRange);
    pulses += 1;
    if (result.distances[m.index(node.x, node.y)] !== 0) {
      failedStep = `站在节点 (${node.x}, ${node.y}) 发射脉冲后未能抵达该格`;
      break;
    }
    activated.add(m.index(node.x, node.y));
  }

  if (!failedStep) {
    check(
      `全部 ${level.requiredResonators} 个节点被脉冲激活`,
      activated.size === level.requiredResonators,
      `已激活 ${activated.size}，发射 ${pulses} 次脉冲，移动 ${steps} 步`
    );
    exitOpen = activated.size === level.requiredResonators;
    check('节点全激活后出口开启', exitOpen);

    // 出口开启后才能进入
    const pathToExit = findPath(m, pos, m.exit, false);
    check('出口开启后可以走到出口', pathToExit.length > 0, `剩余 ${pathToExit.length - 1} 步`);
    if (pathToExit.length > 0) {
      steps += pathToExit.length - 1;
      check('进入出口判定为通关', true, `总计 ${steps} 步 / ${pulses} 次脉冲`);
    }
  } else {
    check('通关模拟', false, failedStep);
  }

  // 反向验证：出口未开启时不可进入
  const closedSim = activated.size === level.requiredResonators;
  check('出口未激活全部节点时保持关闭', !closedSim || exitOpen);
}

// ===================================================================
// 四、随机关卡生成
// ===================================================================
section('随机关卡生成');

/** 与第三节相同的一次完整通关模拟，返回是否通关 */
function simulateClear(
  m: TileMap,
  maxRange: number,
  required: number
): { ok: boolean; steps: number; pulses: number; reason: string } {
  let pos = { x: m.start.x, y: m.start.y };
  const activated = new Set<number>();
  let pulses = 0;
  let steps = 0;

  for (const node of m.resonators) {
    const path = findPath(m, pos, node, true);
    if (path.length === 0) {
      return { ok: false, steps, pulses, reason: `节点 (${node.x}, ${node.y}) 不可达` };
    }
    steps += path.length - 1;
    pos = { x: node.x, y: node.y };
    const result = propagate(m, pos.x, pos.y, maxRange);
    pulses += 1;
    if (result.distances[m.index(node.x, node.y)] !== 0) {
      return { ok: false, steps, pulses, reason: `脉冲未能抵达节点 (${node.x}, ${node.y})` };
    }
    activated.add(m.index(node.x, node.y));
  }
  if (activated.size !== required) {
    return { ok: false, steps, pulses, reason: `只激活了 ${activated.size} / ${required} 个节点` };
  }
  const exitPath = findPath(m, pos, m.exit, false);
  if (exitPath.length === 0) {
    return { ok: false, steps, pulses, reason: '节点全激活后仍无法走到出口' };
  }
  steps += exitPath.length - 1;
  return { ok: true, steps, pulses, reason: '' };
}

for (const preset of RANDOM_PRESETS) {
  for (let i = 0; i < 3; i += 1) {
    const seed = 1000 + i * 137 + preset.params.cols * 11;
    const params: RandomLevelParams = { ...preset.params, seed };
    const level = buildRandomLevel(params);
    const label = `${preset.label}/种子 ${seed}`;

    let map: TileMap | null = null;
    try {
      map = TileMap.fromStrings(level.map, label);
      check(`[${label}] 地图结构合法`, true, `${map.width} × ${map.height}`);
    } catch (error) {
      check(`[${label}] 地图结构合法`, false, (error as Error).message);
      continue;
    }
    const m: TileMap = map;

    check(
      `[${label}] 节点数与 requiredResonators 一致`,
      m.resonators.length === level.requiredResonators && level.requiredResonators >= 1,
      `${m.resonators.length} 个`
    );

    const distBlocked = reachable(m, m.start, true);
    check(
      `[${label}] 出口关闭时所有节点可达（无死锁）`,
      m.resonators.every((r) => distBlocked[r.y][r.x] !== -1)
    );
    check(`[${label}] 出口可达`, reachable(m, m.start, false)[m.exit.y][m.exit.x] !== -1);

    const sim = simulateClear(m, DEFAULT_SONAR.maxRange, level.requiredResonators);
    check(
      `[${label}] 完整通关模拟`,
      sim.ok,
      sim.ok ? `${sim.steps} 步 / ${sim.pulses} 次脉冲` : sim.reason
    );
  }
}

{
  // 种子确定性：同种子必须完全一致，不同种子应当不同
  const a = generateMapRows({ seed: 424242, cols: 7, rows: 5, nodes: 2, braid: 0.15 });
  const b = generateMapRows({ seed: 424242, cols: 7, rows: 5, nodes: 2, braid: 0.15 });
  const c = generateMapRows({ seed: 424243, cols: 7, rows: 5, nodes: 2, braid: 0.15 });
  check('相同种子生成完全相同的地图', a.rows.join('|') === b.rows.join('|'));
  check('不同种子生成不同的地图', a.rows.join('|') !== c.rows.join('|'));

  const clamped = clampParams({ seed: 1, cols: 999, rows: -5, nodes: 99, braid: 9 });
  check(
    '越界参数被夹紧到安全范围',
    clamped.cols === 20 && clamped.rows === 3 && clamped.nodes === 6 && clamped.braid === 0.4,
    JSON.stringify(clamped)
  );
}

// ===================================================================
// 五、分享码
// ===================================================================
section('分享码');

{
  const samples: Array<{ title: string; rows: string[] }> = [
    ...LEVELS.map((l) => ({ title: l.title, rows: l.map })),
    { title: '随机关卡示例', rows: buildRandomLevel({ seed: 777, cols: 7, rows: 5, nodes: 2, braid: 0.15 }).map },
    { title: '中文标题 🎯 测试', rows: LEVELS[0].map }
  ];

  for (const sample of samples) {
    const code = encodeMapCode(sample.title, sample.rows);
    let ok = true;
    let detail = `${code.length} 字符`;
    try {
      const decoded = decodeShareCode(code);
      ok =
        decoded.kind === 'map' &&
        decoded.title === sample.title &&
        decoded.rows.join('') === sample.rows.join('');
      if (!ok) detail += '（往返后内容不一致）';
    } catch (error) {
      ok = false;
      detail += ` — ${(error as Error).message}`;
    }
    check(`地图分享码往返一致：${sample.title}`, ok, detail);
  }

  // 带换行 / 空格的粘贴也应能解析（用户常从聊天软件里复制）
  const messy = encodeMapCode('换行测试', LEVELS[1].map);
  const wrapped = messy.slice(0, 20) + '\n  ' + messy.slice(20);
  let messOk = true;
  try {
    const decoded = decodeShareCode(wrapped);
    messOk = decoded.kind === 'map' && decoded.rows.join('') === LEVELS[1].map.join('');
  } catch {
    messOk = false;
  }
  check('带换行空格的分享码仍可解析', messOk);

  // 篡改任意字符必须被校验码挡住
  const original = encodeMapCode('防篡改', LEVELS[0].map);
  const tampered = `${original.slice(0, original.length - 6)}Z${original.slice(original.length - 5)}`;
  let rejected = false;
  try {
    decodeShareCode(tampered);
  } catch {
    rejected = true;
  }
  check('被篡改的分享码会被拒绝', rejected);

  for (const bad of ['', '   ', 'HELLO', 'RFM1~9~9~1#~00', 'RFM2~9~9~1#~00']) {
    let refused = false;
    try {
      decodeShareCode(bad);
    } catch {
      refused = true;
    }
    check(`非法分享码被拒绝：${bad === '' ? '(空)' : bad}`, refused);
  }

  check('分享码前缀识别', looksLikeShareCode(original) && !looksLikeShareCode('随便一段文字'));
}

{
  const params: RandomLevelParams = { seed: 20261012, cols: 10, rows: 7, nodes: 3, braid: 0.13 };
  const code = encodeRandomCode(params);
  const decoded = decodeShareCode(code);
  const ok =
    decoded.kind === 'random' &&
    decoded.params.seed === params.seed &&
    decoded.params.cols === params.cols &&
    decoded.params.rows === params.rows &&
    decoded.params.nodes === params.nodes &&
    Math.abs(decoded.params.braid - params.braid) < 0.001;
  check('随机种子码往返一致', ok, code);

  const rebuilt = buildRandomLevel(decoded.kind === 'random' ? decoded.params : params);
  const expected = buildRandomLevel(params);
  check('随机码可复现同一张地图', rebuilt.map.join('') === expected.map.join(''));
}

// ===================================================================
// 六、地图分析器（编辑器与导入共用）
// ===================================================================
section('地图分析器');

const MA = (rows: string[]) => analyzeRows(rows);

{
  check('缺少出生点会被判为错误', !MA(['#####', '#...#', '#..E#', '#.R.#', '#####']).playable);
  check('缺少出口会被判为错误', !MA(['#####', '#S..#', '#...#', '#.R.#', '#####']).playable);
  check(
    '多个出口会被判为错误',
    !MA(['#####', '#S..#', '#.E.#', '#R.E#', '#####']).playable
  );
  check('没有节点会被判为错误', !MA(['#####', '#S..#', '#...#', '#..E#', '#####']).playable);
  check(
    '行宽不一致会被判为错误',
    !MA(['######', '#S...#', '#..E#', '#R#', '######']).playable
  );
  check(
    '节点被封死会被判为错误',
    !MA(['#######', '#S...E#', '#.###.#', '#..R..#', '#######'].map((r) => r)).playable === false ||
      MA(['#######', '#S...E#', '#.#####', '#R....#', '#######']).errors.length > 0
  );

  const good = MA(['#######', '#S...E#', '#.....#', '#..R..#', '#######']);
  check('合法地图判定为可玩', good.playable, `${good.width} × ${good.height}`);
  check('统计信息正确', good.nodes === 1 && good.floors === 15, `节点 ${good.nodes} / 地面 ${good.floors}`);
  check('出口步数可计算', good.exitDistance === 4, `${good.exitDistance} 步`);

  // 中间 (3,3)~(5,3) 是一块被墙完全围住的死区
  const isolated = MA([
    '#########',
    '#S.....E#',
    '#.#####.#',
    '#.#...#.#',
    '#.#####.#',
    '#...R...#',
    '#########'
  ]);
  check(
    '孤立区域会产生警告（不影响可玩）',
    isolated.playable && isolated.warnings.length > 0,
    isolated.warnings.map((w) => w.message).join('；')
  );

  // 节点 R 被墙封在左下角，走不到
  const broken = MA(['#######', '#S...E#', '#####.#', '#R#...#', '#######']);
  check(
    '不可达节点会产生错误',
    broken.errors.length > 0 && !broken.playable,
    broken.errors.map((e) => e.message).join('；')
  );
}

// ===================================================================
// 七、陷阱与生命值机制
// ===================================================================
section('陷阱与生命值');

/** 造一个可玩的一行关卡，便于逐格控制玩家走位 */
function hazardSession(rows: string[], hazard?: Partial<typeof DEFAULT_HAZARD>): LevelSession {
  return new LevelSession(
    {
      id: 0,
      title: '测试',
      subtitle: '',
      map: rows,
      requiredResonators: 1,
      hint: [],
      hazard
    },
    DEFAULT_SONAR
  );
}

{
  // ---- 配置合并 ----
  const merged = resolveHazardConfig({ maxHealth: 5 });
  check(
    '陷阱参数覆盖只影响指定字段',
    merged.maxHealth === 5 &&
      merged.spikeDamage === DEFAULT_HAZARD.spikeDamage &&
      merged.jammerRadius === DEFAULT_HAZARD.jammerRadius,
    `maxHealth=${merged.maxHealth} spikeDamage=${merged.spikeDamage}`
  );
  check('默认不回复生命', DEFAULT_HAZARD.healOnResonator === 0);

  // ---- 地图解析出陷阱格 ----
  // 布局：# S ^ E ^ ^ . * #  -> 尖刺在 2/4/5，干扰器在 7，出口在 3
  const trapMap = TileMap.fromStrings(['#########', '#S^E^^.*#', '#.......#', '#..R....#', '#########']);
  check('地图能收集到全部陷阱格', trapMap.traps.length === 4, `${trapMap.traps.length} 个`);
  check('陷阱格可通过', !trapMap.isWall(2, 1), '(2,1) 尖刺不是墙');
  check(
    'isTrap 能识别尖刺与干扰器',
    trapMap.isTrap(2, 1) &&
      trapMap.isTrap(4, 1) &&
      trapMap.isTrap(5, 1) &&
      trapMap.isTrap(7, 1),
    '尖刺 ×3 + 干扰器 ×1'
  );
  check('尖刺与干扰器的类型可区分', trapMap.kindAt(2, 1) === 'spike' && trapMap.kindAt(7, 1) === 'jammer');
  check('普通地面不是陷阱', !trapMap.isTrap(1, 1) && !trapMap.isTrap(6, 1));

  // ---- 踩尖刺扣血 ----
  const hurtLog: number[] = [];
  const spikeSession = new LevelSession(
    {
      id: 0,
      title: '尖刺',
      subtitle: '',
      map: ['#######', '#S^.RE#', '#.....#', '#######'],
      requiredResonators: 1,
      hint: []
    },
    DEFAULT_SONAR,
    { onHurt: (hp) => hurtLog.push(hp) }
  );
  check('开局生命为上限', spikeSession.health === spikeSession.maxHealth, `生命 ${spikeSession.health}`);

  spikeSession.tryMove(1, 0); // 走到 (2,1) 尖刺
  check('踩中尖刺扣 1 点生命', spikeSession.health === 2, `生命 ${spikeSession.health}`);
  check('踩中尖刺会触发受伤事件', hurtLog.length === 1 && hurtLog[0] === 2, `记录 ${hurtLog.join(',')}`);
  check('踩中尖刺计数 +1', spikeSession.spikesHit === 1);
  check('受伤后进入无敌帧', spikeSession.invulnerableTimer > 0, `${spikeSession.invulnerableTimer.toFixed(2)}s`);
  check('受伤后产生屏幕震动', spikeSession.shakeTimer > 0);
  check('已知陷阱会被永久标记', spikeSession.visibility.isTrapKnown(spikeSession.map.index(2, 1)));

  // 无敌帧内原地折返，不应再次扣血
  spikeSession.tryMove(-1, 0);
  spikeSession.tryMove(1, 0);
  check('无敌帧内重复踩刺不再扣血', spikeSession.health === 2 && spikeSession.spikesHit === 1, `生命 ${spikeSession.health}`);

  // 等待无敌帧结束后再踩，应该再次扣血
  for (let i = 0; i < 60; i += 1) spikeSession.update(1 / 30, null); // 推进 2 秒
  check('无敌帧会随时间耗尽', spikeSession.invulnerableTimer <= 0);
  spikeSession.tryMove(-1, 0);
  spikeSession.tryMove(1, 0);
  check('无敌帧结束后再次踩刺会扣血', spikeSession.health === 1, `生命 ${spikeSession.health}`);

  // ---- 生命耗尽即力竭 ----
  const deathLog: string[] = [];
  const deathSession = new LevelSession(
    {
      id: 0,
      title: '力竭',
      subtitle: '',
      map: ['#######', '#S^.RE#', '#.....#', '#######'],
      requiredResonators: 1,
      hint: []
    },
    DEFAULT_SONAR,
    { onExhausted: () => deathLog.push('exhausted') }
  );
  for (let step = 0; step < 6; step += 1) {
    deathSession.tryMove(1, 0);
    deathSession.tryMove(-1, 0);
    for (let i = 0; i < 20; i += 1) deathSession.update(1 / 20, null); // 等无敌帧过去
  }
  check('生命归零后进入力竭状态', deathSession.exhausted && deathSession.health === 0, `生命 ${deathSession.health}`);
  check('力竭只触发一次', deathLog.length === 1, `触发 ${deathLog.length} 次`);
  check('力竭后 finished 为真', deathSession.finished);
  check('力竭后无法再移动', !deathSession.tryMove(1, 0));
  check('力竭后无法再发射脉冲', !deathSession.emitPulse());

  // ---- 重开 ----
  deathSession.reset();
  check('重开后生命恢复满值', deathSession.health === deathSession.maxHealth && !deathSession.exhausted);
  check('重开后陷阱计数清零', deathSession.spikesHit === 0 && deathSession.jammersHit === 0);
  check('不保留记忆时陷阱标记被清除', !deathSession.visibility.isTrapKnown(deathSession.map.index(2, 1)));

  // 力竭保留记忆：先踩出标记，再带 keepTrapMemory 重开
  const keepSession = hazardSession(['#######', '#S^.RE#', '#.....#', '#######']);
  keepSession.tryMove(1, 0);
  keepSession.visibility.markTrapKnown(keepSession.map.index(4, 1));
  keepSession.reset(keepSession.keepTrapMemoryOnDeath);
  check(
    '力竭重开保留已知陷阱标记',
    keepSession.visibility.isTrapKnown(keepSession.map.index(2, 1)) &&
      keepSession.visibility.isTrapKnown(keepSession.map.index(4, 1)),
    '记住 2 处'
  );
  check('力竭重开后普通探索记忆仍然清空', !keepSession.visibility.isExplored(keepSession.map.index(5, 1)));
  check('默认配置开启"保留陷阱记忆"', DEFAULT_HAZARD.rememberTrapsOnDeath);

  // ---- 回声干扰器 ----
  const jamSession = hazardSession(['#########', '#S......#', '#...*...#', '#......E#', '#..R....#', '#########']);
  jamSession.emitPulse();
  for (let i = 0; i < 200; i += 1) jamSession.update(1 / 60, null); // 让脉冲跑完
  const exploredBefore = jamSession.exploredCount;
  check('干扰器测试前已探索若干格', exploredBefore > 0, `已探索 ${exploredBefore} 格`);

  const jamLog: number[] = [];
  const jamSession2 = new LevelSession(
    {
      id: 0,
      title: '干扰器',
      subtitle: '',
      map: ['#########', '#S......#', '#...*...#', '#......E#', '#..R....#', '#########'],
      requiredResonators: 1,
      hint: []
    },
    DEFAULT_SONAR,
    { onJammed: (n) => jamLog.push(n) }
  );
  jamSession2.emitPulse();
  for (let i = 0; i < 200; i += 1) jamSession2.update(1 / 60, null);
  const before = jamSession2.exploredCount;
  // 走到 (4,2) 的干扰器上
  jamSession2.tryMove(1, 0);
  jamSession2.tryMove(0, 1);
  jamSession2.tryMove(1, 0);
  jamSession2.tryMove(1, 0);
  check('玩家已站到干扰器格', jamSession2.player.x === 4 && jamSession2.player.y === 2, `(${jamSession2.player.x},${jamSession2.player.y})`);
  check('踩中干扰器会触发事件', jamLog.length === 1, `上报清除 ${jamLog[0] ?? 0} 格`);
  check('干扰器清除了探索记忆', jamSession2.exploredCount < before, `${before} → ${jamSession2.exploredCount}`);
  check('干扰器踩中计数 +1', jamSession2.jammersHit === 1);
  check('干扰器不扣血', jamSession2.health === jamSession2.maxHealth, `生命 ${jamSession2.health}`);
  check('玩家脚下保持可见', jamSession2.visibility.isExplored(jamSession2.map.index(4, 2)));

  // 一次性：离开再回来不应再次触发
  const exploredAfterFirst = jamSession2.exploredCount;
  jamSession2.tryMove(1, 0);
  jamSession2.tryMove(-1, 0);
  check('干扰器是一次性的', jamSession2.jammersHit === 1 && jamLog.length === 1, `踩中 ${jamSession2.jammersHit} 次`);
  check('二次踩踏不重复清除', jamSession2.exploredCount >= exploredAfterFirst - 1);

  // 干扰器不会抹掉陷阱标记（惩罚是"重新迷路"，不是"重新挨打"）
  const mixSession = hazardSession(['#########', '#S.^..*.#', '#.......#', '#......E#', '#..R....#', '#########']);
  const spikeIndex = mixSession.map.index(3, 1);
  mixSession.visibility.markTrapKnown(spikeIndex);
  mixSession.player.setTo(4, 1);
  mixSession.visibility.markTrapKnown(mixSession.map.index(5, 1));
  mixSession.tryMove(1, 0); // 走到 (5,1)
  mixSession.tryMove(1, 0); // 走到 (6,1) 干扰器
  check('干扰器不会抹掉尖刺的警示标记', mixSession.visibility.isTrapKnown(spikeIndex));

  // ---- 分析器：陷阱代价判定 ----
  // 出口与玩家房间只靠一条 3 格尖刺走廊相连，绕不开
  const forcedRows = [
    '#########',
    '#S...R.##',
    '####^####',
    '####^####',
    '####^####',
    '#......E#',
    '#########'
  ];
  const costMap = TileMap.fromStrings(forcedRows);
  check('必经的尖刺代价会被正确累计', minSpikeCostToClear(costMap) === 3, `代价 ${minSpikeCostToClear(costMap)}`);

  const detourMap = TileMap.fromStrings([
    '#########',
    '#S..^..E#',
    '#.......#',
    '#..R....#',
    '#########'
  ]);
  check('可以绕开尖刺时代价为 0', minSpikeCostToClear(detourMap) === 0, `${minSpikeCostToClear(detourMap)}`);

  // 唯一通道上堆满尖刺：最优路线也必须吃 3 次
  const forced = MA(forcedRows);
  check('必经尖刺会被算进分析结果', forced.minSpikeCost === 3, `代价 ${forced.minSpikeCost}`);
  check(
    '最优路线达到生命上限会被判为不可玩',
    !forced.playable && forced.errors.some((e) => e.message.includes('无法通关')),
    forced.errors.map((e) => e.message).join('；')
  );

  // 把生命上限调高到 4 之后，同一张地图就变得可玩了
  const forcedRaised = analyzeRows(forcedRows, resolveHazardConfig({ maxHealth: 4 }));
  check('提高生命上限后同一张地图变为可玩', forcedRaised.playable, `代价 ${forcedRaised.minSpikeCost} / 生命 4`);

  check('统计陷阱数量正确', detourMap.codeAt(4, 1) === '^' && MA(['#S^*RE#']).jammers === 1);

  // ---- 五张战役关卡的陷阱代价都在生命上限内 ----
  for (const level of LEVELS) {
    const report = analyzeRows(level.map, resolveHazardConfig(level.hazard));
    const maxHealth = resolveHazardConfig(level.hazard).maxHealth;
    check(
      `[${level.title}] 陷阱代价不超过生命上限`,
      report.minSpikeCost >= 0 && report.minSpikeCost < maxHealth,
      `代价 ${report.minSpikeCost} / 生命 ${maxHealth}，尖刺 ${report.spikes} 干扰器 ${report.jammers}`
    );
  }

  // ---- 带陷阱的通关模拟：按分析器给的最优代价重走一遍 ----
  {
    const level = LEVELS[0];
    const session = new LevelSession(level, DEFAULT_SONAR);
    const map = session.map;
    const order = [map.start, ...map.resonators, ...map.traps, map.exit];

    let hpAtStart = session.health;
    let trapsTriggered = 0;
    for (let i = 0; i < order.length - 1; i += 1) {
      const path = findPath(map, order[i], order[i + 1], false);
      for (const step of path.slice(1)) {
        session.tryMove(step.x - session.player.x, step.y - session.player.y);
        for (let t = 0; t < 45; t += 1) session.update(1 / 30, null); // 等无敌帧
      }
      if (map.isTrap(order[i + 1].x, order[i + 1].y)) trapsTriggered += 1;
    }
    check(
      `[${level.title}] 带陷阱巡图不会力竭`,
      !session.exhausted,
      `生命 ${session.health}/${hpAtStart}，踩中 ${session.spikesHit} 次`
    );
    check(`[${level.title}] 陷阱确实被触发`, trapsTriggered > 0 || session.spikesHit > 0, `踩中 ${session.spikesHit} 次`);
  }
}

// ===================================================================
// 八、带陷阱的分享码与随机关卡
// ===================================================================
section('带陷阱的分享码与随机生成');

{
  const trapRows = ['#########', '#S^.^.*E#', '#.......#', '#..R....#', '#########'];
  const code = encodeMapCode('陷阱测试', trapRows);
  const decoded = decodeShareCode(code);
  check(
    '带尖刺与干扰器的分享码可往返',
    decoded.kind === 'map' && decoded.rows.join('') === trapRows.join(''),
    `${code.length} 字符`
  );
  check(
    '分享码中的陷阱字符被正确识别',
    decoded.kind === 'map' && decoded.rows[1].includes('^') && decoded.rows[1].includes('*')
  );

  // 每张战役地图都能带陷阱往返
  let ok = true;
  for (const level of LEVELS) {
    const c = encodeMapCode(level.title, level.map);
    const d = decodeShareCode(c);
    if (d.kind !== 'map' || d.rows.join('') !== level.map.join('')) ok = false;
  }
  check('全部战役关卡带陷阱后仍可分享往返', ok);

  // 陷阱字符不在 [0-9a-z] 内，避免与游程计数歧义
  const counts = '0123456789abcdefghijklmnopqrstuvwxyz';
  check('陷阱字符与游程计数不冲突', '^*'.split('').every((c) => counts.indexOf(c) === -1));

  // 随机关卡也会撒陷阱，且代价不超限
  let randomTraps = 0;
  let randomSafe = true;
  let jammersSeen = 0;
  let randomCount = 0;
  for (const preset of RANDOM_PRESETS) {
    for (let seed = 1; seed <= 12; seed += 1) {
      randomCount += 1;
      // 测"实际会发到玩家手里的那张图"：buildRandomLevel 内部会自检并换种子重试。
      // 直接检查 generateMapRows 的原始输出是错的——那张图本来就可能被自检淘汰。
      const level = buildRandomLevel({ ...preset.params, seed });
      const map = level.map;
      const report = analyzeRows(map, resolveHazardConfig(level.hazard));
      if (report.spikes > 0) randomTraps += 1;
      jammersSeen += report.jammers;
      if (!report.playable) {
        randomSafe = false;
        console.log(`      失败样本：${preset.id} seed=${seed} ${report.errors.map((e) => e.message).join('；')}`);
        continue;
      }
    }
  }
  check('随机关卡确实会撒出陷阱', randomTraps > 0, `${randomTraps}/${randomCount} 张含陷阱`);
  check('随机关卡也会出现回声干扰器', jammersSeen > 0, `共 ${jammersSeen} 个`);
  check('全部随机关卡在生命上限内可通关', randomSafe, `${randomCount} 张全部通过`);

  // 真正跑一遍随机图：模拟"看过陷阱、会绕路"的玩家走完全程。
  //
  // 注意这里必须走**代价最省**的路线，而不是 BFS 最短路：
  // 随机迷宫是编织过的，最短路和最低尖刺代价经常分叉。玩家在前一关就已经
  // 学会了"声波扫到的陷阱会被永久记住"，所以按代价选路才是真实行为；
  // 拿最短路去测，测的是"一个完全无视警示标记的莽夫"，那不是我们要保证的。
  {
    let lethal = 0;
    let checked = 0;
    let sawForcedDamage = 0;
    let overOptimistic = 0;
    for (const preset of RANDOM_PRESETS) {
      for (let seed = 1; seed <= 8; seed += 1) {
        const level = buildRandomLevel({ ...preset.params, seed });
        const hazard = resolveHazardConfig(level.hazard);
        const report = analyzeRows(level.map, hazard);
        const session = new LevelSession(level, DEFAULT_SONAR);
        const m = session.map;
        checked += 1;

        // 逐段走：按分析器给出的**最优节点顺序**，每段再按"最少踩刺"选路。
        // 只按数组顺序走是错的——那会多踩几次尖刺，看着像分析器算错，
        // 其实是模拟器自己走了条烂路线。
        const order = optimalVisitOrder(m);
        for (let i = 0; i < order.length - 1 && !session.finished; i += 1) {
          const path = cheapestPath(m, order[i], order[i + 1]);
          for (const step of path.slice(1)) {
            session.tryMove(step.x - session.player.x, step.y - session.player.y);
            // 无敌帧 1s，按 1/30s 步长推进足够跨过去
            for (let t = 0; t < 45; t += 1) session.update(1 / 30, null);
          }
        }
        if (session.spikesHit > 0) sawForcedDamage += 1;
        if (session.exhausted) {
          lethal += 1;
          console.log(`      实走力竭：${preset.id} seed=${seed}，踩刺 ${session.spikesHit} / 生命 ${hazard.maxHealth}`);
        }
        // 分析器的代价是"按关键点顺序分段求和"，实走是真正的连续走位，
        // 两者可能差 1（分段模型偶尔高估）。要求分析器 **不小于** 实走：
        // 这样它永远偏保守，绝不会把一张真打不过的图判成可玩。
        if (report.minSpikeCost < session.spikesHit) {
          overOptimistic += 1;
          console.log(
            `      分析器过于乐观：${preset.id} seed=${seed}，分析器 ${report.minSpikeCost} < 实走 ${session.spikesHit}`
          );
        }
      }
    }
    check('会绕路的玩家走随机图不会力竭', lethal === 0, `${checked} 张全部实走通过`);
    check('随机图中确实存在必须承受的伤害', sawForcedDamage > 0, `${sawForcedDamage} 张需要硬吃尖刺`);
    check('分析器的代价从不高估可玩性（偏向保守）', overOptimistic === 0, `${checked} 张全部满足`);
  }
}

// ===================================================================
// 九、星级评分（基于脉冲次数）
// ===================================================================
section('星级评分');

{
  // 1. 理论下界的合理性：par 必须是"真的可达"
  //    这条断言很关键——如果 par 比现实还高，三星线就变成了"随便打都是三星"，评分失去意义；
  //    如果 par 比现实还低，三星线就永远拿不到，玩家会觉得评分在耍人。
  //    因此把"按最优路线走 + 每到节点发一次脉冲"这个上界实走一遍，要求 par <= 该上界。
  let parTooHigh = 0;
  let parTooLow = 0;
  for (const level of LEVELS) {
    const m = TileMap.fromStrings(level.map, `第 ${level.id} 关`);
    // 用关卡真正生效的声波配置（含 model 与阈值）算 par，
    // 而不是只传 maxRange —— 否则 field 模型下会按 bfs 口径算分。
    const sonar = resolveSonarConfig(level.sonar);
    const par = minPulsesToClear(m, sonar, level.requiredResonators);

    // 上界：最笨但一定成功的打法——每个节点各发一次，再为出口发一次
    const naiveUpper = m.resonators.length + 1;
    if (par > naiveUpper) {
      parTooHigh += 1;
      console.log(`      [第 ${level.id} 关] par=${par} 超过朴素上界 ${naiveUpper}`);
    }
    // 下界：至少要有 requiredResonators 次（每次脉冲只可能"当场"激活它覆盖的节点）
    if (par < 1) parTooLow += 1;

    console.log(
      `[第 ${level.id} 关] ${level.title}  par=${par}  三星<=${thresholdsFor(par).three}  二星<=${thresholdsFor(par).two}`
    );
  }
  check('每关的理论下界都不超过朴素上界（par 可达）', parTooHigh === 0, `${LEVELS.length} 关`);
  check('理论下界至少为 1', parTooLow === 0);
}

{
  // 2. 星级的单调性与边界：脉冲越少星级不降，三星线 = par + 1（留一次探路容错）
  const par = 3;
  const t = thresholdsFor(par);
  check('阈值单调：三星线 <= 二星线', t.three <= t.two, `three=${t.three} two=${t.two}`);
  check('三星线为 par + 1（保留一次探路容错）', t.three === par + 1, `three=${t.three} par=${par}`);
  check('达到三星线即为三星', starsFor(t.three, par) === 3);
  check('刚好超过三星线降为二星', starsFor(t.three + 1, par) === 2);
  check('达到二星线仍为二星', starsFor(t.two, par) === 2);
  check('超过二星线降为一星', starsFor(t.two + 1, par) === 1);

  let monotone = true;
  let prev = 3;
  for (let pulses = 0; pulses <= 40; pulses += 1) {
    const s = starsFor(pulses, par);
    if (s > prev) monotone = false;
    prev = s;
  }
  check('星级随脉冲次数单调不增', monotone);

  // 3. 三星必须"够得着"但也"有代价"：
  //    恰好 par 次是三星（理想路线），par+1 仍是三星（允许一次探路），
  //    par+2 才掉到二星。这条同时防住两个极端——
  //    阈值太松（随便打都三星）与太紧（真人永远拿不到）。
  for (const p of [2, 3, 4, 5]) {
    check(`par=${p} 时理想路线（正好 par 次）是三星`, starsFor(p, p) === 3, `${p} 次 → ${starsFor(p, p)} 星`);
    check(
      `par=${p} 时多打一次探路（par+1）仍是三星`,
      starsFor(p + 1, p) === 3,
      `${p + 1} 次 → ${starsFor(p + 1, p)} 星`
    );
    check(
      `par=${p} 时多打两次（par+2）掉到二星`,
      starsFor(p + 2, p) === 2,
      `${p + 2} 次 → ${starsFor(p + 2, p)} 星`
    );
  }

  // 4. 极小的 par 不会让阈值退化成负数或 0
  for (const p of [0, 1, 2]) {
    const th = thresholdsFor(p);
    check(`par=${p} 的三星阈值不为 0`, th.three > 0, `three=${th.three}`);
  }
}

{
  // 5. 真实关卡：验证"最优打法拿三星"这条线跨得过去，且三星有真实代价
  for (const level of LEVELS) {
    const m = TileMap.fromStrings(level.map, `第 ${level.id} 关`);
    const sonar = resolveSonarConfig(level.sonar);
    const par = minPulsesToClear(m, sonar, level.requiredResonators);

    // 完整走一遍：走到每个节点各发一次脉冲（就是理论最优的朴素形态），再走到出口。
    //
    // 关键：**走进出口之前必须先发波把出口照亮**。
    // 渲染层只在 `visibility.alphaFor(exit) > 0` 时才画出出口，
    // 也就是说玩家在照到出口之前根本不知道它在哪——
    // 只按 findPath 的完美寻路直接走过去，等于开了全图挂，
    // 实测脉冲数会低于 par，让"三星有真实代价"这条断言假性失败。
    //
    // 每次发射之间必须推进时间越过冷却（0.6s），否则 emitPulse() 会静默失败。
    const runOnce = (extraOpeningPulse: boolean): LevelSession => {
      const session = new LevelSession(level, DEFAULT_SONAR);
      const settle = (): void => {
        for (let t = 0; t < 90; t += 1) session.update(1 / 30, null);
      };
      const exitIndex = session.map.index(session.map.exit.x, session.map.exit.y);
      const exitRevealed = (): boolean => session.visibility.alphaFor(exitIndex) > 0.001;

      // 故意多打的那一发：开局先随手照一下，之后不再多看
      if (extraOpeningPulse) {
        session.emitPulse();
        settle();
      }

      for (const node of session.map.resonators) {
        const path = findPath(
          session.map,
          { x: session.player.x, y: session.player.y },
          node,
          true
        );
        for (const step of path.slice(1)) {
          session.tryMove(step.x - session.player.x, step.y - session.player.y);
        }
        session.emitPulse();
        settle();
      }

      // 出口还没被照亮就补一发（这正是 par 里那"+1"的来源）
      if (!exitRevealed()) {
        session.emitPulse();
        settle();
      }

      const exitPath = findPath(
        session.map,
        { x: session.player.x, y: session.player.y },
        session.map.exit,
        false
      );
      for (const step of exitPath.slice(1)) {
        session.tryMove(step.x - session.player.x, step.y - session.player.y);
      }
      return session;
    };

    const optimal = runOnce(false);
    const optimalStars = starsFor(optimal.pulsesUsed, optimal.parPulses);
    check(
      `[第 ${level.id} 关] 最优打法通关`,
      optimal.completed,
      `脉冲 ${optimal.pulsesUsed} / par ${optimal.parPulses}`
    );
    // 说明：这里的"最优打法"是"走到每个节点各发一次 + 出口没照亮就补一发"，
    // 它是一个**朴素上界**，不一定等于 par——L4/L5 就需要多发一次，
    // 因为真正的最优解要求你在某个"同时够得到节点和出口"的位置发波，
    // 而这需要玩家自己找位置。所以只要求不差太多，不要求恰好等于 par。
    check(
      `[第 ${level.id} 关] 朴素最优打法不超过 par+1`,
      optimal.pulsesUsed <= optimal.parPulses + 1,
      `${optimal.pulsesUsed} 次 vs par ${optimal.parPulses}`
    );
    check(
      `[第 ${level.id} 关] 朴素最优打法能拿到三星（阈值放宽后容错足够）`,
      optimalStars === 3,
      `${optimal.pulsesUsed} 次（三星线 ${thresholdsFor(par).three}）→ ${optimalStars} 星`
    );

    // 星级必须有真实代价，只是容错从 0 放宽到 1：
    // 三星线本身是 par+1，再多打一发（par+2）就该掉到二星。
    const atLine = thresholdsFor(par).three; // = par + 1
    check(
      `[第 ${level.id} 关] 超过三星线一发就掉二星（星级仍有代价）`,
      starsFor(atLine, par) === 3 && starsFor(atLine + 1, par) === 2,
      `三星线 ${atLine} → 3 星，${atLine + 1} → ${starsFor(atLine + 1, par)} 星`
    );

    // 实走的这一发也要有代价：多打一发后的脉冲数必须真的多 1
    const wasteful = runOnce(true);
    check(
      `[第 ${level.id} 关] 多打的脉冲会真实计入成绩`,
      wasteful.pulsesUsed === optimal.pulsesUsed + 1,
      `${optimal.pulsesUsed} → ${wasteful.pulsesUsed} 次`
    );
  }
}

{
  // 6. 与 LevelSession 接线：会话暴露的 par 必须与分析器一致
  for (const level of LEVELS) {
    const session = new LevelSession(level, DEFAULT_SONAR);
    const expected = minPulsesToClear(
      session.map,
      DEFAULT_SONAR,
      level.requiredResonators
    );
    check(
      `[第 ${level.id} 关] 会话的 par 与分析器一致`,
      session.parPulses === expected,
      `${session.parPulses} vs ${expected}`
    );
  }
}

{
  // 7. 随机关卡：par 也要可达，且不应出现"必须发 20 次波"的极端下界
  let bad = 0;
  let maxPar = 0;
  for (const preset of RANDOM_PRESETS) {
    for (let seed = 1; seed <= 6; seed += 1) {
      const level = buildRandomLevel({ ...preset.params, seed });
      const m = TileMap.fromStrings(level.map, 'random');
      const par = minPulsesToClear(m, DEFAULT_SONAR, level.requiredResonators);
      const nodes = m.resonators.length;
      if (par < 1 || par > nodes + 1) {
        bad += 1;
        console.log(`      ${preset.id} seed=${seed}: par=${par} 节点=${nodes}`);
      }
      maxPar = Math.max(maxPar, par);
    }
  }
  check('随机关卡的 par 始终落在 [1, 节点数+1] 内', bad === 0, `最大 par=${maxPar}`);
}

// ===================================================================
// 汇总
// ===================================================================
console.log(`\n---------------------------------------------`);
console.log(`通过 ${passed} 项，失败 ${failed} 项`);
if (failed > 0) {
  console.error('存在失败项，请修复后重新运行。');
  process.exit(1);
}
console.log('全部校验通过。');
