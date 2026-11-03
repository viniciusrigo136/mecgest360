import { defineConfig } from 'vitest/config'

// Testes de integração do banco (RLS, RPCs, regras transacionais).
export default defineConfig({
  test: {
    include: ['tests/db/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['tests/db/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 120_000,
  },
})
