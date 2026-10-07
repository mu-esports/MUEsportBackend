import { MAX_CONTENT_UNITS, MAX_TITLE_LENGTH, normalizeText, parseDocument, planEdit } from './docs'
import type { ParsedDocument } from './docs'
import { nowIso } from './env'
import type { AppEnv, Ctx, StaffSession as Session } from './env'
import { getAccessToken, googleFetch } from './google'
import { HttpError, json, readJson } from './http'
import { audit, requireMutation, requireUser } from './session'
import { invalidateLists } from './library'
import { checkFile } from './setup'
import { batchAll, bumpDataVersion, GoogleApiError, makeGapi, registerSyncer, toHttpError } from './sync'
import { hashPayload, idempotencyKey, invalid } from './validation'

const DOCS_API = 'https://docs.googleapis.com/v1/documents'
const DRIVE_API = 'https://www.googleapis.com/drive/v3/files'
const DOC_MIME = 'application/vnd.google-apps.document'
// ป้ายบนไฟล์ใน Drive ใช้หาไฟล์ที่สร้างสำเร็จแล้วแต่บันทึกผลไม่ทัน เพื่อไม่สร้างซ้ำตอนลองใหม่
const OPERATION_PROPERTY = 'muOperation'
const MAX_BODY = 512 * 1024

interface DocumentRow {
  id: string
  google_document_id: string
  title: string
  status: 'ok' | 'read_only' | 'unavailable'
  status_detail: string
  created_at: string
  updated_at: string
  last_checked_at: string | null
  origin?: string
  created_by_name?: string | null
  updated_by_name?: string | null
}

const toDocument = (row: DocumentRow) => ({
  id: row.id,
  title: row.title,
  status: row.status,
  statusDetail: row.status_detail,
  // รหัสไฟล์ใน Google ใช้เปิดตัวอย่างในหน้าไฟล์ชมรม
  googleId: row.google_document_id,
  googleUrl: `https://docs.google.com/document/d/${row.google_document_id}/edit`,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  lastCheckedAt: row.last_checked_at,
  // created = สร้างผ่านเว็บ, selected = ไฟล์เดิมที่ผู้ดูแลเลือกมาผูก
  origin: row.origin ?? 'created',
  createdByName: row.created_by_name ?? '',
  updatedByName: row.updated_by_name ?? '',
})

const toContent = (parsed: ParsedDocument) => ({
  text: parsed.text,
  revisionId: parsed.revisionId,
  editable: parsed.supported,
  reasons: parsed.reasons,
})

const SELECT_DOCUMENT = `
  SELECT d.*, COALESCE(NULLIF(c.name, ''), c.email) AS created_by_name, COALESCE(NULLIF(u.name, ''), u.email) AS updated_by_name
    FROM documents d
    LEFT JOIN users c ON c.id = d.created_by
    LEFT JOIN users u ON u.id = d.updated_by`

const getDocument = (env: AppEnv, id: string) => env.DB.prepare(`${SELECT_DOCUMENT} WHERE d.id = ?`).bind(id).first<DocumentRow>()

const unavailable = () =>
  new HttpError(
    404,
    'document_unavailable',
    'เปิดเอกสารนี้จาก Google ไม่ได้ อาจถูกลบ หรือบัญชี Google ของชมรมไม่มีสิทธิ์เข้าถึงไฟล์นี้แล้ว',
  )
const googleFailed = (status: number) =>
  new HttpError(502, 'google_error', 'Google ตอบกลับผิดพลาด ลองอีกครั้งในอีกสักครู่', { googleStatus: status })

// ---------- เรียก Google ----------

async function fetchDoc(env: AppEnv, googleId: string): Promise<ParsedDocument> {
  // includeTabsContent=true เพื่อให้ได้เนื้อหาตามแท็บจริง และรู้ว่าเอกสารมีกี่แท็บ
  const response = await googleFetch(env, `${DOCS_API}/${encodeURIComponent(googleId)}?includeTabsContent=true`)
  if (response.status === 404 || response.status === 403) throw unavailable()
  if (!response.ok) throw googleFailed(response.status)
  return parseDocument(await response.json())
}

/** เขียนด้วย requiredRevisionId: Google จะปฏิเสธทั้งคำสั่งถ้าเอกสารถูกแก้หลัง revision ที่อ้างถึง */
async function writeDoc(env: AppEnv, googleId: string, requests: unknown[], revisionId: string): Promise<'ok' | 'rejected'> {
  const response = await googleFetch(env, `${DOCS_API}/${encodeURIComponent(googleId)}:batchUpdate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests, writeControl: { requiredRevisionId: revisionId } }),
  })
  if (response.ok) return 'ok'
  if (response.status === 400) return 'rejected'
  if (response.status === 404 || response.status === 403) throw unavailable()
  throw googleFailed(response.status)
}

/** Google ตอบ 5xx หรือคำตอบไม่กลับมา: ไม่รู้ว่าคำสั่งถูกใช้ไปแล้วหรือยัง */
const isUnknownOutcome = (error: HttpError) =>
  error.code === 'google_unavailable' || (error.code === 'google_error' && Number(error.extra.googleStatus) >= 500)

/** ไฟล์ทั้งหมดที่ติดป้ายของงานนี้ (ปกติ 0 หรือ 1 ไฟล์) ผลค้นหาที่ว่างไม่ได้ยืนยันว่าไม่มีไฟล์ เพราะไฟล์ใหม่อาจยังไม่ปรากฏ */
async function findCreatedFiles(env: AppEnv, operationId: string): Promise<string[]> {
  const query = `appProperties has { key='${OPERATION_PROPERTY}' and value='${operationId}' } and trashed = false`
  const response = await googleFetch(env, `${DRIVE_API}?${new URLSearchParams({ q: query, fields: 'files(id)', spaces: 'drive' })}`)
  if (!response.ok) throw googleFailed(response.status)
  const data = (await response.json()) as { files?: { id?: string }[] }
  return (data.files ?? []).map((f) => f.id).filter((id): id is string => typeof id === 'string')
}

type CreateResult =
  | { kind: 'created'; id: string }
  /** Google ปฏิเสธคำขอชัดเจน (4xx): ไม่มีไฟล์ถูกสร้าง */
  | { kind: 'not_created'; status: number }
  /** 5xx, เครือข่ายขาด, หมดเวลา หรือคำตอบอ่านไม่ได้: Google อาจสร้างไฟล์ไปแล้ว */
  | { kind: 'unknown' }

async function createFile(env: AppEnv, title: string, operationId: string): Promise<CreateResult> {
  let response: Response
  try {
    response = await googleFetch(env, `${DRIVE_API}?fields=id`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: title, mimeType: DOC_MIME, appProperties: { [OPERATION_PROPERTY]: operationId } }),
    })
  } catch {
    return { kind: 'unknown' }
  }
  if (response.ok) {
    const data = (await response.json().catch(() => null)) as { id?: string } | null
    return data?.id ? { kind: 'created', id: data.id } : { kind: 'unknown' }
  }
  return response.status >= 400 && response.status < 500 ? { kind: 'not_created', status: response.status } : { kind: 'unknown' }
}

// ---------- ตรวจข้อมูลที่ส่งมา ----------

function parseInput(body: Record<string, unknown>) {
  const title = typeof body.title === 'string' ? body.title.trim() : ''
  if (!title) throw invalid('กรอกชื่อเอกสาร', 'title')
  if (title.length > MAX_TITLE_LENGTH) throw invalid(`ชื่อเอกสารยาวได้ไม่เกิน ${MAX_TITLE_LENGTH} ตัวอักษร`, 'title')
  if (typeof body.text !== 'string') throw invalid('เนื้อหาไม่ถูกต้อง', 'text')
  const text = normalizeText(body.text)
  if (text.length > MAX_CONTENT_UNITS) {
    throw invalid(`เนื้อหายาวเกิน ${MAX_CONTENT_UNITS.toLocaleString('en-US')} ตัวอักษร`, 'text')
  }
  return { title, text }
}

// ---------- รายการและการอ่าน ----------

async function list(ctx: Ctx): Promise<Response> {
  requireUser(ctx)
  const { results } = await ctx.env.DB.prepare(`${SELECT_DOCUMENT} ORDER BY d.updated_at DESC`).all<DocumentRow>()
  return json({ documents: results.map(toDocument) })
}

async function recordCheck(env: AppEnv, id: string, parsed: ParsedDocument | null): Promise<void> {
  const now = nowIso()
  if (!parsed) {
    await env.DB.prepare(`UPDATE documents SET status = 'unavailable', status_detail = '', last_checked_at = ? WHERE id = ?`).bind(now, id).run()
    return
  }
  // ชื่อใน Google เป็นค่าจริง ถ้าถูกเปลี่ยนจากฝั่ง Google ให้รายการในเว็บตามให้ตรง
  await env.DB.prepare('UPDATE documents SET status = ?, status_detail = ?, title = ?, last_checked_at = ? WHERE id = ?')
    .bind(parsed.supported ? 'ok' : 'read_only', parsed.reasons.join(' · '), parsed.title || 'ไม่มีชื่อ', now, id)
    .run()
}

async function loadFromGoogle(env: AppEnv, row: DocumentRow): Promise<ParsedDocument> {
  try {
    const parsed = await fetchDoc(env, row.google_document_id)
    await recordCheck(env, row.id, parsed)
    return parsed
  } catch (error) {
    if (error instanceof HttpError && error.code === 'document_unavailable') await recordCheck(env, row.id, null)
    throw error
  }
}

async function requireDocument(env: AppEnv, id: string): Promise<DocumentRow> {
  const row = await getDocument(env, id)
  if (!row) throw new HttpError(404, 'not_found', 'ไม่พบเอกสารนี้ในระบบ ลิงก์อาจไม่ถูกต้อง')
  return row
}

/** GET /api/documents/:id/file — รายการที่ลงทะเบียนไว้ (จาก D1 ไม่เรียก Google) ใช้พาลิงก์เอกสารเดิมไปยังตัวอย่างในหน้าไฟล์ชมรม */
async function fileOf(ctx: Ctx, id: string): Promise<Response> {
  requireUser(ctx)
  return json({ document: toDocument(await requireDocument(ctx.env, id)) })
}

async function read(ctx: Ctx, id: string): Promise<Response> {
  requireUser(ctx)
  const row = await requireDocument(ctx.env, id)
  const parsed = await loadFromGoogle(ctx.env, row)
  return json({ document: toDocument((await getDocument(ctx.env, id))!), content: toContent(parsed) })
}

/**
 * ตรวจแบบเบา (ไม่ดึงเนื้อหา) ว่าเอกสารใน Google เป็น revision ใดแล้ว หน้าแก้เอกสารเรียกเป็นระยะขณะเปิดอยู่
 * เพื่อบอกว่ามีฉบับใหม่ โดยไม่แตะร่างที่ผู้ใช้กำลังพิมพ์
 */
async function revision(ctx: Ctx, id: string): Promise<Response> {
  requireUser(ctx)
  const row = await requireDocument(ctx.env, id)
  const response = await googleFetch(ctx.env, `${DOCS_API}/${encodeURIComponent(row.google_document_id)}?fields=revisionId,title`)
  if (response.status === 404 || response.status === 403) {
    await recordCheck(ctx.env, row.id, null)
    throw unavailable()
  }
  if (!response.ok) throw googleFailed(response.status)
  const data = (await response.json()) as { revisionId?: string; title?: string }
  if (typeof data.revisionId !== 'string') throw googleFailed(502)
  if (typeof data.title === 'string' && data.title && data.title !== row.title) {
    await ctx.env.DB.prepare('UPDATE documents SET title = ?, last_checked_at = ? WHERE id = ?').bind(data.title, nowIso(), id).run()
    await bumpDataVersion(ctx.env, 'docs')
  }
  return json({ revisionId: data.revisionId, title: data.title || row.title })
}

/** ผูกเอกสารเดิมที่ผู้ดูแลเลือกผ่าน Google Picker: server ต้องเปิดไฟล์ได้จริงด้วยสิทธิ์ของบัญชีชมรมก่อนจึงลงทะเบียน */
async function linkExisting(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const body = await readJson(ctx.request)
  const fileId = typeof body.fileId === 'string' ? body.fileId.trim() : ''
  let file
  try {
    file = await checkFile(makeGapi(ctx.env), fileId, DOC_MIME, 'ไฟล์ Google Docs')
  } catch (error) {
    throw toHttpError(error)
  }
  const parsed = await fetchDoc(ctx.env, file.id)
  const now = nowIso()
  const id = crypto.randomUUID()
  const result = await ctx.env.DB.prepare(
    `INSERT INTO documents (id, google_document_id, title, status, status_detail, created_by, updated_by, created_at, updated_at, last_checked_at, origin)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'selected') ON CONFLICT (google_document_id) DO NOTHING`,
  )
    .bind(id, file.id, parsed.title || file.name || 'ไม่มีชื่อ', parsed.supported ? 'ok' : 'read_only', parsed.reasons.join(' · '), session.user.id, session.user.id, now, now, now)
    .run()
  if (result.meta.changes !== 1) throw new HttpError(409, 'already_linked', 'เอกสารนี้อยู่ในรายการเอกสารของเว็บอยู่แล้ว ไม่ได้เพิ่มซ้ำ')
  await audit(ctx.env, session.user.id, 'document.linked', id)
  await bumpDataVersion(ctx.env, 'docs')
  await invalidateLists(ctx.env)
  return json({ document: toDocument((await getDocument(ctx.env, id))!), content: toContent(parsed) }, 201)
}

// รายการเอกสารตามการเปลี่ยนชื่อใน Google: ตรวจ metadata ทีละชุดเล็ก เริ่มจากรายการที่ไม่ได้ตรวจนานที่สุด ไม่ดึงเนื้อหา
registerSyncer('docs', async ({ env, gapi }) => {
  const { results } = await env.DB.prepare('SELECT id, google_document_id, title, status FROM documents ORDER BY last_checked_at IS NOT NULL, last_checked_at LIMIT 12')
    .all<{ id: string; google_document_id: string; title: string; status: string }>()
  const statements: D1PreparedStatement[] = []
  let changed = false
  const now = nowIso()
  for (const row of results) {
    if (gapi.remaining() < 1) break
    let name: string | null = null
    try {
      const file = await gapi.json<{ name?: string; trashed?: boolean }>(`${DRIVE_API}/${encodeURIComponent(row.google_document_id)}?fields=id,name,trashed`)
      name = file.trashed === true ? null : (file.name ?? row.title)
    } catch (error) {
      // ไฟล์เดียวเปิดไม่ได้ไม่ทำให้รายการอื่นหยุด; ข้อผิดพลาดอื่น (เช่น Google ล่ม) ให้ทั้งรอบล้มเหลวและคงค่าเดิม
      if (!(error instanceof GoogleApiError && (error.status === 404 || error.status === 403))) throw error
    }
    if (name === null) {
      if (row.status !== 'unavailable') changed = true
      statements.push(env.DB.prepare(`UPDATE documents SET status = 'unavailable', status_detail = '', last_checked_at = ? WHERE id = ?`).bind(now, row.id))
    } else {
      if (name !== row.title) changed = true
      // สถานะ "เปิดไม่ได้" จะกลับเป็นปกติเมื่อมีคนเปิดเอกสารและอ่านเนื้อหาได้จริง
      statements.push(env.DB.prepare('UPDATE documents SET title = ?, last_checked_at = ? WHERE id = ?').bind(name || 'ไม่มีชื่อ', now, row.id))
    }
  }
  await batchAll(env, statements)
  return { changed }
})

// ---------- แก้ไข ----------

async function update(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request, MAX_BODY)
  if (typeof body.text !== 'string') throw invalid('เนื้อหาไม่ถูกต้อง', 'text')
  const text = normalizeText(body.text)
  if (text.length > MAX_CONTENT_UNITS) throw invalid(`เนื้อหายาวเกิน ${MAX_CONTENT_UNITS.toLocaleString('en-US')} ตัวอักษร`, 'text')
  const baseRevisionId = typeof body.baseRevisionId === 'string' ? body.baseRevisionId : ''
  if (!baseRevisionId) throw invalid('ไม่ได้ระบุรุ่นของเอกสารที่กำลังแก้ไข โหลดเอกสารใหม่แล้วลองอีกครั้ง', 'baseRevisionId')

  const row = await requireDocument(ctx.env, id)
  const current = await loadFromGoogle(ctx.env, row)

  // เว็บนี้ไม่เปลี่ยนชื่อเอกสารหลังสร้าง: การเปลี่ยนชื่อเป็นคำสั่งของ Drive ซึ่งไม่มีเงื่อนไข revision ให้ Google ตรวจ
  // จึงกันการเขียนทับชื่อที่คนอื่นเพิ่งเปลี่ยนไม่ได้ คำขอที่ส่งชื่อต่างจากชื่อปัจจุบันถูกปฏิเสธก่อนเขียนอะไรทั้งสิ้น
  if (body.title !== undefined && (typeof body.title !== 'string' || body.title.trim() !== current.title)) {
    throw new HttpError(409, 'title_change_not_supported', 'เปลี่ยนชื่อเอกสารจากเว็บนี้ไม่ได้ ยังไม่ได้บันทึกอะไร เปิดเอกสารใน Google Docs เพื่อเปลี่ยนชื่อ', {
      currentTitle: current.title,
    })
  }
  if (!current.supported) {
    throw new HttpError(409, 'document_not_editable', 'เอกสารนี้มีโครงสร้างที่ editor ในเว็บแก้ไม่ได้ จึงไม่ได้บันทึก เปิดแก้ใน Google Docs แทน', {
      reasons: current.reasons,
    })
  }
  const conflict = (latest: ParsedDocument) =>
    new HttpError(
      409,
      'revision_conflict',
      'เอกสารถูกแก้ไขจากที่อื่นหลังจากที่คุณเปิด ยังไม่ได้บันทึกสิ่งที่คุณแก้ ตรวจฉบับล่าสุดก่อนเลือกว่าจะทำอย่างไร',
      { latest: { title: latest.title, ...toContent(latest) } },
    )
  if (current.revisionId !== baseRevisionId) throw conflict(current)

  const plan = planEdit(current.text, text, current.tabId)
  let wrote = false
  if (plan.requests.length > 0) {
    // ตรวจ revision อีกครั้งในคำสั่งเขียนจริง การอ่านก่อนหน้าไม่พอสำหรับกันการเขียนทับ
    let result: 'ok' | 'rejected'
    try {
      result = await writeDoc(ctx.env, row.google_document_id, plan.requests, current.revisionId)
    } catch (error) {
      // Google ตอบ 5xx หรือคำตอบไม่กลับมา: คำสั่งอาจถูกใช้ไปแล้ว จึงไม่บอกว่าไม่มีอะไรเปลี่ยน
      if (error instanceof HttpError && isUnknownOutcome(error)) {
        throw new HttpError(
          502,
          'save_outcome_unknown',
          'ไม่ทราบว่า Google Docs บันทึกการแก้ครั้งนี้แล้วหรือยัง (คำสั่งไปถึง Google แต่ไม่ได้รับคำตอบที่ยืนยันได้) ตรวจฉบับล่าสุดก่อนบันทึกซ้ำ',
        )
      }
      throw error
    }
    if (result === 'rejected') {
      const latest = await loadFromGoogle(ctx.env, row)
      if (latest.revisionId !== current.revisionId) throw conflict(latest)
      throw new HttpError(502, 'google_write_rejected', 'Google ไม่รับการบันทึกครั้งนี้ ยังไม่มีการเปลี่ยนแปลงเอกสาร ลองอีกครั้ง')
    }
    wrote = true
  }

  // อ่านกลับจาก Google ก่อนยืนยันว่าบันทึกแล้ว
  let after: ParsedDocument
  try {
    after = await fetchDoc(ctx.env, row.google_document_id)
  } catch (error) {
    if (!wrote) throw error
    // เขียนสำเร็จแล้วแต่อ่านกลับไม่ได้: บอกตามจริงว่า Google รับแล้ว ไม่ใช่ "บันทึกไม่สำเร็จ"
    const now = nowIso()
    await ctx.env.DB.prepare('UPDATE documents SET updated_by = ?, updated_at = ? WHERE id = ?').bind(session.user.id, now, id).run()
    throw new HttpError(
      502,
      'saved_unverified',
      'Google Docs รับการบันทึกแล้ว แต่ระบบอ่านกลับเพื่อยืนยันเนื้อหาไม่ได้ ตรวจฉบับล่าสุดเพื่อยืนยัน',
    )
  }
  const now = nowIso()
  await ctx.env.DB.prepare(
    'UPDATE documents SET title = ?, status = ?, status_detail = ?, updated_by = ?, updated_at = ?, last_checked_at = ? WHERE id = ?',
  )
    .bind(after.title || row.title, after.supported ? 'ok' : 'read_only', after.reasons.join(' · '), session.user.id, now, now, id)
    .run()
  return json({
    document: toDocument((await getDocument(ctx.env, id))!),
    content: toContent(after),
    verified: after.text === text,
  })
}

// ---------- สร้าง ----------
//
// งานสร้างเอกสารมีผลข้างเคียงที่ Google (สร้างไฟล์ เขียนเนื้อหา) จึงต้องมีผู้ทำทีละหนึ่งคำขอ และต้องไม่สร้างไฟล์ซ้ำ
//
// 1) lease ใน D1: คำขอต้อง claim แถวของงานด้วย UPDATE แบบมีเงื่อนไขก่อนทำอะไรกับ Google
//    คำขออื่นที่มาระหว่างนั้นจะรอผลเดิม หรือได้คำตอบว่ากำลังทำอยู่ ไม่ได้ทำงานซ้อน
// 2) create_attempted_at: บันทึกก่อนส่งคำสั่งสร้างไฟล์ทุกครั้ง และล้างเฉพาะเมื่อ Google ตอบชัดว่าไม่ได้สร้าง
//    ถ้าค่านี้ค้างอยู่โดยไม่มี id ของไฟล์ = "ไม่ทราบผล" ระบบจะค้นหาไฟล์เดิมเท่านั้น ไม่สร้างใหม่เอง
//    แม้ lease หมดระหว่างรอ Google คำขอที่รับช่วงต่อก็เห็นค่านี้และไม่สร้างซ้ำ
// 3) การเขียนเนื้อหาใช้ requiredRevisionId และเขียนเฉพาะเมื่อไฟล์ยังว่าง คำขอที่ค้างมาช้าจึงเขียนซ้ำไม่ได้
// 4) การลงทะเบียนใน D1 ทำได้เฉพาะคำขอที่ยังถือ lease อยู่

const LEASE_MS = 120_000
const WAIT_FOR_RUNNER_MS = 4_000
const WAIT_STEP_MS = 200
/** ต้องผ่านเวลานี้หลังส่งคำสั่งสร้างที่ไม่ทราบผล ผู้ใช้จึงยืนยันให้สร้างใหม่ได้ (ให้เวลา Drive แสดงไฟล์เดิมในผลค้นหา) */
const CONFIRM_CREATE_AFTER_MS = 120_000

type FileState = 'none' | 'unknown' | 'created'

interface OperationRow {
  id: string
  user_id: string
  payload_hash: string
  title: string
  content: string | null
  status: 'pending' | 'file_created' | 'completed' | 'failed'
  google_document_id: string | null
  document_id: string | null
  last_error: string | null
  created_at: string
  lease_owner: string | null
  lease_expires_at: string | null
  create_attempted_at: string | null
  dismissed_at: string | null
  user_name?: string | null
}

const getOperation = (env: AppEnv, id: string) =>
  env.DB.prepare('SELECT * FROM document_operations WHERE id = ?').bind(id).first<OperationRow>()

const fileStateOf = (op: OperationRow): FileState => (op.google_document_id ? 'created' : op.create_attempted_at ? 'unknown' : 'none')
const leaseActive = (op: OperationRow) => op.lease_owner !== null && op.lease_expires_at !== null && op.lease_expires_at > nowIso()
const leaseUntil = () => new Date(Date.now() + LEASE_MS).toISOString()

const STAGE_TEXT: Record<FileState, string> = {
  none: 'ยังไม่ได้ส่งคำสั่งสร้างไฟล์ไป Google Docs กด “ลองอีกครั้ง” ได้',
  unknown:
    'ไม่ทราบว่า Google Docs สร้างไฟล์แล้วหรือยัง เพราะคำสั่งไปถึง Google แต่ไม่ได้รับคำตอบที่ยืนยันได้ ระบบจะไม่สร้างไฟล์ใหม่เองเพื่อไม่ให้เกิดไฟล์ซ้ำ กด “ลองอีกครั้ง” เพื่อให้ระบบค้นหาไฟล์เดิม',
  created: 'สร้างไฟล์ใน Google Docs แล้ว แต่ยังทำไม่ครบทุกขั้น กด “ลองอีกครั้ง” เพื่อทำต่อจากไฟล์เดิม ระบบจะไม่สร้างไฟล์ซ้ำ',
}

const inProgress = (op: OperationRow) =>
  new HttpError(409, 'operation_in_progress', 'กำลังสร้างเอกสารนี้อยู่จากคำขอก่อนหน้า รอสักครู่แล้วกด “ลองอีกครั้ง” ระบบจะไม่สร้างไฟล์ซ้ำ', {
    operationId: op.id,
    fileState: fileStateOf(op),
  })
const dismissed = (op: OperationRow) =>
  new HttpError(409, 'operation_dismissed', 'งานสร้างเอกสารนี้ถูกนำออกจากรายการแล้ว กด “สร้างเอกสาร” อีกครั้งเพื่อเริ่มงานใหม่', {
    operationId: op.id,
    fileState: fileStateOf(op),
  })

/** claim งานแบบ atomic: สำเร็จได้ทีละคำขอเดียว ตราบที่ lease ของคำขอก่อนยังไม่หมด */
async function claim(env: AppEnv, opId: string, owner: string): Promise<boolean> {
  const result = await env.DB.prepare(
    `UPDATE document_operations SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'file_created') AND dismissed_at IS NULL
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(owner, leaseUntil(), nowIso(), opId, nowIso())
    .run()
  return result.meta.changes === 1
}

const release = (env: AppEnv, opId: string, owner: string) =>
  env.DB.prepare('UPDATE document_operations SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?')
    .bind(opId, owner)
    .run()
    .catch(() => undefined)

const documentResponse = async (env: AppEnv, documentId: string, extra: Record<string, unknown> = {}, status = 200) =>
  json({ document: toDocument((await getDocument(env, documentId))!), ...extra }, status)

/**
 * ทำงานสร้างเอกสาร (ทั้งจาก POST และจากการทำต่อ)
 * ถ้ามีคำขออื่นกำลังทำอยู่ จะรอผลช่วงสั้น ๆ แล้วคืนเอกสารเดิม หรือบอกว่ากำลังทำอยู่
 */
async function runOperation(env: AppEnv, session: Session, opId: string, options: { confirmCreate?: boolean } = {}): Promise<Response> {
  const owner = crypto.randomUUID()
  const deadline = Date.now() + WAIT_FOR_RUNNER_MS
  for (;;) {
    const op = await getOperation(env, opId)
    if (!op) throw new HttpError(404, 'not_found', 'ไม่พบงานนี้')
    if (op.status === 'completed' && op.document_id) return documentResponse(env, op.document_id, { replayed: true })
    if (op.dismissed_at) throw dismissed(op)
    if (op.status === 'failed') {
      throw new HttpError(409, 'operation_needs_review', 'งานนี้ต้องตรวจไฟล์ใน Google Docs เอง ระบบทำต่อให้ไม่ได้', {
        operationId: op.id,
        fileState: fileStateOf(op),
        googleUrl: op.google_document_id ? `https://docs.google.com/document/d/${op.google_document_id}/edit` : null,
      })
    }
    if (await claim(env, opId, owner)) break
    if (Date.now() >= deadline) throw inProgress(op)
    await new Promise((resolve) => setTimeout(resolve, WAIT_STEP_MS))
  }
  try {
    return await runSteps(env, session, opId, owner, options)
  } finally {
    await release(env, opId, owner)
  }
}

async function runSteps(env: AppEnv, session: Session, opId: string, owner: string, options: { confirmCreate?: boolean }): Promise<Response> {
  // อ่านสถานะหลัง claim เสมอ เพื่อไม่ทำงานจากข้อมูลที่อ่านไว้ก่อนได้สิทธิ์
  let op = (await getOperation(env, opId))!

  /** ต่ออายุ lease ก่อนทุกขั้นที่มีผลข้างเคียง ถ้าไม่ใช่เจ้าของแล้วให้หยุดทันทีโดยไม่ทำอะไรต่อ */
  const stillOwner = async () => {
    const result = await env.DB.prepare(
      'UPDATE document_operations SET lease_expires_at = ? WHERE id = ? AND lease_owner = ? AND dismissed_at IS NULL',
    )
      .bind(leaseUntil(), opId, owner)
      .run()
    if (result.meta.changes !== 1) throw inProgress((await getOperation(env, opId)) ?? op)
  }
  const fail = (error: HttpError, state: FileState, message?: string) =>
    new HttpError(error.status, error.code, message ?? `${error.message} (${STAGE_TEXT[state]})`, {
      ...error.extra,
      operationId: opId,
      fileState: state,
      fileCreated: state === 'created',
    })
  const noteError = (code: string, status?: OperationRow['status']) =>
    env.DB.prepare('UPDATE document_operations SET last_error = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ? AND lease_owner = ?')
      .bind(code, status ?? null, nowIso(), opId, owner)
      .run()
      .catch(() => undefined)

  let state = fileStateOf(op)
  try {
    if (op.content === null) throw new HttpError(409, 'operation_not_resumable', 'งานนี้ทำต่อไม่ได้แล้ว')
    const content = op.content
    let googleId = op.google_document_id

    // ----- ขั้นที่ 1: ให้มีไฟล์เพียงไฟล์เดียว -----
    if (!googleId && op.create_attempted_at) {
      // เคยส่งคำสั่งสร้างไปแล้วแต่ไม่ทราบผล: ค้นหาไฟล์เดิมจากป้ายบนไฟล์ ห้ามสร้างใหม่จากการที่ยังค้นไม่พบ
      const found = await findCreatedFiles(env, opId)
      await stillOwner()
      if (found.length > 1) {
        await noteError('multiple_files', 'failed')
        throw new HttpError(409, 'operation_needs_review', 'พบไฟล์ของงานนี้มากกว่าหนึ่งไฟล์ใน Google Drive ระบบจึงไม่ทำต่อ ให้ผู้ดูแลตรวจไฟล์ใน Google Drive ของชมรม')
      }
      if (found.length === 1) {
        googleId = found[0]
      } else {
        const waitedMs = Date.now() - Date.parse(op.create_attempted_at)
        const canConfirmCreate = waitedMs >= CONFIRM_CREATE_AFTER_MS
        if (!(options.confirmCreate && canConfirmCreate)) {
          await noteError('create_unknown')
          throw new HttpError(
            409,
            'operation_create_unknown',
            `ไม่ทราบว่า Google Docs สร้างไฟล์ของงานนี้แล้วหรือยัง ระบบค้นหาแล้วยังไม่พบไฟล์ แต่ไฟล์ที่เพิ่งสร้างอาจยังไม่ปรากฏในผลค้นหา จึงยังไม่สร้างใหม่เพื่อไม่ให้เกิดไฟล์ซ้ำ ${
              canConfirmCreate
                ? 'ถ้าตรวจ Google Drive ของชมรมแล้วว่าไม่มีไฟล์นี้ ยืนยันให้สร้างใหม่ได้จากรายการงานที่ยังไม่เสร็จในหน้าเอกสาร'
                : 'กด “ลองอีกครั้ง” ในอีกสักครู่เพื่อค้นหาอีกครั้ง'
            }`,
            { canConfirmCreate },
          )
        }
        // ผู้ใช้ยืนยันเองหลังตรวจ Drive แล้ว: ล้างเครื่องหมายเพื่อเริ่มคำสั่งสร้างรอบใหม่
        const cleared = await env.DB.prepare(
          'UPDATE document_operations SET create_attempted_at = NULL WHERE id = ? AND lease_owner = ? AND google_document_id IS NULL',
        )
          .bind(opId, owner)
          .run()
        if (cleared.meta.changes !== 1) throw inProgress(op)
        await audit(env, session.user.id, 'document.create_reconfirmed', opId)
        op = { ...op, create_attempted_at: null }
        state = 'none'
      }
    }

    if (!googleId) {
      // ให้แน่ใจว่ามี token ใช้งานได้ก่อนทำเครื่องหมาย ข้อผิดพลาดตรงนี้แปลว่ายังไม่ได้ส่งคำสั่งสร้างแน่นอน
      await getAccessToken(env)
      const marked = await env.DB.prepare(
        `UPDATE document_operations SET create_attempted_at = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = ? AND lease_owner = ? AND create_attempted_at IS NULL AND google_document_id IS NULL AND dismissed_at IS NULL`,
      )
        .bind(nowIso(), leaseUntil(), nowIso(), opId, owner)
        .run()
      if (marked.meta.changes !== 1) throw inProgress(op)
      state = 'unknown'

      const created = await createFile(env, op.title, opId)
      if (created.kind === 'not_created') {
        // Google ตอบชัดว่าไม่ได้สร้าง: ล้างเครื่องหมายได้ (เฉพาะเมื่อยังเป็นเจ้าของงาน)
        const cleared = await env.DB.prepare('UPDATE document_operations SET create_attempted_at = NULL WHERE id = ? AND lease_owner = ? AND google_document_id IS NULL')
          .bind(opId, owner)
          .run()
        if (cleared.meta.changes === 1) state = 'none'
        throw googleFailed(created.status)
      }
      if (created.kind === 'unknown') throw new HttpError(502, 'google_unavailable', 'ติดต่อ Google ไม่สำเร็จ')
      googleId = created.id
    }

    if (!op.google_document_id) {
      // บันทึก id ทันทีที่รู้ ไม่ขึ้นกับ lease เพราะไฟล์มีอยู่จริงแล้วและคำสั่งสร้างเกิดได้ครั้งเดียวต่อเครื่องหมาย
      await env.DB.prepare(
        `UPDATE document_operations SET google_document_id = ?, status = 'file_created', updated_at = ? WHERE id = ? AND google_document_id IS NULL`,
      )
        .bind(googleId, nowIso(), opId)
        .run()
    }
    state = 'created'

    // ----- ขั้นที่ 2: เขียนเนื้อหา (เฉพาะเมื่อไฟล์ยังว่าง และ Google ตรวจ revision ให้) -----
    await stillOwner()
    let parsed = await fetchDoc(env, googleId)
    const unexpected = () =>
      new HttpError(409, 'operation_needs_review', 'ไฟล์ที่สร้างไว้มีเนื้อหาไม่ตรงกับที่ส่ง ระบบจึงไม่เขียนทับ เปิดตรวจไฟล์ใน Google Docs', {
        googleUrl: `https://docs.google.com/document/d/${googleId}/edit`,
      })
    if (parsed.text !== content) {
      if (!parsed.supported || parsed.text !== '') {
        await noteError('unexpected_content', 'failed')
        throw unexpected()
      }
      await stillOwner()
      const plan = planEdit('', content, parsed.tabId)
      const result = await writeDoc(env, googleId, plan.requests, parsed.revisionId)
      if (result === 'rejected') throw new HttpError(502, 'google_write_rejected', 'Google ไม่รับการเขียนเนื้อหา ลองอีกครั้ง')
      parsed = await fetchDoc(env, googleId)
      if (parsed.text !== content) {
        await noteError('readback_mismatch', 'failed')
        throw unexpected()
      }
    }

    // ----- ขั้นที่ 3: ลงทะเบียน ทำได้เฉพาะคำขอที่ยังถือ lease และงานยังไม่เสร็จ -----
    const now = nowIso()
    const results = await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO documents (id, google_document_id, title, status, status_detail, created_by, updated_by, created_at, updated_at, last_checked_at)
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM document_operations WHERE id = ? AND lease_owner = ? AND status != 'completed' AND dismissed_at IS NULL)
         ON CONFLICT (google_document_id) DO NOTHING`,
      ).bind(crypto.randomUUID(), googleId, op.title, parsed.supported ? 'ok' : 'read_only', parsed.reasons.join(' · '), op.user_id, session.user.id, now, now, now, opId, owner),
      // ล้างเนื้อหาชั่วคราวเมื่องานเสร็จ เนื้อหาจริงอยู่ใน Google Docs
      env.DB.prepare(
        `UPDATE document_operations
            SET status = 'completed', content = NULL, last_error = NULL, updated_at = ?, lease_owner = NULL, lease_expires_at = NULL,
                document_id = (SELECT id FROM documents WHERE google_document_id = ?)
          WHERE id = ? AND lease_owner = ? AND status != 'completed' AND dismissed_at IS NULL`,
      ).bind(now, googleId, opId, owner),
    ])
    const done = (await getOperation(env, opId))!
    if (results[1].meta.changes !== 1 || !done.document_id) {
      // เสียสิทธิ์ไประหว่างทาง: ไม่ได้ลงทะเบียนอะไร คืนผลของคำขอที่รับช่วงต่อถ้าเสร็จแล้ว
      if (done.status === 'completed' && done.document_id) return documentResponse(env, done.document_id, { replayed: true })
      throw inProgress(done)
    }
    await invalidateLists(env)
    return documentResponse(env, done.document_id, { content: toContent(parsed) }, 201)
  } catch (error) {
    const known = error instanceof HttpError ? error : new HttpError(500, 'internal_error', 'ระบบขัดข้อง')
    const selfExplained = ['operation_needs_review', 'operation_not_resumable', 'operation_create_unknown', 'operation_in_progress']
    if (!selfExplained.includes(known.code)) await noteError(known.code)
    throw fail(known, state, selfExplained.includes(known.code) ? known.message : undefined)
  }
}

async function create(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx)
  const key = idempotencyKey(ctx.request)
  const input = parseInput(await readJson(ctx.request, MAX_BODY))
  const payloadHash = await hashPayload(input)
  const now = nowIso()

  await ctx.env.DB.prepare(
    `INSERT INTO document_operations (id, user_id, idem_key, payload_hash, title, content, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (user_id, idem_key) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), session.user.id, key, payloadHash, input.title, input.text, now, now)
    .run()
  const op = await ctx.env.DB.prepare('SELECT * FROM document_operations WHERE user_id = ? AND idem_key = ?')
    .bind(session.user.id, key)
    .first<OperationRow>()
  if (!op) throw new HttpError(500, 'internal_error', 'ระบบขัดข้อง ลองอีกครั้ง')
  if (op.payload_hash !== payloadHash) {
    throw new HttpError(422, 'idempotency_mismatch', 'คำขอนี้ซ้ำกับรายการก่อนหน้าแต่ข้อมูลไม่ตรงกัน โหลดหน้าใหม่แล้วลองอีกครั้ง')
  }
  return runOperation(ctx.env, session, op.id)
}

// ---------- งานสร้างที่ค้าง ----------

const toOperation = (op: OperationRow) => ({
  id: op.id,
  title: op.title,
  status: op.status,
  fileState: fileStateOf(op),
  fileCreated: op.google_document_id !== null,
  inProgress: leaseActive(op),
  canConfirmCreate:
    fileStateOf(op) === 'unknown' && Date.now() - Date.parse(op.create_attempted_at!) >= CONFIRM_CREATE_AFTER_MS,
  googleUrl: op.google_document_id ? `https://docs.google.com/document/d/${op.google_document_id}/edit` : null,
  lastError: op.last_error,
  createdAt: op.created_at,
  userName: op.user_name ?? '',
})

async function listOperations(ctx: Ctx): Promise<Response> {
  const session = requireUser(ctx)
  const admin = session.user.role === 'admin'
  const { results } = await ctx.env.DB.prepare(
    `SELECT o.*, COALESCE(NULLIF(u.name, ''), u.email) AS user_name
       FROM document_operations o LEFT JOIN users u ON u.id = o.user_id
      WHERE o.status != 'completed' AND o.dismissed_at IS NULL AND (? = 1 OR o.user_id = ?)
      ORDER BY o.created_at DESC`,
  )
    .bind(admin ? 1 : 0, session.user.id)
    .all<OperationRow>()
  return json({ operations: results.map(toOperation) })
}

async function ownOperation(ctx: Ctx, session: Session, id: string): Promise<OperationRow> {
  const op = await getOperation(ctx.env, id)
  if (!op || (op.user_id !== session.user.id && session.user.role !== 'admin')) {
    throw new HttpError(404, 'not_found', 'ไม่พบงานนี้')
  }
  return op
}

/** ทำงานที่ค้างต่อ ใช้การควบคุมชุดเดียวกับการสร้าง */
async function resumeOperation(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const op = await ownOperation(ctx, session, id)
  let confirmCreate = false
  if ((ctx.request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) {
    confirmCreate = (await readJson(ctx.request)).confirmCreate === true
  }
  return runOperation(ctx.env, session, op.id, { confirmCreate })
}

/**
 * นำงานค้างออกจากรายการ โดยเก็บแถวไว้เป็นหลักฐาน (id ของไฟล์ หรือเครื่องหมายว่าเคยส่งคำสั่งสร้าง)
 * ทำไม่ได้ขณะมีคำขอกำลังทำงานนี้อยู่ และไม่ลบไฟล์ใน Google
 */
async function dismissOperation(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const op = await ownOperation(ctx, session, id)
  const now = nowIso()
  const result = await ctx.env.DB.prepare(
    `UPDATE document_operations SET dismissed_at = ?, dismissed_by = ?, content = NULL, updated_at = ?
      WHERE id = ? AND status != 'completed' AND dismissed_at IS NULL
        AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(now, session.user.id, now, id, now)
    .run()
  if (result.meta.changes !== 1) {
    const latest = (await getOperation(ctx.env, id)) ?? op
    if (latest.status === 'completed') throw new HttpError(409, 'operation_completed', 'งานนี้เสร็จแล้ว เอกสารอยู่ในรายการเอกสาร')
    if (latest.dismissed_at) return json({ ok: true, fileState: fileStateOf(latest), fileRemainsInGoogle: latest.google_document_id !== null })
    throw new HttpError(409, 'operation_in_progress', 'งานนี้กำลังทำอยู่ จึงยังนำออกจากรายการไม่ได้ รอให้เสร็จหรือลองอีกครั้งในอีกสักครู่', {
      operationId: id,
      fileState: fileStateOf(latest),
    })
  }
  await audit(ctx.env, session.user.id, 'document.operation_dismissed', id, fileStateOf(op))
  return json({ ok: true, fileState: fileStateOf(op), fileRemainsInGoogle: op.google_document_id !== null })
}

export async function handleDocuments(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 0) {
    if (method === 'GET') return list(ctx)
    if (method === 'POST') return create(ctx)
    return null
  }
  if (parts.length === 1 && parts[0] === 'link' && method === 'POST') return linkExisting(ctx)
  if (parts.length === 2 && parts[1] === 'revision' && method === 'GET') return revision(ctx, parts[0])
  if (parts.length === 2 && parts[1] === 'file' && method === 'GET') return fileOf(ctx, parts[0])
  if (parts[0] === 'operations') {
    if (parts.length === 1 && method === 'GET') return listOperations(ctx)
    if (parts.length === 3 && parts[2] === 'resume' && method === 'POST') return resumeOperation(ctx, parts[1])
    if (parts.length === 2 && method === 'DELETE') return dismissOperation(ctx, parts[1])
    return null
  }
  if (parts.length === 1) {
    if (method === 'GET') return read(ctx, parts[0])
    if (method === 'PUT') return update(ctx, parts[0])
  }
  return null
}
