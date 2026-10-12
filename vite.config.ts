import { defineConfig } from 'vite';

export default defineConfig({
  // 使用相对路径，便于把 dist 直接当作静态站点打开或部署到任意子路径
  base: './',
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2020',
    sourcemap: false
  },
  server: {
    host: '127.0.0.1',
    port: 5173
  }
});
