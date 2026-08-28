import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      /**
       * 阈值只卡在能测的部分。
       * 需要真实节点的代码（evm/tron 的 client 与 tx）不在这里追覆盖率 ——
       * 它们由 scripts/sync.ts 的探活与真实上链联调验证。
       */
      exclude: [
        'src/server.ts',
        'src/app.ts',
        'src/lib/web3/evm/client.ts',
        'src/lib/web3/evm/tx.ts',
        'src/lib/web3/tron/**',
        'src/lib/keys/signer.ts',
        'src/lib/keys/worker.ts',
      ],
      thresholds: { lines: 55, functions: 60, branches: 80, statements: 55 },
    },
  },
  resolve: { alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) } },
})
