import { pkceChallenge, randomToken, sha256Hex } from './crypto'
import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import {
  buildAuthUrl, clubEmail, CONNECT_SCOPES, DRIVE_FILE_SCOPE, exchangeCode, isAuthConfigured, LOGIN_SCOPES,
  missingConnectConfig, saveConnection, SERVICE_SCOPES, verifyIdToken,
} from './google'
import type { GoogleIdentity } from './google'
import { cookie, HttpError, isHttps, json, parseCookies, readJson, redirect } from './http'
import { audit, clearSessionCookie, createSession, deleteSession, requireMutation } from './session'

const STATE_COOKIE = 'mu_oauth'
const STATE_TTL_SECONDS = 10 * 60

type Purpose = 'login' | 'connect'

/** return URL รับเฉพาะ path ภายในเว็บ กันการพาไปเว็บอื่นหลังเข้าสู่ระบบ */
export function safeReturnPath(value: string | null): string {
  if (!value || !value.startsWith('/') || value.startsWith('//') || value.includes('\\')) return '/'
  if (/^\/(auth|api)(\/|$)/.test(value) || value.startsWith('/login')) return '/'
  return value.length > 512 ? '/' : value
}

/** เริ่ม OAuth: สร้าง state ใช้ครั้งเดียว ผูกกับเบราว์เซอร์นี้ (cookie) และจุดประสงค์ */
async function startFlow(ctx: Ctx, purpose: Purpose, returnPath: string, userId: string | null, extraScopes: string[] = []) {
  const state = randomToken()
  const browser = randomToken()
  const nonce = randomToken()
  const verifier = randomToken(48)
  const now = Date.now()
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM oauth_states WHERE expires_at < ?').bind(new Date(now).toISOString()),
    ctx.env.DB.prepare(
      `INSERT INTO oauth_states (state_hash, purpose, browser_hash, nonce, code_verifier, return_path, user_id, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      await sha256Hex(state),
      purpose,
      await sha256Hex(browser),
      nonce,
      verifier,
      returnPath,
      userId,
      new Date(now).toISOString(),
      new Date(now + STATE_TTL_SECONDS * 1000).toISOString(),
    ),
  ])
  const authUrl = buildAuthUrl(ctx.env, {
    origin: ctx.url.origin,
    state,
    nonce,
    codeChallenge: await pkceChallenge(verifier),
    // การเข้าสู่ระบบขอเฉพาะ identity เสมอ; scope ของบริการเพิ่มได้เฉพาะในขั้นตอนเชื่อมของผู้ดูแล
    scopes: purpose === 'login' ? LOGIN_SCOPES : [...CONNECT_SCOPES, ...extraScopes],
    offline: purpose === 'connect',
    loginHint: purpose === 'connect' ? clubEmail(ctx.env) : undefined,
  })
  const stateCookie = cookie(STATE_COOKIE, browser, { maxAge: STATE_TTL_SECONDS, path: '/auth', secure: isHttps(ctx.url) })
  return { authUrl, stateCookie }
}

const clearStateCookie = (url: URL) => cookie(STATE_COOKIE, '', { maxAge: 0, path: '/auth', secure: isHttps(url) })

/** GET /auth/login — เริ่มเข้าสู่ระบบทีมงานด้วย Google (OIDC) */
async function login(ctx: Ctx): Promise<Response> {
  if (!isAuthConfigured(ctx.env)) return redirect('/login?error=not_configured')
  const { authUrl, stateCookie } = await startFlow(ctx, 'login', safeReturnPath(ctx.url.searchParams.get('return')), null)
  return redirect(authUrl, [stateCookie])
}

/** POST /api/google/connect — ผู้ดูแลเริ่มเชื่อมบัญชี Google ของชมรม */
export async function startConnect(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const missing = await missingConnectConfig(ctx.env)
  if (missing.length > 0) {
    throw new HttpError(503, 'google_not_configured', 'เว็บไซต์ยังไม่ได้ตั้งค่าการเชื่อม Google', { missing })
  }
  // ขอสิทธิ์ของบริการเพิ่มทีละส่วนตามที่ผู้ดูแลเลือก (include_granted_scopes คงสิทธิ์เดิมไว้)
  let extra: string[] = []
  if ((ctx.request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    const service = (await readJson(ctx.request)).service
    if (service !== undefined) {
      if (typeof service !== 'string' || !(service in SERVICE_SCOPES)) throw new HttpError(422, 'validation_failed', 'ไม่รู้จักบริการที่ขอสิทธิ์')
      extra = SERVICE_SCOPES[service]
    }
  }
  const { authUrl, stateCookie } = await startFlow(ctx, 'connect', '/sources', session.user.id, extra)
  return json({ authUrl }, 200, { 'Set-Cookie': stateCookie })
}

interface StateRow {
  purpose: Purpose
  browser_hash: string
  nonce: string
  code_verifier: string
  return_path: string
  user_id: string | null
  expires_at: string
}

/** GET /auth/google/callback — ใช้ร่วมกันทั้งเข้าสู่ระบบและเชื่อม Google แยกด้วย purpose ที่ผูกกับ state */
async function callback(ctx: Ctx): Promise<Response> {
  const { env, url } = ctx
  const clear = clearStateCookie(url)
  const fail = (code: string) => redirect(`/login?error=${code}`, [clear])

  const state = url.searchParams.get('state')
  if (!state) return fail('state_invalid')
  const stateHash = await sha256Hex(state)
  const row = await env.DB.prepare('SELECT * FROM oauth_states WHERE state_hash = ?').bind(stateHash).first<StateRow>()
  if (!row) return fail('state_invalid')

  // ใช้ได้ครั้งเดียว: ถ้ามีคำขออื่นใช้ไปแล้ว คำสั่งนี้จะไม่เปลี่ยนแถวใด
  const consumed = await env.DB.prepare('UPDATE oauth_states SET used_at = ? WHERE state_hash = ? AND used_at IS NULL')
    .bind(nowIso(), stateHash)
    .run()
  if (consumed.meta.changes !== 1) return fail('state_used')
  if (row.expires_at <= nowIso()) return fail('state_expired')

  const browser = parseCookies(ctx.request)[STATE_COOKIE]
  if (!browser || (await sha256Hex(browser)) !== row.browser_hash) return fail('state_invalid')

  const connectFail = (code: string) => redirect(`/sources?google=${code}`, [clear])
  const failFor = row.purpose === 'connect' ? connectFail : fail

  if (url.searchParams.get('error')) return failFor(row.purpose === 'connect' ? 'cancelled' : 'google_denied')
  const code = url.searchParams.get('code')
  if (!code) return failFor(row.purpose === 'connect' ? 'failed' : 'state_invalid')

  let identity: GoogleIdentity
  let tokens
  try {
    tokens = await exchangeCode(env, code, row.code_verifier, url.origin)
    identity = await verifyIdToken(env, tokens.id_token, row.nonce)
  } catch (error) {
    console.error('oauth callback failed', error instanceof HttpError ? error.code : 'unexpected')
    return failFor(row.purpose === 'connect' ? 'failed' : 'google_failed')
  }

  if (row.purpose === 'connect') {
    // ต้องเป็นผู้ดูแลคนเดิมที่เริ่มขั้นตอน และบัญชีที่อนุญาตต้องเป็นบัญชีชมรมที่ Google ยืนยันอีเมลแล้ว
    if (!ctx.session || ctx.session.user.role !== 'admin' || ctx.session.user.id !== row.user_id) return connectFail('forbidden')
    if (!identity.emailVerified || identity.email !== clubEmail(env)) {
      await audit(env, ctx.session.user.id, 'google.connect_rejected', 'club', 'wrong_account')
      return connectFail('wrong_account')
    }
    if (!(tokens.scope ?? '').split(' ').includes(DRIVE_FILE_SCOPE)) return connectFail('missing_scope')
    const saved = await saveConnection(env, identity, tokens, ctx.session.user.id)
    if (saved === 'no_refresh_token') return connectFail('no_refresh_token')
    await audit(env, ctx.session.user.id, 'google.connected', 'club')
    return connectFail('connected')
  }

  const userId = await resolveUser(env, identity)
  if (!userId) return redirect('/access-denied', [clear])
  return redirect(row.return_path, [clear, await createSession(env, userId, url)])
}

/**
 * หาผู้ใช้ที่มีสิทธิ์จากบัญชีที่ Google ยืนยัน
 * - บัญชีชมรมเป็นผู้ดูแลคนแรกโดยอัตโนมัติ (bootstrap) เฉพาะเมื่อ Google ยืนยันอีเมลแล้ว
 * - บัญชีอื่นต้องถูกผู้ดูแลเพิ่มอีเมลไว้ก่อน
 */
async function resolveUser(env: AppEnv, identity: GoogleIdentity): Promise<string | null> {
  if (!identity.emailVerified) return null
  const now = nowIso()

  if (identity.email === clubEmail(env)) {
    const existing = await env.DB.prepare('SELECT id, google_sub FROM users WHERE email = ?')
      .bind(identity.email)
      .first<{ id: string; google_sub: string | null }>()
    if (existing) {
      if (existing.google_sub && existing.google_sub !== identity.sub) return null
      await env.DB.prepare(
        `UPDATE users SET google_sub = ?, name = ?, role = 'admin', status = 'active', is_bootstrap = 1, last_login_at = ?, updated_at = ? WHERE id = ?`,
      )
        .bind(identity.sub, identity.name, now, now, existing.id)
        .run()
      return existing.id
    }
    const id = crypto.randomUUID()
    await env.DB.prepare(
      `INSERT INTO users (id, email, google_sub, name, role, status, is_bootstrap, created_at, updated_at, last_login_at)
       VALUES (?, ?, ?, ?, 'admin', 'active', 1, ?, ?, ?)`,
    )
      .bind(id, identity.email, identity.sub, identity.name, now, now, now)
      .run()
    await audit(env, id, 'user.bootstrap_admin', id)
    return id
  }

  const user = await env.DB.prepare('SELECT id, google_sub, status FROM users WHERE google_sub = ? OR email = ? ORDER BY google_sub = ? DESC')
    .bind(identity.sub, identity.email, identity.sub)
    .first<{ id: string; google_sub: string | null; status: string }>()
  if (!user || user.status !== 'active') return null
  // อีเมลที่เพิ่มไว้ถูกผูกกับบัญชี Google แรกที่ใช้เข้าสู่ระบบ บัญชีอื่นที่ใช้อีเมลเดียวกันภายหลังจะไม่ได้สิทธิ์
  if (user.google_sub && user.google_sub !== identity.sub) return null
  await env.DB.prepare('UPDATE users SET google_sub = ?, name = ?, last_login_at = ?, updated_at = ? WHERE id = ?')
    .bind(identity.sub, identity.name, now, now, user.id)
    .run()
  return user.id
}

/** POST /auth/logout — ออกจากระบบเฉพาะทีมงานคนนี้ ไม่ตัดการเชื่อม Google ของชมรม */
async function logout(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx)
  await deleteSession(ctx.env, session.tokenHash)
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(ctx.url) })
}

export async function handleAuth(ctx: Ctx): Promise<Response> {
  const { pathname } = ctx.url
  const method = ctx.request.method
  if (pathname === '/auth/login' && method === 'GET') return login(ctx)
  if (pathname === '/auth/google/callback' && method === 'GET') return callback(ctx)
  if (pathname === '/auth/logout' && method === 'POST') return logout(ctx)
  throw new HttpError(404, 'not_found', 'ไม่พบเส้นทางนี้')
}
