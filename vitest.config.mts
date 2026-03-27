import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    env: { NODE9_TESTING: '1' },
    clearMocks: true,
  },
  coverage: {
    provider: 'v8',
    include: ['src/**/*.ts'],
    exclude: ['src/**/__tests__/**', 'src/**/*.d.ts', 'src/daemon/ui.ts'],
    reporter: ['text', 'html'],
    reportsDirectory: './coverage',
    all: true,
  },
});
