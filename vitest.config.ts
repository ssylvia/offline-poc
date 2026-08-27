import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    css: false,
    environment: 'jsdom',
    setupFiles: './src/test/setup.ts',
  },
})
