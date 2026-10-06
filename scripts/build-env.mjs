// build สำหรับ environment ที่ระบุใน wrangler.jsonc (staging | production)
// Cloudflare Vite plugin เลือก environment จากตัวแปร CLOUDFLARE_ENV ตอน build
import { spawnSync } from 'node:child_process'

const target = process.argv[2]
if (!['staging', 'production'].includes(target)) {
  console.error('ใช้: node scripts/build-env.mjs <staging|production>')
  process.exit(1)
}
const result = spawnSync('npx', ['vite', 'build'], {
  stdio: 'inherit',
  shell: true,
  env: { ...process.env, CLOUDFLARE_ENV: target },
})
process.exit(result.status ?? 1)
