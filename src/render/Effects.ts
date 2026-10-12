/** 轻量粒子与涟漪特效，坐标使用"格"为单位，由渲染器换算成像素 */
export interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  maxLife: number;
  size: number;
  color: string;
}

export interface Ripple {
  x: number;
  y: number;
  radius: number;
  maxRadius: number;
  life: number;
  maxLife: number;
  color: string;
}

/**
 * 特效系统：只做轻量点缀（节点激活、出口开启、通关、撞墙），
 * 不参与任何游戏判定，也不会阻塞操作。
 */
export class Effects {
  private particles: Particle[] = [];
  private ripples: Ripple[] = [];

  get particleList(): Particle[] {
    return this.particles;
  }

  get rippleList(): Ripple[] {
    return this.ripples;
  }

  burst(x: number, y: number, color: string, count = 10, speed = 2.2): void {
    for (let i = 0; i < count; i += 1) {
      const angle = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const v = speed * (0.5 + Math.random() * 0.7);
      const life = 0.45 + Math.random() * 0.35;
      this.particles.push({
        x,
        y,
        vx: Math.cos(angle) * v,
        vy: Math.sin(angle) * v,
        life,
        maxLife: life,
        size: 1.6 + Math.random() * 2.2,
        color
      });
    }
  }

  ripple(x: number, y: number, color: string, maxRadius = 3, life = 0.6): void {
    this.ripples.push({ x, y, radius: 0, maxRadius, life, maxLife: life, color });
  }

  update(dt: number): void {
    for (let i = this.particles.length - 1; i >= 0; i -= 1) {
      const p = this.particles[i];
      p.life -= dt;
      if (p.life <= 0) {
        this.particles.splice(i, 1);
        continue;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.vx *= 1 - 2.4 * dt;
      p.vy *= 1 - 2.4 * dt;
    }

    for (let i = this.ripples.length - 1; i >= 0; i -= 1) {
      const r = this.ripples[i];
      r.life -= dt;
      if (r.life <= 0) {
        this.ripples.splice(i, 1);
        continue;
      }
      const t = 1 - r.life / r.maxLife;
      r.radius = r.maxRadius * (1 - Math.pow(1 - t, 2));
    }
  }

  clear(): void {
    this.particles.length = 0;
    this.ripples.length = 0;
  }

  /** 控制粒子总量，避免长时间游玩后累积 */
  limit(max = 220): void {
    if (this.particles.length > max) {
      this.particles.splice(0, this.particles.length - max);
    }
  }
}
