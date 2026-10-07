import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { sha256Hex } from './crypto'
import { createMemberWithId } from './members'
import { audit, requireMutation, requireUser } from './session'
import {
  batchAll, bumpDataVersion, GoogleApiError, isUnknownOutcome, jsonInit, loadResource, makeGapi, outcomeUnknown, patchResource, registerSyncer,
  requireWritable, SyncDataError, toHttpError, withLock,
} from './sync'
import type { Gapi, SyncResource } from './sync'
import { invalid, text } from './validation'

/**
 * Google Forms: โครงสร้างฟอร์ม ↔ เว็บ และคำตอบ → เว็บ
 * - แยกสามส่วน: โครงสร้างฟอร์ม (form_items) คำตอบต้นฉบับ (form_responses) และสมาชิกที่นำมาเพิ่ม (members)
 * - จับคู่ด้วย formId, itemId/questionId และ responseId ไม่ใช้ข้อความของคำถาม
 * - คำตอบต้นฉบับอ่านอย่างเดียว: Forms API มีเฉพาะ get/list ของคำตอบ เว็บจึงไม่มีการแก้หรือส่งคำตอบแทนผู้ตอบ
 * - เว็บแก้ได้เฉพาะหัวเรื่อง คำอธิบาย และคำถามชนิดพื้นฐาน ด้วย forms.batchUpdate + requiredRevisionId
 *   ส่วนที่ซับซ้อน (ตาราง อัปโหลดไฟล์ branching quiz ฯลฯ) แสดงสรุปอย่างเดียวและให้เปิด Google Forms
 */
export const FORMS_API = 'https://forms.googleapis.com/v1/forms'
export const FORM_MIME = 'application/vnd.google-apps.form'
const PAGE_SIZE = 200
const MAX_PAGES = 3
const FULL_RECHECK_MS = 6 * 60 * 60 * 1000
const MAX_RESPONSES_SHOWN = 300

export const formEditUrl = (formId: string) => `https://docs.google.com/forms/d/${formId}/edit`

type GForm = Record<string, any>
type GItem = Record<string, any>

export const EDITABLE_KINDS = ['short_text', 'paragraph', 'radio', 'checkbox', 'dropdown'] as const
type EditableKind = (typeof EDITABLE_KINDS)[number]
const CHOICE_TYPES: Record<string, EditableKind> = { RADIO: 'radio', CHECKBOX: 'checkbox', DROP_DOWN: 'dropdown' }
const CHOICE_OUT: Record<string, string> = { radio: 'RADIO', checkbox: 'CHECKBOX', dropdown: 'DROP_DOWN' }
const isChoice = (kind: string) => kind === 'radio' || kind === 'checkbox' || kind === 'dropdown'

interface ItemView {
  itemId: string
  kind: string
  title: string
  description: string
  required: boolean
  questions: { id: string; label: string }[]
  options: { value: string; isOther: boolean }[]
  editable: boolean
  editNote: string
}

/** อ่าน item ของ Forms API เป็นรูปที่เว็บแสดง และตัดสินว่าเว็บแก้ได้โดยไม่ทำให้ส่วนใดสูญหายหรือไม่ */
export function describeItem(item: GItem, isQuiz: boolean): ItemView {
  const base = { itemId: String(item.itemId ?? ''), title: typeof item.title === 'string' ? item.title : '', description: typeof item.description === 'string' ? item.description : '' }
  const readOnly = (kind: string, editNote: string, extra: Partial<ItemView> = {}): ItemView => ({ ...base, kind, required: false, questions: [], options: [], editable: false, editNote, ...extra })

  if (item.pageBreakItem) return readOnly('section', 'ตัวแบ่งส่วนของฟอร์ม แก้ใน Google Forms')
  if (item.textItem) return readOnly('text', 'ข้อความประกอบ แก้ใน Google Forms')
  if (item.imageItem) return readOnly('image', 'รูปภาพ แก้ใน Google Forms')
  if (item.videoItem) return readOnly('video', 'วิดีโอ แก้ใน Google Forms')
  if (item.questionGroupItem) {
    const group = item.questionGroupItem
    const questions = ((group.questions ?? []) as GItem[]).map((q) => ({ id: String(q.questionId ?? ''), label: q.rowQuestion?.title ?? '' }))
    const options = ((group.grid?.columns?.options ?? []) as GItem[]).map((o) => ({ value: String(o.value ?? ''), isOther: false }))
    return readOnly('grid', 'คำถามแบบตาราง แก้ใน Google Forms', { questions, options, required: (group.questions ?? []).some((q: GItem) => q.required === true) })
  }
  const question = item.questionItem?.question as GItem | undefined
  if (!question) return readOnly('unknown', 'ชนิดที่ระบบยังไม่รู้จัก แก้ใน Google Forms')

  const questions = [{ id: String(question.questionId ?? ''), label: '' }]
  const required = question.required === true
  let kind = 'unknown'
  let options: ItemView['options'] = []
  let note = ''
  if (question.textQuestion) kind = question.textQuestion.paragraph ? 'paragraph' : 'short_text'
  else if (question.choiceQuestion) {
    kind = CHOICE_TYPES[question.choiceQuestion.type] ?? 'unknown'
    const raw = (question.choiceQuestion.options ?? []) as GItem[]
    options = raw.map((o) => ({ value: typeof o.value === 'string' ? o.value : '', isOther: o.isOther === true }))
    if (raw.some((o) => o.goToAction || o.goToSectionId)) note = 'ตัวเลือกพาไปส่วนอื่นตามคำตอบ (branching)'
    else if (raw.some((o) => o.image)) note = 'ตัวเลือกมีรูปภาพ'
    else if (question.choiceQuestion.shuffle) note = 'ตั้งค่าสลับลำดับตัวเลือก'
  } else if (question.scaleQuestion) kind = 'scale'
  else if (question.dateQuestion) kind = 'date'
  else if (question.timeQuestion) kind = 'time'
  else if (question.ratingQuestion) kind = 'rating'
  else if (question.fileUploadQuestion) kind = 'file_upload'

  if (!note && isQuiz) note = 'ฟอร์มนี้เป็นแบบทดสอบ (quiz) มีคะแนนและเฉลย'
  if (!note && question.grading) note = 'คำถามมีคะแนนหรือเฉลย'
  if (!note && item.questionItem.image) note = 'คำถามมีรูปภาพประกอบ'
  if (!note && !(EDITABLE_KINDS as readonly string[]).includes(kind)) note = 'ชนิดคำถามนี้แก้ใน Google Forms'
  return { ...base, kind, required, questions, options, editable: note === '', editNote: note ? `${note} จึงแก้ใน Google Forms เพื่อไม่ให้ส่วนนี้สูญหาย` : '' }
}

interface FormConfig {
  title: string
  description: string
  revisionId: string
  responderUri: string
  isQuiz: boolean
  /** null = Google ไม่ได้บอกสถานะเผยแพร่ (ฟอร์มรุ่นเก่า) */
  published: boolean | null
  acceptingResponses: boolean | null
  /** question ID ของฟอร์ม → ฟิลด์ของสมาชิก ใช้ตอนตรวจก่อนนำคำตอบไปเพิ่มเป็นสมาชิก */
  mapping: Partial<Record<'name' | 'nickname' | 'contact' | 'note', string>>
  responsesFullAt?: string
}

const configOf = (resource: SyncResource): FormConfig => ({
  title: '', description: '', revisionId: '', responderUri: '', isQuiz: false, published: null, acceptingResponses: null, mapping: {},
  ...(resource.config as Partial<FormConfig>),
})

export async function fetchForm(gapi: Gapi, formId: string): Promise<GForm> {
  const form = await gapi.json<GForm>(`${FORMS_API}/${encodeURIComponent(formId)}`)
  if (typeof form.revisionId !== 'string' || typeof form.info !== 'object' || form.info === null) throw new SyncDataError('Google Forms ตอบโครงสร้างฟอร์มในรูปแบบที่ระบบอ่านไม่ได้')
  return form
}

/** ปรับสำเนาโครงสร้างฟอร์มให้ตรงกับ Google คำถามที่หายไปเก็บไว้พร้อมเวลาที่หาย เพื่อให้คำตอบเก่ายังอ่านได้ */
export async function applyForm(env: AppEnv, resource: SyncResource, form: GForm): Promise<boolean> {
  const formId = resource.resourceId
  const config = configOf(resource)
  const isQuiz = form.settings?.quizSettings?.isQuiz === true
  const items = ((form.items ?? []) as GItem[]).map((item) => describeItem(item, isQuiz)).filter((item) => item.itemId)
  const publish = form.publishSettings?.publishState
  const next: FormConfig = {
    ...config,
    title: form.info.title ?? '',
    description: form.info.description ?? '',
    revisionId: form.revisionId,
    responderUri: form.responderUri ?? '',
    isQuiz,
    published: publish ? publish.isPublished === true : null,
    acceptingResponses: publish ? publish.isAcceptingResponses === true : null,
  }
  const now = nowIso()
  const statements = items.map((item, position) =>
    env.DB.prepare(
      `INSERT INTO form_items (form_id, item_id, position, kind, title, description, required, questions_json, options_json, editable, edit_note, removed_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)
       ON CONFLICT (form_id, item_id) DO UPDATE SET position = excluded.position, kind = excluded.kind, title = excluded.title, description = excluded.description,
         required = excluded.required, questions_json = excluded.questions_json, options_json = excluded.options_json, editable = excluded.editable,
         edit_note = excluded.edit_note, removed_at = NULL, updated_at = excluded.updated_at`,
    ).bind(formId, item.itemId, position, item.kind, item.title, item.description, item.required ? 1 : 0, JSON.stringify(item.questions), JSON.stringify(item.options), item.editable ? 1 : 0, item.editNote, now),
  )
  const keep = new Set(items.map((item) => item.itemId))
  const { results: known } = await env.DB.prepare('SELECT item_id FROM form_items WHERE form_id = ? AND removed_at IS NULL').bind(formId).all<{ item_id: string }>()
  for (const row of known) {
    if (!keep.has(row.item_id)) statements.push(env.DB.prepare('UPDATE form_items SET removed_at = ? WHERE form_id = ? AND item_id = ?').bind(now, formId, row.item_id))
  }
  await batchAll(env, statements)
  const changed = config.revisionId !== next.revisionId || config.published !== next.published || config.acceptingResponses !== next.acceptingResponses
  await patchResource(env, 'forms', { name: form.info.documentTitle || next.title || resource.name, config: next as unknown as Record<string, unknown> })
  return changed
}

interface StoredAnswer {
  values: string[]
  files: string[]
}

function normalizeAnswers(raw: unknown): Record<string, StoredAnswer> {
  const out: Record<string, StoredAnswer> = {}
  if (!raw || typeof raw !== 'object') return out
  for (const [questionId, answer] of Object.entries(raw as Record<string, GItem>)) {
    const values = ((answer?.textAnswers?.answers ?? []) as GItem[]).map((a) => (typeof a.value === 'string' ? a.value : '')).filter((v) => v !== '')
    const files = ((answer?.fileUploadAnswers?.answers ?? []) as GItem[]).map((a) => (typeof a.fileName === 'string' ? a.fileName : 'ไฟล์แนบ'))
    out[questionId] = { values, files }
  }
  return out
}

interface ResponseCursor {
  since?: string
  pageToken?: string
  /** รอบตรวจทั้งชุดที่ยังไม่จบ */
  fullRun?: string
  fullAt?: string
}

/** ดึงคำตอบแบบแบ่งหน้า: ปกติดึงเฉพาะที่ส่งหรือแก้หลังครั้งก่อน และตรวจทั้งชุดเป็นระยะเพื่อรู้ว่าคำตอบใดถูกลบที่ Google */
async function syncResponses(env: AppEnv, gapi: Gapi, formId: string, cursor: ResponseCursor): Promise<{ changed: boolean; cursor: ResponseCursor }> {
  let changed = false
  const now = Date.now()
  const next: ResponseCursor = { ...cursor }
  if (!next.fullRun && !next.pageToken && (!next.fullAt || now - Date.parse(next.fullAt) > FULL_RECHECK_MS)) next.fullRun = crypto.randomUUID()
  let newest = next.since ?? ''

  for (let page = 0; page < MAX_PAGES && gapi.remaining() > 0; page++) {
    const params = new URLSearchParams({ pageSize: String(PAGE_SIZE) })
    if (next.pageToken) params.set('pageToken', next.pageToken)
    if (!next.fullRun && next.since) params.set('filter', `timestamp >= ${next.since}`)
    const data = await gapi.json<GForm>(`${FORMS_API}/${encodeURIComponent(formId)}/responses?${params}`)
    const stamp = nowIso()
    const statements: D1PreparedStatement[] = []
    for (const r of (data.responses ?? []) as GItem[]) {
      if (typeof r.responseId !== 'string') continue
      const submitted = typeof r.lastSubmittedTime === 'string' ? r.lastSubmittedTime : (r.createTime ?? stamp)
      if (submitted > newest) newest = submitted
      statements.push(
        env.DB.prepare(
          `INSERT INTO form_responses (form_id, response_id, create_time, last_submitted_time, respondent_email, answers_json, seen_run, first_seen_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (form_id, response_id) DO UPDATE SET
             answers_json = excluded.answers_json, respondent_email = excluded.respondent_email, seen_run = COALESCE(excluded.seen_run, form_responses.seen_run),
             source_state = 'ok',
             updated_at = CASE WHEN form_responses.last_submitted_time != excluded.last_submitted_time THEN excluded.updated_at ELSE form_responses.updated_at END,
             last_submitted_time = excluded.last_submitted_time`,
        ).bind(formId, r.responseId, r.createTime ?? submitted, submitted, typeof r.respondentEmail === 'string' ? r.respondentEmail : '', JSON.stringify(normalizeAnswers(r.answers)), next.fullRun ?? null, stamp, stamp),
      )
    }
    if (statements.length > 0) {
      const before = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM form_responses WHERE form_id = ?').bind(formId).first<{ n: number; latest: string | null }>()
      await batchAll(env, statements)
      const after = await env.DB.prepare('SELECT COUNT(*) AS n, MAX(updated_at) AS latest FROM form_responses WHERE form_id = ?').bind(formId).first<{ n: number; latest: string | null }>()
      if (before?.n !== after?.n || before?.latest !== after?.latest) changed = true
    }
    if (data.nextPageToken) {
      next.pageToken = data.nextPageToken
      continue
    }
    next.pageToken = undefined
    if (next.fullRun) {
      // จบรอบตรวจทั้งชุด: คำตอบที่ Google ไม่ส่งมาแล้วถูกลบที่ต้นทาง เก็บสำเนาไว้เป็นหลักฐานพร้อมเครื่องหมาย
      const swept = await env.DB.prepare(`UPDATE form_responses SET source_state = 'missing', updated_at = ? WHERE form_id = ? AND source_state = 'ok' AND (seen_run IS NULL OR seen_run != ?)`)
        .bind(nowIso(), formId, next.fullRun)
        .run()
      if (swept.meta.changes > 0) changed = true
      next.fullRun = undefined
      next.fullAt = new Date(now).toISOString()
    }
    if (newest) next.since = newest
    break
  }
  return { changed, cursor: next }
}

registerSyncer('forms', async ({ env, gapi, resource, cursor: rawCursor }) => {
  const form = await fetchForm(gapi, resource!.resourceId)
  let changed = await applyForm(env, resource!, form)
  let cursor: ResponseCursor = {}
  try {
    cursor = rawCursor ? (JSON.parse(rawCursor) as ResponseCursor) : {}
  } catch {
    cursor = {}
  }
  const responses = await syncResponses(env, gapi, resource!.resourceId, cursor)
  changed ||= responses.changed
  return { changed, cursor: JSON.stringify(responses.cursor), remoteVersion: form.revisionId }
})

// ---------- อ่านสำหรับหน้าเว็บ ----------

interface ItemRow {
  item_id: string
  position: number
  kind: string
  title: string
  description: string
  required: number
  questions_json: string
  options_json: string
  editable: number
  edit_note: string
  removed_at: string | null
}

interface ResponseRow {
  response_id: string
  create_time: string
  last_submitted_time: string
  respondent_email: string
  answers_json: string
  source_state: string
  review_status: string
  member_id: string | null
}

const parse = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

async function view(env: AppEnv, admin: boolean) {
  const resource = await loadResource(env, 'forms')
  if (!resource) return { form: null, items: [], responses: [], responseCount: 0 }
  const config = configOf(resource)
  const formId = resource.resourceId
  const [{ results: items }, { results: responses }, count, { results: members }] = await Promise.all([
    env.DB.prepare('SELECT * FROM form_items WHERE form_id = ? ORDER BY removed_at IS NOT NULL, position').bind(formId).all<ItemRow>(),
    env.DB.prepare('SELECT * FROM form_responses WHERE form_id = ? ORDER BY last_submitted_time DESC LIMIT ?').bind(formId, MAX_RESPONSES_SHOWN).all<ResponseRow>(),
    env.DB.prepare('SELECT COUNT(*) AS n FROM form_responses WHERE form_id = ?').bind(formId).first<{ n: number }>(),
    env.DB.prepare(`SELECT id, name, nickname, contact FROM members WHERE source_state = 'ok'`).all<{ id: string; name: string; nickname: string; contact: string }>(),
  ])
  const key = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')
  const first = (answers: Record<string, StoredAnswer>, questionId?: string) => (questionId ? (answers[questionId]?.values.join(', ') ?? '') : '')

  return {
    form: {
      id: formId,
      name: resource.name,
      title: config.title,
      description: config.description,
      revisionId: config.revisionId,
      editUrl: resource.url,
      responderUrl: config.responderUri,
      isQuiz: config.isQuiz,
      published: config.published,
      acceptingResponses: config.acceptingResponses,
      writable: resource.access === 'write',
      mapping: config.mapping,
      canConfigure: admin,
    },
    items: items.map((row) => ({
      itemId: row.item_id,
      kind: row.kind,
      title: row.title,
      description: row.description,
      required: row.required === 1,
      questions: parse<{ id: string; label: string }[]>(row.questions_json, []),
      options: parse<{ value: string; isOther: boolean }[]>(row.options_json, []),
      editable: row.editable === 1 && row.removed_at === null && resource.access === 'write',
      editNote: row.edit_note,
      removedAt: row.removed_at,
    })),
    responses: responses.map((row) => {
      const answers = parse<Record<string, StoredAnswer>>(row.answers_json, {})
      // ค่าที่จะเสนอให้ตรวจก่อนเพิ่มเป็นสมาชิก มาจากการจับคู่คำถามของผู้ดูแล ไม่แก้คำตอบต้นฉบับ
      const candidate = {
        name: first(answers, config.mapping.name),
        nickname: first(answers, config.mapping.nickname),
        contact: first(answers, config.mapping.contact),
        note: first(answers, config.mapping.note),
      }
      const duplicates =
        row.review_status === 'new' && candidate.name
          ? members.filter((m) => key(m.name) === key(candidate.name) || (candidate.contact !== '' && key(m.contact) === key(candidate.contact))).map((m) => ({ id: m.id, name: m.name, nickname: m.nickname }))
          : []
      return {
        responseId: row.response_id,
        createTime: row.create_time,
        lastSubmittedTime: row.last_submitted_time,
        respondentEmail: row.respondent_email,
        answers,
        sourceState: row.source_state,
        reviewStatus: row.review_status,
        memberId: row.member_id,
        candidate,
        duplicates,
      }
    }),
    responseCount: count?.n ?? 0,
  }
}

// ---------- เว็บ → Google Forms ----------

const conflict = () =>
  new HttpError(409, 'revision_conflict', 'ฟอร์มถูกแก้ไขใน Google Forms หลังจากที่คุณเปิด ยังไม่ได้บันทึกสิ่งที่คุณแก้ หน้านี้แสดงฉบับล่าสุดแล้ว ตรวจก่อนบันทึกอีกครั้ง')

/** เขียนโครงสร้างฟอร์มหนึ่งคำสั่ง โดยให้ Google ตรวจ revision ล่าสุดที่ผู้ใช้เห็น แล้วปรับสำเนาจากฟอร์มที่ Google ส่งกลับ */
async function writeForm(env: AppEnv, expectedRevision: string, build: (form: GForm, resource: SyncResource) => GItem, verify: (form: GForm) => boolean): Promise<{ verified: boolean }> {
  const resource = await loadResource(env, 'forms')
  if (!resource) throw new HttpError(409, 'not_linked', 'ยังไม่ได้เชื่อม Google Forms')
  requireWritable(resource, 'ฟอร์ม')
  const gapi = makeGapi(env)
  try {
    const current = await fetchForm(gapi, resource.resourceId)
    if (current.revisionId !== expectedRevision) {
      if (await applyForm(env, resource, current)) await bumpDataVersion(env, 'forms')
      throw conflict()
    }
    const request = build(current, resource)
    let result: GForm
    try {
      result = await gapi.json(`${FORMS_API}/${encodeURIComponent(resource.resourceId)}:batchUpdate`, jsonInit('POST', {
        includeFormInResponse: true,
        requests: [request],
        writeControl: { requiredRevisionId: current.revisionId },
      }))
    } catch (error) {
      if (isUnknownOutcome(error)) throw outcomeUnknown('การแก้ฟอร์ม')
      if (error instanceof GoogleApiError && error.status === 400) {
        // Google ปฏิเสธทั้งคำสั่ง: ตรวจว่าเป็นเพราะฟอร์มถูกแก้ระหว่างนี้หรือไม่
        const latest = await fetchForm(gapi, resource.resourceId)
        if (latest.revisionId !== current.revisionId) {
          if (await applyForm(env, resource, latest)) await bumpDataVersion(env, 'forms')
          throw conflict()
        }
        throw new HttpError(502, 'google_write_rejected', 'Google Forms ไม่รับการแก้ไขนี้ ยังไม่มีการเปลี่ยนแปลงฟอร์ม ลองอีกครั้ง หรือแก้ใน Google Forms')
      }
      throw error
    }
    const after: GForm = result.form?.revisionId ? result.form : await fetchForm(gapi, resource.resourceId)
    await applyForm(env, (await loadResource(env, 'forms'))!, after)
    await bumpDataVersion(env, 'forms')
    return { verified: verify(after) }
  } catch (error) {
    throw toHttpError(error)
  }
}

const revisionOf = (body: Record<string, unknown>) => {
  if (typeof body.expectedRevision !== 'string' || !body.expectedRevision) throw invalid('ไม่ได้ระบุรุ่นของฟอร์มที่กำลังแก้ไข โหลดหน้าใหม่แล้วลองอีกครั้ง', 'expectedRevision')
  return body.expectedRevision
}

async function updateInfo(ctx: Ctx): Promise<Response> {
  await requireMutation(ctx)
  const body = await readJson(ctx.request)
  const title = text(body, 'title', 'หัวเรื่องฟอร์ม', 300, true)
  const description = text(body, 'description', 'คำอธิบายฟอร์ม', 4000)
  const result = await writeForm(
    ctx.env,
    revisionOf(body),
    () => ({ updateFormInfo: { info: { title, description }, updateMask: 'title,description' } }),
    (form) => (form.info?.title ?? '') === title && (form.info?.description ?? '') === description,
  )
  return json({ ...(await view(ctx.env, (ctx.session?.kind === 'staff' && ctx.session.user.role === 'admin'))), verified: result.verified })
}

function questionInput(body: Record<string, unknown>, kind: string) {
  const title = text(body, 'title', 'คำถาม', 500, true)
  const description = text(body, 'description', 'คำอธิบายคำถาม', 2000)
  if (typeof body.required !== 'boolean') throw invalid('ระบุว่าบังคับตอบหรือไม่', 'required')
  let options: string[] = []
  if (isChoice(kind)) {
    if (!Array.isArray(body.options) || body.options.some((o) => typeof o !== 'string')) throw invalid('ตัวเลือกไม่ถูกต้อง', 'options')
    options = (body.options as string[]).map((o) => o.trim())
    if (options.length === 0) throw invalid('ต้องมีตัวเลือกอย่างน้อยหนึ่งข้อ', 'options')
    if (options.length > 100) throw invalid('ตัวเลือกมีได้ไม่เกิน 100 ข้อ', 'options')
    if (options.some((o) => !o || o.length > 500)) throw invalid('ตัวเลือกต้องไม่ว่างและยาวไม่เกิน 500 ตัวอักษร', 'options')
    if (new Set(options).size !== options.length) throw invalid('ตัวเลือกต้องไม่ซ้ำกัน', 'options')
  }
  return { title, description, required: body.required, options }
}

const sameQuestion = (item: GItem | undefined, kind: string, input: ReturnType<typeof questionInput>, withOther: boolean) => {
  if (!item) return false
  const seen = describeItem(item, false)
  const expected = [...input.options.map((value) => ({ value, isOther: false })), ...(withOther ? [{ value: '', isOther: true }] : [])]
  return (
    seen.kind === kind && seen.title === input.title && seen.description === input.description && seen.required === input.required &&
    (!isChoice(kind) || JSON.stringify(seen.options) === JSON.stringify(expected))
  )
}

async function updateItem(ctx: Ctx, itemId: string): Promise<Response> {
  await requireMutation(ctx)
  const body = await readJson(ctx.request)
  let kind = ''
  let input!: ReturnType<typeof questionInput>
  let withOther = false
  const result = await writeForm(
    ctx.env,
    revisionOf(body),
    (form) => {
      const items = (form.items ?? []) as GItem[]
      const index = items.findIndex((item) => item.itemId === itemId)
      if (index < 0) throw new HttpError(404, 'not_found', 'ไม่พบคำถามนี้ในฟอร์มแล้ว อาจถูกลบใน Google Forms')
      // ตัดสินจากฟอร์มที่เพิ่งอ่านจาก Google ไม่ใช่จากสำเนา: ส่วนที่เว็บรักษาไม่ได้ต้องไม่ถูกเขียนทับ
      const seen = describeItem(items[index], form.settings?.quizSettings?.isQuiz === true)
      if (!seen.editable) throw new HttpError(409, 'item_not_editable', `แก้คำถามนี้จากเว็บไม่ได้: ${seen.editNote} ยังไม่ได้บันทึกอะไร`)
      kind = seen.kind
      input = questionInput(body, kind)
      withOther = seen.options.some((o) => o.isOther)
      const question: GItem = { questionId: seen.questions[0].id, required: input.required }
      let mask = 'title,description,questionItem.question.required'
      if (isChoice(kind)) {
        question.choiceQuestion = { type: CHOICE_OUT[kind], options: [...input.options.map((value) => ({ value })), ...(withOther ? [{ isOther: true }] : [])] }
        mask += ',questionItem.question.choiceQuestion.options'
      }
      return { updateItem: { item: { itemId, title: input.title, description: input.description, questionItem: { question } }, location: { index }, updateMask: mask } }
    },
    (form) => sameQuestion(((form.items ?? []) as GItem[]).find((item) => item.itemId === itemId), kind, input, withOther),
  )
  return json({ ...(await view(ctx.env, (ctx.session?.kind === 'staff' && ctx.session.user.role === 'admin'))), verified: result.verified })
}

async function createItem(ctx: Ctx): Promise<Response> {
  await requireMutation(ctx)
  const body = await readJson(ctx.request)
  const kind = typeof body.kind === 'string' && (EDITABLE_KINDS as readonly string[]).includes(body.kind) ? body.kind : null
  if (!kind) throw invalid('ชนิดคำถามไม่ถูกต้อง', 'kind')
  const input = questionInput(body, kind)
  let countBefore = 0
  const result = await writeForm(
    ctx.env,
    revisionOf(body),
    (form) => {
      countBefore = ((form.items ?? []) as GItem[]).length
      const question: GItem = { required: input.required }
      if (isChoice(kind)) question.choiceQuestion = { type: CHOICE_OUT[kind], options: input.options.map((value) => ({ value })) }
      else question.textQuestion = { paragraph: kind === 'paragraph' }
      // เพิ่มต่อท้ายเสมอ การจัดลำดับและการลบทำใน Google Forms
      return { createItem: { item: { title: input.title, description: input.description, questionItem: { question } }, location: { index: countBefore } } }
    },
    (form) => {
      const items = (form.items ?? []) as GItem[]
      return items.length === countBefore + 1 && sameQuestion(items[items.length - 1], kind, input, false)
    },
  )
  return json({ ...(await view(ctx.env, (ctx.session?.kind === 'staff' && ctx.session.user.role === 'admin'))), verified: result.verified }, 201)
}

// ---------- คำตอบ → สมาชิก ----------

const MAPPING_FIELDS = ['name', 'nickname', 'contact', 'note'] as const

/** ผู้ดูแลกำหนดว่าคำถามใดเป็นชื่อ ชื่อเล่น ช่องทางติดต่อ และหมายเหตุ (เก็บเป็น question ID) */
async function setMapping(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const resource = await loadResource(ctx.env, 'forms')
  if (!resource) throw new HttpError(409, 'not_linked', 'ยังไม่ได้เชื่อม Google Forms')
  const body = await readJson(ctx.request)
  const raw = body.mapping && typeof body.mapping === 'object' ? (body.mapping as Record<string, unknown>) : {}
  const { results } = await ctx.env.DB.prepare('SELECT questions_json FROM form_items WHERE form_id = ? AND removed_at IS NULL').bind(resource.resourceId).all<{ questions_json: string }>()
  const known = new Set(results.flatMap((row) => parse<{ id: string }[]>(row.questions_json, []).map((q) => q.id)))
  const mapping: FormConfig['mapping'] = {}
  for (const field of MAPPING_FIELDS) {
    const value = raw[field]
    if (value === undefined || value === null || value === '') continue
    if (typeof value !== 'string' || !known.has(value)) throw invalid('คำถามที่เลือกไม่มีอยู่ในฟอร์มแล้ว โหลดหน้าใหม่แล้วเลือกอีกครั้ง', field)
    mapping[field] = value
  }
  await patchResource(ctx.env, 'forms', { config: { ...configOf(resource), mapping } as unknown as Record<string, unknown> })
  await bumpDataVersion(ctx.env, 'forms')
  await audit(ctx.env, session.user.id, 'forms.mapping_updated', resource.resourceId)
  return json(await view(ctx.env, true))
}

const getResponse = (env: AppEnv, formId: string, responseId: string) =>
  env.DB.prepare('SELECT * FROM form_responses WHERE form_id = ? AND response_id = ?').bind(formId, responseId).first<ResponseRow>()

interface ImportRow {
  member_id: string
  payload_hash: string
  payload_json: string
  status: 'pending' | 'completed'
  claimed_by: string
}

const getImport = (env: AppEnv, formId: string, responseId: string) =>
  env.DB.prepare('SELECT * FROM form_imports WHERE form_id = ? AND response_id = ?').bind(formId, responseId).first<ImportRow>()

/**
 * เพิ่มสมาชิกจากคำตอบหลังทีมงานตรวจค่าแล้ว
 * - บทบาทเป็น "สมาชิก" เสมอ และไม่เกี่ยวกับสิทธิ์เข้าหลังบ้าน (ตาราง users ไม่ถูกแตะ)
 * - คำตอบต้นฉบับไม่ถูกแก้ ค่าที่ทีมงานปรับเป็นข้อมูลของทะเบียนสมาชิก
 * - หนึ่งคำตอบนำเข้าได้ครั้งเดียวไม่ว่าใครกด: คำขอแรกจอง (form_id, response_id) ใน form_imports พร้อมรหัสสมาชิกและค่าที่ยืนยัน
 *   คำขออื่นทั้งหมด (จากบัญชีใดก็ตาม พร้อมกันหรือภายหลัง) ใช้รหัสและค่าชุดนั้น จึงไม่มีทางได้สมาชิกคนที่สองหรือแถวที่สองในชีต
 *   ถ้างานของผู้จองค้างกลางทาง คำขอถัดไปทำต่อให้จบด้วยค่าเดิม
 */
async function importResponse(ctx: Ctx, responseId: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const env = ctx.env
  const resource = await loadResource(env, 'forms')
  if (!resource) throw new HttpError(409, 'not_linked', 'ยังไม่ได้เชื่อม Google Forms')
  const formId = resource.resourceId
  if (!(await getResponse(env, formId, responseId))) throw new HttpError(404, 'not_found', 'ไม่พบคำตอบนี้')
  const body = await readJson(ctx.request)
  const input = {
    name: text(body, 'name', 'ชื่อสมาชิก', 100, true),
    nickname: text(body, 'nickname', 'ชื่อเล่น', 40, true),
    role: 'member' as const,
    status: 'active' as const,
    contact: text(body, 'contact', 'ช่องทางติดต่อ', 200),
    note: text(body, 'note', 'หมายเหตุ', 2000),
  }
  const payloadJson = JSON.stringify(input)
  const payloadHash = await sha256Hex(payloadJson)

  // จองแบบ atomic: PRIMARY KEY (form_id, response_id) ให้มีผู้จองได้คนเดียวข้ามทุกผู้ใช้และทุก Worker instance
  await env.DB.prepare(
    `INSERT INTO form_imports (form_id, response_id, member_id, payload_hash, payload_json, status, claimed_by, claimed_at)
     VALUES (?, ?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (form_id, response_id) DO NOTHING`,
  )
    .bind(formId, responseId, crypto.randomUUID(), payloadHash, payloadJson, session.user.id, nowIso())
    .run()

  const already = (claim: ImportRow) =>
    new HttpError(409, 'already_imported', 'คำตอบนี้ถูกเพิ่มเป็นสมาชิกไปแล้ว ไม่ได้เพิ่มซ้ำ ถ้าต้องการปรับข้อมูลให้แก้ที่หน้าสมาชิก', { memberId: claim.member_id })

  // ทำทีละคำขอต่อหนึ่งคำตอบ: คำขอที่มาพร้อมกันรอผลของคำขอแรกก่อน แล้วเห็นว่าเสร็จแล้วหรือทำต่อจากรายการเดิม
  const outcome = await withLock(env, `form-import:${await sha256Hex(`${formId}:${responseId}`)}`, async () => {
    const claim = (await getImport(env, formId, responseId))!
    const mine = claim.payload_hash === payloadHash
    if (claim.status === 'completed') {
      // คำขอเดียวกันที่มาช้ากว่า (เช่น สองคนกดพร้อมกันด้วยค่าเดียวกัน) ได้ผลเดิม; ค่าต่างกัน = มีผู้นำเข้าไปก่อนแล้ว
      if (mine) return { memberId: claim.member_id, created: false }
      throw already(claim)
    }
    // ทำต่อด้วยค่าที่ผู้จองยืนยันไว้เสมอ ไม่ใช่ค่าของคำขอนี้ เพื่อให้ผลมีชุดเดียว
    const member = await createMemberWithId(env, session.user.id, claim.member_id, JSON.parse(claim.payload_json) as typeof input)
    const now = nowIso()
    await env.DB.batch([
      env.DB.prepare(`UPDATE form_responses SET review_status = 'imported', member_id = ?, reviewed_by = ?, reviewed_at = ? WHERE form_id = ? AND response_id = ?`).bind(member.id, claim.claimed_by, now, formId, responseId),
      env.DB.prepare('UPDATE members SET origin_response_id = ? WHERE id = ?').bind(responseId, member.id),
      env.DB.prepare(`UPDATE form_imports SET status = 'completed', completed_by = ?, completed_at = ? WHERE form_id = ? AND response_id = ?`).bind(session.user.id, now, formId, responseId),
    ])
    await audit(env, session.user.id, 'forms.response_imported', member.id, claim.claimed_by === session.user.id ? 'claimed' : 'completed_for_other')
    await bumpDataVersion(env, 'forms')
    if (!mine) throw already(claim)
    return { memberId: member.id, created: true }
  })
  return json({ ...(await view(env, session.user.role === 'admin')), memberId: outcome.memberId }, 201)
}

async function setReview(ctx: Ctx, responseId: string, status: 'dismissed' | 'new'): Promise<Response> {
  const session = await requireMutation(ctx)
  const resource = await loadResource(ctx.env, 'forms')
  if (!resource) throw new HttpError(409, 'not_linked', 'ยังไม่ได้เชื่อม Google Forms')
  const result = await ctx.env.DB.prepare(
    `UPDATE form_responses SET review_status = ?, reviewed_by = ?, reviewed_at = ? WHERE form_id = ? AND response_id = ? AND review_status != 'imported'`,
  )
    .bind(status, session.user.id, nowIso(), resource.resourceId, responseId)
    .run()
  if (result.meta.changes !== 1) throw new HttpError(409, 'already_imported', 'คำตอบนี้ถูกเพิ่มเป็นสมาชิกไปแล้ว หรือไม่มีอยู่ในระบบ')
  await bumpDataVersion(ctx.env, 'forms')
  return json(await view(ctx.env, session.user.role === 'admin'))
}

export async function handleForms(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 0 && method === 'GET') return json(await view(ctx.env, requireUser(ctx).user.role === 'admin'))
  if (parts.length === 1 && parts[0] === 'info' && method === 'PATCH') return updateInfo(ctx)
  if (parts.length === 1 && parts[0] === 'mapping' && method === 'PUT') return setMapping(ctx)
  if (parts[0] === 'items') {
    if (parts.length === 1 && method === 'POST') return createItem(ctx)
    if (parts.length === 2 && method === 'PATCH') return updateItem(ctx, parts[1])
  }
  if (parts[0] === 'responses' && parts.length === 3 && method === 'POST') {
    if (parts[2] === 'import') return importResponse(ctx, parts[1])
    if (parts[2] === 'dismiss') return setReview(ctx, parts[1], 'dismissed')
    if (parts[2] === 'restore') return setReview(ctx, parts[1], 'new')
  }
  return null
}

// ---------- ตั้งค่า ----------

const DEFAULT_QUESTIONS: { field: 'name' | 'nickname' | 'contact' | 'note'; title: string; required: boolean; paragraph: boolean }[] = [
  { field: 'name', title: 'ชื่อ-นามสกุล', required: true, paragraph: false },
  { field: 'nickname', title: 'ชื่อเล่น', required: true, paragraph: false },
  { field: 'contact', title: 'ช่องทางติดต่อ (เช่น ชื่อ Discord หรืออีเมล)', required: false, paragraph: false },
  { field: 'note', title: 'หมายเหตุ', required: false, paragraph: true },
]

/** ใส่คำถามตั้งต้นให้ฟอร์มที่เว็บสร้าง เฉพาะเมื่อฟอร์มยังไม่มีคำถาม (ทำซ้ำได้) แล้วคืนการจับคู่คำถามกับฟิลด์สมาชิก */
export async function initCreatedForm(gapi: Gapi, formId: string): Promise<FormConfig['mapping']> {
  let form = await fetchForm(gapi, formId)
  if (((form.items ?? []) as GItem[]).length === 0) {
    const result = await gapi.json<GForm>(`${FORMS_API}/${encodeURIComponent(formId)}:batchUpdate`, jsonInit('POST', {
      includeFormInResponse: true,
      writeControl: { requiredRevisionId: form.revisionId },
      requests: DEFAULT_QUESTIONS.map((q, index) => ({
        createItem: { item: { title: q.title, questionItem: { question: { required: q.required, textQuestion: { paragraph: q.paragraph } } } }, location: { index } },
      })),
    }))
    form = result.form?.revisionId ? result.form : await fetchForm(gapi, formId)
  }
  const mapping: FormConfig['mapping'] = {}
  const items = (form.items ?? []) as GItem[]
  for (const q of DEFAULT_QUESTIONS) {
    const item = items.find((i) => i.title === q.title)
    const questionId = item?.questionItem?.question?.questionId
    if (typeof questionId === 'string') mapping[q.field] = questionId
  }
  return mapping
}
