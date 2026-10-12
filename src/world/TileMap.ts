import {
  TileCode,
  TileKind,
  TILE_CODE_TO_KIND,
  isTileCode,
  isPassableKind,
  isTrapKind
} from './TileType';

/** 网格坐标 */
export interface Cell {
  x: number;
  y: number;
}

/**
 * 二维网格地图。
 * 负责解析关卡字符串、校验尺寸与关键格，并提供坐标访问接口。
 * 该模块不依赖 DOM，可在 Node 中直接用于关卡校验。
 */
export class TileMap {
  readonly width: number;
  readonly height: number;
  /** 原始字符，按 row-major 展开 */
  readonly codes: TileCode[];
  /** 逻辑类型，按 row-major 展开 */
  readonly kinds: TileKind[];
  readonly start: Cell;
  readonly exit: Cell;
  readonly resonators: Cell[];
  /** 所有陷阱格（尖刺 ^ 与回声干扰器 *），可通行但有代价 */
  readonly traps: Cell[];

  private constructor(init: {
    width: number;
    height: number;
    codes: TileCode[];
    kinds: TileKind[];
    start: Cell;
    exit: Cell;
    resonators: Cell[];
    traps: Cell[];
  }) {
    this.width = init.width;
    this.height = init.height;
    this.codes = init.codes;
    this.kinds = init.kinds;
    this.start = init.start;
    this.exit = init.exit;
    this.resonators = init.resonators;
    this.traps = init.traps;
  }

  /**
   * 从等宽字符串数组构建地图，并进行完整性校验。
   * 任何数据错误都直接抛出带关卡名的错误，避免静默加载出空白画面。
   */
  static fromStrings(rows: string[], levelName = '关卡'): TileMap {
    if (rows.length === 0) {
      throw new Error(`[${levelName}] 地图为空，至少需要一行。`);
    }

    const width = rows[0].length;
    if (width === 0) {
      throw new Error(`[${levelName}] 地图首行长度为 0。`);
    }

    rows.forEach((row, y) => {
      if (row.length !== width) {
        throw new Error(
          `[${levelName}] 第 ${y} 行宽度为 ${row.length}，应为 ${width}（所有行必须等宽）。`
        );
      }
      for (let x = 0; x < row.length; x += 1) {
        const ch = row[x];
        if (!isTileCode(ch)) {
          throw new Error(`[${levelName}] 第 ${y} 行第 ${x} 列出现非法字符 "${ch}"。`);
        }
      }
    });

    const height = rows.length;
    const codes: TileCode[] = new Array(width * height);
    const kinds: TileKind[] = new Array(width * height);
    const resonators: Cell[] = [];
    const traps: Cell[] = [];
    let start: Cell | null = null;
    let exit: Cell | null = null;

    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const code = rows[y][x] as TileCode;
        const index = y * width + x;
        codes[index] = code;
        kinds[index] = TILE_CODE_TO_KIND[code];
        if (code === 'S') {
          if (start !== null) {
            throw new Error(`[${levelName}] 存在多个出生点 S。`);
          }
          start = { x, y };
        } else if (code === 'E') {
          if (exit !== null) {
            throw new Error(`[${levelName}] 存在多个出口 E。`);
          }
          exit = { x, y };
        } else if (code === 'R') {
          resonators.push({ x, y });
        } else if (code === '^' || code === '*') {
          traps.push({ x, y });
        }
      }
    }

    if (start === null) {
      throw new Error(`[${levelName}] 缺少出生点 S。`);
    }
    if (exit === null) {
      throw new Error(`[${levelName}] 缺少出口 E。`);
    }

    return new TileMap({
      width,
      height,
      codes,
      kinds,
      start,
      exit,
      resonators,
      traps
    });
  }

  /** 一维下标 */
  index(x: number, y: number): number {
    return y * this.width + x;
  }

  /** 由一维下标还原坐标 */
  cellOf(index: number): Cell {
    return { x: index % this.width, y: Math.floor(index / this.width) };
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  kindAt(x: number, y: number): TileKind {
    if (!this.inBounds(x, y)) return 'wall';
    return this.kinds[this.index(x, y)];
  }

  codeAt(x: number, y: number): TileCode {
    if (!this.inBounds(x, y)) return '#';
    return this.codes[this.index(x, y)];
  }

  isWall(x: number, y: number): boolean {
    return this.kindAt(x, y) === 'wall';
  }

  /** 声波层面是否可通过（出口允许声波穿过，陷阱不挡声波也不挡路） */
  isPassable(x: number, y: number): boolean {
    return !this.inBounds(x, y) ? false : isPassableKind(this.kinds[this.index(x, y)]);
  }

  /** 是否为陷阱格 */
  isTrap(x: number, y: number): boolean {
    if (!this.inBounds(x, y)) return false;
    return isTrapKind(this.kinds[this.index(x, y)]);
  }

  /**
   * 所有可通行格（墙以外的一切：地面、出生点、节点、出口、陷阱）。
   *
   * 每次调用都现算一遍：地图构建后不可变，但调用方（关卡分析）通常只调用一两次，
   * 为此维护一份缓存反而增加状态与同步成本。
   */
  floorCells(): Cell[] {
    const out: Cell[] = [];
    for (let y = 0; y < this.height; y += 1) {
      for (let x = 0; x < this.width; x += 1) {
        if (this.kinds[this.index(x, y)] !== 'wall') out.push({ x, y });
      }
    }
    return out;
  }
}
