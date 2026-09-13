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
        'src/net/fswriter.js',
        'src/net/save-session.js',
        'src/features/batch.js',
      ],
      // 覆盖率棘轮：只升不降（2026-09-13 流式管线重构后上调）
      thresholds: {
        statements: 89,
        branches: 75,
        functions: 84,
        lines: 93,
      },
    },
  },
});
