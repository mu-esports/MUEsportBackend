import { beforeEach, describe, expect, it } from 'vitest'
import { call, CLUB_EMAIL, data, env, resetDb, seedMemberActor, seedUser } from './helpers'
import { calendarSpans } from '../src/lib/calendar-spans'
beforeEach(resetDb)
describe('own contact profiles', () => {
  it('updates email and only chosen channels without touching roster or Sheets', async () => {
    const a = await seedMemberActor({ contact: 'เดิม' }),
      b = await seedMemberActor(),
      admin = await seedUser(CLUB_EMAIL, 'admin')
    const body = {
      email: 'HELLO@example.org',
      contacts: [{ platform: 'discord', value: 'club-test' }],
      expectedVersion: 1,
      memberId: b.id,
    }
    expect((await call('/api/member/profile', { method: 'PATCH', as: a, body })).status).toBe(200)
    const own = (await data(await call('/api/member/me', { as: a }))).member
    expect(own.email).toBe('hello@example.org')
    expect(own.contacts).toEqual(body.contacts)
    expect(own.contact).toBe('เดิม')
    expect(own.profileVersion).toBe(2)
    expect((await data(await call('/api/member/me', { as: b }))).member.email).toBe('')
    expect(
      (await data(await call('/api/members', { as: admin }))).members.find((m: { id: string }) => m.id === a.id).email,
    ).toBe('hello@example.org')
    expect(
      (await env.DB.prepare('SELECT version FROM members WHERE id=?').bind(a.id).first<{ version: number }>())?.version,
    ).toBe(1)
  })
  it('enforces CAS, supports removing optional channels and limits fields', async () => {
    const a = await seedMemberActor(),
      body = { email: '', contacts: [], expectedVersion: 1 }
    expect((await call('/api/member/profile', { method: 'PATCH', as: a, body })).status).toBe(200)
    expect((await call('/api/member/profile', { method: 'PATCH', as: a, body })).status).toBe(409)
    expect(
      (await call('/api/member/profile', { method: 'PATCH', as: a, body: { ...body, expectedVersion: 2 } })).status,
    ).toBe(200)
    for (const extra of [
      { email: 'wrong' },
      { contacts: [{ platform: 'unknown', value: 'x' }] },
      { contacts: [{ platform: 'line', value: '' }] },
      {
        contacts: [
          { platform: 'line', value: 'a' },
          { platform: 'line', value: 'b' },
        ],
      },
    ])
      expect((await call('/api/member/profile', { method: 'PATCH', as: a, body: { ...body, ...extra } })).status).toBe(
        422,
      )
  })
  it('only members with completed password setup can update their own profile', async () => {
    const a = await seedMemberActor({ mustChange: true }),
      staff = await seedUser(CLUB_EMAIL, 'admin'),
      body = { email: '', contacts: [], expectedVersion: 1 }
    for (const as of [null, a, staff])
      expect((await call('/api/member/profile', { method: 'PATCH', as, body })).status).toBe(as ? 403 : 401)
  })
  it('blocks regular password changes until admin issues a temporary password', async () => {
    const a = await seedMemberActor()
    const r = await call('/api/member/password', {
      method: 'POST',
      as: a,
      body: { currentPassword: 'anything', newPassword: 'Different-Password-123' },
    })
    expect(r.status).toBe(403)
    expect((await data(r)).error).toBe('admin_reset_required')
  })
})
describe('continuous calendar bars', () => {
  const week = ['2026-10-04', '2026-10-05', '2026-10-06', '2026-10-07', '2026-10-08', '2026-10-09', '2026-10-10']
  it('spans an inclusive 4–6 date range', () => {
    expect(calendarSpans([{ id: 'a', start: week[0], end: week[2] }], week)[0]).toMatchObject({
      from: 0,
      to: 2,
      lane: 0,
      continuesBefore: false,
      continuesAfter: false,
    })
  })
  it('clips cross-week and cross-month ranges with continuation markers', () => {
    expect(calendarSpans([{ id: 'a', start: '2026-09-30', end: '2026-10-15' }], week)[0]).toMatchObject({
      from: 0,
      to: 6,
      continuesBefore: true,
      continuesAfter: true,
    })
  })
  it('packs overlap separately and reuses a lane after a span ends', () => {
    const spans = calendarSpans(
      [
        { id: 'a', start: week[0], end: week[2] },
        { id: 'b', start: week[1], end: week[3] },
        { id: 'c', start: week[4], end: week[6] },
      ],
      week,
    )
    expect(spans.map((s) => s.lane)).toEqual([0, 1, 0])
  })
  it('omits single-day and non-intersecting events but handles timed multi-day events', () => {
    expect(
      calendarSpans(
        [
          { id: 'a', start: week[0], end: week[0] },
          { id: 'b', start: '2026-10-11', end: '2026-10-13' },
        ],
        week,
      ),
    ).toEqual([])
    expect(calendarSpans([{ id: 'c', start: week[1] + 'T18:00', end: week[2] + 'T09:00' }], week)[0]).toMatchObject({
      from: 1,
      to: 2,
    })
  })
})
