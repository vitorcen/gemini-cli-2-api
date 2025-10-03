import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // globalSetup: './setup.ts',  // 暂时禁用，手动启动服务器
    testTimeout: 30000,
    hookTimeout: 10000,
    include: ['**/*.test.ts'],
    reporters: ['verbose'],
  },
});
