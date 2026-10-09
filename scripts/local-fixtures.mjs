// สร้างผู้ใช้ สมาชิก บัญชีสมาชิก และ session ทดสอบใน D1 local เท่านั้น สำหรับชุดตรวจ UI โหมดใช้งานจริง
// ทำงานกับไฟล์ฐานข้อมูลในเครื่องโดยตรงผ่าน `wrangler d1 execute --local`
// ไม่มีเส้นทางใน Worker ที่ข้ามการเข้าสู่ระบบ และสคริปต์นี้ไม่รองรับ --remote โดยเจตนา
import { spawnSync } from 'node:child_process'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { argon2id } from '@noble/hashes/argon2.js'

const TABLES = [
  'club_news',
  'member_deletions',
  'athletes', 'member_photos', 'member_sessions', 'member_accounts', 'login_throttle', 'library_cache', 'library_state',
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
const b64 = (bytes) => Buffer.from(bytes).toString('base64').replace(/=+$/, '')

/** ผลของ Argon2id ด้วยค่าเดียวกับ Worker (worker/password.ts) เพื่อให้บัญชีทดสอบเข้าสู่ระบบผ่านเส้นทางจริงได้ */
export function passwordHash(password) {
  const salt = randomBytes(16)
  const out = argon2id(Buffer.from(password.normalize('NFC'), 'utf8'), salt, { m: 19456, t: 2, p: 1, dkLen: 32 })
  return `$argon2id$v=19$m=19456,t=2,p=1$${b64(salt)}$${b64(out)}`
}

/**
 * เตรียมฐานข้อมูลทดสอบ: ใช้ migrations จริง ล้างข้อมูล แล้วสร้างผู้ใช้และสมาชิกพร้อม session
 * @param {string} stateDir โฟลเดอร์เก็บ D1 local ของชุดทดสอบ (แยกจากของการพัฒนา)
 * @param {{ key: string, email: string, role: 'staff' | 'admin', name?: string, sessions?: number }[]} users
 * @param {{ key: string, name: string, nickname?: string, studentId?: string, role?: string, status?: string, contact?: string, note?: string,
 *           password?: string, mustChange?: boolean, accountStatus?: 'active' | 'disabled', sessions?: number,
 *           athlete?: { game: string, team?: string, position?: string, ign?: string, status?: 'active' | 'inactive', note?: string } }[]} members
 *        password มีค่า = เปิดบัญชีให้ด้วยรหัสผ่านนี้; sessions = จำนวน session ของสมาชิกที่สร้างไว้ล่วงหน้า
 * @returns {Record<string, { id: string, email?: string, studentId?: string, tokens: string[] }>}
 */
export function prepareLocalDatabase(stateDir, users, members = []) {
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
  for (const member of members) {
    const id = randomUUID()
    const tokens = []
    const studentId = member.studentId ?? ''
    statements.push(
      `INSERT INTO members (id, name, nickname, role, status, contact, note, added_at, version, created_by, updated_by, created_at, updated_at, student_id) VALUES (${[
        id, member.name, member.nickname ?? '', member.role ?? 'member', member.status ?? 'active', member.contact ?? '', member.note ?? '', now.slice(0, 10),
      ].map(quote).join(', ')}, 1, 'fixture', 'fixture', ${quote(now)}, ${quote(now)}, ${quote(studentId)});`,
    )
    if (member.password) {
      statements.push(
        `INSERT INTO member_accounts (member_id, login_id, password_hash, status, must_change_password, password_set_at, password_set_by, created_by, created_at, updated_at, revision) VALUES (${[
          id, studentId, passwordHash(member.password), member.accountStatus ?? 'active',
        ].map(quote).join(', ')}, ${member.mustChange ? 1 : 0}, ${quote(now)}, 'fixture', 'fixture', ${quote(now)}, ${quote(now)}, ${quote(randomBytes(12).toString('hex'))});`,
      )
      for (let i = 0; i < (member.sessions ?? 0); i++) {
        // token ของสมาชิกขึ้นต้นด้วย m. เหมือนที่ Worker ออกให้
        const token = `m.${randomBytes(32).toString('base64url')}`
        tokens.push(token)
        const hash = createHash('sha256').update(token).digest('hex')
        statements.push(`INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at) VALUES (${[hash, id, now, expires].map(quote).join(', ')});`)
      }
    }
    if (member.athlete) {
      const a = member.athlete
      statements.push(
        `INSERT INTO athletes (member_id, game, team, position, ign, status, note, version, created_by, updated_by, created_at, updated_at) VALUES (${[
          id, a.game, a.team ?? '', a.position ?? '', a.ign ?? '', a.status ?? 'active', a.note ?? '',
        ].map(quote).join(', ')}, 1, 'fixture', 'fixture', ${quote(now)}, ${quote(now)});`,
      )
    }
    out[member.key] = { id, studentId, tokens }
  }
  const file = join(stateDir, 'fixtures.sql')
  writeFileSync(file, statements.join('\n'))
  wrangler(['execute', 'DB', '--file', file, '--yes'], stateDir)
  return out
}
