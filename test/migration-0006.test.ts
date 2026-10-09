import { applyD1Migrations } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'
import { env } from './helpers'

/**
 * Migration 0006 (รุ่นของบัญชี, นักกีฬา, รูปโปรไฟล์) กับฐานข้อมูลที่มีข้อมูลของรุ่นก่อนอยู่แล้ว
 * ไฟล์นี้ใช้ฐานข้อมูลทดสอบของตัวเอง: ใช้ migrations 0001–0005 ก่อน ใส่ข้อมูลแบบที่รุ่นก่อนเขียน แล้วจึงใช้ 0006
 */
const all = <T = Record<string, unknown>>(sql: string) => env.DB.prepare(sql).all<T>().then((r) => r.results)

describe('migration 0006 รักษาข้อมูลเดิม', () => {
  it('ข้อมูลสมาชิก บัญชี session ทีมงาน และกำหนดการเดิมอยู่ครบ บัญชีเดิมได้รุ่นที่ไม่ซ้ำกัน และรุ่นก่อนของ Worker ยังเขียนข้อมูลได้', async () => {
    const index = env.TEST_MIGRATIONS.findIndex((m) => m.name.startsWith('0006_'))
    expect(index).toBe(5)
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS.slice(0, index))
    expect((await all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('athletes', 'member_photos')`))).toEqual([])

    const now = '2026-10-01T00:00:00.000Z'
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO users (id, email, google_sub, name, role, status, is_bootstrap, created_at, updated_at) VALUES ('u1', 'staff@example.com', 'sub-1', 'staff', 'admin', 'active', 0, ?, ?)`).bind(now, now),
      env.DB.prepare(`INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES ('staff-token-hash', 'u1', ?, '2099-01-01T00:00:00.000Z')`).bind(now),
      ...['a', 'b', 'c'].map((k, i) =>
        env.DB.prepare(
          `INSERT INTO members (id, name, nickname, role, status, contact, note, added_at, version, created_by, updated_by, created_at, updated_at, student_id)
           VALUES (?, ?, ?, 'member', 'active', 'line: x', 'หมายเหตุเดิม', '2026-09-01', 3, 'u1', 'u1', ?, ?, ?)`,
        ).bind(`m-${k}`, `สมาชิก ${k}`, k, now, now, `650000${i + 1}`),
      ),
      ...['a', 'b'].map((k, i) =>
        env.DB.prepare(
          `INSERT INTO member_accounts (member_id, login_id, password_hash, status, must_change_password, password_set_at, password_set_by, created_by, created_at, updated_at)
           VALUES (?, ?, ?, 'active', 0, ?, NULL, 'u1', ?, ?)`,
        ).bind(`m-${k}`, `650000${i + 1}`, `$argon2id$v=19$m=19456,t=2,p=1$${'A'.repeat(22)}$${'B'.repeat(43)}`, now, now, now),
      ),
      env.DB.prepare(`INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at) VALUES ('member-token-hash', 'm-a', ?, '2099-01-01T00:00:00.000Z')`).bind(now),
      env.DB.prepare(`INSERT INTO events (id, title, all_day, start_at, end_at, location, description, version, created_by, updated_by, created_at, updated_at) VALUES ('e1', 'ซ้อมทีม', 0, '2026-10-08T18:00', '2026-10-08T20:00', '', '', 1, 'u1', 'u1', ?, ?)`).bind(now, now),
    ])
    const before = {
      members: await all('SELECT * FROM members ORDER BY id'),
      accounts: await all('SELECT member_id, login_id, password_hash, status, must_change_password, password_set_at, password_set_by, created_by, created_at, updated_at, disabled_at, last_login_at FROM member_accounts ORDER BY member_id'),
      memberSessions: await all('SELECT * FROM member_sessions'),
      users: await all('SELECT * FROM users'),
      sessions: await all('SELECT * FROM sessions'),
      events: await all('SELECT * FROM events'),
    }

    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)

    // ข้อมูลเดิมทุกตารางเหมือนเดิมทุกคอลัมน์
    expect(await all('SELECT * FROM members ORDER BY id')).toEqual(before.members)
    expect(await all('SELECT member_id, login_id, password_hash, status, must_change_password, password_set_at, password_set_by, created_by, created_at, updated_at, disabled_at, last_login_at FROM member_accounts ORDER BY member_id')).toEqual(before.accounts)
    expect(await all('SELECT * FROM member_sessions')).toEqual(before.memberSessions)
    expect(await all('SELECT * FROM users')).toEqual(before.users)
    expect(await all('SELECT * FROM sessions')).toEqual(before.sessions)
    expect(await all('SELECT * FROM events')).toEqual(before.events)

    // บัญชีเดิมได้รุ่นแบบสุ่มที่ไม่ว่างและไม่ซ้ำกัน
    const revisions = (await all<{ revision: string }>('SELECT revision FROM member_accounts ORDER BY member_id')).map((r) => r.revision)
    expect(revisions).toHaveLength(2)
    for (const revision of revisions) expect(revision).toMatch(/^[0-9a-f]{24}$/)
    expect(new Set(revisions).size).toBe(2)

    // ตารางใหม่ว่าง: ไม่มีใครถูกตั้งเป็นนักกีฬาหรือมีรูปเอง
    expect(await all('SELECT * FROM athletes')).toEqual([])
    expect(await all('SELECT member_id FROM member_photos')).toEqual([])

    // Worker รุ่นก่อน (ยังไม่รู้จักคอลัมน์และตารางใหม่) ยังเขียนบัญชีด้วยคำสั่งเดิมได้ระหว่างช่วงเปลี่ยนรุ่น
    await env.DB.prepare(
      `INSERT INTO member_accounts (member_id, login_id, password_hash, status, must_change_password, password_set_at, password_set_by, created_by, created_at, updated_at)
       VALUES ('m-c', '6500003', 'x', 'active', 1, ?, 'u1', 'u1', ?, ?)`,
    ).bind(now, now, now).run()
    expect((await all<{ revision: string }>(`SELECT revision FROM member_accounts WHERE member_id = 'm-c'`))[0].revision).toBe('')

    // ข้อจำกัดของตารางใหม่: ผูกกับสมาชิกที่มีจริง ค่าที่กำหนดเท่านั้น และรูปไม่เกินขนาดที่ตั้งไว้
    const insertAthlete = (memberId: string, status: string) =>
      env.DB.prepare(`INSERT INTO athletes (member_id, game, status, created_by, updated_by, created_at, updated_at) VALUES (?, 'Valorant', ?, 'u1', 'u1', ?, ?)`).bind(memberId, status, now, now).run()
    const insertPhoto = (memberId: string, type: string, size: number, width: number) =>
      env.DB.prepare(`INSERT INTO member_photos (member_id, content_type, bytes, size, width, height, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 64, 'v', 'u1', ?)`).bind(memberId, type, new Uint8Array([1]), size, width, now).run()
    await insertAthlete('m-a', 'active')
    await expect(insertAthlete('m-a', 'active')).rejects.toThrow()
    await expect(insertAthlete('m-b', 'retired')).rejects.toThrow()
    await expect(insertAthlete('no-such-member', 'active')).rejects.toThrow()
    await insertPhoto('m-a', 'image/jpeg', 1, 64)
    await expect(insertPhoto('m-b', 'image/svg+xml', 1, 64)).rejects.toThrow()
    await expect(insertPhoto('m-b', 'image/png', 262145, 64)).rejects.toThrow()
    await expect(insertPhoto('m-b', 'image/png', 1, 513)).rejects.toThrow()
    await expect(insertPhoto('no-such-member', 'image/png', 1, 64)).rejects.toThrow()
  })
})
