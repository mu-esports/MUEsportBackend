import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

// ชุดทดสอบ Worker รันใน Workers runtime (workerd) กับ D1 local และ Google จำลอง
// ค่าด้านล่างเป็นค่าทดสอบ ไม่ใช่ credentials จริง
export default defineConfig(async () => ({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './test/wrangler.test.jsonc' },
      miniflare: {
        bindings: {
          PASSWORD_HASH_MODE: 'server-test',
          TEST_MIGRATIONS: await readD1Migrations('./migrations'),
          GOOGLE_CLIENT_ID: 'test-client-id',
          GOOGLE_CLIENT_SECRET: 'test-client-secret',
          TOKEN_ENCRYPTION_KEY: 'MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY=',
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
}))
