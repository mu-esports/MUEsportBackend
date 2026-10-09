import { handleMemberSelf } from './accounts'
import { handleAthletes } from './athletes'
import { handleAuth, startConnect } from './auth'
import { handleDocuments } from './documents'
import type { AppEnv, Ctx } from './env'
import { handleEvents } from './events'
import { handleForms } from './gforms'
import { handleLibrary } from './library'
import { isAuthConfigured } from './google'
import { errorResponse, HttpError, json, redirect } from './http'
import { handleMembers } from './members'
import { loadSession } from './session'
import { handleSetup, handleSync } from './setup'
import { handleSources } from './sources'
import { runScheduled } from './sync'
import { handleUsers } from './users'

async function handleApi(ctx: Ctx): Promise<Response> {
  const parts = ctx.url.pathname.split('/').filter(Boolean).slice(1)
  const [resource, ...rest] = parts

  if (resource === 'session' && rest.length === 0 && ctx.request.method === 'GET') {
    // user = ทีมงาน (Google), member = สมาชิก (รหัสนักศึกษา) มีได้อย่างใดอย่างหนึ่งตามชนิดของ session ที่ server ตรวจแล้ว
    return json({
      authConfigured: isAuthConfigured(ctx.env),
      user: ctx.session?.kind === 'staff' ? ctx.session.user : null,
      member: ctx.session?.kind === 'member' ? ctx.session.member : null,
      csrfToken: ctx.session?.csrfToken ?? null,
    })
  }

  let response: Response | null = null
  if (resource === 'members') response = await handleMembers(ctx, rest)
  else if (resource === 'athletes') response = await handleAthletes(ctx, rest)
  else if (resource === 'member') response = await handleMemberSelf(ctx, rest)
  else if (resource === 'library') response = await handleLibrary(ctx, rest)
  else if (resource === 'events') response = await handleEvents(ctx, rest)
  else if (resource === 'users') response = await handleUsers(ctx, rest)
  else if (resource === 'documents') response = await handleDocuments(ctx, rest)
  else if (resource === 'forms') response = await handleForms(ctx, rest)
  else if (resource === 'sync') response = await handleSync(ctx, rest)
  else if (resource === 'setup') response = await handleSetup(ctx, rest)
  else if (resource === 'google' && rest[0] === 'connect' && rest.length === 1 && ctx.request.method === 'POST') response = await startConnect(ctx)
  else if (resource === 'sources' || resource === 'google') response = await handleSources(ctx, parts)

  // เส้นทาง API ที่ไม่มีต้องตอบเป็น JSON ไม่ใช่หน้าเว็บ
  return response ?? errorResponse(new HttpError(404, 'not_found', 'ไม่พบเส้นทาง API นี้'))
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url)
    const isApi = url.pathname === '/api' || url.pathname.startsWith('/api/')
    const isAuth = url.pathname.startsWith('/auth/')
    // หน้าเว็บและไฟล์ประกอบให้ static assets จัดการ (SPA fallback)
    if (!isApi && !isAuth) return env.ASSETS.fetch(request)

    try {
      const ctx: Ctx = { request, env, url, session: await loadSession(request, env) }
      return isApi ? await handleApi(ctx) : await handleAuth(ctx)
    } catch (error) {
      if (error instanceof HttpError) {
        // เส้นทาง /auth ที่เปิดจากเบราว์เซอร์โดยตรงพากลับหน้าเข้าสู่ระบบแทนการแสดง JSON
        if (isAuth && request.method === 'GET') return redirect(`/login?error=${encodeURIComponent(error.code)}`)
        return errorResponse(error)
      }
      // log เฉพาะชนิดข้อผิดพลาดและเส้นทาง ไม่มี token, cookie, เนื้อหาเอกสาร หรือข้อมูลสมาชิก
      console.error('unhandled error', request.method, url.pathname, error instanceof Error ? error.name : 'unknown')
      return errorResponse(new HttpError(500, 'internal_error', 'ระบบขัดข้อง ลองอีกครั้งในอีกสักครู่'))
    }
  },
  // Cron (ตั้งแยกต่อ environment ใน wrangler.jsonc): อัปเดตสำเนาแม้ไม่มีใครเปิดเว็บ ทำทีละชุดจำกัด และใช้ lease เดียวกับคำขอจากหน้าเว็บจึงไม่ทำงานซ้อน
  async scheduled(_controller, env, ctx): Promise<void> {
    ctx.waitUntil(runScheduled(env).then(() => undefined))
  },
} satisfies ExportedHandler<AppEnv>
