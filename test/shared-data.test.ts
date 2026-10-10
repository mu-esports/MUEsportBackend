import { beforeEach, describe, expect, it } from 'vitest'
import { call, data, env, key, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'

const MEMBER = { name: 'สมชาย ทดสอบ', nickname: 'ชาย', studentId: '6543210', role: 'member', status: 'active', contact: 'discord: chai', note: '' }
const EVENT = { title: 'ซ้อมทีม', allDay: false, start: '2026-10-10T18:00', end: '2026-10-10T20:00', location: 'ห้อง 1', description: '' }

let a: Actor
let b: Actor

beforeEach(async () => {
  await resetDb()
  // สอง session ของคนละคน ใช้ฐานข้อมูลเดียวกัน (เหมือนเปิดจากคนละอุปกรณ์)
  a = await seedUser('a@example.com', 'staff')
  b = await seedUser('b@example.com', 'staff')
})

const createMember = async (as: Actor, body: unknown = MEMBER, idem = key()) =>
  call('/api/members', { method: 'POST', as, headers: { 'Idempotency-Key': idem }, body })

describe('สมาชิก: ข้อมูลร่วมกัน', () => {
  it('ข้อมูลจริงเริ่มว่าง ไม่มีข้อมูลตัวอย่าง', async () => {
    expect((await data(await call('/api/members', { as: a }))).members).toEqual([])
    expect((await data(await call('/api/events', { as: a }))).events).toEqual([])
  })

  it('คนหนึ่งบันทึก อีกคน reload แล้วเห็นผล พร้อม id และ version จาก server', async () => {
    const created = await data(await createMember(a))
    expect(created.member).toMatchObject({ ...MEMBER, version: 1 })
    expect(created.member.id).toMatch(/^[0-9a-f-]{36}$/)
    expect(created.member.addedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(created.member.createdAt).toBe(created.member.updatedAt)

    const seenByB = await data(await call('/api/members', { as: b }))
    expect(seenByB.members).toHaveLength(1)
    expect(seenByB.members[0]).toEqual(created.member)
  })

  it('ไม่รับ id หรือ version ที่ client ส่งมาตอนสร้าง', async () => {
    const created = await data(await createMember(a, { ...MEMBER, id: 'client-chosen', version: 99, addedAt: '2000-01-01' }))
    expect(created.member.id).not.toBe('client-chosen')
    expect(created.member.version).toBe(1)
    expect(created.member.addedAt).not.toBe('2000-01-01')
  })

  it('แก้จากข้อมูลเก่าได้ 409 พร้อมค่าล่าสุด และไม่เขียนทับเงียบ ๆ', async () => {
    const { member } = await data(await createMember(a))
    const byA = await call(`/api/members/${member.id}`, { method: 'PATCH', as: a, body: { ...MEMBER, note: 'แก้โดย A', expectedVersion: 1 } })
    expect(byA.status).toBe(200)
    expect((await data(byA)).member.version).toBe(2)

    // B ยังถือ version 1 อยู่
    const byB = await call(`/api/members/${member.id}`, { method: 'PATCH', as: b, body: { ...MEMBER, note: 'แก้โดย B', expectedVersion: 1 } })
    expect(byB.status).toBe(409)
    const conflict = await data(byB)
    expect(conflict.error).toBe('version_conflict')
    expect(conflict.message).toContain('ถูกแก้ไขจากที่อื่น')
    expect(conflict.current).toMatchObject({ note: 'แก้โดย A', version: 2 })

    const stored = await data(await call('/api/members', { as: b }))
    expect(stored.members[0].note).toBe('แก้โดย A')

    // โหลดค่าล่าสุดแล้วแก้ใหม่ได้
    const retry = await call(`/api/members/${member.id}`, { method: 'PATCH', as: b, body: { ...MEMBER, note: 'แก้โดย B', expectedVersion: 2 } })
    expect((await data(retry)).member).toMatchObject({ note: 'แก้โดย B', version: 3 })
  })

  it('เปลี่ยนสถานะจากข้อมูลเก่าได้ 409 เช่นกัน', async () => {
    const { member } = await data(await createMember(a))
    await call(`/api/members/${member.id}`, { method: 'PATCH', as: a, body: { ...MEMBER, nickname: 'ใหม่', expectedVersion: 1 } })
    const stale = await call(`/api/members/${member.id}/status`, { method: 'POST', as: b, body: { status: 'suspended', expectedVersion: 1 } })
    expect(stale.status).toBe(409)
    const ok = await call(`/api/members/${member.id}/status`, { method: 'POST', as: b, body: { status: 'suspended', expectedVersion: 2 } })
    expect((await data(ok)).member).toMatchObject({ status: 'suspended', nickname: 'ใหม่', version: 3 })
  })

  it('คำขอแก้พร้อมกันจากรุ่นเดียวกัน สำเร็จได้เพียงคำขอเดียว', async () => {
    const { member } = await data(await createMember(a))
    const results = await Promise.all(
      [a, b, a, b].map((actor, i) =>
        call(`/api/members/${member.id}`, { method: 'PATCH', as: actor, body: { ...MEMBER, note: `รอบ ${i}`, expectedVersion: 1 } }),
      ),
    )
    expect(results.map((r) => r.status).sort()).toEqual([200, 409, 409, 409])
  })

  it('ต้องระบุ expectedVersion และรายการที่ไม่มีตอบ 404', async () => {
    const { member } = await data(await createMember(a))
    expect((await call(`/api/members/${member.id}`, { method: 'PATCH', as: a, body: MEMBER })).status).toBe(422)
    expect((await call('/api/members/no-such-id', { method: 'PATCH', as: a, body: { ...MEMBER, expectedVersion: 1 } })).status).toBe(404)
  })

  it('สร้างซ้ำด้วย key เดิม (retry) ไม่เกิดรายการซ้ำ', async () => {
    const idem = key()
    const first = await createMember(a, MEMBER, idem)
    const second = await createMember(a, MEMBER, idem)
    expect(first.status).toBe(201)
    expect(second.status).toBe(200)
    const [one, two] = [await data(first), await data(second)]
    expect(two.replayed).toBe(true)
    expect(two.member.id).toBe(one.member.id)
    expect((await data(await call('/api/members', { as: a }))).members).toHaveLength(1)
  })

  it('คำขอสร้างซ้ำที่มาพร้อมกันสร้างได้รายการเดียว', async () => {
    const idem = key()
    const results = await Promise.all([1, 2, 3, 4].map(() => createMember(a, MEMBER, idem)))
    expect(results.every((r) => r.status === 200 || r.status === 201)).toBe(true)
    const ids = new Set((await Promise.all(results.map((r) => data(r)))).map((r) => r.member.id))
    expect(ids.size).toBe(1)
    expect((await data(await call('/api/members', { as: a }))).members).toHaveLength(1)
  })

  it('key เดิมกับข้อมูลอื่นถูกปฏิเสธ และ key ผูกกับผู้ใช้', async () => {
    const idem = key()
    await createMember(a, MEMBER, idem)
    const different = await createMember(a, { ...MEMBER, name: 'คนอื่น' }, idem)
    expect(different.status).toBe(422)
    expect((await data(different)).error).toBe('idempotency_mismatch')
    // ผู้ใช้อีกคนใช้ key เดียวกันได้ เป็นคนละคำสั่ง
    expect((await createMember(b, { ...MEMBER, studentId: '6543211' }, idem)).status).toBe(201)
    expect((await data(await call('/api/members', { as: a }))).members).toHaveLength(2)
  })

  it('การแก้รายการหนึ่งไม่กระทบรายการอื่นที่อีกคนเพิ่งแก้ (ไม่มีการเขียนทั้งก้อน)', async () => {
    const one = (await data(await createMember(a, { ...MEMBER, name: 'หนึ่ง' }))).member
    const two = (await data(await createMember(a, { ...MEMBER, studentId: '6543211', name: 'สอง' }))).member
    // B โหลดข้อมูลทั้งหมดไว้ก่อน แล้ว A แก้รายการ "สอง"
    await call('/api/members', { as: b })
    await call(`/api/members/${two.id}`, { method: 'PATCH', as: a, body: { ...MEMBER, studentId: '6543211', name: 'สอง', note: 'A แก้', expectedVersion: 1 } })
    // B แก้รายการ "หนึ่ง" จากข้อมูลที่โหลดไว้เดิม
    const res = await call(`/api/members/${one.id}`, { method: 'PATCH', as: b, body: { ...MEMBER, name: 'หนึ่ง', note: 'B แก้', expectedVersion: 1 } })
    expect(res.status).toBe(200)
    const members = (await data(await call('/api/members', { as: a }))).members as { name: string; note: string }[]
    expect(members.find((m) => m.name === 'สอง')?.note).toBe('A แก้')
    expect(members.find((m) => m.name === 'หนึ่ง')?.note).toBe('B แก้')
  })

  it('ไม่มีเส้นทางเขียนข้อมูลทั้งก้อน รีเซ็ต หรือใส่ข้อมูลตัวอย่าง', async () => {
    for (const [method, path] of [
      ['PUT', '/api/members'], ['DELETE', '/api/members'], ['PUT', '/api/data'], ['POST', '/api/reset'], ['POST', '/api/seed'],
      ['POST', '/api/test/login'], ['POST', '/api/session'],
    ]) {
      const res = await call(path, { method, as: a, body: { members: [], events: [] } })
      expect(res.status, `${method} ${path}`).toBe(404)
    }
  })
})

describe('กำหนดการ: ข้อมูลร่วมกัน', () => {
  it('สร้าง เห็นร่วมกัน แก้จากข้อมูลเก่าได้ 409 และ retry ไม่ซ้ำ', async () => {
    const idem = key()
    const first = await call('/api/events', { method: 'POST', as: a, headers: { 'Idempotency-Key': idem }, body: EVENT })
    const again = await call('/api/events', { method: 'POST', as: a, headers: { 'Idempotency-Key': idem }, body: EVENT })
    const { event } = await data(first)
    expect((await data(again)).event.id).toBe(event.id)
    expect(event).toMatchObject({ ...EVENT, version: 1 })

    expect((await data(await call('/api/events', { as: b }))).events).toHaveLength(1)

    const byA = await call(`/api/events/${event.id}`, { method: 'PATCH', as: a, body: { ...EVENT, title: 'ซ้อมทีม (เลื่อน)', expectedVersion: 1 } })
    expect(byA.status).toBe(200)
    const byB = await call(`/api/events/${event.id}`, { method: 'PATCH', as: b, body: { ...EVENT, location: 'ห้อง 2', expectedVersion: 1 } })
    expect(byB.status).toBe(409)
    expect((await data(byB)).current).toMatchObject({ title: 'ซ้อมทีม (เลื่อน)', location: 'ห้อง 1', version: 2 })
  })

  it('ผู้แก้ล่าสุดถูกบันทึกที่ server', async () => {
    const { event } = await data(await call('/api/events', { method: 'POST', as: a, headers: { 'Idempotency-Key': key() }, body: EVENT }))
    await call(`/api/events/${event.id}`, { method: 'PATCH', as: b, body: { ...EVENT, expectedVersion: 1 } })
    const row = await env.DB.prepare('SELECT created_by, updated_by FROM events WHERE id = ?').bind(event.id).first()
    expect(row).toEqual({ created_by: a.id, updated_by: b.id })
  })
})
