// Regression จากรอบตรวจอิสระ: คำขอสร้างเอกสารที่มาพร้อมกัน ผลการสร้างที่ไม่แน่ชัด การนำงานออกขณะกำลังทำ
// และการเปลี่ยนชื่อ/บันทึกเนื้อหาที่สำเร็จบางส่วน — ทั้งหมดรันกับ Worker + D1 local และ Google จำลอง
//
// ปรับจาก review-docs-races.test.ts: ชุดเดิมกั้นที่ Drive search และรอให้สองคำขอมาถึงพร้อมกัน
// หลังแก้ คำขอที่สองไปไม่ถึง Google เลย (ถูกกันด้วย lease ใน D1) จึงย้ายจุดกั้นไปที่คำสั่งสร้างไฟล์
// และปล่อยด้วยเวลาแทน โดยคง assertion เดิมว่าต้องมีไฟล์เดียว
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { encryptSecret } from '../worker/crypto'
import { call, CLUB_EMAIL, data, env, FakeGoogle, key, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'

let google: FakeGoogle
let staff: Actor
let admin: Actor

beforeEach(async () => {
  await resetDb()
  google = await FakeGoogle.start()
  staff = await seedUser('reviewer@example.com', 'staff')
  admin = await seedUser(CLUB_EMAIL, 'admin')
  google.refreshTokens.set('review-refresh', 'valid')
  await env.DB.prepare(
    `INSERT INTO google_connections (id, google_sub, email, scopes, refresh_token_enc, status, updated_at)
     VALUES ('club', 'club-sub', ?, 'openid email https://www.googleapis.com/auth/drive.file', ?, 'connected', 'x')`,
  )
    .bind(CLUB_EMAIL, await encryptSecret(env.TOKEN_ENCRYPTION_KEY, 'review-refresh'))
    .run()
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

const INPUT = { title: 'Concurrent creation review', text: 'same payload' }
const post = (idem: string, body: unknown = INPUT, as: Actor = staff) =>
  call('/api/documents', { method: 'POST', as, headers: { 'Idempotency-Key': idem }, body })
const resume = (id: string, body?: unknown, as: Actor = staff) =>
  call(`/api/documents/operations/${id}/resume`, { method: 'POST', as, body })
const dismiss = (id: string, as: Actor = staff) => call(`/api/documents/operations/${id}`, { method: 'DELETE', as })
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

const isDriveCreate = (url: URL, method: string) => url.pathname === '/drive/v3/files' && method === 'POST'
const isDriveSearch = (url: URL, method: string) => url.pathname === '/drive/v3/files' && method === 'GET'
const isBatchUpdate = (url: URL) => url.pathname.endsWith(':batchUpdate')
const count = (match: (url: URL, method: string) => boolean) => google.calls.filter((c) => match(new URL(c.url), c.method)).length
const documents = async () => (await env.DB.prepare('SELECT * FROM documents').all<Record<string, any>>()).results
const operation = async () => (await env.DB.prepare('SELECT * FROM document_operations').first<Record<string, any>>())!
const operations = async () => (await env.DB.prepare('SELECT * FROM document_operations').all<Record<string, any>>()).results

/** หยุดคำขอแรกที่ตรงเงื่อนไขไว้กลางทาง (ก่อนถึง Google จำลอง) จนกว่าจะปล่อย */
function hold(match: (url: URL, method: string) => boolean) {
  let release!: () => void
  let arrived!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const arrival = new Promise<void>((resolve) => (arrived = resolve))
  let used = false
  google.interceptors.push(async (url, init) => {
    if (used || !match(url, init?.method ?? 'GET')) return undefined
    used = true
    arrived()
    await gate
    return undefined
  })
  return { arrival, release }
}

/** Google สร้างไฟล์สำเร็จ แต่คำตอบที่กลับมาเป็นข้อผิดพลาด (response หาย) */
function createButLoseResponse() {
  let used = false
  google.interceptors.push((url, init) => {
    if (used || !isDriveCreate(url, init?.method ?? 'GET')) return undefined
    used = true
    const body = JSON.parse(init!.body as string) as { name: string; appProperties: Record<string, string> }
    google.addDoc(body.name, '').appProperties = body.appProperties
    return new Response('{}', { status: 504 })
  })
}

describe('คำขอสร้างเอกสารที่มาพร้อมกัน', () => {
  it('REVIEW: simultaneous retries must create just one Google file', async () => {
    const blocked = hold(isDriveCreate)
    const idem = key()
    const first = post(idem)
    const second = post(idem)
    await blocked.arrival
    await sleep(300)
    blocked.release()
    const responses = await Promise.all([first, second])
    const bodies = await Promise.all(responses.map((r) => data(r)))

    expect(google.docs.size).toBe(1)
    expect(count(isDriveCreate)).toBe(1)
    expect(count(isBatchUpdate)).toBe(1)
    expect(await documents()).toHaveLength(1)
    expect(await operations()).toHaveLength(1)
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    // ทั้งสองคำขออ้างถึงเอกสารเดียวกัน
    expect(bodies[0].document.id).toBe(bodies[1].document.id)
    expect([...google.docs.values()][0].text).toBe('same payload\n')
  })

  it('คำขอซ้ำระหว่างที่คำขอแรกยังไม่เสร็จ: ได้คำตอบว่ากำลังทำอยู่ ไม่ไปถึง Google และอ้างงานเดียวกัน', async () => {
    const blocked = hold(isDriveCreate)
    const idem = key()
    const first = post(idem)
    await blocked.arrival
    const second = await post(idem)
    expect(second.status).toBe(409)
    const waiting = await data(second)
    expect(waiting.error).toBe('operation_in_progress')
    expect(waiting.operationId).toBe((await operation()).id)
    expect(count(isDriveCreate)).toBe(1)
    expect(count(isDriveSearch)).toBe(0)

    blocked.release()
    const done = await data(await first)
    const replay = await post(idem)
    expect(replay.status).toBe(200)
    expect((await data(replay)).document.id).toBe(done.document.id)
    expect(google.docs.size).toBe(1)
    expect(await documents()).toHaveLength(1)
  })

  it('POST กับ resume พร้อมกัน: ผลเดียวกัน ไม่เขียนเนื้อหาซ้ำ', async () => {
    const idem = key()
    google.failOnce(isBatchUpdate, 503)
    const failed = await data(await post(idem))
    expect(failed.fileState).toBe('created')

    const blocked = hold(isBatchUpdate)
    const viaPost = post(idem)
    const viaResume = resume(failed.operationId)
    await blocked.arrival
    await sleep(300)
    blocked.release()
    const responses = await Promise.all([viaPost, viaResume])
    const bodies = await Promise.all(responses.map((r) => data(r)))
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    expect(bodies[0].document.id).toBe(bodies[1].document.id)
    expect(count(isDriveCreate)).toBe(1)
    // batchUpdate: ครั้งแรกที่จงใจให้ล้มเหลว + ครั้งที่สำเร็จครั้งเดียว
    expect(count(isBatchUpdate)).toBe(2)
    expect([...google.docs.values()][0].text).toBe('same payload\n')
    expect(await documents()).toHaveLength(1)
  })

  it('resume สองตัวพร้อมกัน (คนละผู้ใช้: เจ้าของงานกับผู้ดูแล): ผลเดียวกัน', async () => {
    google.failOnce(isBatchUpdate, 503)
    const failed = await data(await post(key()))
    const blocked = hold(isBatchUpdate)
    const one = resume(failed.operationId)
    const two = resume(failed.operationId, undefined, admin)
    await blocked.arrival
    await sleep(300)
    blocked.release()
    const responses = await Promise.all([one, two])
    const bodies = await Promise.all(responses.map((r) => data(r)))
    expect(responses.map((r) => r.status).sort()).toEqual([200, 201])
    expect(bodies[0].document.id).toBe(bodies[1].document.id)
    expect(count(isBatchUpdate)).toBe(2)
    expect(google.docs.size).toBe(1)
    expect(await documents()).toHaveLength(1)
    expect((await operation()).status).toBe('completed')
  })
})

describe('ผลการสร้างไฟล์ที่ไม่แน่ชัด', () => {
  it('response หายหลัง Google สร้างไฟล์: บอกว่าไม่ทราบผล ไม่รับรองว่ายังไม่ได้สร้าง และลองใหม่ใช้ไฟล์เดิม', async () => {
    createButLoseResponse()
    const idem = key()
    const failed = await post(idem)
    expect(failed.status).toBe(502)
    const body = await data(failed)
    expect(body.fileState).toBe('unknown')
    expect(body.message).toContain('ไม่ทราบว่า Google Docs สร้างไฟล์แล้วหรือยัง')
    expect(body.message).not.toContain('ยังไม่ได้สร้าง')
    expect(body.message).not.toContain('ยังไม่ได้ส่งคำสั่ง')
    const row = await operation()
    expect(row.create_attempted_at).toBeTruthy()
    expect(row.google_document_id).toBeNull()
    expect(row.lease_owner).toBeNull()

    const listed = await data(await call('/api/documents/operations', { as: staff }))
    expect(listed.operations[0]).toMatchObject({ fileState: 'unknown', fileCreated: false, inProgress: false, canConfirmCreate: false })

    const retried = await post(idem)
    expect(retried.status).toBe(201)
    expect(google.docs.size).toBe(1)
    expect(count(isDriveCreate)).toBe(1)
    expect([...google.docs.values()][0].text).toBe('same payload\n')
  })

  it('Drive search ยังไม่เห็นไฟล์ที่เพิ่งสร้าง: ไม่สร้างใหม่แบบเดา รอจนค้นพบไฟล์เดิม', async () => {
    createButLoseResponse()
    const idem = key()
    await post(idem)
    // ผลค้นหายังว่างสองครั้งแรก (ดัชนีของ Drive ยังไม่ทัน)
    let stale = 2
    google.interceptors.push((url, init) => {
      if (stale > 0 && isDriveSearch(url, init?.method ?? 'GET')) {
        stale--
        return Response.json({ files: [] })
      }
      return undefined
    })
    for (let i = 0; i < 2; i++) {
      const again = await post(idem)
      expect(again.status).toBe(409)
      const body = await data(again)
      expect(body.error).toBe('operation_create_unknown')
      expect(body.fileState).toBe('unknown')
      expect(body.message).toContain('ไฟล์ที่เพิ่งสร้างอาจยังไม่ปรากฏในผลค้นหา')
      expect(count(isDriveCreate)).toBe(1)
      expect(google.docs.size).toBe(1)
    }
    const found = await post(idem)
    expect(found.status).toBe(201)
    expect(count(isDriveCreate)).toBe(1)
    expect(google.docs.size).toBe(1)
    expect(await documents()).toHaveLength(1)
  })

  it('Google ไม่ตอบและไม่ได้สร้างจริง: ยังไม่สร้างใหม่เอง ต้องรอเวลาและให้ผู้ใช้ยืนยันหลังตรวจ Drive', async () => {
    google.failOnce(isDriveCreate, 504)
    const idem = key()
    const failed = await data(await post(idem))
    expect(failed.fileState).toBe('unknown')
    expect(google.docs.size).toBe(0)

    // ยืนยันทันทีไม่ได้ (ไฟล์อาจยังไม่ปรากฏในผลค้นหา)
    const early = await resume(failed.operationId, { confirmCreate: true })
    expect(early.status).toBe(409)
    expect(await data(early)).toMatchObject({ error: 'operation_create_unknown', canConfirmCreate: false })
    expect(count(isDriveCreate)).toBe(1)

    await env.DB.prepare('UPDATE document_operations SET create_attempted_at = ?').bind(new Date(Date.now() - 180_000).toISOString()).run()
    // ไม่ยืนยัน = ไม่สร้าง แม้ผ่านเวลาแล้ว
    const unconfirmed = await post(idem)
    expect(unconfirmed.status).toBe(409)
    expect(await data(unconfirmed)).toMatchObject({ error: 'operation_create_unknown', canConfirmCreate: true })
    expect(count(isDriveCreate)).toBe(1)
    expect((await data(await call('/api/documents/operations', { as: staff }))).operations[0].canConfirmCreate).toBe(true)

    const confirmed = await resume(failed.operationId, { confirmCreate: true })
    expect(confirmed.status).toBe(201)
    expect(count(isDriveCreate)).toBe(2)
    expect(google.docs.size).toBe(1)
    expect(await documents()).toHaveLength(1)
    const logged = await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'document.create_reconfirmed'`).first<{ n: number }>()
    expect(logged?.n).toBe(1)
  })

  it('ยืนยันให้สร้างใหม่ แต่ระบบค้นพบไฟล์เดิม: ใช้ไฟล์เดิม ไม่สร้างเพิ่ม', async () => {
    createButLoseResponse()
    const failed = await data(await post(key()))
    await env.DB.prepare('UPDATE document_operations SET create_attempted_at = ?').bind(new Date(Date.now() - 180_000).toISOString()).run()
    const confirmed = await resume(failed.operationId, { confirmCreate: true })
    expect(confirmed.status).toBe(201)
    expect(count(isDriveCreate)).toBe(1)
    expect(google.docs.size).toBe(1)
  })

  it('Google ปฏิเสธคำสั่งสร้างชัดเจน (4xx): บอกว่ายังไม่ได้สร้าง และลองใหม่สร้างได้', async () => {
    google.failOnce(isDriveCreate, 403)
    const idem = key()
    const failed = await post(idem)
    const body = await data(failed)
    expect(failed.status).toBe(502)
    expect(body.fileState).toBe('none')
    expect((await operation()).create_attempted_at).toBeNull()
    const retried = await post(idem)
    expect(retried.status).toBe(201)
    expect(google.docs.size).toBe(1)
  })

  it('D1 บันทึก id ของไฟล์ไม่สำเร็จหลัง Google สร้างแล้ว (จำลองสถานะที่เหลืออยู่ใน D1): ลองใหม่ใช้ไฟล์เดิม', async () => {
    const idem = key()
    google.failOnce(isBatchUpdate, 503)
    await post(idem)
    // สถานะเดียวกับกรณีคำสั่ง UPDATE ที่บันทึก id ล้มเหลว: มีเครื่องหมายว่าส่งคำสั่งสร้างแล้ว แต่ไม่มี id
    await env.DB.prepare(`UPDATE document_operations SET google_document_id = NULL, status = 'pending'`).run()
    expect((await operation()).create_attempted_at).toBeTruthy()
    const retried = await post(idem)
    expect(retried.status).toBe(201)
    expect(count(isDriveCreate)).toBe(1)
    expect(google.docs.size).toBe(1)
    expect(await documents()).toHaveLength(1)
  })

  it('runner หยุดกลางทางหลังส่งคำสั่งสร้าง และ lease หมดแล้ว: คำขอใหม่รับช่วงได้แต่ไม่สร้างไฟล์ใหม่', async () => {
    google.failOnce(isDriveCreate, 429)
    const idem = key()
    await post(idem)
    const past = new Date(Date.now() - 1000).toISOString()
    await env.DB.prepare(`UPDATE document_operations SET create_attempted_at = ?, lease_owner = 'dead-runner', lease_expires_at = ?`).bind(past, past).run()
    const again = await post(idem)
    expect(again.status).toBe(409)
    expect((await data(again)).error).toBe('operation_create_unknown')
    expect(count(isDriveCreate)).toBe(1)
    expect(google.docs.size).toBe(0)
    expect((await operation()).lease_owner).toBeNull()
  })

  it('lease ของ runner เดิมยังไม่หมด: คำขอใหม่ไม่ทำอะไรกับ Google เลย', async () => {
    google.failOnce(isDriveCreate, 429)
    const idem = key()
    await post(idem)
    const calls = google.calls.length
    await env.DB.prepare(`UPDATE document_operations SET lease_owner = 'live-runner', lease_expires_at = ?`).bind(new Date(Date.now() + 60_000).toISOString()).run()
    const again = await post(idem)
    expect(again.status).toBe(409)
    expect((await data(again)).error).toBe('operation_in_progress')
    expect(google.calls.length).toBe(calls)
    expect((await operation()).lease_owner).toBe('live-runner')
  })

  it('lease หมดระหว่างรอ Google สร้างไฟล์: คำขอที่รับช่วงไม่สร้างใหม่ และ runner เดิมที่มาช้าไม่ลงทะเบียนซ้ำ', async () => {
    const blocked = hold(isDriveCreate)
    const idem = key()
    const first = post(idem)
    await blocked.arrival
    await env.DB.prepare('UPDATE document_operations SET lease_expires_at = ?').bind(new Date(Date.now() - 1000).toISOString()).run()

    const takeover = await post(idem)
    expect(takeover.status).toBe(409)
    expect((await data(takeover)).error).toBe('operation_create_unknown')
    expect(count(isDriveCreate)).toBe(1)

    blocked.release()
    const late = await first
    // runner เดิมเสียสิทธิ์ไปแล้ว: บันทึก id ของไฟล์ที่ Google สร้างไว้ให้ตามได้ แต่ไม่ทำขั้นต่อไป
    expect(late.status).toBe(409)
    expect(await data(late)).toMatchObject({ error: 'operation_in_progress', fileState: 'created' })
    expect(await documents()).toHaveLength(0)
    expect((await operation()).google_document_id).toBe([...google.docs.keys()][0])
    expect(count(isBatchUpdate)).toBe(0)

    const finished = await post(idem)
    expect(finished.status).toBe(201)
    expect(google.docs.size).toBe(1)
    expect(count(isDriveCreate)).toBe(1)
    expect(await documents()).toHaveLength(1)
  })

  it('runner ที่เสียสิทธิ์ระหว่างเขียนเนื้อหา: ไม่ลงทะเบียนเอกสาร และงานที่เสร็จแล้วไม่ถูกทับ', async () => {
    const blocked = hold(isBatchUpdate)
    const idem = key()
    const first = post(idem)
    await blocked.arrival
    await env.DB.prepare(`UPDATE document_operations SET lease_owner = 'other-runner', lease_expires_at = ?`).bind(new Date(Date.now() + 60_000).toISOString()).run()
    blocked.release()
    const late = await first
    expect(late.status).toBe(409)
    expect((await data(late)).error).toBe('operation_in_progress')
    expect(await documents()).toHaveLength(0)
    expect((await operation()).status).toBe('file_created')
    // lease ของอีกตัวไม่ถูก runner เดิมปล่อยทิ้ง
    expect((await operation()).lease_owner).toBe('other-runner')

    await env.DB.prepare('UPDATE document_operations SET lease_owner = NULL, lease_expires_at = NULL').run()
    const finished = await data(await post(idem))
    expect(count(isBatchUpdate)).toBe(1)
    expect([...google.docs.values()][0].text).toBe('same payload\n')
    const rows = await documents()
    expect(rows).toHaveLength(1)
    expect((await operation()).document_id).toBe(rows[0].id)
    expect(finished.document.id).toBe(rows[0].id)

    // คำขอที่มาหลังงานเสร็จ: ได้เอกสารเดิม ไม่มีแถวเพิ่ม
    const replay = await data(await resume((await operation()).id))
    expect(replay.document.id).toBe(rows[0].id)
    expect(await documents()).toHaveLength(1)
  })
})

describe('นำงานออกจากรายการ', () => {
  it('ขณะงานกำลังทำ: ปฏิเสธ ไม่ลบหลักฐาน และงานทำต่อจนเสร็จโดยมี operation ติดตาม', async () => {
    const blocked = hold(isDriveCreate)
    const idem = key()
    const first = post(idem)
    await blocked.arrival
    const opId = (await operation()).id

    const refused = await dismiss(opId)
    expect(refused.status).toBe(409)
    expect((await data(refused)).error).toBe('operation_in_progress')
    expect(await operations()).toHaveLength(1)
    expect((await operation()).dismissed_at).toBeNull()

    blocked.release()
    const done = await data(await first)
    const row = await operation()
    expect(row).toMatchObject({ status: 'completed', document_id: done.document.id, dismissed_at: null })
    expect(google.docs.size).toBe(1)
    expect((await dismiss(opId)).status).toBe(409)
  })

  it('งานที่ไม่ทราบผลการสร้าง: เก็บแถวไว้เป็นหลักฐาน ไม่บอกว่าไม่มีไฟล์ และ key เดิมไม่เริ่มงานใหม่เงียบ ๆ', async () => {
    createButLoseResponse()
    const idem = key()
    const failed = await data(await post(idem))
    const result = await dismiss(failed.operationId)
    expect(await data(result)).toEqual({ ok: true, fileState: 'unknown', fileRemainsInGoogle: false })

    const row = await operation()
    expect(row.dismissed_at).toBeTruthy()
    expect(row.dismissed_by).toBe(staff.id)
    expect(row.create_attempted_at).toBeTruthy()
    expect(row.content).toBeNull()
    expect((await data(await call('/api/documents/operations', { as: staff }))).operations).toEqual([])

    const calls = google.calls.length
    const again = await post(idem)
    expect(again.status).toBe(409)
    expect((await data(again)).error).toBe('operation_dismissed')
    expect((await resume(failed.operationId)).status).toBe(409)
    expect(google.calls.length).toBe(calls)
    expect(await documents()).toHaveLength(0)
    expect(google.calls.some((c) => c.method === 'DELETE')).toBe(false)
    // นำออกซ้ำได้ผลเดิม
    expect((await dismiss(failed.operationId)).status).toBe(200)
  })

  it('งานที่สร้างไฟล์แล้ว: แถวยังเก็บ id ของไฟล์ไว้ให้ตามได้', async () => {
    google.failOnce(isBatchUpdate, 503)
    const failed = await data(await post(key()))
    expect(await data(await dismiss(failed.operationId))).toEqual({ ok: true, fileState: 'created', fileRemainsInGoogle: true })
    expect((await operation()).google_document_id).toBe([...google.docs.keys()][0])
  })
})

describe('retry และ payload', () => {
  it('retry หลังเสร็จได้เอกสารเดิม และ key เดิมกับข้อมูลอื่นถูกปฏิเสธ', async () => {
    const idem = key()
    const first = await data(await post(idem))
    const again = await post(idem)
    expect(again.status).toBe(200)
    expect(await data(again)).toMatchObject({ replayed: true, document: { id: first.document.id } })
    const mismatch = await post(idem, { ...INPUT, text: 'different payload' })
    expect(mismatch.status).toBe(422)
    expect((await data(mismatch)).error).toBe('idempotency_mismatch')
    expect(google.docs.size).toBe(1)
    expect(count(isDriveCreate)).toBe(1)
  })
})

describe('ชื่อเอกสารและการบันทึกที่สำเร็จบางส่วน', () => {
  const createDoc = async () => {
    const created = await data(await post(key(), { title: 'Original title', text: 'unchanged body' }))
    return { created, googleId: [...google.docs.keys()][0] }
  }
  const save = (id: string, body: unknown) => call(`/api/documents/${id}`, { method: 'PUT', as: staff, body })
  const isRename = (url: URL, method: string) => url.pathname.startsWith('/drive/v3/files/') && method === 'PATCH'

  it('REVIEW: external title change during save must not be overwritten silently', async () => {
    const { created, googleId } = await createDoc()
    // อีกคนเปลี่ยนชื่อใน Google Docs หลังจากผู้ใช้เปิดเอกสาร
    google.docs.get(googleId)!.title = 'New title from another editor'
    const saved = await save(created.document.id, { title: 'Stale user title', text: 'unchanged body', baseRevisionId: created.content.revisionId })
    expect(saved.status).toBe(409)
    expect(await data(saved)).toMatchObject({ error: 'title_change_not_supported', currentTitle: 'New title from another editor' })
    // ปฏิเสธก่อนถึงคำสั่งเปลี่ยนชื่อของ Drive และชื่อของอีกคนยังอยู่
    expect(count(isRename)).toBe(0)
    expect(google.docs.get(googleId)!.title).toBe('New title from another editor')
  })

  it('server ปฏิเสธการเปลี่ยนชื่อทุกกรณี และไม่บันทึกเนื้อหาที่ส่งมาพร้อมกัน', async () => {
    const { created, googleId } = await createDoc()
    const saved = await save(created.document.id, { title: 'Renamed from web', text: 'changed body', baseRevisionId: created.content.revisionId })
    expect(saved.status).toBe(409)
    expect((await data(saved)).message).toContain('ยังไม่ได้บันทึกอะไร')
    expect(count(isRename)).toBe(0)
    expect(count(isBatchUpdate)).toBe(1) // เฉพาะตอนสร้าง
    expect(google.docs.get(googleId)).toMatchObject({ title: 'Original title', text: 'unchanged body\n' })
    expect((await save(created.document.id, { title: 5, text: 'x', baseRevisionId: created.content.revisionId })).status).toBe(409)
  })

  it('บันทึกเนื้อหาโดยไม่เปลี่ยนชื่อยังทำงาน (ทั้งไม่ส่งชื่อ และส่งชื่อเดิม) และรายการในเว็บตามชื่อที่เปลี่ยนจาก Google', async () => {
    const { created, googleId } = await createDoc()
    const one = await save(created.document.id, { text: 'edited once', baseRevisionId: created.content.revisionId })
    expect(one.status).toBe(200)
    const first = await data(one)
    expect(first).toMatchObject({ verified: true, content: { text: 'edited once' } })
    expect(first.titleSaved).toBeUndefined()

    google.docs.get(googleId)!.title = 'Renamed in Google Docs'
    const two = await save(created.document.id, { title: 'Renamed in Google Docs', text: 'edited twice', baseRevisionId: first.content.revisionId })
    expect(two.status).toBe(200)
    expect((await data(two)).document.title).toBe('Renamed in Google Docs')
    expect((await data(await call('/api/documents', { as: staff }))).documents[0].title).toBe('Renamed in Google Docs')
    expect(google.docs.get(googleId)!.text).toBe('edited twice\n')
    expect(count(isRename)).toBe(0)
  })

  it('conflict ของ Docs ยังป้องกันได้เมื่อไม่ส่งชื่อ', async () => {
    const { created, googleId } = await createDoc()
    google.editExternally(googleId, 'someone else')
    const saved = await save(created.document.id, { text: 'mine', baseRevisionId: created.content.revisionId })
    expect(saved.status).toBe(409)
    expect((await data(saved)).error).toBe('revision_conflict')
    expect(google.docs.get(googleId)!.text).toBe('someone else\n')
  })

  it('Google ใช้คำสั่งบันทึกแล้วแต่คำตอบเป็นข้อผิดพลาด: ไม่บอกว่าไม่มีอะไรเปลี่ยน', async () => {
    const { created, googleId } = await createDoc()
    let used = false
    google.interceptors.push((url) => {
      if (used || !isBatchUpdate(url)) return undefined
      used = true
      google.editExternally(googleId, 'applied by google')
      return new Response('{}', { status: 500 })
    })
    const saved = await save(created.document.id, { text: 'applied by google', baseRevisionId: created.content.revisionId })
    expect(saved.status).toBe(502)
    const body = await data(saved)
    expect(body.error).toBe('save_outcome_unknown')
    expect(body.message).toContain('ไม่ทราบว่า Google Docs บันทึกการแก้ครั้งนี้แล้วหรือยัง')
    expect(body.message).not.toContain('ยังไม่มีการเปลี่ยนแปลง')
    // ตรวจฉบับล่าสุดได้ตามจริง
    const latest = await data(await call(`/api/documents/${created.document.id}`, { as: staff }))
    expect(latest.content.text).toBe('applied by google')
  })

  it('คำตอบของคำสั่งบันทึกไม่กลับมาเลย (เครือข่ายขาด): รายงานว่าไม่ทราบผลเช่นกัน', async () => {
    const { created } = await createDoc()
    let used = false
    google.interceptors.push((url) => {
      if (used || !isBatchUpdate(url)) return undefined
      used = true
      throw new Error('network down')
    })
    const saved = await save(created.document.id, { text: 'maybe', baseRevisionId: created.content.revisionId })
    expect(saved.status).toBe(502)
    expect((await data(saved)).error).toBe('save_outcome_unknown')
  })

  it('Google บันทึกแล้วแต่อ่านกลับเพื่อยืนยันไม่ได้: บอกว่า Google รับแล้วแต่ยังไม่ยืนยัน', async () => {
    const { created, googleId } = await createDoc()
    let wrote = false
    let failed = false
    google.interceptors.push((url, init) => {
      if (isBatchUpdate(url)) wrote = true
      else if (wrote && !failed && url.origin === 'https://docs.googleapis.com' && (init?.method ?? 'GET') === 'GET') {
        failed = true
        return new Response('{}', { status: 503 })
      }
      return undefined
    })
    const saved = await save(created.document.id, { text: 'written', baseRevisionId: created.content.revisionId })
    expect(saved.status).toBe(502)
    const body = await data(saved)
    expect(body.error).toBe('saved_unverified')
    expect(body.message).toContain('Google Docs รับการบันทึกแล้ว')
    expect(google.docs.get(googleId)!.text).toBe('written\n')
  })

  it('Google ปฏิเสธคำสั่งบันทึกชัดเจน: บอกว่ายังไม่มีการเปลี่ยนแปลง ซึ่งเป็นจริง', async () => {
    const { created, googleId } = await createDoc()
    google.failOnce(isBatchUpdate, 429)
    const saved = await save(created.document.id, { text: 'rejected', baseRevisionId: created.content.revisionId })
    expect(saved.status).toBe(502)
    expect((await data(saved)).error).toBe('google_error')
    expect(google.docs.get(googleId)!.text).toBe('unchanged body\n')
  })
})
