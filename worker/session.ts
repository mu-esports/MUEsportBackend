import { randomToken, safeEqual, sha256Hex } from './crypto'
import { nowIso } from './env'
import type { AppEnv, Ctx, MemberSession, Role, Session, StaffSession } from './env'
import { cookie, HttpError, isHttps, parseCookies } from './http'

export const SESSION_COOKIE = 'mu_session'
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60
/**
 * token ของสมาชิกขึ้นต้นด้วยค่านี้ และถูกค้นในตาราง member_sessions เท่านั้น ส่วน token ของทีมงานถูกค้นในตาราง sessions เท่านั้น
 * ชนิดของ session จึงมาจากตารางที่ server พบแถว ไม่ได้มาจากค่าที่ browser อ้าง: token ที่แก้ prefix จะไม่พบแถวในอีกตาราง
 */
const MEMBER_TOKEN_PREFIX = 'm.'

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

/** token ใหม่ของสมาชิก พร้อมคำสั่งบันทึกแถว session (ผู้เรียกรวมไว้ใน batch เดียวกับคำสั่งอื่นได้) */
export async function newMemberSession(env: AppEnv, memberId: string, url: URL) {
  const token = MEMBER_TOKEN_PREFIX + randomToken()
  const now = Date.now()
  return {
    insert: env.DB.prepare('INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)').bind(
      await sha256Hex(token), memberId, new Date(now).toISOString(), new Date(now + SESSION_TTL_SECONDS * 1000).toISOString(),
    ),
    cookie: cookie(SESSION_COOKIE, token, { maxAge: SESSION_TTL_SECONDS, secure: isHttps(url) }),
    csrfToken: await csrfFor(token),
  }
}

export const clearSessionCookie = (url: URL) => cookie(SESSION_COOKIE, '', { maxAge: 0, secure: isHttps(url) })

/**
 * อ่าน session จาก cookie: ต้องยังไม่หมดอายุ และผู้ใช้ยังมีสิทธิ์อยู่ ณ ตอนที่คำขอนี้มาถึง
 * - ทีมงาน: บัญชีในตาราง users ต้องยัง active
 * - สมาชิก: บัญชีสมาชิกต้องยังเปิดใช้งาน และสมาชิกต้องไม่ถูกพักการใช้งาน
 */
export async function loadSession(request: Request, env: AppEnv): Promise<Session | null> {
  const token = parseCookies(request)[SESSION_COOKIE]
  if (!token) return null
  const tokenHash = await sha256Hex(token)

  if (token.startsWith(MEMBER_TOKEN_PREFIX)) {
    const row = await env.DB.prepare(
      `SELECT m.id, m.name, m.nickname, a.login_id, a.must_change_password
         FROM member_sessions s
         JOIN member_accounts a ON a.member_id = s.member_id
         JOIN members m ON m.id = a.member_id
        WHERE s.token_hash = ? AND s.expires_at > ? AND a.status = 'active' AND m.status = 'active'`,
    )
      .bind(tokenHash, nowIso())
      .first<{ id: string; name: string; nickname: string; login_id: string; must_change_password: number }>()
    if (!row) return null
    return {
      kind: 'member',
      member: { id: row.id, name: row.name, nickname: row.nickname, studentId: row.login_id, mustChangePassword: row.must_change_password === 1 },
      tokenHash,
      csrfToken: await csrfFor(token),
    }
  }

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.name, u.role
       FROM sessions s JOIN users u ON u.id = s.user_id
      WHERE s.token_hash = ? AND s.expires_at > ? AND u.status = 'active'`,
  )
    .bind(tokenHash, nowIso())
    .first<{ id: string; email: string; name: string; role: Role }>()
  if (!row) return null
  return { kind: 'staff', user: row, tokenHash, csrfToken: await csrfFor(token) }
}

/** ยกเลิก session ที่ server (ทั้งสองชนิด) */
export async function deleteSession(env: AppEnv, session: Pick<Session, 'kind' | 'tokenHash'>): Promise<void> {
  const table = session.kind === 'member' ? 'member_sessions' : 'sessions'
  await env.DB.prepare(`DELETE FROM ${table} WHERE token_hash = ?`).bind(session.tokenHash).run()
}

const unauthenticated = () => new HttpError(401, 'unauthenticated', 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว')

/** บทบาททีมงานที่ผ่าน guard ของแต่ละระดับ ระบุครบทุกค่า ไม่มีค่าใดผ่านโดยปริยาย */
const STAFF_ROLES_FOR: Record<Role, readonly string[]> = {
  staff: ['staff', 'admin'],
  admin: ['admin'],
}

/**
 * ตรวจสิทธิ์ทีมงานที่ server ทุก route ของหลังบ้าน: ต้องเป็น session ของทีมงาน (เข้าสู่ระบบด้วย Google) และมีบทบาทตามที่กำหนด
 * session ของสมาชิก (รหัสนักศึกษา) ไม่ผ่าน guard นี้ไม่ว่ากรณีใด รวมถึงสมาชิกที่บทบาทในทะเบียนเป็น "ทีมงาน" หรือ "ผู้ดูแล"
 */
export function requireUser(ctx: Ctx, role: Role = 'staff'): StaffSession {
  const session = ctx.session
  if (!session) throw unauthenticated()
  if (session.kind !== 'staff') {
    throw new HttpError(403, 'staff_only', 'ส่วนนี้สำหรับทีมงานเท่านั้น บัญชีสมาชิกเปิดไม่ได้')
  }
  if (!STAFF_ROLES_FOR[role].includes(session.user.role)) {
    throw new HttpError(403, 'forbidden', role === 'admin' ? 'ต้องเป็นผู้ดูแลระบบจึงจะทำรายการนี้ได้' : 'บัญชีนี้ไม่มีสิทธิ์ใช้งานส่วนนี้')
  }
  return session
}

interface MemberGuardOptions {
  /** ยอมให้ session ที่ยังต้องเปลี่ยนรหัสผ่านชั่วคราวผ่าน ใช้เฉพาะเส้นทางเปลี่ยนรหัสผ่าน */
  allowPasswordChange?: boolean
}

const passwordChangeRequired = () =>
  new HttpError(403, 'password_change_required', 'ต้องเปลี่ยนรหัสผ่านชั่วคราวก่อน จึงจะใช้งานส่วนนี้ได้')

/**
 * ตรวจสิทธิ์สมาชิก: ต้องเป็น session ของสมาชิก บัญชียังเปิดใช้งาน (ตรวจตอนโหลด session) และเปลี่ยนรหัสผ่านชั่วคราวแล้ว
 * ทีมงานไม่ผ่าน guard นี้: ข้อมูลตนเองของสมาชิกผูกกับ session ของสมาชิกเท่านั้น
 */
export function requireMember(ctx: Ctx, options: MemberGuardOptions = {}): MemberSession {
  const session = ctx.session
  if (!session) throw unauthenticated()
  if (session.kind !== 'member') throw new HttpError(403, 'member_only', 'ส่วนนี้สำหรับบัญชีสมาชิกเท่านั้น')
  if (session.member.mustChangePassword && !options.allowPasswordChange) throw passwordChangeRequired()
  return session
}

/** ผู้ที่อ่านคลังไฟล์ได้: ทีมงาน (staff/admin) หรือสมาชิกที่บัญชีเปิดใช้งานและเปลี่ยนรหัสผ่านชั่วคราวแล้ว */
export function requireViewer(ctx: Ctx): Session {
  const session = ctx.session
  if (!session) throw unauthenticated()
  if (session.kind === 'staff') return requireUser(ctx)
  return requireMember(ctx)
}

/** ป้องกัน CSRF สำหรับคำสั่งที่เปลี่ยนข้อมูล: Origin ต้องเป็นของเว็บเอง และมี token ที่ผูกกับ session */
async function checkMutation(ctx: Ctx, session: Session): Promise<void> {
  if (ctx.request.headers.get('Origin') !== ctx.url.origin) {
    throw new HttpError(403, 'bad_origin', 'คำขอนี้ไม่ได้มาจากหน้าเว็บของระบบ')
  }
  const sent = ctx.request.headers.get('X-CSRF-Token') ?? ''
  if (!sent || !(await safeEqual(sent, session.csrfToken))) {
    throw new HttpError(403, 'bad_csrf', 'คำขอไม่ผ่านการตรวจความปลอดภัย โหลดหน้าใหม่แล้วลองอีกครั้ง')
  }
}

export async function requireMutation(ctx: Ctx, role: Role = 'staff'): Promise<StaffSession> {
  const session = requireUser(ctx, role)
  await checkMutation(ctx, session)
  return session
}

export async function requireMemberMutation(ctx: Ctx, options: MemberGuardOptions = {}): Promise<MemberSession> {
  const session = requireMember(ctx, options)
  await checkMutation(ctx, session)
  return session
}

/** คำสั่งที่ทุกชนิดของ session ทำได้กับ session ของตัวเอง (ออกจากระบบ) */
export async function requireOwnSessionMutation(ctx: Ctx): Promise<Session> {
  const session = ctx.session
  if (!session) throw unauthenticated()
  await checkMutation(ctx, session)
  return session
}

export async function audit(env: AppEnv, userId: string | null, action: string, target = '', detail = ''): Promise<void> {
  await env.DB.prepare('INSERT INTO audit_log (at, user_id, action, target, detail) VALUES (?, ?, ?, ?, ?)')
    .bind(nowIso(), userId, action, target, detail)
    .run()
}
