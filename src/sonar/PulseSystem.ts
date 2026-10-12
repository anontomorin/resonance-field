import { TileMap } from '../world/TileMap';
import { SonarConfig } from './SonarConfig';
import { propagate, propagateField } from './Propagation';

/** 单个格子的到达事件 */
export interface PulseArrival {
  /** 格子一维下标 */
  index: number;
  /** 相对脉冲开始时刻的到达时间（秒） */
  time: number;
  /** 该格到起点的 BFS 步数 */
  distance: number;
  /**
   * 该格的照度 0~1。
   *
   * bfs 模型下恒为 1（要么到达要么没到）；
   * field 模型下是真实的能量值，供渲染层做"越远越模糊"的渐变。
   */
  intensity: number;
}

/** 一枚正在传播的脉冲 */
export interface Pulse {
  originX: number;
  originY: number;
  /** 已经过的时间（秒） */
  elapsed: number;
  /** 按到达时间升序排列的到达事件 */
  arrivals: PulseArrival[];
  /** 下一个待处理事件下标 */
  cursor: number;
  /** 传播阶段时长 = 最远距离 * stepDelay */
  travelDuration: number;
  /** 总时长（含波纹消散的尾巴） */
  totalDuration: number;
  maxDistance: number;
  /** 本次脉冲使用的模型，渲染层据此决定画等亮圆环还是衰减光晕 */
  model: SonarConfig['model'];
}

/**
 * 脉冲系统：负责发射冷却、活动脉冲生命周期与"到达事件"调度。
 *
 * 同一时刻最多存在一枚活动脉冲；传播阶段结束后脉冲进入消散尾巴，
 * 尾巴结束或关卡重置时脉冲被清空，避免旧回调污染新的地图状态。
 *
 * 本模块**不关心传播模型**：它只消费 "哪些格子在什么时刻被点亮、亮到什么程度"
 * 这张事件表。因此换掉声波模型（bfs ↔ field）完全不需要改动这里的调度逻辑。
 */
export class PulseSystem {
  private config: SonarConfig;
  private active: Pulse | null = null;
  private cooldownRemaining = 0;

  constructor(config: SonarConfig) {
    this.config = config;
  }

  /** 使用新配置（切换关卡时调用），并立刻取消活动脉冲 */
  configure(config: SonarConfig): void {
    this.config = config;
    this.cancel();
  }

  /** 取消当前脉冲与冷却（重开、切换关卡、返回标题时必须调用） */
  cancel(): void {
    this.active = null;
    this.cooldownRemaining = 0;
  }

  get pulse(): Pulse | null {
    return this.active;
  }

  get cooldown(): number {
    return this.cooldownRemaining;
  }

  /** 冷却进度 0~1（1 表示已充能完毕） */
  get cooldownRatio(): number {
    if (this.config.cooldown <= 0) return 1;
    return 1 - Math.min(1, this.cooldownRemaining / this.config.cooldown);
  }

  canEmit(): boolean {
    if (this.cooldownRemaining > 0) return false;
    if (this.active && this.active.elapsed < this.active.travelDuration) return false;
    return true;
  }

  /** 尝试发射一枚脉冲，成功返回脉冲对象，失败返回 null */
  tryEmit(map: TileMap, x: number, y: number): Pulse | null {
    if (!this.canEmit()) return null;

    const arrivals: PulseArrival[] = [];
    let maxDistance = 0;

    if (this.config.model === 'field') {
      const field = propagateField(map, x, y, this.config.maxRange, this.config.fieldFalloff);
      const threshold = this.config.fieldThreshold;

      // 照度场是连续的，所以"到达时间"用射线走过的格距推算 ——
      // 这样动画节奏与 bfs 模型一致（近处先亮、远处后亮），
      // 但同一圈上的亮度会随实际能量而不同。
      for (let i = 0; i < field.intensity.length; i += 1) {
        const energy = field.intensity[i];
        if (energy < threshold) continue;
        const cell = map.cellOf(i);
        const dist = Math.max(Math.abs(cell.x - x), Math.abs(cell.y - y));
        arrivals.push({ index: i, time: dist * this.config.stepDelay, distance: dist, intensity: energy });
        if (dist > maxDistance) maxDistance = dist;
      }
      // 墙格：撞墙残留能量超过阈值也算"看到了这面墙"
      for (let i = 0; i < field.wallIntensity.length; i += 1) {
        const energy = field.wallIntensity[i];
        if (energy < threshold) continue;
        const cell = map.cellOf(i);
        const dist = Math.max(Math.abs(cell.x - x), Math.abs(cell.y - y));
        arrivals.push({ index: i, time: dist * this.config.stepDelay, distance: dist, intensity: energy });
        if (dist > maxDistance) maxDistance = dist;
      }
    } else {
      const result = propagate(map, x, y, this.config.maxRange);
      maxDistance = result.maxDistance;

      for (let i = 0; i < result.distances.length; i += 1) {
        const d = result.distances[i];
        if (d >= 0) {
          arrivals.push({ index: i, time: d * this.config.stepDelay, distance: d, intensity: 1 });
        }
      }
      for (let i = 0; i < result.wallDistances.length; i += 1) {
        const d = result.wallDistances[i];
        if (d >= 0) {
          arrivals.push({ index: i, time: d * this.config.stepDelay, distance: d, intensity: 1 });
        }
      }
    }

    arrivals.sort((a, b) => a.time - b.time || a.index - b.index);

    const travelDuration = Math.max(maxDistance, 1) * this.config.stepDelay;
    const pulse: Pulse = {
      originX: x,
      originY: y,
      elapsed: 0,
      arrivals,
      cursor: 0,
      travelDuration,
      totalDuration: travelDuration + 0.55,
      maxDistance,
      model: this.config.model
    };

    this.active = pulse;
    this.cooldownRemaining = this.config.cooldown;
    return pulse;
  }

  /**
   * 推进脉冲时间轴。
   * @param dt 帧间隔（秒）
   * @param onArrive 到达回调，收到本次新抵达的格子下标、格距与照度
   * @returns 本次脉冲是否已经完全结束
   */
  update(
    dt: number,
    onArrive: (index: number, distance: number, intensity: number) => void
  ): boolean {
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - dt);
    }

    const pulse = this.active;
    if (!pulse) return true;

    pulse.elapsed += dt;

    while (pulse.cursor < pulse.arrivals.length && pulse.arrivals[pulse.cursor].time <= pulse.elapsed) {
      const arrival = pulse.arrivals[pulse.cursor];
      pulse.cursor += 1;
      onArrive(arrival.index, arrival.distance, arrival.intensity);
    }

    if (pulse.elapsed >= pulse.totalDuration) {
      this.active = null;
      return true;
    }
    return false;
  }
}
