import { defineConfig } from 'vitest/config';

// 测试统一用内存库（每个测试文件独立实例，vitest 默认 isolate）；
// 生产入口不经 vitest，仍锚定 server/media.db。
export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['src/test/setup.ts'],
  },
});
