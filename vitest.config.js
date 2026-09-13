import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.js'],
    coverage: {
      provider: 'v8',
      include: [
        'src/core/**',
        'src/hls/**',
        'src/site/video-info.js',
        'src/net/save.js',
        'src/features/batch.js',
      ],
      // 覆盖率棘轮：锁定首轮基线（81.3/73.4/82.8/84.7），只升不降
      thresholds: {
        statements: 80,
        branches: 72,
        functions: 82,
        lines: 84,
      },
    },
  },
});
