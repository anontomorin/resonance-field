import { TileMap } from '../world/TileMap';

/**
 * 一次声波传播的 BFS 结果。
 *
 * distances / wallDistances 为长度 = 地图格子数的数组，-1 表示本次脉冲未抵达。
 */
export interface PropagationResult {
  /** 起点一维下标 */
  origin: number;
  /** 可通行格 -> BFS 步数距离，-1 表示未抵达 */
  distances: Int32Array;
  /** 边界墙 -> 显现距离（相邻可通行格距离 + 1），-1 表示未显现 */
  wallDistances: Int32Array;
  /** 本次脉冲实际抵达的最远距离 */
  maxDistance: number;
  /** 被抵达的可通行格数量（用于统计） */
  reachedCount: number;
  /** 被边界显影的墙格数量 */
  wallCount: number;
}

/**
 * 一次"射线照度场"传播的结果。
 *
 * intensity 为 0~1 的连续能量值：起点为 1，沿射线逐格衰减。
 * 与 BFS 结果最大的区别是它不再是"几步到达"的整数，而是"有多响"的实数，
 * 因此可以用来表达距离衰减，也能直接喂给渲染层做渐变。
 */
export interface FieldResult {
  origin: number;
  /** 可通行格 -> 照度 0~1，0 表示本次未照亮 */
  intensity: Float32Array;
  /** 边界墙 -> 照度（撞墙时注入的残留能量），0 表示未显影 */
  wallIntensity: Float32Array;
  /** 本次照明中照度的最大值（通常为 1，即起点） */
  maxIntensity: number;
  /**
   * 沿射线触及的最大格距离（切比雪夫距离）。
   *
   * 注意：这不是"照度超过阈值的格子数"。阈值属于玩法参数而非传播结果，
   * 所以"被照亮了多少格"由调用方用 `countLit()` 自行统计，
   * 避免传播函数里藏一个和配置耦合的计数。
   */
  maxDistance: number;
}

/** 8 个射线方向：4 正交 + 4 对角 */
const RAY_DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1]
];

/**
 * 基于网格 BFS 的声波传播。
 *
 * 规则：
 * 1. 起点距离为 0，脉冲开始时立即显现；
 * 2. 只沿上 / 下 / 左 / 右四个方向传播；
 * 3. 只把可通行格放入队列；
 * 4. 墙格只记入"边界墙显现集合"，不加入队列，因此声波不会穿墙；
 * 5. 距离超过 maxRange 的格子不会被本次脉冲揭示；
 * 6. 每个格子在一次脉冲中最多处理一次。
 */
export function propagate(
  map: TileMap,
  startX: number,
  startY: number,
  maxRange: number
): PropagationResult {
  const size = map.width * map.height;
  const distances = new Int32Array(size).fill(-1);
  const wallDistances = new Int32Array(size).fill(-1);

  const origin = map.index(startX, startY);
  let maxDistance = 0;
  let reachedCount = 0;
  let wallCount = 0;

  // 起点必须是可通行格；若调用方传入非法起点，直接返回空结果而不是崩溃
  if (!map.inBounds(startX, startY) || map.isWall(startX, startY)) {
    return { origin, distances, wallDistances, maxDistance, reachedCount, wallCount };
  }

  const queue: number[] = [origin];
  distances[origin] = 0;
  reachedCount = 1;

  let head = 0;
  while (head < queue.length) {
    const current = queue[head];
    head += 1;
    const cx = current % map.width;
    const cy = Math.floor(current / map.width);
    const d = distances[current];

    // 已达最大传播距离，不再向外扩散
    if (d >= maxRange) continue;

    for (let dir = 0; dir < 4; dir += 1) {
      const nx = cx + (dir === 0 ? 1 : dir === 1 ? -1 : 0);
      const ny = cy + (dir === 2 ? 1 : dir === 3 ? -1 : 0);

      // 越界忽略
      if (!map.inBounds(nx, ny)) continue;

      const nIndex = map.index(nx, ny);

      // 墙格：只做边界显影，不入队（声波不能穿墙）
      if (map.isWall(nx, ny)) {
        if (wallDistances[nIndex] === -1) {
          wallDistances[nIndex] = d + 1;
          wallCount += 1;
        }
        continue;
      }

      // 可通行格：未访问且不超过 maxRange 才入队（每格一次）
      if (distances[nIndex] !== -1) continue;
      const nd = d + 1;
      if (nd > maxRange) continue;

      distances[nIndex] = nd;
      reachedCount += 1;
      if (nd > maxDistance) maxDistance = nd;
      queue.push(nIndex);
    }
  }

  return { origin, distances, wallDistances, maxDistance, reachedCount, wallCount };
}

/**
 * 基于射线投射的声波照度场传播（"方案 B"）。
 *
 * 与 `propagate()` 的区别在于它模拟的是**能量**而不是**步数**：
 *
 * 1. 从起点向 8 个方向（4 正交 + 4 对角）各投一条射线；
 * 2. 射线按网格步进（DDA / Amanatides–Woo 走法）逐格推进，
 *    每次前进到"下一条格线"为止，保证**射线经过的每一格都被采样到**；
 * 3. 每进入一个新格，照度乘以衰减系数 `falloff`，
 *    因此距离越远能量越低 —— 这就是"距离衰减"的来源；
 * 4. 撞到墙：给墙格注入一半残留照度（表示"声波打在这面墙上"），
 *    射线立刻终止 —— 这就是"不穿墙"的来源；
 * 5. 照度低于 `epsilon` 时提前收线，省掉无意义的远距离计算。
 *
 * ## 为什么必须是 DDA 而不是"固定步长采样"
 *
 * 最初这里是"沿方向每次前进 0.5 格，取 floor 得到所在格"。看似能防穿墙，
 * 实际在 45° 方向上是错的：起点取格心偏移 (x+0.5, y+0.5) 后，
 * 对角方向的位置序列恰好是 (x±0.5, y±0.5)、(x+1, y+1)、(x+1.5, y+1.5)…
 * —— 每两步就精确落在**整数格点**上。`Math.floor(2.0)` 只会判给 (2,2)，
 * 于是 (2,1) 与 (1,2) 这两格**从未被采样**，声波从两堵墙的夹角里穿了过去。
 *
 * DDA 用"到下一格线的距离"来推进，每步必进一格、且一定落在格内而非格线，
 * 从根本上消除了这个盲区。
 *
 * 返回的是连续值，所以调用方需要自己用阈值决定"算不算看见"。
 * 阈值放在 `SonarConfig.fieldThreshold`，与游戏和评分共用同一个值。
 */
export function propagateField(
  map: TileMap,
  startX: number,
  startY: number,
  maxRange: number,
  falloff = 0.86,
  epsilon = 0.02
): FieldResult {
  const size = map.width * map.height;
  const intensity = new Float32Array(size);
  const wallIntensity = new Float32Array(size);

  const origin = map.index(startX, startY);
  // 起点必须是可通行格；非法起点返回全零场（与 propagate 的容错口径一致）
  if (map.inBounds(startX, startY) && !map.isWall(startX, startY)) {
    intensity[origin] = 1;
  } else {
    return { origin, intensity, wallIntensity, maxIntensity: 0, maxDistance: 0 };
  }

  let maxDistance = 0;

  for (const [dx, dy] of RAY_DIRS) {
    // 从格心出发
    let fx = startX + 0.5;
    let fy = startY + 0.5;
    let cx = startX;
    let cy = startY;

    // DDA 每轮前进恰好一格，所以 8 个方向共用同一个每格衰减系数：
    // 对角射线在一轮里同样只跨一格，用 falloff² 会让斜向白白多衰减一半，
    // 造成"同一圈上正交亮、对角暗"的能量各向异性（视觉上是八角星而非圆）。
    let atten = 1;

    /**
     * DDA 状态：走到下一条竖直 / 水平格线分别需要多少"参数化距离"。
     * 这里用 t 表示沿方向向量走的距离（dx/dy 为单位方向，故每格线间距为 1）。
     */
    const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
    const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
    // 到第一条格线的距离：由格心到格边是 0.5 个格宽
    let tMaxX = dx === 0 ? Infinity : Math.abs((dx > 0 ? startX + 1 - fx : fx - startX) / dx);
    let tMaxY = dy === 0 ? Infinity : Math.abs((dy > 0 ? startY + 1 - fy : fy - startY) / dy);

    for (let guard = 0; guard <= maxRange && atten > epsilon; guard += 1) {
      // 前进一格：选更近的那条格线跨过去
      if (tMaxX < tMaxY) {
        cx += dx > 0 ? 1 : -1;
        tMaxX += tDeltaX;
      } else if (tMaxY < tMaxX) {
        cy += dy > 0 ? 1 : -1;
        tMaxY += tDeltaY;
      } else {
        // 恰好同时跨两条线 —— 对角射线穿格点。两格都算作被经过，
        // 任一为墙都必须拦下（这正是"从墙缝穿过"的那条路）。
        const nx = cx + (dx > 0 ? 1 : -1);
        const ny = cy + (dy > 0 ? 1 : -1);
        if (map.inBounds(nx, cy) && map.isWall(nx, cy)) {
          const mark = atten * 0.5;
          const wi = map.index(nx, cy);
          if (mark > wallIntensity[wi]) wallIntensity[wi] = mark;
          atten = 0;
          break;
        }
        if (map.inBounds(cx, ny) && map.isWall(cx, ny)) {
          const mark = atten * 0.5;
          const wi = map.index(cx, ny);
          if (mark > wallIntensity[wi]) wallIntensity[wi] = mark;
          atten = 0;
          break;
        }
        cx = nx;
        cy = ny;
        tMaxX += tDeltaX;
        tMaxY += tDeltaY;
      }

      if (!map.inBounds(cx, cy)) break;
      const index = map.index(cx, cy);

      if (map.isWall(cx, cy)) {
        // 撞墙：留下半格能量作为"边界显影"，然后终止这条射线。
        // 取 max 而不是覆盖，保证多条射线打在同一面墙上时记最亮的那次。
        const mark = atten * 0.5;
        if (mark > wallIntensity[index]) wallIntensity[index] = mark;
        atten = 0;
        break;
      }

      // 先衰减再落账：起点本身是 1，从起点往外走第一格就该是 falloff，
      // 否则相邻两格同为 1.0，画面会出现"一圈一样亮"的断层。
      atten *= falloff;
      if (atten > intensity[index]) intensity[index] = atten;

      // 记录射线走到的格距离（切比雪夫距离），供动画时长推算
      const dist = Math.max(Math.abs(cx - startX), Math.abs(cy - startY));
      if (dist > maxDistance) maxDistance = dist;
    }
  }

  return {
    origin,
    intensity,
    wallIntensity,
    maxIntensity: 1,
    maxDistance
  };
}

/**
 * 统计照度场中超过阈值的格子数量。
 *
 * 单独拆出来是因为"数一数有多少格被照亮"这件事既不需要每次都算，
 * 也不该把阈值硬编码进 `propagateField()` —— 阈值属于玩法参数，
 * 由 `SonarConfig` 决定，传播函数只负责产生能量场。
 */
export function countLit(
  result: FieldResult,
  threshold: number
): { lit: number; litWalls: number } {
  let lit = 0;
  for (let i = 0; i < result.intensity.length; i += 1) {
    if (result.intensity[i] >= threshold) lit += 1;
  }
  let litWalls = 0;
  for (let i = 0; i < result.wallIntensity.length; i += 1) {
    if (result.wallIntensity[i] >= threshold) litWalls += 1;
  }
  return { lit, litWalls };
}
