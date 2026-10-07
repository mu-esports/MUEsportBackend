// สร้างผู้ใช้และ session ทดสอบใน D1 local เท่านั้น สำหรับชุดตรวจ UI โหมดใช้งานจริง
// ทำงานกับไฟล์ฐานข้อมูลในเครื่องโดยตรงผ่าน `wrangler d1 execute --local`
// ไม่มีเส้นทางใน Worker ที่ข้ามการเข้าสู่ระบบ และสคริปต์นี้ไม่รองรับ --remote โดยเจตนา
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const TABLES = [
  'form_imports', 'write_locks', 'form_responses', 'form_items', 'calendar_series', 'setup_operations', 'sync_state', 'sync_resources',
  'audit_log', 'resource_configs', 'document_operations', 'documents', 'google_connections',
  'idempotency_keys', 'events', 'members', 'oauth_states', 'sessions', 'users',
]

function wrangler(args, stateDir) {
  const result = spawnSync('npx', ['wrangler', 'd1', ...args, '--local', '--persist-to', stateDir], { shell: true, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`wrangler ${args.join(' ')} ล้มเหลว\n${result.stdout}\n${result.stderr}`)
  return result.stdout
}

const quote = (value) => `'${String(value).replace(/'/g, "''")}'`

/**
 * เตรียมฐานข้อมูลทดสอบ: ใช้ migrations จริง ล้างข้อมูล แล้วสร้างผู้ใช้พร้อม session
 * @param {string} stateDir โฟลเดอร์เก็บ D1 local ของชุดทดสอบ (แยกจากของการพัฒนา)
 * @param {{ key: string, email: string, role: 'staff' | 'admin', sessions?: number }[]} users
 * @returns {Record<string, { id: string, email: string, tokens: string[] }>}
 */
export function prepareLocalDatabase(stateDir, users) {
  mkdirSync(stateDir, { recursive: true })
  wrangler(['migrations', 'apply', 'DB'], stateDir)

  const now = new Date().toISOString()
  const expires = new Date(Date.now() + 6 * 60 * 60 * 1000).toISOString()
  const statements = TABLES.map((table) => `DELETE FROM ${table};`)
  const out = {}
  for (const user of users) {
    const id = randomUUID()
    const tokens = []
    statements.push(
      `INSERT INTO users (id, email, google_sub, name, role, status, is_bootstrap, created_at, updated_at, last_login_at) VALUES (${[
        id, user.email, `fixture-${id}`, user.name ?? '', user.role, 'active',
      ].map(quote).join(', ')}, ${user.email === 'muesport2567@gmail.com' ? 1 : 0}, ${quote(now)}, ${quote(now)}, ${quote(now)});`,
    )
    for (let i = 0; i < (user.sessions ?? 1); i++) {
      // เหมือน Worker: cookie ถือค่าสุ่ม ส่วน D1 เก็บเฉพาะ SHA-256 ของค่านั้น
      const token = randomBytes(32).toString('base64url')
      tokens.push(token)
      const hash = createHash('sha256').update(token).digest('hex')
      statements.push(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (${[hash, id, now, expires].map(quote).join(', ')});`)
    }
    out[user.key] = { id, email: user.email, tokens }
  }
  const file = join(stateDir, 'fixtures.sql')
  writeFileSync(file, statements.join('\n'))
  wrangler(['execute', 'DB', '--file', file, '--yes'], stateDir)
  return out
}
