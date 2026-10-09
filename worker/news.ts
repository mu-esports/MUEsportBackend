import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { audit, requireMember, requireMutation, requireUser } from './session'
import { bangkokToday, expectedVersion, findIdempotent, hashPayload, idempotencyInsert, idempotencyKey, invalid, oneOf, text, versionConflict } from './validation'

const STATUSES = ['draft', 'published', 'archived'] as const
interface NewsRow {
  id: string; title: string; summary: string; body: string; category: string; published_date: string
  image_url: string; instagram_url: string; source_url: string; status: typeof STATUSES[number]; version: number; updated_at: string
}
const get = (env: AppEnv, id: string) => env.DB.prepare('SELECT * FROM club_news WHERE id = ?').bind(id).first<NewsRow>()
const display = (row: NewsRow) => ({ id: row.id, title: row.title, summary: row.summary, body: row.body, category: row.category, publishedDate: row.published_date, imageUrl: row.image_url, instagramUrl: row.instagram_url, sourceUrl: row.source_url })
const staffDisplay = (row: NewsRow) => ({ ...display(row), status: row.status, version: row.version, updatedAt: row.updated_at })

function httpsUrl(body: Record<string, unknown>, field: string, label: string): string {
  const value = text(body, field, label, 2048)
  if (!value) return ''
  let url: URL
  try { url = new URL(value) } catch { throw invalid(`${label}ต้องเป็น URL ที่ถูกต้อง`, field) }
  if (url.protocol !== 'https:' || url.username || url.password) throw invalid(`${label}ต้องเป็นลิงก์ https`, field)
  if (field === 'instagramUrl' && (!['instagram.com', 'www.instagram.com'].includes(url.hostname) || !/^\/(p|reel|tv)\/[A-Za-z0-9_-]+\/?$/.test(url.pathname))) {
    throw invalid('ใช้ลิงก์โพสต์หรือ Reel ของ Instagram', field)
  }
  return url.href
}

function input(body: Record<string, unknown>) {
  const publishedDate = text(body, 'publishedDate', 'วันที่ข่าว', 10, true)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(publishedDate) || !Number.isFinite(Date.parse(`${publishedDate}T00:00:00Z`)) || new Date(`${publishedDate}T00:00:00Z`).toISOString().slice(0, 10) !== publishedDate) throw invalid('วันที่ข่าวไม่ถูกต้อง', 'publishedDate')
  return {
    title: text(body, 'title', 'หัวข้อ', 200, true), summary: text(body, 'summary', 'คำโปรย', 1000), body: text(body, 'body', 'เนื้อหา', 12000),
    category: text(body, 'category', 'หมวดหมู่', 40, true), publishedDate,
    imageUrl: httpsUrl(body, 'imageUrl', 'ลิงก์ภาพ'), instagramUrl: httpsUrl(body, 'instagramUrl', 'ลิงก์ Instagram'), sourceUrl: httpsUrl(body, 'sourceUrl', 'ลิงก์ต้นทาง'),
    status: oneOf(body, 'status', 'สถานะข่าว', STATUSES),
  }
}

export async function memberNews(ctx: Ctx): Promise<Response> {
  requireMember(ctx)
  const { results } = await ctx.env.DB.prepare("SELECT * FROM club_news WHERE status = 'published' AND published_date <= ? ORDER BY published_date DESC, id LIMIT 101").bind(bangkokToday()).all<NewsRow>()
  return json({ news: results.slice(0, 100).map(display), truncated: results.length > 100 })
}

async function list(ctx: Ctx): Promise<Response> {
  requireUser(ctx)
  const { results } = await ctx.env.DB.prepare('SELECT * FROM club_news ORDER BY published_date DESC, id LIMIT 201').all<NewsRow>()
  return json({ news: results.slice(0, 200).map(staffDisplay), truncated: results.length > 200 })
}

async function create(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx)
  const value = input(await readJson(ctx.request, 64 * 1024))
  const key = idempotencyKey(ctx.request), hash = await hashPayload(value)
  const replay = async () => {
    const id = await findIdempotent(ctx.env, session.user.id, key, 'news.create', hash)
    return id ? get(ctx.env, id) : null
  }
  const existing = await replay()
  if (existing) return json({ news: staffDisplay(existing), replayed: true })
  const id = crypto.randomUUID(), time = nowIso()
  try {
    await ctx.env.DB.batch([
      idempotencyInsert(ctx.env, session.user.id, key, 'news.create', hash, id),
      ctx.env.DB.prepare('INSERT INTO club_news (id,title,summary,body,category,published_date,image_url,instagram_url,source_url,status,created_by,updated_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .bind(id, value.title, value.summary, value.body, value.category, value.publishedDate, value.imageUrl, value.instagramUrl, value.sourceUrl, value.status, session.user.id, session.user.id, time, time),
    ])
  } catch (failure) {
    const again = await replay()
    if (again) return json({ news: staffDisplay(again), replayed: true })
    throw failure
  }
  await audit(ctx.env, session.user.id, 'news.created', id)
  return json({ news: staffDisplay((await get(ctx.env, id))!) }, 201)
}

async function update(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request, 64 * 1024), value = input(body), version = expectedVersion(body)
  const result = await ctx.env.DB.prepare('UPDATE club_news SET title=?, summary=?, body=?, category=?, published_date=?, image_url=?, instagram_url=?, source_url=?, status=?, version=version+1, updated_by=?, updated_at=? WHERE id=? AND version=?')
    .bind(value.title, value.summary, value.body, value.category, value.publishedDate, value.imageUrl, value.instagramUrl, value.sourceUrl, value.status, session.user.id, nowIso(), id, version).run()
  const current = await get(ctx.env, id)
  if (!current) throw new HttpError(404, 'not_found', 'ไม่พบข่าวนี้')
  if (!result.meta.changes) throw versionConflict(staffDisplay(current))
  await audit(ctx.env, session.user.id, 'news.updated', id)
  return json({ news: staffDisplay(current) })
}

export async function handleNews(ctx: Ctx, parts: string[]): Promise<Response | null> {
  if (!parts.length && ctx.request.method === 'GET') return list(ctx)
  if (!parts.length && ctx.request.method === 'POST') return create(ctx)
  if (parts.length === 1 && ctx.request.method === 'PATCH') return update(ctx, parts[0])
  return null
}
