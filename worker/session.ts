import { randomToken, safeEqual, sha256Hex } from './crypto'
import { nowIso } from './env'
import type { AppEnv, Ctx, Role, Session } from './env'
import { cookie, HttpError, isHttps, parseCookies } from './http'

export const SESSION_COOKIE = 'mu_session'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60

/** CSRF token ผูกกับ session: คำนวณจาก session secret ซึ่งผู้โจมตีอ่านไม่ได้ */
const csrfFor = (token: string) => sha256Hex(`csrf:${token}`)

export async function createSession(env: AppEnv, userId: string, url: URL): Promise<string> {
  const token = randomToken()
  const now = Date.now()
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, new Date(now).toISOString(), new Date(now + SESSION_TTL_SECONDS * 1000).toISOString())
    .run()
  return cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, secure: isHttps(url) })
}

export const clearSessionCookie = (url: URL) => cookie(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(url) })

/** อ่าน session จาก cookie: ต้องยังไม่หมดอายุ และผู้ใช้ยังมีสิทธิ์อยู่ */
export async function loadSession(request: Request, env: AppEnv): Promise<Session | null> {
  const token = parseCookies(request)[SESSION_COOKIE]
  if (!token) return null
  const tokenHash = await sha256Hex(token)
  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
  )
    .bind(tokenHash, nowIso())
    .first<{ id: string; email: string; name: string; role: Role }>()
  if (!row) return null
  return { user: row, tokenHash, csrfToken: await csrfFor(token) }
}

export async function deleteSession(env: AppEnv, tokenHash: string): Promise<void> {
  await env.DB.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(tokenHash).run()
}

/** ตรวจสิทธิ์ที่ server ทุก route: ต้องเข้าสู่ระบบ และมีบทบาทตามที่กำหนด */
export function requireUser(ctx: Ctx, role: Role = 'staff'): Session {
  if (!ctx.session) {
    throw new HttpError(401, 'unauthenticated', 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว')
  }
  if (role === 'admin' && ctx.session.user.role !== 'admin') {
    throw new HttpError(403, 'forbidden', 'ต้องเป็นผู้ดูแลระบบจึงจะทำรายการนี้ได้')
  }
  return ctx.session
}

/** ป้องกัน CSRF สำหรับคำสั่งที่เปลี่ยนข้อมูล: Origin ต้องเป็นของเว็บเอง และมี token ที่ผูกกับ session */
export async function requireMutation(ctx: Ctx, role: Role = 'staff'): Promise<Session> {
  const session = requireUser(ctx, role)
  if (ctx.request.headers.get('Origin') !== ctx.url.origin) {
    throw new HttpError(403, 'bad_origin', 'คำขอนี้ไม่ได้มาจากหน้าเว็บของระบบ')
  }
  const sent = ctx.request.headers.get('X-CSRF-Token') ?? ''
  if (!sent || !(await safeEqual(sent, session.csrfToken))) {
    throw new HttpError(403, 'bad_csrf', 'คำขอไม่ผ่านการตรวจความปลอดภัย โหลดหน้าใหม่แล้วลองอีกครั้ง')
  }
  return session
}

export async function audit(env: AppEnv, userId: string | null, action: string, target = '', detail = ''): Promise<void> {
  await env.DB.prepare('INSERT INTO audit_log (at, user_id, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(nowIso(), userId, action, target, detail)
    .run()
}
