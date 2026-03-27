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
    exclude: [
      'src/**/__tests__/**',
      'src/**/*.d.ts',
      'src/daemon/ui.ts',
      // Barrel file — no executable code, 0% is correct
      'src/core.ts',
      // OS-native UI — spawns zenity/osascript, untestable in CI
      'src/ui/native.ts',
    ],
    reporter: ['text', 'html', 'json-summary'],
    reportsDirectory: './coverage',
    all: true,
    thresholds: {
      // Floors set at current baseline — CI blocks any regression below these numbers.
      // Raise thresholds as test coverage improves (target: 80% across the board).
      statements: 68,
      branches: 58,
      functions: 66,
      lines: 70,
    },
  },
});
