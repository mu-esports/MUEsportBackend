import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, CLUB_EMAIL, data, env, FakeGoogle, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'

const DRIVE_FILE = 'https://www.googleapis.com/auth/drive.file'
let google: FakeGoogle

beforeEach(async () => {
  await resetDb()
  google = await FakeGoogle.start()
})
afterEach(() => vi.unstubAllGlobals())

const cookieValue = (res: Response, name: string) => {
  const header = res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))
  return header ? `${name}=${header.split(';')[0].slice(name.length + 1)}` : ''
}

/** เริ่มเข้าสู่ระบบ: คืน state, nonce และ cookie ผูกเบราว์เซอร์ที่ Worker ออกให้ */
async function startLogin(returnPath = '/members') {
  const res = await call(`/auth/login?return=${encodeURIComponent(returnPath)}`)
  expect(res.status).toBe(302)
  const authUrl = new URL(res.headers.get('Location')!)
  return { authUrl, state: authUrl.searchParams.get('state')!, nonce: authUrl.searchParams.get('nonce')!, browser: cookieValue(res, 'mu_oauth') }
}

async function finishLogin(identity: { sub: string; email: string; email_verified?: boolean; name?: string }, returnPath = '/members') {
  const flow = await startLogin(returnPath)
  google.grant('code-1', { identity, nonce: flow.nonce })
  return call(`/auth/google/callback?state=${flow.state}&code=code-1`, { cookie: flow.browser })
}

const countUsers = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())!.n
const countSessions = async () => (await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions').first<{ n: number }>())!.n

describe('เข้าสู่ระบบทีมงานด้วย Google', () => {
  it('ส่งไป Google ด้วย state, nonce, PKCE และขอเฉพาะ scope ของการเข้าสู่ระบบ', async () => {
    const { authUrl, browser } = await startLogin()
    expect(authUrl.origin + authUrl.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    expect(authUrl.searchParams.get('redirect_uri')).toBe('https://staff.example.test/auth/google/callback')
    expect(authUrl.searchParams.get('scope')).toBe('openid email profile')
    expect(authUrl.searchParams.get('code_challenge_method')).toBe('S256')
    expect(authUrl.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(authUrl.searchParams.get('access_type')).toBeNull()
    expect(authUrl.href).not.toContain('test-client-secret')
    expect(browser).not.toBe('')
    // D1 เก็บเฉพาะ hash ของ state
    const row = await env.DB.prepare('SELECT state_hash, purpose FROM oauth_states').first<{ state_hash: string; purpose: string }>()
    expect(row?.purpose).toBe('login')
    expect(row?.state_hash).not.toBe(authUrl.searchParams.get('state'))
  })

  it('บัญชีชมรมที่ Google ยืนยันอีเมลแล้วเป็นผู้ดูแลคนแรก และได้ session cookie ที่ปลอดภัย', async () => {
    const res = await finishLogin({ sub: 'club-sub', email: CLUB_EMAIL, name: 'MU Esport' })
    expect(res.status).toBe(302)
    expect(res.headers.get('Location')).toBe('/members')
    const session = res.headers.getSetCookie().find((c) => c.startsWith('mu_session='))!
    expect(session).toContain('HttpOnly')
    expect(session).toContain('SameSite=Lax')
    expect(session).toContain('Secure')
    const me = await data(await call('/api/session', { cookie: cookieValue(res, 'mu_session') }))
    expect(me.user).toMatchObject({ email: CLUB_EMAIL, role: 'admin' })
    expect(me.csrfToken).toMatch(/^[0-9a-f]{64}$/)
  })

  it('บัญชีอื่นที่ไม่ได้รับสิทธิ์ถูกปฏิเสธ แม้ล็อกอิน Google สำเร็จ และไม่ถูกสร้างเป็นผู้ใช้', async () => {
    const res = await finishLogin({ sub: 'stranger', email: 'stranger@gmail.com' })
    expect(res.headers.get('Location')).toBe('/access-denied')
    expect(cookieValue(res, 'mu_session')).toBe('')
    expect(await countUsers()).toBe(0)
    expect(await countSessions()).toBe(0)
  })

  it('อีเมลชมรมที่ Google ยังไม่ยืนยัน ไม่ได้เป็นผู้ดูแล', async () => {
    const res = await finishLogin({ sub: 'fake-club', email: CLUB_EMAIL, email_verified: false })
    expect(res.headers.get('Location')).toBe('/access-denied')
    expect(await countUsers()).toBe(0)
  })

  it('ทีมงานที่ผู้ดูแลเพิ่มอีเมลไว้เข้าได้ตามสิทธิ์ที่ server เก็บ และผูกกับบัญชี Google แรกที่ใช้', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    await call('/api/users', { method: 'POST', as: admin, body: { email: 'staff@gmail.com', role: 'staff' } })

    const res = await finishLogin({ sub: 'staff-sub', email: 'Staff@Gmail.com', name: 'ทีมงาน หนึ่ง' })
    expect(res.headers.get('Location')).toBe('/members')
    const me = await data(await call('/api/session', { cookie: cookieValue(res, 'mu_session') }))
    expect(me.user).toMatchObject({ email: 'staff@gmail.com', role: 'staff', name: 'ทีมงาน หนึ่ง' })

    // บัญชี Google อื่นที่อ้างอีเมลเดียวกันภายหลังไม่ได้สิทธิ์
    const other = await finishLogin({ sub: 'another-sub', email: 'staff@gmail.com' })
    expect(other.headers.get('Location')).toBe('/access-denied')
  })

  it('ทีมงานที่ถูกถอนสิทธิ์เข้าไม่ได้', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const added = await data(await call('/api/users', { method: 'POST', as: admin, body: { email: 'staff@gmail.com', role: 'staff' } }))
    await call(`/api/users/${added.user.id}`, { method: 'PATCH', as: admin, body: { status: 'revoked' } })
    const res = await finishLogin({ sub: 'staff-sub', email: 'staff@gmail.com' })
    expect(res.headers.get('Location')).toBe('/access-denied')
  })

  it('return URL รับเฉพาะ path ภายในเว็บ', async () => {
    for (const [input, expected] of [
      ['https://evil.example/x', '/'], ['//evil.example', '/'], ['/\\evil.example', '/'], ['/auth/login', '/'], ['/api/members', '/'],
      ['/calendar?event=abc&keep=1', '/calendar?event=abc&keep=1'], ['/documents/123', '/documents/123'],
    ]) {
      const res = await finishLogin({ sub: 'club-sub', email: CLUB_EMAIL }, input)
      expect(res.headers.get('Location'), input).toBe(expected)
    }
  })
})

describe('state, nonce และ PKCE', () => {
  it('state ที่ไม่รู้จักถูกปฏิเสธ', async () => {
    const flow = await startLogin()
    google.grant('code-1', { identity: { sub: 'club-sub', email: CLUB_EMAIL }, nonce: flow.nonce })
    const res = await call('/auth/google/callback?state=forged-state&code=code-1', { cookie: flow.browser })
    expect(res.headers.get('Location')).toBe('/login?error=state_invalid')
    expect(await countSessions()).toBe(0)
  })

  it('state ใช้ได้ครั้งเดียว (replay ถูกปฏิเสธ)', async () => {
    const flow = await startLogin()
    google.grant('code-1', { identity: { sub: 'club-sub', email: CLUB_EMAIL }, nonce: flow.nonce })
    const first = await call(`/auth/google/callback?state=${flow.state}&code=code-1`, { cookie: flow.browser })
    expect(first.headers.get('Location')).toBe('/members')
    google.grant('code-2', { identity: { sub: 'club-sub', email: CLUB_EMAIL }, nonce: flow.nonce })
    const replay = await call(`/auth/google/callback?state=${flow.state}&code=code-2`, { cookie: flow.browser })
    expect(replay.headers.get('Location')).toBe('/login?error=state_used')
    expect(await countSessions()).toBe(1)
  })

  it('state หมดอายุถูกปฏิเสธ', async () => {
    const flow = await startLogin()
    await env.DB.prepare('UPDATE oauth_states SET expires_at = ?').bind(new Date(Date.now() - 1000).toISOString()).run()
    google.grant('code-1', { identity: { sub: 'club-sub', email: CLUB_EMAIL }, nonce: flow.nonce })
    const res = await call(`/auth/google/callback?state=${flow.state}&code=code-1`, { cookie: flow.browser })
    expect(res.headers.get('Location')).toBe('/login?error=state_expired')
    expect(await countSessions()).toBe(0)
  })

  it('state ผูกกับเบราว์เซอร์ที่เริ่ม: ไม่มี cookie หรือ cookie ของเบราว์เซอร์อื่นถูกปฏิเสธ', async () => {
    const victim = await startLogin()
    const attacker = await startLogin()
    google.grant('code-1', { identity: { sub: 'club-sub', email: CLUB_EMAIL }, nonce: victim.nonce })
    expect((await call(`/auth/google/callback?state=${victim.state}&code=code-1`)).headers.get('Location')).toBe('/login?error=state_invalid')

    const second = await startLogin()
    google.grant('code-2', { identity: { sub: 'club-sub', email: CLUB_EMAIL }, nonce: second.nonce })
    const res = await call(`/auth/google/callback?state=${second.state}&code=code-2`, { cookie: attacker.browser })
    expect(res.headers.get('Location')).toBe('/login?error=state_invalid')
    expect(await countSessions()).toBe(0)
  })

  it('nonce ใน id_token ไม่ตรงถูกปฏิเสธ', async () => {
    const flow = await startLogin()
    google.grant('code-1', { identity: { sub: 'club-sub', email: CLUB_EMAIL }, nonce: 'another-nonce' })
    const res = await call(`/auth/google/callback?state=${flow.state}&code=code-1`, { cookie: flow.browser })
    expect(res.headers.get('Location')).toBe('/login?error=google_failed')
    expect(await countUsers()).toBe(0)
  })

  it('id_token ที่ผู้ออก ผู้รับ ลายเซ็น หรือวันหมดอายุไม่ถูกต้องถูกปฏิเสธ', async () => {
    const bad: Record<string, unknown>[] = [{ iss: 'https://evil.example' }, { aud: 'another-client' }, { expired: true }]
    for (const overrides of bad) {
      const flow = await startLogin()
      const idToken = await google.idToken({ sub: 'club-sub', email: CLUB_EMAIL }, flow.nonce, overrides)
      google.failOnce((url) => url.href === 'https://oauth2.googleapis.com/token', 200, { access_token: 'access-x', expires_in: 3600, id_token: idToken })
      const res = await call(`/auth/google/callback?state=${flow.state}&code=any`, { cookie: flow.browser })
      expect(res.headers.get('Location'), JSON.stringify(overrides)).toBe('/login?error=google_failed')
    }
    // ลายเซ็นจากกุญแจอื่น
    const flow = await startLogin()
    const other = await FakeGoogle.start()
    const forged = await other.idToken({ sub: 'club-sub', email: CLUB_EMAIL }, flow.nonce)
    google = await FakeGoogle.start()
    google.failOnce((url) => url.href === 'https://oauth2.googleapis.com/token', 200, { access_token: 'access-x', expires_in: 3600, id_token: forged })
    const res = await call(`/auth/google/callback?state=${flow.state}&code=any`, { cookie: flow.browser })
    expect(res.headers.get('Location')).toBe('/login?error=google_failed')
    expect(await countUsers()).toBe(0)
  })

  it('ผู้ใช้กดยกเลิกที่ Google', async () => {
    const flow = await startLogin()
    const res = await call(`/auth/google/callback?state=${flow.state}&error=access_denied`, { cookie: flow.browser })
    expect(res.headers.get('Location')).toBe('/login?error=google_denied')
  })

  it('ยังไม่ได้ตั้งค่า client: ไม่ส่งไป Google และบอกว่ายังไม่ได้ตั้งค่า', async () => {
    const bare = { ...env, GOOGLE_CLIENT_ID: '', GOOGLE_CLIENT_SECRET: undefined }
    const res = await call('/auth/login', { env: bare })
    expect(res.headers.get('Location')).toBe('/login?error=not_configured')
    expect((await data(await call('/api/session', { env: bare }))).authConfigured).toBe(false)
    const placeholder = { ...env, GOOGLE_CLIENT_ID: 'REPLACE_WITH_PRODUCTION_GOOGLE_CLIENT_ID' }
    expect((await data(await call('/api/session', { env: placeholder }))).authConfigured).toBe(false)
  })
})

describe('เชื่อม Google ของชมรม', () => {
  let admin: Actor

  beforeEach(async () => {
    admin = await seedUser(CLUB_EMAIL, 'admin')
  })

  async function startConnect(as: Actor = admin) {
    const res = await call('/api/google/connect', { method: 'POST', as })
    expect(res.status).toBe(200)
    const authUrl = new URL((await data(res)).authUrl)
    return { authUrl, state: authUrl.searchParams.get('state')!, nonce: authUrl.searchParams.get('nonce')!, browser: cookieValue(res, 'mu_oauth') }
  }

  async function connect(options: { email?: string; refreshToken?: string | null; scope?: string; verified?: boolean; as?: Actor } = {}) {
    const flow = await startConnect(options.as)
    google.grant('connect-code', {
      identity: { sub: `sub-of-${options.email ?? CLUB_EMAIL}`, email: options.email ?? CLUB_EMAIL, email_verified: options.verified ?? true },
      nonce: flow.nonce,
      refreshToken: options.refreshToken === null ? undefined : (options.refreshToken ?? 'refresh-secret-1'),
      scope: options.scope ?? `openid email ${DRIVE_FILE}`,
    })
    return call(`/auth/google/callback?state=${flow.state}&code=connect-code`, { as: options.as ?? admin, cookie: flow.browser })
  }

  const connection = () => env.DB.prepare('SELECT * FROM google_connections').first<Record<string, string | null>>()
  const sources = async (as: Actor = admin) => data(await call('/api/sources', { as }))

  it('ขอ drive.file แบบ offline และไม่ขอ Gmail ทั้ง Drive หรือ Calendar', async () => {
    const { authUrl } = await startConnect()
    const scopes = authUrl.searchParams.get('scope')!.split(' ')
    expect(scopes).toEqual(['openid', 'email', DRIVE_FILE])
    expect(authUrl.searchParams.get('access_type')).toBe('offline')
    expect(authUrl.searchParams.get('login_hint')).toBe(CLUB_EMAIL)
    expect(authUrl.searchParams.get('prompt')).toContain('select_account')
  })

  it('ก่อนเชื่อม: สถานะยังไม่ได้เชื่อม ไม่มีป้ายเชื่อมแล้ว', async () => {
    const body = await sources()
    expect(body.google).toMatchObject({ status: 'not_connected', email: null, expectedEmail: CLUB_EMAIL })
    expect(body.resources.find((r: { id: string }) => r.id === 'docs').status).toBe('needs_connection')
  })

  it('เชื่อมด้วยบัญชีชมรม: เก็บ refresh token แบบเข้ารหัส และแสดงบัญชีที่เชื่อมจริง', async () => {
    const res = await connect()
    expect(res.headers.get('Location')).toBe('/sources?google=connected')
    const row = await connection()
    expect(row?.status).toBe('connected')
    expect(row?.email).toBe(CLUB_EMAIL)
    expect(row?.refresh_token_enc).toMatch(/^v1\./)
    expect(JSON.stringify(row)).not.toContain('refresh-secret-1')
    expect(JSON.stringify(row)).not.toMatch(/access-\d/)

    const body = await sources()
    expect(body.google).toMatchObject({ status: 'connected', email: CLUB_EMAIL })
    expect(body.google.lastCheckedAt).toBeTruthy()
    expect(body.resources.find((r: { id: string }) => r.id === 'docs').status).toBe('ready')
    // เชื่อมบัญชีแล้ว แต่ยังไม่ได้เลือกชีตและปฏิทิน
    expect(body.resources.find((r: { id: string }) => r.id === 'sheets').status).toBe('not_selected')
    expect(body.resources.find((r: { id: string }) => r.id === 'calendar').status).toBe('not_selected')
  })

  it('ค่าลับไม่หลุดใน response หรือ URL', async () => {
    const start = await call('/api/google/connect', { method: 'POST', as: admin })
    const startText = await start.clone().text()
    expect(startText).not.toContain('test-client-secret')
    await connect()
    for (const path of ['/api/sources', '/api/session', '/api/users']) {
      const text = await (await call(path, { as: admin })).text()
      expect(text, path).not.toContain('refresh-secret-1')
      expect(text, path).not.toContain('test-client-secret')
      expect(text, path).not.toMatch(/access-\d/)
      expect(text, path).not.toContain('v1.')
      expect(text, path).not.toContain(env.TOKEN_ENCRYPTION_KEY)
    }
    const checked = await (await call('/api/google/check', { method: 'POST', as: admin })).text()
    expect(checked).not.toMatch(/access-\d|refresh-secret|v1\./)
  })

  it('IV ใหม่ทุกครั้ง: เข้ารหัสค่าเดิมสองครั้งได้ผลต่างกัน', async () => {
    await connect()
    const first = (await connection())!.refresh_token_enc
    await connect()
    const second = (await connection())!.refresh_token_enc
    expect(first).not.toBe(second)
  })

  it('callback เป็นบัญชีอื่น: ปฏิเสธและไม่เก็บ connection ใหม่', async () => {
    const res = await connect({ email: 'someone.else@gmail.com' })
    expect(res.headers.get('Location')).toBe('/sources?google=wrong_account')
    expect(await connection()).toBeNull()

    // มี connection เดิมอยู่แล้ว ก็ไม่ถูกแทนที่ด้วยบัญชีอื่น
    await connect()
    const before = await connection()
    await connect({ email: 'someone.else@gmail.com', refreshToken: 'refresh-of-other' })
    expect(await connection()).toEqual(before)
  })

  it('อีเมลชมรมที่ยังไม่ยืนยันถูกปฏิเสธ', async () => {
    const res = await connect({ verified: false })
    expect(res.headers.get('Location')).toBe('/sources?google=wrong_account')
    expect(await connection()).toBeNull()
  })

  it('ไม่ได้อนุญาต drive.file: ไม่เก็บ connection', async () => {
    const res = await connect({ scope: 'openid email' })
    expect(res.headers.get('Location')).toBe('/sources?google=missing_scope')
    expect(await connection()).toBeNull()
  })

  it('Google ไม่ส่ง refresh token ใหม่: token เดิมของบัญชีเดียวกันไม่หาย', async () => {
    await connect({ refreshToken: 'refresh-secret-1' })
    const before = (await connection())!.refresh_token_enc
    const res = await connect({ refreshToken: null })
    expect(res.headers.get('Location')).toBe('/sources?google=connected')
    const after = await connection()
    expect(after?.refresh_token_enc).toBe(before)
    expect(after?.status).toBe('connected')
    // token เดิมยังใช้ขอ access token ได้จริง
    const checked = await data(await call('/api/google/check', { method: 'POST', as: admin }))
    expect(checked.google.status).toBe('connected')
    expect(checked.problem).toBeNull()
  })

  it('ไม่มี refresh token เลยตั้งแต่ครั้งแรก: ไม่ถือว่าเชื่อมแล้ว', async () => {
    const res = await connect({ refreshToken: null })
    expect(res.headers.get('Location')).toBe('/sources?google=no_refresh_token')
    expect(await connection()).toBeNull()
  })

  it('invalid_grant (ถูกถอนสิทธิ์หรือหมดอายุ): เข้าสถานะต้องเชื่อมใหม่ ไม่เปลี่ยนบัญชีและไม่ใช้ข้อมูลตัวอย่าง', async () => {
    await connect()
    google.refreshTokens.set('refresh-secret-1', 'invalid_grant')
    const checked = await data(await call('/api/google/check', { method: 'POST', as: admin }))
    expect(checked.google).toMatchObject({ status: 'needs_reconnect', email: CLUB_EMAIL, lastError: 'invalid_grant' })
    expect(checked.problem).toContain('เชื่อมใหม่')
    expect(checked.resources.find((r: { id: string }) => r.id === 'docs').status).toBe('needs_connection')

    const docs = await call('/api/documents', { method: 'POST', as: admin, headers: { 'Idempotency-Key': 'k'.repeat(20) }, body: { title: 'ทดสอบ', text: 'x' } })
    expect(docs.status).toBe(409)
    expect((await data(docs)).error).toBe('google_needs_reconnect')
    expect((await data(await call('/api/documents', { as: admin }))).documents).toEqual([])
  })

  it('ข้อผิดพลาดชั่วคราวของ Google ไม่ทำให้ต้องเชื่อมใหม่', async () => {
    await connect()
    google.failOnce((url) => url.href === 'https://oauth2.googleapis.com/token', 503, { error: 'backend_error' })
    const checked = await data(await call('/api/google/check', { method: 'POST', as: admin }))
    expect(checked.google.status).toBe('error')
    const again = await data(await call('/api/google/check', { method: 'POST', as: admin }))
    expect(again.google.status).toBe('connected')
  })

  it('logout ทีมงานไม่ตัดการเชื่อม Google ของชมรม', async () => {
    await connect()
    await call('/auth/logout', { method: 'POST', as: admin })
    expect((await connection())?.status).toBe('connected')
  })

  it('ตัดการเชื่อมเป็นคำสั่งแยกของ admin: ลบ token แต่ไม่ลบข้อมูลใน D1', async () => {
    await connect()
    await env.DB.prepare(
      `INSERT INTO documents (id, google_document_id, title, created_by, updated_by, created_at, updated_at) VALUES ('d1', 'g1', 'เอกสาร', ?, ?, 'x', 'x')`,
    ).bind(admin.id, admin.id).run()
    const res = await data(await call('/api/google/disconnect', { method: 'POST', as: admin }))
    expect(res.google.status).toBe('not_connected')
    expect(res.google.email).toBeNull()
    expect(res.revokedAtGoogle).toBe(true)
    const row = await connection()
    expect(row).toMatchObject({ status: 'disconnected', refresh_token_enc: null, access_token_enc: null })
    expect((await data(await call('/api/documents', { as: admin }))).documents).toHaveLength(1)
    // ไม่มีการเรียกลบไฟล์ที่ Google
    expect(google.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('ผู้ที่จบขั้นตอนต้องเป็นผู้ดูแลคนเดิมที่เริ่ม', async () => {
    const flow = await startConnect()
    google.grant('c', { identity: { sub: 'club', email: CLUB_EMAIL }, nonce: flow.nonce, refreshToken: 'r', scope: `openid email ${DRIVE_FILE}` })
    const staff = await seedUser('staff@example.com', 'staff')
    const res = await call(`/auth/google/callback?state=${flow.state}&code=c`, { as: staff, cookie: flow.browser })
    expect(res.headers.get('Location')).toBe('/sources?google=forbidden')
    expect(await connection()).toBeNull()
  })

  it('state ของการเข้าสู่ระบบใช้เชื่อม Google ไม่ได้ (ผูกกับจุดประสงค์)', async () => {
    const login = await call('/auth/login')
    const state = new URL(login.headers.get('Location')!).searchParams.get('state')!
    const nonce = new URL(login.headers.get('Location')!).searchParams.get('nonce')!
    google.grant('c', { identity: { sub: 'club', email: CLUB_EMAIL }, nonce, refreshToken: 'r', scope: `openid email ${DRIVE_FILE}` })
    await call(`/auth/google/callback?state=${state}&code=c`, { as: admin, cookie: cookieValue(login, 'mu_oauth') })
    expect(await connection()).toBeNull()
  })

  it('ยังไม่ได้ตั้งค่า: บอกชื่อค่าที่ขาดให้ผู้ดูแล ไม่มีสถานะเชื่อมแล้ว และส่วนอื่นยังใช้ได้', async () => {
    const bare = { ...env, GOOGLE_CLIENT_SECRET: undefined, TOKEN_ENCRYPTION_KEY: 'too-short' }
    const body = await data(await call('/api/sources', { as: admin, env: bare }))
    expect(body.google.status).toBe('not_configured')
    expect(body.google.missingConfig).toEqual(['GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'])
    const start = await call('/api/google/connect', { method: 'POST', as: admin, env: bare })
    expect(start.status).toBe(503)
    expect((await call('/api/members', { as: admin, env: bare })).status).toBe(200)

    const staff = await seedUser('staff@example.com', 'staff')
    expect((await data(await call('/api/sources', { as: staff, env: bare }))).google.missingConfig).toEqual([])
  })
})
