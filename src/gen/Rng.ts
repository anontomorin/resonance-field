/**
 * 可复现的伪随机数发生器。
 *
 * 使用 mulberry32：同一种子必定产生同一序列，
 * 因此"随机种子"既能复现关卡，也能作为分享码传播。
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    // 避免种子为 0 导致序列退化
    this.state = (Math.abs(Math.floor(seed)) >>> 0) || 0x9e3779b9;
  }

  /** [0, 1) 之间的随机数 */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** [0, n) 之间的整数 */
  int(n: number): number {
    if (n <= 0) return 0;
    return Math.floor(this.next() * n) % n;
  }

  /** 从数组中随机取一个元素 */
  pick<T>(list: readonly T[]): T {
    return list[this.int(list.length)];
  }

  /** 原地洗牌 */
  shuffle<T>(list: T[]): T[] {
    for (let i = list.length - 1; i > 0; i -= 1) {
      const j = this.int(i + 1);
      const tmp = list[i];
      list[i] = list[j];
      list[j] = tmp;
    }
    return list;
  }
}
