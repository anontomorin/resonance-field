/**
 * requestAnimationFrame 主循环。
 * 暂停由 GameApp 在 update 回调内部判断（模拟冻结），循环本身继续运行以保持 UI 响应。
 */
export class GameLoop {
  private rafId = 0;
  private lastTime = 0;
  private running = false;
  private updateFn: (dt: number) => void;
  private renderFn: () => void;

  constructor(updateFn: (dt: number) => void, renderFn: () => void) {
    this.updateFn = updateFn;
    this.renderFn = renderFn;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.lastTime = performance.now();
    const frame = (now: number): void => {
      if (!this.running) return;
      // 限制单帧最大步长，避免切换标签页后一次性推进过多
      const dt = Math.min(0.05, (now - this.lastTime) / 1000);
      this.lastTime = now;
      this.updateFn(dt);
      this.renderFn();
      this.rafId = requestAnimationFrame(frame);
    };
    this.rafId = requestAnimationFrame(frame);
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.rafId);
  }
}
