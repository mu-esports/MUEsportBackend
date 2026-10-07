import type { AppEnv, Ctx } from './env'
import { clubEmail, disconnect, DRIVE_FILE_SCOPE, getAccessToken, loadConnection, missingConnectConfig } from './google'
import { HttpError, json } from './http'
import { loadResources } from './sync'
import { audit, requireMutation, requireUser } from './session'

type GoogleStatus = 'not_configured' | 'not_connected' | 'connected' | 'needs_reconnect' | 'error'

/** สถานะตามข้อมูลจริงใน D1 และค่าตั้งของ Worker แยกการเชื่อมบัญชีออกจากการเลือกแหล่งข้อมูล */
async function describe(env: AppEnv, admin: boolean) {
  const missing = await missingConnectConfig(env)
  const row = await loadConnection(env)
  let status: GoogleStatus
  if (missing.length > 0) status = 'not_configured'
  else if (!row || row.status === 'disconnected') status = 'not_connected'
  else status = row.status

  const linked = row && row.status !== 'disconnected' ? row : null
  const docsReady = status === 'connected' && (linked?.scopes ?? '').split(' ').includes(DRIVE_FILE_SCOPE)
  const linkedResources = await loadResources(env)

  return {
    google: {
      status,
      expectedEmail: clubEmail(env),
      email: linked?.email ?? null,
      connectedAt: linked?.connected_at ?? null,
      lastCheckedAt: row?.last_checked_at ?? null,
      lastError: linked?.last_error ?? null,
      // ชื่อค่าที่ยังขาด แสดงเฉพาะผู้ดูแลเพื่อใช้ตั้งค่า (เป็นชื่อตัวแปร ไม่ใช่ค่าลับ)
      missingConfig: admin ? missing : [],
    },
    resources: [
      { id: 'docs', status: docsReady ? 'ready' : status === 'connected' ? 'missing_scope' : 'needs_connection' },
      // เชื่อมบัญชีแล้วไม่ได้แปลว่าเลือกชีตหรือปฏิทินแล้ว ต้องมีการตั้งค่าแหล่งข้อมูลแยกต่างหาก
      ...(['sheets', 'calendar', 'forms'] as const).map((id) => ({
        id,
        status: linkedResources[id] ? 'selected' : 'not_selected',
        resourceName: linkedResources[id]?.name ?? null,
      })),
      // Excel อยู่นอกงานซิงค์ Google: ยังไม่มีการทำงานส่วนนี้ จึงแสดงว่ายังไม่เปิดใช้
      { id: 'excel', status: 'disabled' },
    ],
  }
}

async function get(ctx: Ctx): Promise<Response> {
  const session = requireUser(ctx)
  return json(await describe(ctx.env, session.user.role === 'admin'))
}

/** ตรวจการเชื่อมกับ Google จริงด้วยการขอ access token ใหม่ แล้วรายงานสถานะตามผล */
async function check(ctx: Ctx): Promise<Response> {
  await requireMutation(ctx, 'admin')
  let problem: string | null = null
  try {
    await getAccessToken(ctx.env, true)
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
    problem = error.message
  }
  return json({ ...(await describe(ctx.env, true)), problem })
}

async function remove(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const result = await disconnect(ctx.env)
  await audit(ctx.env, session.user.id, 'google.disconnected', 'club', result.revokedAtGoogle ? 'revoked' : 'local_only')
  return json({ ...(await describe(ctx.env, true)), revokedAtGoogle: result.revokedAtGoogle })
}

export async function handleSources(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts[0] === 'sources' && parts.length === 1 && method === 'GET') return get(ctx)
  if (parts[0] === 'google' && parts.length === 2 && method === 'POST') {
    if (parts[1] === 'check') return check(ctx)
    if (parts[1] === 'disconnect') return remove(ctx)
  }
  return null
}
