import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

// Pure-function tests only (topology filter / layout / generator, fossflow parity).
// React and three.js code is not covered here; it is verified in the browser.
// 순수 함수 테스트 전용. React/three 코드는 브라우저에서 확인한다.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
  },
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
});
