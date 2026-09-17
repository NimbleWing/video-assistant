import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// outDir 直出 ../server/public：文件名不带哈希（产物随仓库提交，diff 稳定），
// 服务侧零依赖开箱即用；emptyOutDir 清掉旧版手写 index.html。
export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    outDir: '../server/public',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        entryFileNames: 'assets/app.js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
    },
  },
  server: {
    proxy: {
      '/api': 'http://127.0.0.1:17321',
      '/stream': 'http://127.0.0.1:17321',
    },
  },
  test: {
    environment: 'happy-dom',
    globals: true,
    setupFiles: ['src/test/setup.ts'],
  },
});
