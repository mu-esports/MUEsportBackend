import { beforeEach, describe, expect, it } from 'vitest'
import { call, CLUB_EMAIL, data, env, key, resetDb, seedMemberActor, seedUser } from './helpers'
import type { Actor } from './helpers'
import type { Task, TaskInput } from '../src/tasks/types'

let admin: Actor, a: Actor, b: Actor, outsider: Actor
beforeEach(async () => {
  await resetDb()
  admin = await seedUser(CLUB_EMAIL, 'admin')
  a = await seedMemberActor()
  b = await seedMemberActor()
  outsider = await seedMemberActor()
})
const input = (extra: Partial<TaskInput> = {}): TaskInput => ({
  title: 'โปสเตอร์งานชมรม',
  category: 'ออกแบบ',
  instructions: 'ส่งโปสเตอร์พร้อมเอกสาร',
  start: '2020-01-01T00:00',
  due: '2099-01-01T23:59',
  kind: 'group',
  status: 'open',
  assigneeIds: [a.id, b.id],
  ...extra,
})
async function create(extra: Partial<TaskInput> = {}) {
  const r = await call('/api/tasks', {
    method: 'POST',
    as: admin,
    body: input(extra),
    headers: { 'Idempotency-Key': key() },
  })
  expect(r.status).toBe(201)
  return (await data<{ task: Task }>(r)).task
}
async function detail(t: Task, as = a) {
  return (await data<{ task: Task }>(await call(`/api/member/tasks/${t.id}`, { as }))).task
}
const send = (t: Task, as = a, extra: Record<string, unknown> = {}, k = key()) =>
  call(`/api/member/tasks/${t.id}/submissions`, {
    method: 'POST',
    as,
    headers: { 'Idempotency-Key': k },
    body: {
      mode: 'link',
      linkUrl: 'https://example.org/project',
      note: 'เสร็จแล้ว',
      expectedVersion: 1,
      taskVersion: t.version,
      ...extra,
    },
  })
function form(task: Task, name = 'work.pdf', bytes: Uint8Array = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])) {
  const f = new FormData()
  f.set('expectedVersion', '1')
  f.set('taskVersion', String(task.version))
  f.set('note', 'ไฟล์งาน')
  f.append('files', new File([bytes.slice().buffer as ArrayBuffer], name))
  return f
}
const upload = (task: Task, body: FormData, as = a, k = key()) =>
  call(`/api/member/tasks/${task.id}/submissions`, { method: 'POST', as, body, headers: { 'Idempotency-Key': k } })

describe('tasks and submission permissions', () => {
  it('staff can assign but members and anonymous users cannot manage tasks', async () => {
    for (const as of [a, null]) expect((await call('/api/tasks', { as })).status).toBe(as ? 403 : 401)
    const staff = await seedUser('organizer@example.org', 'staff')
    expect(
      (await call('/api/tasks', { method: 'POST', as: staff, body: input(), headers: { 'Idempotency-Key': key() } }))
        .status,
    ).toBe(201)
    expect((await call('/api/tasks', { method: 'POST', as: a, body: input() })).status).toBe(403)
  })
  it('enforces CSRF and forced password guards', async () => {
    const t = await create(),
      forced = await seedMemberActor({ mustChange: true })
    expect((await call('/api/tasks', { method: 'POST', as: admin, raw: true, body: input() })).status).toBe(403)
    expect((await call('/api/member/tasks', { as: forced })).status).toBe(403)
    expect(
      (await call(`/api/member/tasks/${t.id}/submissions`, { method: 'POST', as: a, raw: true, body: {} })).status,
    ).toBe(403)
  })
  it('lists only assigned tasks and rejects guesses by another member', async () => {
    const t = await create()
    expect((await data(await call('/api/member/tasks', { as: outsider }))).tasks).toEqual([])
    expect((await call(`/api/member/tasks/${t.id}`, { as: outsider })).status).toBe(404)
    expect((await send(t, outsider)).status).toBe(404)
    expect((await data(await call('/api/member/tasks', { as: a }))).tasks).toHaveLength(1)
  })
  it('group members see the same latest submission with author and late state', async () => {
    const t = await create({ due: '2020-02-01T23:59' })
    expect((await send(t)).status).toBe(201)
    const one = await detail(t),
      two = await detail(t, b)
    expect(one.units).toEqual(two.units)
    expect(one.units[0].submission?.late).toBe(true)
    expect(one.units[0].version).toBe(2)
    expect(one.units[0].submission?.files).toEqual([])
  })
  it('individual submissions are isolated, including downloaded attachments', async () => {
    const t = await create({ kind: 'individual' })
    expect((await upload(t, form(t))).status).toBe(201)
    const mine = await detail(t),
      theirs = await detail(t, b),
      file = mine.units[0].submission!.files[0]
    expect(theirs.units[0].submission).toBeNull()
    expect((await call(`/api/task-files/${file.id}`, { as: b })).status).toBe(404)
    expect((await call(`/api/task-files/${file.id}`, { as: outsider })).status).toBe(404)
    expect((await call(`/api/task-files/${file.id}`, { as: admin })).status).toBe(200)
  })
  it('rejects pre-start and archived submissions but still displays assigned work', async () => {
    for (const extra of [{ start: '2098-01-01T00:00' }, { status: 'archived' as const }]) {
      const t = await create(extra)
      expect((await send(t)).status).toBe(409)
      expect((await detail(t)).id).toBe(t.id)
    }
  })
  it('rejects stale group writes without changing the winner', async () => {
    const t = await create()
    expect((await send(t, a)).status).toBe(201)
    expect((await send(t, b, { linkUrl: 'https://example.org/stale' })).status).toBe(409)
    expect((await detail(t, b)).units[0].submission?.linkUrl).toBe('https://example.org/project')
    expect((await env.DB.prepare('SELECT count(*) AS n FROM task_submissions').first<{ n: number }>())?.n).toBe(1)
  })
  it('two simultaneous group writers have one winner', async () => {
    const t = await create(),
      r = await Promise.all([send(t, a), send(t, b)])
    expect(r.map((v) => v.status).sort()).toEqual([201, 409])
    expect((await env.DB.prepare('SELECT count(*) AS n FROM task_submissions').first<{ n: number }>())?.n).toBe(1)
  })
  it('replays unchanged submissions and rejects reuse with altered content', async () => {
    const t = await create(),
      k = key()
    expect((await send(t, a, {}, k)).status).toBe(201)
    expect((await data(await send(t, a, {}, k))).replayed).toBe(true)
    expect((await send(t, a, { note: 'ข้อมูลอื่น' }, k)).status).toBe(409)
    const r = await Promise.all([send(t, a, { expectedVersion: 2 }, key()), send(t, a, { expectedVersion: 2 }, key())])
    expect(r.map((v) => v.status).sort()).toEqual([201, 409])
  })
  it('task creation is idempotent and different payload cannot reuse a key', async () => {
    const k = key(),
      options = { method: 'POST', as: admin, headers: { 'Idempotency-Key': k }, body: input() }
    const r = await call('/api/tasks', options),
      first = await data(r)
    expect((await data(await call('/api/tasks', options))).task.id).toBe(first.task.id)
    expect((await call('/api/tasks', { ...options, body: input({ title: 'เปลี่ยน' }) })).status).toBe(422)
  })
  it('locks assignments after submission, while allowing deadline and instructions edits', async () => {
    const t = await create()
    await send(t)
    expect(
      (
        await call(`/api/tasks/${t.id}`, {
          method: 'PATCH',
          as: admin,
          body: { ...input({ assigneeIds: [a.id] }), expectedVersion: 1 },
        })
      ).status,
    ).toBe(409)
    expect(
      (
        await call(`/api/tasks/${t.id}`, {
          method: 'PATCH',
          as: admin,
          body: { ...input({ instructions: 'ปรับรายละเอียด' }), expectedVersion: 1 },
        })
      ).status,
    ).toBe(200)
    expect((await send(t, a, { expectedVersion: 2 })).status).toBe(409)
  })
  it('stale task edits never erase assignment rows', async () => {
    const t = await create()
    expect(
      (
        await call(`/api/tasks/${t.id}`, {
          method: 'PATCH',
          as: admin,
          body: { ...input({ assigneeIds: [b.id] }), expectedVersion: 1 },
        })
      ).status,
    ).toBe(200)
    expect(
      (
        await call(`/api/tasks/${t.id}`, {
          method: 'PATCH',
          as: admin,
          body: { ...input({ assigneeIds: [outsider.id] }), expectedVersion: 1 },
        })
      ).status,
    ).toBe(409)
    expect(
      (await data(await call(`/api/tasks/${t.id}`, { as: admin }))).task.assignees.map((p: { id: string }) => p.id),
    ).toEqual([b.id])
  })
  it('validates dates, members, HTTPS links and hidden identity inputs', async () => {
    for (const extra of [
      { start: '2026-02-30T12:00' },
      { due: '2019-01-01T00:00' },
      { assigneeIds: [] },
      { assigneeIds: ['missing'] },
    ])
      expect(
        (
          await call('/api/tasks', {
            method: 'POST',
            as: admin,
            body: input(extra),
            headers: { 'Idempotency-Key': key() },
          })
        ).status,
      ).toBe(422)
    const t = await create()
    for (const linkUrl of ['javascript:alert(1)', 'http://example.org', 'https://user:pass@example.org'])
      expect((await send(t, a, { linkUrl })).status).toBe(422)
    expect((await send(t, a, { submittedBy: outsider.id })).status).toBe(201)
    expect(
      (await env.DB.prepare('SELECT submitted_by FROM task_submissions').first<{ submitted_by: string }>())
        ?.submitted_by,
    ).toBe(a.id)
  })
})
describe('private file submissions', () => {
  it('accepts the maximum 20 MiB set and downloads each 10 MiB file unchanged', async () => {
    const t = await create()
    const bytes = new Uint8Array(10 * 1024 * 1024)
    bytes.set([37, 80, 68, 70, 45])
    bytes[bytes.length - 1] = 77
    const body = form(t, 'large-one.pdf', bytes)
    body.append('files', new File([bytes.buffer], 'large-two.pdf'))
    const response = await upload(t, body)
    expect(response.status).toBe(201)
    const files = (await detail(t)).units[0].submission!.files
    expect(files).toHaveLength(2)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    for (const file of files) {
      const downloaded = await (await call(`/api/task-files/${file.id}`, { as: b })).arrayBuffer()
      expect(downloaded.byteLength).toBe(bytes.length)
      expect(await crypto.subtle.digest('SHA-256', downloaded)).toEqual(digest)
    }
  }, 30000)
  it('stores binary bytes and streams matching content to every group member', async () => {
    const t = await create(),
      bytes = new Uint8Array(1024 * 1024 + 27)
    bytes.set([37, 80, 68, 70, 45])
    bytes[bytes.length - 1] = 33
    expect((await upload(t, form(t, 'งานชมรม.pdf', bytes))).status).toBe(201)
    const f = (await detail(t)).units[0].submission!.files[0]
    for (const as of [a, b, admin]) {
      const r = await call(`/api/task-files/${f.id}`, { as })
      expect(r.status).toBe(200)
      expect(r.headers.get('Content-Disposition')).toContain('attachment')
      expect(r.headers.get('Cache-Control')).toBe('no-store')
      const downloaded = await r.arrayBuffer()
      expect(downloaded.byteLength).toBe(bytes.length)
      expect(await crypto.subtle.digest('SHA-256', downloaded)).toEqual(await crypto.subtle.digest('SHA-256', bytes))
    }
    expect((await call(`/api/task-files/${f.id}`)).status).toBe(401)
  })
  it('rejects forged types, active content, empty files and excessive file count', async () => {
    const t = await create()
    for (const [name, bytes] of [
      ['fake.pdf', new TextEncoder().encode('<html>')],
      ['active.svg', new TextEncoder().encode('<svg/>')],
      ['empty.txt', new Uint8Array()],
    ] as const)
      expect((await upload(t, form(t, name, bytes))).status).toBe(422)
    const f = form(t)
    for (let i = 0; i < 3; i++) f.append('files', new File(['text'], 'note.txt'))
    expect((await upload(t, f)).status).toBe(422)
    expect((await env.DB.prepare('SELECT count(*) AS n FROM task_submissions').first<{ n: number }>())?.n).toBe(0)
  })
  it('oversize body is rejected without reading and files obey the 10 MB limit', async () => {
    const t = await create()
    expect(
      (
        await call(`/api/member/tasks/${t.id}/submissions`, {
          method: 'POST',
          as: a,
          headers: {
            'Idempotency-Key': key(),
            'Content-Type': 'multipart/form-data; boundary=x',
            'Content-Length': String(22 * 1024 * 1024),
          },
          body: 'x',
        })
      ).status,
    ).toBe(413)
    expect((await upload(t, form(t, 'large.pdf', new Uint8Array(10 * 1024 * 1024 + 1)))).status).toBe(422)
  })
  it('deleting an individual removes their files; group submissions survive for peers', async () => {
    const t = await create({ kind: 'individual' })
    await upload(t, form(t))
    await env.DB.prepare('DELETE FROM members WHERE id=?').bind(a.id).run()
    expect((await env.DB.prepare('SELECT count(*) AS n FROM task_file_chunks').first<{ n: number }>())?.n).toBe(0)
    const group = await create({ assigneeIds: [b.id, outsider.id] })
    await send(group, b)
    await env.DB.prepare('DELETE FROM members WHERE id=?').bind(b.id).run()
    expect((await detail(group, outsider)).units[0].submission?.submittedBy).toBe('สมาชิกที่ลบแล้ว')
  })
})
