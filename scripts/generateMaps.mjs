/**
 * 开发期工具：生成关卡地图字符串（不参与游戏运行时）。
 *
 * 用法：node scripts/generateMaps.mjs
 * 输出可直接粘贴进 src/levels/levelData.ts 的等宽字符串数组，
 * 随后必须用 `npm run validate` 校验行宽、连通性与节点可达性。
 *
 * 算法：递归回溯法生成基础迷宫 -> 少量"编织"（打通部分墙形成回路与小房间）
 *      -> BFS 计算距离 -> 把出生点/出口/共振节点放在距离较远的位置与死路末端。
 */

/** 简单可复现的伪随机数发生器 */
function makeRandom(seed) {
  let s = seed >>> 0;
  return function random() {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 4294967296;
  };
}

/** 递归回溯生成迷宫：grid[y][x] = 1 表示该单元已访问，links 保存已打通的相邻单元对 */
function carveMaze(cols, rows, rand) {
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const visited = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const links = new Set();
  const stack = [[0, 0]];
  visited[0][0] = true;
  grid[0][0] = 1;

  const linkKey = (ax, ay, bx, by) => `${ax},${ay}|${bx},${by}`;

  while (stack.length > 0) {
    const [cx, cy] = stack[stack.length - 1];
    const options = [];
    if (cy > 0 && !visited[cy - 1][cx]) options.push([cx, cy - 1]);
    if (cy < rows - 1 && !visited[cy + 1][cx]) options.push([cx, cy + 1]);
    if (cx > 0 && !visited[cy][cx - 1]) options.push([cx - 1, cy]);
    if (cx < cols - 1 && !visited[cy][cx + 1]) options.push([cx + 1, cy]);

    if (options.length === 0) {
      stack.pop();
      continue;
    }
    const pick = options[Math.floor(rand() * options.length)];
    visited[pick[1]][pick[0]] = true;
    grid[pick[1]][pick[0]] = 1;
    links.add(linkKey(cx, cy, pick[0], pick[1]));
    links.add(linkKey(pick[0], pick[1], cx, cy));
    stack.push(pick);
  }
  return { grid, links };
}

/** 把迷宫放大成字符地图（墙厚度为 1 格） */
function toCharGrid(grid, links, rand, braidRatio) {
  const rows = grid.length;
  const cols = grid[0].length;
  const h = rows * 2 + 1;
  const w = cols * 2 + 1;
  const out = Array.from({ length: h }, () => new Array(w).fill('#'));
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (grid[y][x] === 1) out[y * 2 + 1][x * 2 + 1] = '.';
    }
  }
  // 按已打通的单元对连接通道
  for (let y = 0; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (grid[y][x] !== 1) continue;
      if (x < cols - 1 && links.has(`${x},${y}|${x + 1},${y}`)) out[y * 2 + 1][x * 2 + 2] = '.';
      if (y < rows - 1 && links.has(`${x},${y}|${x},${y + 1}`)) out[y * 2 + 2][x * 2 + 1] = '.';
    }
  }

  // 编织：随机打通一部分额外的墙，形成回路与小空地，避免纯树状迷宫过于单调
  const candidates = [];
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
    const idx = Math.floor(rand() * candidates.length);
    const [x, y] = candidates[idx];
    candidates.splice(idx, 1);
    out[y][x] = '.';
  }

  return out;
}

/** BFS 距离场 */
function distanceField(out, sx, sy) {
  const h = out.length;
  const w = out[0].length;
  const dist = Array.from({ length: h }, () => new Array(w).fill(-1));
  dist[sy][sx] = 0;
  const queue = [[sx, sy]];
  let head = 0;
  while (head < queue.length) {
    const [x, y] = queue[head];
    head += 1;
    const dirs = [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1]
    ];
    for (const [dx, dy] of dirs) {
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

function floorCells(out) {
  const cells = [];
  for (let y = 0; y < out.length; y += 1) {
    for (let x = 0; x < out[0].length; x += 1) {
      if (out[y][x] !== '#') cells.push([x, y]);
    }
  }
  return cells;
}

function neighborCount(out, x, y) {
  let n = 0;
  const dirs = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];
  for (const [dx, dy] of dirs) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= out[0].length || ny >= out.length) continue;
    if (out[ny][nx] !== '#') n += 1;
  }
  return n;
}

function minGapSafe(cols, rows) {
  return Math.max(5, Math.floor((cols + rows) / 3));
}

function build(seed, cols, rows, nodeCount, braidRatio) {
  const rand = makeRandom(seed);
  const maze = carveMaze(cols, rows, rand);
  const out = toCharGrid(maze.grid, maze.links, rand, braidRatio);
  const cells = floorCells(out);

  // 出生点：靠左上的通道格
  let start = cells[0];
  for (const [x, y] of cells) {
    if (x + y < start[0] + start[1]) start = [x, y];
  }
  const dist = distanceField(out, start[0], start[1]);

  // 出口：距离出生点最远的格
  let exitCell = start;
  for (const [x, y] of cells) {
    if (dist[y][x] > dist[exitCell[1]][exitCell[0]]) exitCell = [x, y];
  }

  // 共振节点：优先放在死路末端，要求离出生点足够远，并且彼此保持距离
  const minStartDist = Math.max(10, Math.floor((cols + rows) * 0.45));
  const deadEnds = cells.filter(
    ([x, y]) => neighborCount(out, x, y) === 1 && dist[y][x] >= minStartDist
  );
  const farCells = cells.filter(([x, y]) => dist[y][x] >= minStartDist);
  const pool = deadEnds.length >= nodeCount ? deadEnds : farCells;
  pool.sort((a, b) => dist[b[1]][b[0]] - dist[a[1]][a[0]]);

  const near = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) < minGapSafe(cols, rows);
  const chosen = [];
  for (const cell of pool) {
    if (cell[0] === start[0] && cell[1] === start[1]) continue;
    if (cell[0] === exitCell[0] && cell[1] === exitCell[1]) continue;
    if (near(cell, start) || near(cell, exitCell)) continue;
    if (chosen.some((c) => near(c, cell))) continue;
    chosen.push(cell);
    if (chosen.length === nodeCount) break;
  }
  // 若死路不够分散，则退化为从远到近补足
  const fallback = farCells.slice().sort((a, b) => dist[b[1]][b[0]] - dist[a[1]][a[0]]);
  for (const cell of fallback) {
    if (chosen.length === nodeCount) break;
    if (cell[0] === start[0] && cell[1] === start[1]) continue;
    if (cell[0] === exitCell[0] && cell[1] === exitCell[1]) continue;
    if (chosen.some((c) => c[0] === cell[0] && c[1] === cell[1])) continue;
    chosen.push(cell);
  }

  out[start[1]][start[0]] = 'S';
  out[exitCell[1]][exitCell[0]] = 'E';
  for (const [x, y] of chosen) out[y][x] = 'R';

  return {
    rows: out.map((r) => r.join('')),
    start,
    exit: exitCell,
    nodes: chosen,
    dist
  };
}

const level3 = build(20261012, 11, 7, 2, 0.14);
const level4 = build(918273, 14, 9, 3, 0.12);

function print(name, result) {
  console.log(`// ===== ${name} =====`);
  console.log(`// 起点 (${result.start[0]}, ${result.start[1]})  出口 (${result.exit[0]}, ${result.exit[1]})`);
  console.log(`// 节点: ${result.nodes.map((c) => `(${c[0]}, ${c[1]}) 距离 ${result.dist[c[1]][c[0]]}`).join('  ')}`);
  console.log('[');
  for (const row of result.rows) {
    console.log(`      '${row}',`);
  }
  console.log(']');
  console.log(`// 尺寸: ${result.rows[0].length} x ${result.rows.length}`);
  console.log('');
}

print('回声走廊', level3);
print('共振核心', level4);
