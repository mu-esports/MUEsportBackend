import { beforeEach, describe, expect, it } from 'vitest'
import { call, CLUB_EMAIL, data, env, key, resetDb, seedMemberActor, seedUser } from './helpers'
import type { Actor } from './helpers'
import { bangkokToday } from '../worker/validation'
import { monthGrid } from '../src/lib/datetime'

let admin: Actor, staff: Actor, member: Actor
beforeEach(async () => {
  await resetDb()
  admin = await seedUser(CLUB_EMAIL, 'admin')
  staff = await seedUser('editor@example.test', 'staff')
  member = await seedMemberActor()
})
const input = (changes: Record<string, unknown> = {}) => ({ title: 'ข่าวทดสอบชมรม', summary: 'คำโปรย', body: 'รายละเอียด\nบรรทัดที่สอง', category: 'ประกาศ', publishedDate: bangkokToday(), imageUrl: '', instagramUrl: 'https://www.instagram.com/p/Example123/', sourceUrl: '', status: 'draft', ...changes })
const create = (body = input(), as: Actor | null = staff, createKey = key()) => call('/api/news', { method: 'POST', as, body, headers: { 'Idempotency-Key': createKey } })
const newsForMember = async () => data(await call('/api/member/news', { as: member }))
const seedEvent = async (id: string, start: string, end: string, changes: { missing?: boolean; allDay?: boolean } = {}) => {
  await env.DB.prepare(`INSERT INTO events (id,title,all_day,start_at,end_at,location,description,created_by,updated_by,created_at,updated_at,source_state)
    VALUES (?,?,?,?,?,'ห้องชมรม','รายละเอียดสำหรับสมาชิก','private-actor','private-actor','2026-10-09','2026-10-09',?)`)
    .bind(id, `กิจกรรม ${id}`, changes.allDay ? 1 : 0, start, end, changes.missing ? 'missing' : 'ok').run()
}

describe('ข่าวกลางของชมรม', () => {
  it('ทีมงานจัดการได้ แต่สมาชิก/anonymous อ่านหลังบ้านหรือเขียนข่าวไม่ได้; ต้องมี Origin/CSRF', async () => {
    expect((await create(input(), null)).status).toBe(401)
    expect((await create(input(), member)).status).toBe(403)
    expect((await call('/api/news', { as: member })).status).toBe(403)
    expect((await call('/api/news', { method: 'POST', as: admin, body: input(), raw: true })).status).toBe(403)
    expect((await call('/api/news', { method: 'POST', as: admin, body: input(), raw: true, headers: { Origin: 'https://other.example', 'X-CSRF-Token': admin.csrf } })).status).toBe(403)
    expect((await create(input(), admin)).status).toBe(201)
    expect((await call('/api/news', { as: staff })).status).toBe(200)
  })

  it('สร้างซ้ำด้วย key เดิมได้รายการเดียว แม้คำตอบครั้งแรกหาย; key เดิมกับข้อมูลใหม่ถูกปฏิเสธ', async () => {
    const createKey = key(), body = input()
    const first = await data(await create(body, staff, createKey))
    const retry = await create(body, staff, createKey)
    expect(retry.status).toBe(200)
    expect((await data(retry)).news.id).toBe(first.news.id)
    expect((await create(input({ title: 'ข้อมูลเปลี่ยน' }), staff, createKey)).status).toBe(422)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM club_news').first<{ n: number }>())?.n).toBe(1)
  })

  it('สมาชิกเห็นเฉพาะข่าวเผยแพร่ที่ถึงวันแล้ว ไม่มีชื่อผู้แก้ รุ่น หรือข้อมูลจัดการ', async () => {
    await create(input({ status: 'published', title: 'ข่าวที่เห็น' }))
    await create(input({ title: 'ร่าง' }))
    await create(input({ status: 'archived', title: 'ในคลัง' }))
    await create(input({ status: 'published', publishedDate: '9998-12-31', title: 'ข่าวอนาคต' }))
    const page = await newsForMember()
    expect(page.news.map((p: { title: string }) => p.title)).toEqual(['ข่าวที่เห็น'])
    expect(Object.keys(page.news[0]).sort()).toEqual(['body','category','id','imageUrl','instagramUrl','publishedDate','sourceUrl','summary','title'])
    expect((await call('/api/member/news')).status).toBe(401)
    expect((await call('/api/member/news', { as: staff })).status).toBe(403)
    const temporary = await seedMemberActor({ mustChange: true })
    expect((await call('/api/member/news', { as: temporary })).status).toBe(403)
  })

  it('การแก้ข่าวและเก็บเข้าคลังปรากฏในคำขอสมาชิกถัดไป; stale version ไม่ทับข่าวคนอื่น', async () => {
    const post = (await data(await create(input({ status: 'published' })))).news
    const first = await call(`/api/news/${post.id}`, { method: 'PATCH', as: staff, body: { ...input({ status: 'published', title: 'หัวข้อใหม่' }), expectedVersion: 1 } })
    expect(first.status).toBe(200)
    expect((await newsForMember()).news[0].title).toBe('หัวข้อใหม่')
    const conflict = await call(`/api/news/${post.id}`, { method: 'PATCH', as: admin, body: { ...input({ title: 'ร่างเก่า' }), expectedVersion: 1 } })
    expect(conflict.status).toBe(409)
    expect((await data(conflict)).current.title).toBe('หัวข้อใหม่')
    expect((await call(`/api/news/${post.id}`, { method: 'PATCH', as: staff, body: { ...input({ status: 'archived' }), expectedVersion: 2 } })).status).toBe(200)
    expect((await newsForMember()).news).toEqual([])
    expect((await call('/api/news/missing', { method: 'PATCH', as: staff, body: { ...input(), expectedVersion: 1 } })).status).toBe(404)
  })

  it('วันที่ผิด ลิงก์อันตราย และข้อมูลเกินขนาดถูกปฏิเสธก่อนเก็บ', async () => {
    for (const change of [
      { publishedDate: '2026-02-30' }, { publishedDate: 'oops' }, { title: '' }, { title: 'x'.repeat(201) },
      { imageUrl: 'javascript:alert(1)' }, { imageUrl: 'data:image/svg+xml;base64,abc' },
      { imageUrl: 'https://user:password@example.com/a.jpg' }, { instagramUrl: 'https://instagram.com.evil.example/p/test' },
      { instagramUrl: 'https://instagram.com/accounts/login/' }, { status: 'unknown' },
    ]) expect((await create(input(change))).status, JSON.stringify(change)).toBe(422)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM club_news').first<{ n: number }>())?.n).toBe(0)
  })

  it('บันทึกข่าวภาษาไทยเต็มเพดาน 12000 ตัวอักษรได้ทั้งสร้างและแก้ ไม่สับสนขนาด UTF-8 กับจำนวนตัวอักษร', async () => {
    const body = 'ก'.repeat(12000)
    const response = await create(input({ body }))
    expect(response.status).toBe(201)
    const post = (await data(response)).news
    expect(post.body).toBe(body)
    const changed = 'ข'.repeat(12000)
    const update = await call(`/api/news/${post.id}`, { method: 'PATCH', as: staff, body: { ...input({ body: changed }), expectedVersion: post.version } })
    expect(update.status).toBe(200)
    expect((await data(update)).news.body).toBe(changed)
    expect((await create(input({ body: 'ก'.repeat(12001) }))).status).toBe(422)
  })

  it('จำกัดจำนวนข่าวพร้อมแจ้ง truncated ไม่ทำให้ browser โหลดข้อมูลทั้งคลัง', async () => {
    await env.DB.batch(Array.from({ length: 205 }, (_, i) => env.DB.prepare(`INSERT INTO club_news (id,title,published_date,status,created_by,updated_by,created_at,updated_at) VALUES (?,?,'2026-01-01','published','seed','seed','2026-01-01','2026-01-01')`).bind(`post-${i}`, `ข่าว ${i}`)))
    const publicPage = await newsForMember(), staffPage = await data(await call('/api/news', { as: staff }))
    expect(publicPage.news.length).toBe(100); expect(publicPage.truncated).toBe(true)
    expect(staffPage.news.length).toBe(200); expect(staffPage.truncated).toBe(true)
  })
})

describe('ปฏิทินสมาชิกใช้ข้อมูลเดียวกับหลังบ้าน', () => {
  it('อ่านได้เฉพาะสมาชิกที่เปลี่ยนรหัสแล้ว ไม่มี endpoint จัดการปฏิทินให้สมาชิก', async () => {
    expect((await call('/api/member/calendar?month=2026-10')).status).toBe(401)
    expect((await call('/api/member/calendar?month=2026-10', { as: admin })).status).toBe(403)
    const temporary = await seedMemberActor({ mustChange: true })
    expect((await call('/api/member/calendar?month=2026-10', { as: temporary })).status).toBe(403)
    expect((await call('/api/member/calendar?month=2026-10', { as: member, method: 'POST', body: {} })).status).toBe(404)
  })

  it('แสดงเดือนเก่า กำหนดการข้ามวัน และช่องวันเดือนข้างเคียง; ไม่แสดง source ที่หายหรือข้อมูลภายใน', async () => {
    const days = monthGrid('2025-05')
    await seedEvent('old', '2025-05-10T09:00', '2025-05-10T10:00')
    await seedEvent('spanning', '2025-04-01T00:00', '2025-06-01T23:59', { allDay: true })
    await seedEvent('first-grid-day', `${days[0]}T00:00`, `${days[0]}T01:00`)
    await seedEvent('last-grid-day', `${days[days.length-1]}T23:59`, `${days[days.length-1]}T23:59`)
    await seedEvent('outside', '2025-03-01T10:00', '2025-03-01T11:00')
    await seedEvent('missing', '2025-05-10T09:00', '2025-05-10T10:00', { missing: true })
    const page = await data(await call('/api/member/calendar?month=2025-05', { as: member }))
    expect(page.month).toBe('2025-05'); expect(page.truncated).toBe(false)
    expect(page.events.map((e: { id: string }) => e.id).sort()).toEqual(['old','spanning','first-grid-day','last-grid-day'].sort())
    expect(Object.keys(page.events[0]).sort()).toEqual(['allDay','description','end','id','location','start','title'])
    expect(page.events.find((e: { id: string }) => e.id === 'spanning').allDay).toBe(true)
    expect(JSON.stringify(page)).not.toContain('private-actor')
  })

  it('หลังทีมงานบันทึกกำหนดการ สมาชิกเห็นการแก้ในคำขออ่านเดือนถัดไป', async () => {
    const body = { title: 'กิจกรรมใหม่', allDay: false, start: '2026-10-12T13:00', end: '2026-10-12T14:00', location: 'ห้องชมรม', description: 'เปิดให้สมาชิก' }
    const created = await data(await call('/api/events', { method: 'POST', as: staff, body, headers: { 'Idempotency-Key': key() } }))
    expect((await data(await call('/api/member/calendar?month=2026-10', { as: member }))).events[0].title).toBe('กิจกรรมใหม่')
    const update = await call(`/api/events/${created.event.id}`, { method: 'PATCH', as: staff, body: { ...body, title: 'ชื่อกิจกรรมที่แก้แล้ว', expectedVersion: created.event.version } })
    expect(update.status).toBe(200)
    expect((await data(await call('/api/member/calendar?month=2026-10', { as: member }))).events[0].title).toBe('ชื่อกิจกรรมที่แก้แล้ว')
  })

  it('เดือนที่ผิดถูกปฏิเสธ และคำขอไม่มีเดือนใช้เดือนปัจจุบันตามเวลาไทย', async () => {
    for (const month of ['2026-00', '2026-13', '26-10', '2026-10-01', '0001-01', '9999-12', 'oops']) expect((await call(`/api/member/calendar?month=${month}`, { as: member })).status).toBe(422)
    expect((await data(await call('/api/member/calendar', { as: member }))).month).toBe(bangkokToday().slice(0,7))
  })

  it('เดือนที่มีรายการมากถูกจำกัด 500 และบอกว่าข้อมูลถูกตัด', async () => {
    await env.DB.batch(Array.from({ length: 501 }, (_, i) => env.DB.prepare(`INSERT INTO events (id,title,all_day,start_at,end_at,created_by,updated_by,created_at,updated_at) VALUES (?, ?, 0, '2026-10-10T09:00', '2026-10-10T10:00','seed','seed','2026-10-09','2026-10-09')`).bind(`event-${i}`, `กิจกรรม ${i}`)))
    const page = await data(await call('/api/member/calendar?month=2026-10', { as: member }))
    expect(page.events.length).toBe(500); expect(page.truncated).toBe(true)
  })
})
