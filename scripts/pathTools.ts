import { TileMap } from '../src/world/TileMap';

export interface Point {
  x: number;
  y: number;
}

/**
 * 在可通行格上求最短路径（含起点与终点）。
 * @param blockExit 是否把出口当作墙（用于验证"出口未开启时节点仍可达"）
 */
export function findPath(
  map: TileMap,
  from: Point,
  target: Point,
  blockExit: boolean
): Point[] {
  const w = map.width;
  const startIndex = map.index(from.x, from.y);
  const targetIndex = map.index(target.x, target.y);
  const prev = new Map<number, number>();
  const seen = new Set<number>([startIndex]);
  const queue: number[] = [startIndex];
  let head = 0;

  const dirs: Array<[number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1]
  ];

  while (head < queue.length) {
    const cur = queue[head];
    head += 1;
    if (cur === targetIndex) break;
    const cx = cur % w;
    const cy = Math.floor(cur / w);
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
  const path: Point[] = [];
  let cursor: number | undefined = targetIndex;
  while (cursor !== undefined) {
    path.push({ x: cursor % w, y: Math.floor(cursor / w) });
    cursor = prev.get(cursor);
  }
  return path.reverse();
}

/** 把相邻格之间的移动转换成方向键序列 */
export function pathToKeys(path: Point[]): string[] {
  const keys: string[] = [];
  for (let i = 1; i < path.length; i += 1) {
    const dx = path[i].x - path[i - 1].x;
    const dy = path[i].y - path[i - 1].y;
    if (dx === 1) keys.push('ArrowRight');
    else if (dx === -1) keys.push('ArrowLeft');
    else if (dy === 1) keys.push('ArrowDown');
    else if (dy === -1) keys.push('ArrowUp');
  }
  return keys;
}
