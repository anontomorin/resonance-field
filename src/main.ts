import './styles/main.css';
import { GameApp } from './app/GameApp';

const canvas = document.getElementById('game-canvas');
if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('未找到 #game-canvas 画布元素');
}

// 整个应用只有一个实例，键盘事件也只注册一次
const app = new GameApp(canvas);

// 开发模式下暴露只读调试快照，便于自动化测试与手动验证（打包产物中不存在）
if (import.meta.env.DEV) {
  (window as unknown as { __resonance?: GameApp }).__resonance = app;
}
