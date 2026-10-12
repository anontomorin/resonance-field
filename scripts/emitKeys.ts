/**
 * 开发期工具：为指定关卡生成"完整通关"的逐段路径。
 *
 * 用法：npm run emit-keys -- <关卡序号，从 0 开始>
 * 输出 JSON：{ level, segments: [[{x,y}, ...], ...] }
 * 除最后一段（走向出口）外，每段终点都是一个共振节点，抵达后需要按一次 Space。
 */

import { LEVELS } from '../src/levels/levelData';
import { TileMap } from '../src/world/TileMap';
import { findPath, Point } from './pathTools';

const index = Number(process.argv[2] ?? '0');
const level = LEVELS[index];
if (!level) {
  console.error(`关卡序号 ${index} 不存在（0 ~ ${LEVELS.length - 1}）`);
  process.exit(1);
}

const map = TileMap.fromStrings(level.map, level.title);
const segments: Point[][] = [];
let pos: Point = { x: map.start.x, y: map.start.y };

for (const node of map.resonators) {
  const path = findPath(map, pos, node, true);
  if (path.length === 0) throw new Error(`无法抵达节点 (${node.x}, ${node.y})`);
  segments.push(path);
  pos = node;
}

const exitPath = findPath(map, pos, map.exit, false);
if (exitPath.length === 0) throw new Error('无法抵达出口');
segments.push(exitPath);

console.log(JSON.stringify({ level: level.title, segments }));
