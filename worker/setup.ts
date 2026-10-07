import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { CAL_API, calendarUrl, canRead, canWrite, listCalendars, previewCalendar, previewLocalEvents, pushLocalEvents } from './gcal'
import { fetchForm, FORM_MIME, formEditUrl, FORMS_API, initCreatedForm, describeItem } from './gforms'
import { CAL_APP_CREATED_SCOPE, CAL_EVENTS_SCOPE, CAL_LIST_SCOPE, DRIVE_FILE_SCOPE, DRIVE_READONLY_SCOPE, getAccessToken, grantedScopes } from './google'
import { HttpError, json, readJson } from './http'
import { audit, requireMutation, requireUser } from './session'
import {
  addHeaderColumn, addIdColumn, DEFAULT_HEADERS, initCreatedSheet, listTabs, MEMBER_FIELDS, parseTable, previewLocalMembers, previewSheet, pushLocalMembers, readGrid, SHEET_MIME, sheetUrl,
  suggestColumns,
} from './sheets'
import type { MemberField, SheetConfig } from './sheets'
import {
  GoogleApiError, jsonInit, loadResource, makeGapi, patchResource, RESOURCE_KINDS, runSync, saveResource, SYNC_KINDS, SyncDataError, syncStatus, syncStatuses, toHttpError,
} from './sync'
import type { Gapi, ResourceKind, SyncKind } from './sync'
import { idempotencyKey, invalid, text } from './validation'

/**
 * ตั้งค่าพื้นที่ข้อมูลชมรม (เฉพาะผู้ดูแล) และเส้นทางสั่งซิงค์
 * - สร้างทรัพยากรใหม่ในบัญชีชมรมเกิดเฉพาะเมื่อผู้ดูแลกดยืนยันใน flow นี้ ไม่สร้างตอนเปิดหน้า เข้าสู่ระบบ หรือเชื่อมบัญชี
 * - แหล่งเดิมต้องเป็นสิ่งที่ผู้ดูแลเลือกเอง (ไฟล์ผ่าน Google Picker, ปฏิทินจากรายชื่อของ Calendar API) และ server ตรวจสิทธิ์กับ Google ทุกครั้งก่อนผูก
 * - ยกเลิกการเชื่อมไม่ลบต้นฉบับใน Google และไม่ลบสำเนาในเว็บ
 */
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'
const OPERATION_PROPERTY = 'muOperation'
const LEASE_MS = 120_000
const CONFIRM_CREATE_AFTER_MS = 120_000

const KIND_LABEL: Record<ResourceKind, string> = { sheets: 'ชีต', calendar: 'ปฏิทิน', forms: 'ฟอร์ม' }
const isResourceKind = (value: unknown): value is ResourceKind => typeof value === 'string' && (RESOURCE_KINDS as string[]).includes(value)
const isSyncKind = (value: unknown): value is SyncKind => typeof value === 'string' && (SYNC_KINDS as string[]).includes(value)

// ---------- สั่งซิงค์และดูสถานะ ----------

export async function handleSync(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 0 && method === 'GET') {
    requireUser(ctx)
    return json({ sync: await syncStatuses(ctx.env) })
  }
  if (parts.length === 1 && method === 'POST' && isSyncKind(parts[0])) {
    // ทีมงานทุกคนสั่งอัปเดตจาก Google ได้ server เป็นผู้ตัดสินว่าถึงรอบหรือยัง
    await requireMutation(ctx)
    let force = false
    if ((ctx.request.headers.get('Content-Type') ?? '').toLowerCase().startsWith('application/json')) force = (await readJson(ctx.request)).force === true
    const result = await runSync(ctx.env, parts[0], { force })
    return json({ ran: result.ran, skipped: result.skipped ?? null, status: result.status })
  }
  if (parts.length === 2 && parts[1] === 'push-local' && (parts[0] === 'sheets' || parts[0] === 'calendar')) {
    if (method === 'POST') return pushLocal(ctx, parts[0])
    if (method === 'GET') {
      // ดูก่อนย้าย: จำนวนและรายการที่อาจซ้ำ ไม่เขียนอะไร
      requireUser(ctx, 'admin')
      const resource = await loadResource(ctx.env, parts[0])
      if (!resource) throw new HttpError(409, 'not_linked', `ยังไม่ได้เชื่อม${KIND_LABEL[parts[0]]}`)
      return json(parts[0] === 'sheets' ? await previewLocalMembers(ctx.env, resource) : await previewLocalEvents(ctx.env, resource))
    }
  }
  return null
}

/** ย้ายข้อมูลที่อยู่เฉพาะในเว็บขึ้นแหล่ง Google ที่เชื่อม (ผู้ดูแลยืนยันจากหน้าตั้งค่าหลังดูจำนวนและรายการที่อาจซ้ำแล้ว) */
async function pushLocal(ctx: Ctx, kind: 'sheets' | 'calendar'): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const resource = await loadResource(ctx.env, kind)
  if (!resource) throw new HttpError(409, 'not_linked', `ยังไม่ได้เชื่อม${KIND_LABEL[kind]}`)
  const body = await readJson(ctx.request)
  const skipIds = Array.isArray(body.skipIds) ? body.skipIds.filter((id): id is string => typeof id === 'string').slice(0, 500) : []
  const result = kind === 'sheets' ? await pushLocalMembers(ctx.env, resource, skipIds) : await pushLocalEvents(ctx.env, resource, skipIds)
  if (result.pushed > 0) await audit(ctx.env, session.user.id, 'sync.local_pushed', kind, String(result.pushed))
  return json({ ...result, status: await syncStatus(ctx.env, kind) })
}

// ---------- สถานะการตั้งค่า ----------

async function overview(env: AppEnv) {
  const scopes = await grantedScopes(env)
  const missingPicker = [
    ...(env.GOOGLE_PICKER_API_KEY ? [] : ['GOOGLE_PICKER_API_KEY']),
    ...(env.GOOGLE_CLOUD_PROJECT_NUMBER ? [] : ['GOOGLE_CLOUD_PROJECT_NUMBER']),
  ]
  const [members, events, { results: operations }] = await Promise.all([
    env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE source = 'local'`).first<{ n: number }>(),
    env.DB.prepare(`SELECT COUNT(*) AS n FROM events WHERE source = 'local'`).first<{ n: number }>(),
    env.DB.prepare(`SELECT id, kind, name, status, resource_id, create_attempted_at, last_error, created_at FROM setup_operations WHERE status IN ('pending', 'resource_created', 'failed') ORDER BY created_at DESC LIMIT 10`).all<OperationRow>(),
  ])
  return {
    scopes: {
      driveFile: scopes.has(DRIVE_FILE_SCOPE),
      calendarCreated: scopes.has(CAL_APP_CREATED_SCOPE) || scopes.has(CAL_EVENTS_SCOPE),
      calendarExisting: scopes.has(CAL_EVENTS_SCOPE) && scopes.has(CAL_LIST_SCOPE),
      // คลังไฟล์ชมรม: อ่านไฟล์ทั้งหมดที่บัญชีชมรมเข้าถึงได้ (ขอแยกเมื่อผู้ดูแลเปิดใช้)
      library: scopes.has(DRIVE_READONLY_SCOPE),
    },
    // ชีตที่เชื่อมอยู่มีคอลัมน์รหัสนักศึกษาที่จับคู่แล้วหรือยัง (null = ยังไม่ได้เชื่อมชีต)
    studentIdColumn: await linkedStudentIdColumn(env),
    // ค่าที่เบราว์เซอร์ต้องใช้เปิด Google Picker ไม่มีค่าลับ (client ID และ API key เป็นค่าที่เปิดเผยในหน้าเว็บโดยธรรมชาติ)
    picker: {
      configured: missingPicker.length === 0,
      missing: missingPicker,
      apiKey: env.GOOGLE_PICKER_API_KEY ?? '',
      appId: env.GOOGLE_CLOUD_PROJECT_NUMBER ?? '',
      clientId: env.GOOGLE_CLIENT_ID ?? '',
    },
    local: { members: members?.n ?? 0, events: events?.n ?? 0 },
    operations: operations.map((op) => ({
      id: op.id,
      kind: op.kind,
      name: op.name,
      status: op.status,
      fileState: op.resource_id ? 'created' : op.create_attempted_at ? 'unknown' : 'none',
      canConfirmCreate: !op.resource_id && !!op.create_attempted_at && Date.now() - Date.parse(op.create_attempted_at) >= CONFIRM_CREATE_AFTER_MS,
      lastError: op.last_error,
      createdAt: op.created_at,
    })),
    sync: await syncStatuses(env),
  }
}

/** หัวคอลัมน์รหัสนักศึกษาที่จับคู่ไว้ของชีตที่เชื่อม ('' = เชื่อมแล้วแต่ยังไม่มีคอลัมน์นี้, null = ยังไม่ได้เชื่อมชีต) */
async function linkedStudentIdColumn(env: AppEnv): Promise<string | null> {
  const sheet = await loadResource(env, 'sheets')
  return sheet ? ((sheet.config as unknown as SheetConfig).columns?.studentId ?? '') : null
}

/**
 * คอลัมน์รหัสนักศึกษาของชีตที่เชื่อมอยู่แล้ว: ผู้ดูแลจับคู่คอลัมน์ที่มีอยู่ หรือให้ระบบเพิ่มคอลัมน์ต่อท้าย โดยไม่ต้องยกเลิกการเชื่อม
 * รหัสนักศึกษาที่กรอกไว้ในเว็บก่อนหน้านี้ไม่ถูกล้าง: ระบบเขียนลงช่องที่ยังว่างของแถวสมาชิกคนนั้นในรอบซิงค์ถัดไป
 * ไม่มีข้อมูลรหัสผ่านหรือบัญชีถูกเขียนลงชีตในขั้นตอนใด
 */
async function studentIdColumn(ctx: Ctx): Promise<Response> {
  const read = ctx.request.method === 'GET'
  const session = read ? requireUser(ctx, 'admin') : await requireMutation(ctx, 'admin')
  const resource = await loadResource(ctx.env, 'sheets')
  if (!resource) throw new HttpError(409, 'not_linked', 'ยังไม่ได้เชื่อมชีต')
  const config = resource.config as unknown as SheetConfig
  const gapi = makeGapi(ctx.env)
  try {
    const [row = []] = await readGrid(gapi, resource.resourceId, config.sheetId, 'FORMATTED_VALUE', [config.headerRow - 1, config.headerRow])
    const headers = row.map((cell) => (typeof cell === 'string' ? cell.trim() : String(cell ?? '').trim()))
    const used = new Set(Object.entries(config.columns).filter(([field]) => field !== 'studentId').map(([, header]) => header.trim().toLowerCase()))
    const free = headers.filter((header) => header !== '' && !used.has(header.toLowerCase()))
    if (read) {
      return json({
        mapped: config.columns.studentId ?? null,
        headers: [...new Set(free)],
        suggestion: suggestColumns(free).studentId ?? null,
        writable: resource.access === 'write',
        defaultHeader: DEFAULT_HEADERS.studentId,
      })
    }

    const body = await readJson(ctx.request)
    let header: string
    if (body.add === true) {
      const existing = free.find((h) => h.toLowerCase() === DEFAULT_HEADERS.studentId.toLowerCase())
      if (existing) header = existing
      else {
        if (resource.access !== 'write') throw new HttpError(403, 'source_read_only', 'บัญชี Google ของชมรมแก้ชีตนี้ไม่ได้ จึงเพิ่มคอลัมน์รหัสนักศึกษาไม่ได้ เพิ่มคอลัมน์ในชีตเองแล้วเลือกจับคู่แทน')
        const { tabs } = await listTabs(gapi, resource.resourceId)
        const tab = tabs.find((t) => t.sheetId === config.sheetId)
        if (!tab) throw new SyncDataError('ไม่พบแท็บของชีตที่เชื่อมไว้ อาจถูกลบจากไฟล์')
        header = await addHeaderColumn(gapi, resource.resourceId, tab, config.headerRow, DEFAULT_HEADERS.studentId)
      }
    } else {
      header = text(body, 'header', 'หัวคอลัมน์', 200, true)
      if (!free.some((h) => h.toLowerCase() === header.toLowerCase())) throw invalid('ไม่พบคอลัมน์นี้ในแถวหัวตารางของชีต หรือคอลัมน์นี้ถูกจับคู่กับฟิลด์อื่นแล้ว', 'header')
    }
    const next: SheetConfig = { ...config, columns: { ...config.columns, studentId: header } }
    // อ่านด้วยการจับคู่ใหม่หนึ่งครั้งก่อนบันทึก: หัวคอลัมน์ที่หายหรือซ้ำจะไม่ถูกบันทึก
    parseTable(await readGrid(gapi, resource.resourceId, config.sheetId), next, '')
    await ctx.env.DB.batch([
      // ค่าที่มีอยู่ในเว็บถือเป็นค่าที่กรอกในเว็บ จึงไม่ถูกล้างเมื่อช่องในคอลัมน์ที่เพิ่งจับคู่ยังว่าง
      ctx.env.DB.prepare(`UPDATE members SET student_id_origin = 'web' WHERE source = 'sheets'`),
      ctx.env.DB.prepare(`UPDATE sync_state SET remote_version = NULL, last_attempt_at = NULL, next_attempt_at = NULL WHERE kind = 'sheets'`),
    ])
    await patchResource(ctx.env, 'sheets', { config: next as unknown as Record<string, unknown> })
    await audit(ctx.env, session.user.id, 'sync.student_id_column', 'sheets', body.add === true ? 'added' : 'mapped')
  } catch (error) {
    if (error instanceof SyncDataError) throw new HttpError(422, 'malformed', `${error.message} ยังไม่ได้เปลี่ยนการจับคู่`)
    throw toHttpError(error)
  }
  const first = await runSync(ctx.env, 'sheets', { force: true })
  return json({ status: first.status, mapped: await linkedStudentIdColumn(ctx.env) })
}

// ---------- ตรวจแหล่งเดิมกับ Google ----------

interface DriveFile {
  id: string
  name: string
  mimeType: string
  trashed: boolean
  canEdit: boolean
}

/** ตรวจไฟล์ที่ผู้ดูแลเลือกด้วย token ของบัญชีชมรมเสมอ: ถ้า server เปิดไม่ได้ แปลว่ายังไม่ได้รับสิทธิ์จริง ไม่ผูก */
export async function checkFile(gapi: Gapi, fileId: string, mimeType: string, label: string): Promise<DriveFile> {
  if (!/^[A-Za-z0-9_-]{5,200}$/.test(fileId)) throw invalid('รหัสไฟล์ไม่ถูกต้อง', 'resourceId')
  let data: Record<string, any>
  try {
    data = await gapi.json(`${DRIVE_FILES}/${encodeURIComponent(fileId)}?fields=id,name,mimeType,trashed,capabilities(canEdit)&supportsAllDrives=true`)
  } catch (error) {
    if (error instanceof GoogleApiError && (error.status === 404 || error.status === 403)) {
      throw new HttpError(409, 'file_not_granted', `บัญชี Google ของชมรมยังเปิด${label}นี้ไม่ได้ ต้องเลือกไฟล์ผ่านหน้าต่างเลือกไฟล์ของ Google ด้วยบัญชีชมรม (การวางลิงก์อย่างเดียวไม่ได้ให้สิทธิ์แก่เว็บไซต์) ยังไม่ได้เชื่อม`)
    }
    throw error
  }
  if (data.mimeType !== mimeType) throw new HttpError(422, 'wrong_file_type', `ไฟล์ที่เลือกไม่ใช่${label} ยังไม่ได้เชื่อม`)
  if (data.trashed === true) throw new HttpError(422, 'file_trashed', 'ไฟล์ที่เลือกอยู่ในถังขยะของ Google Drive ยังไม่ได้เชื่อม')
  return { id: data.id, name: data.name ?? '', mimeType: data.mimeType, trashed: false, canEdit: data.capabilities?.canEdit === true }
}

async function checkCalendar(gapi: Gapi, calendarId: string) {
  if (!calendarId || calendarId.length > 300) throw invalid('รหัสปฏิทินไม่ถูกต้อง', 'resourceId')
  let data: Record<string, any>
  try {
    data = await gapi.json(`${CAL_API}/users/me/calendarList/${encodeURIComponent(calendarId)}`)
  } catch (error) {
    if (error instanceof GoogleApiError && error.status === 404) throw new HttpError(409, 'calendar_not_found', 'ไม่พบปฏิทินนี้ในบัญชี Google ของชมรม ยังไม่ได้เชื่อม')
    throw error
  }
  const accessRole = String(data.accessRole ?? '')
  if (!canRead(accessRole)) throw new HttpError(422, 'calendar_no_access', 'บัญชี Google ของชมรมเห็นได้เพียงช่วงว่าง/ไม่ว่างของปฏิทินนี้ อ่านรายละเอียดกำหนดการไม่ได้ จึงเชื่อมไม่ได้')
  return { id: String(data.id), name: String(data.summaryOverride ?? data.summary ?? calendarId), accessRole, timeZone: String(data.timeZone ?? '') }
}

function sheetOptions(body: Record<string, unknown>) {
  const sheetId = typeof body.sheetId === 'number' && Number.isInteger(body.sheetId) ? body.sheetId : null
  const headerRow = body.headerRow === undefined ? 1 : body.headerRow
  if (typeof headerRow !== 'number' || !Number.isInteger(headerRow) || headerRow < 1 || headerRow > 50) throw invalid('แถวหัวตารางต้องอยู่ระหว่าง 1 ถึง 50', 'headerRow')
  let columns: Partial<Record<MemberField, string>> | undefined
  if (body.columns !== undefined) {
    if (!body.columns || typeof body.columns !== 'object' || Array.isArray(body.columns)) throw invalid('การจับคู่คอลัมน์ไม่ถูกต้อง', 'columns')
    columns = {}
    for (const [field, header] of Object.entries(body.columns as Record<string, unknown>)) {
      if (!(MEMBER_FIELDS as readonly string[]).includes(field)) throw invalid('การจับคู่คอลัมน์ไม่ถูกต้อง', 'columns')
      if (header === null || header === '') continue
      if (typeof header !== 'string' || header.length > 200) throw invalid('การจับคู่คอลัมน์ไม่ถูกต้อง', 'columns')
      columns[field as MemberField] = header
    }
    const used = Object.values(columns).map((h) => h.trim().toLowerCase())
    if (new Set(used).size !== used.length) throw invalid('คอลัมน์หนึ่งจับคู่ได้กับฟิลด์เดียว', 'columns')
  }
  return { sheetId, headerRow, columns }
}

async function preview(ctx: Ctx): Promise<Response> {
  await requireMutation(ctx, 'admin')
  const body = await readJson(ctx.request)
  if (!isResourceKind(body.kind)) throw invalid('ชนิดแหล่งข้อมูลไม่ถูกต้อง', 'kind')
  const resourceId = typeof body.resourceId === 'string' ? body.resourceId.trim() : ''
  const gapi = makeGapi(ctx.env)
  try {
    if (body.kind === 'sheets') {
      const file = await checkFile(gapi, resourceId, SHEET_MIME, 'ไฟล์ Google Sheets')
      const { tabs } = await listTabs(gapi, file.id)
      const options = sheetOptions(body)
      const tab = tabs.find((t) => t.sheetId === options.sheetId) ?? tabs[0]
      if (!tab) throw new HttpError(422, 'no_tabs', 'ไฟล์นี้ไม่มีแท็บแบบตาราง')
      return json({
        kind: 'sheets', resourceId: file.id, name: file.name, writable: file.canEdit, tabs: tabs.map((t) => ({ sheetId: t.sheetId, title: t.title })),
        sheetId: tab.sheetId, headerRow: options.headerRow, ...(await previewSheet(ctx.env, gapi, file.id, tab.sheetId, options.headerRow, options.columns)),
      })
    }
    if (body.kind === 'calendar') {
      const calendar = await checkCalendar(gapi, resourceId)
      return json({ kind: 'calendar', resourceId: calendar.id, name: calendar.name, accessRole: calendar.accessRole, writable: canWrite(calendar.accessRole), timeZone: calendar.timeZone, ...(await previewCalendar(ctx.env, gapi, calendar.id)) })
    }
    const file = await checkFile(gapi, resourceId, FORM_MIME, 'ไฟล์ Google Forms')
    const form = await fetchForm(gapi, file.id)
    const isQuiz = form.settings?.quizSettings?.isQuiz === true
    const items = ((form.items ?? []) as Record<string, any>[]).map((item) => describeItem(item, isQuiz))
    return json({
      kind: 'forms', resourceId: file.id, name: file.name, writable: file.canEdit, title: form.info?.title ?? '', isQuiz,
      itemCount: items.length, editableCount: items.filter((i) => i.editable).length, readOnlyCount: items.filter((i) => !i.editable).length,
    })
  } catch (error) {
    throw toHttpError(error)
  }
}

async function requireFree(env: AppEnv, kind: ResourceKind) {
  if (await loadResource(env, kind)) {
    throw new HttpError(409, 'already_linked', `มี${KIND_LABEL[kind]}ที่เชื่อมอยู่แล้ว ต้องยกเลิกการเชื่อมแหล่งเดิมก่อนจึงจะเชื่อมแหล่งใหม่ได้ (ต้นฉบับใน Google และข้อมูลในเว็บไม่ถูกลบ)`)
  }
}

/** เชื่อมแหล่งเดิมที่ผู้ดูแลเลือก หลังตรวจสิทธิ์และรูปแบบกับ Google แล้ว */
async function link(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const body = await readJson(ctx.request)
  if (!isResourceKind(body.kind)) throw invalid('ชนิดแหล่งข้อมูลไม่ถูกต้อง', 'kind')
  const kind = body.kind
  const resourceId = typeof body.resourceId === 'string' ? body.resourceId.trim() : ''
  await requireFree(ctx.env, kind)
  const gapi = makeGapi(ctx.env)
  try {
    if (kind === 'sheets') {
      const file = await checkFile(gapi, resourceId, SHEET_MIME, 'ไฟล์ Google Sheets')
      const { tabs } = await listTabs(gapi, file.id)
      const options = sheetOptions(body)
      const tab = tabs.find((t) => t.sheetId === options.sheetId)
      if (!tab) throw invalid('เลือกแท็บของชีตที่จะใช้', 'sheetId')
      const columns = { ...(options.columns ?? {}) }
      if (!columns.name) throw invalid('ต้องจับคู่คอลัมน์ชื่อ', 'columns')
      if (!columns.id) {
        // ชีตเดิมที่ยังไม่มีคอลัมน์รหัส: เพิ่มได้เฉพาะเมื่อผู้ดูแลยืนยัน และบัญชีชมรมแก้ไฟล์ได้
        if (body.addIdColumn !== true) throw invalid('ชีตนี้ยังไม่มีคอลัมน์รหัสสมาชิก ต้องจับคู่คอลัมน์รหัส หรือยืนยันให้ระบบเพิ่มคอลัมน์รหัสต่อท้าย', 'columns')
        if (!file.canEdit) throw new HttpError(403, 'source_read_only', 'บัญชี Google ของชมรมแก้ไฟล์นี้ไม่ได้ จึงเพิ่มคอลัมน์รหัสสมาชิกไม่ได้ ให้เจ้าของไฟล์เพิ่มสิทธิ์แก้ไข หรือเพิ่มคอลัมน์รหัสเองแล้วจับคู่')
        columns.id = await addIdColumn(gapi, file.id, tab, options.headerRow)
      }
      const config: SheetConfig = { sheetId: tab.sheetId, headerRow: options.headerRow, columns }
      // อ่านด้วยการจับคู่จริงหนึ่งครั้งก่อนผูก: ถ้าคอลัมน์ไม่ครบหรือซ้ำ จะไม่ผูก
      parseTable(await readGrid(gapi, file.id, tab.sheetId), config, '')
      await saveResource(ctx.env, { kind, resourceId: file.id, name: file.name, url: sheetUrl(file.id, tab.sheetId), origin: 'selected', access: file.canEdit ? 'write' : 'read', config: config as unknown as Record<string, unknown> }, session.user.id)
    } else if (kind === 'calendar') {
      const calendar = await checkCalendar(gapi, resourceId)
      await saveResource(ctx.env, {
        kind, resourceId: calendar.id, name: calendar.name, url: calendarUrl(calendar.id), origin: 'selected',
        access: canWrite(calendar.accessRole) ? 'write' : 'read', config: { accessRole: calendar.accessRole, timeZone: calendar.timeZone },
      }, session.user.id)
      await readoptEvents(ctx.env, calendar.id)
    } else {
      const file = await checkFile(gapi, resourceId, FORM_MIME, 'ไฟล์ Google Forms')
      await fetchForm(gapi, file.id)
      await saveResource(ctx.env, { kind, resourceId: file.id, name: file.name, url: formEditUrl(file.id), origin: 'selected', access: file.canEdit ? 'write' : 'read', config: { mapping: {} } }, session.user.id)
    }
  } catch (error) {
    if (error instanceof SyncDataError) throw new HttpError(422, 'malformed', `${error.message} ยังไม่ได้เชื่อม`)
    throw toHttpError(error)
  }
  await audit(ctx.env, session.user.id, 'sync.linked', kind, 'selected')
  const first = await runSync(ctx.env, kind, { force: true })
  return json({ status: first.status }, 201)
}

/** กำหนดการที่เคยมาจากปฏิทินนี้ (ก่อนยกเลิกการเชื่อม) กลับมาเป็นสำเนาของปฏิทินเดิม ไม่ถูกนับเป็นรายการเฉพาะในเว็บ */
const readoptEvents = (env: AppEnv, calendarId: string) =>
  env.DB.prepare(`UPDATE events SET source = 'calendar' WHERE source = 'local' AND google_calendar_id = ? AND google_event_id IS NOT NULL`).bind(calendarId).run()

async function unlink(ctx: Ctx, kind: ResourceKind): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const resource = await loadResource(ctx.env, kind)
  if (!resource) return json({ status: await syncStatus(ctx.env, kind) })
  const now = nowIso()
  const statements = [
    ctx.env.DB.prepare('DELETE FROM sync_resources WHERE kind = ?').bind(kind),
    ctx.env.DB.prepare(
      `UPDATE sync_state SET resource_id = '', cursor = NULL, remote_version = NULL, last_attempt_at = NULL, last_success_at = NULL, last_error_code = NULL,
              last_error_message = NULL, failure_count = 0, next_attempt_at = NULL, issues_json = '[]', lease_owner = NULL, lease_expires_at = NULL,
              data_version = data_version + 1, updated_at = ? WHERE kind = ?`,
    ).bind(now, kind),
  ]
  // สำเนาในเว็บยังอยู่ครบและกลับเป็นข้อมูลของเว็บ (แก้ในเว็บได้) ต้นฉบับใน Google ไม่ถูกแตะ
  if (kind === 'sheets') statements.push(ctx.env.DB.prepare(`UPDATE members SET source = 'local' WHERE source = 'sheets'`))
  if (kind === 'calendar') {
    statements.push(
      ctx.env.DB.prepare(`UPDATE events SET source = 'local' WHERE source = 'calendar'`),
      ctx.env.DB.prepare('DELETE FROM calendar_series WHERE calendar_id = ?').bind(resource.resourceId),
    )
  }
  await ctx.env.DB.batch(statements)
  await audit(ctx.env, session.user.id, 'sync.unlinked', kind, resource.origin)
  return json({ status: await syncStatus(ctx.env, kind) })
}

// ---------- สร้างแหล่งใหม่ในบัญชีชมรม ----------

interface OperationRow {
  id: string
  kind: ResourceKind
  user_id: string
  name: string
  status: 'pending' | 'resource_created' | 'completed' | 'failed'
  resource_id: string | null
  create_attempted_at: string | null
  last_error: string | null
  lease_owner: string | null
  lease_expires_at: string | null
  created_at: string
}

type Created = { kind: 'created'; id: string } | { kind: 'not_created'; error: GoogleApiError } | { kind: 'unknown' }

async function sendCreate(run: () => Promise<Record<string, any>>): Promise<Created> {
  try {
    const data = await run()
    return typeof data?.id === 'string' ? { kind: 'created', id: data.id } : typeof data?.formId === 'string' ? { kind: 'created', id: data.formId } : { kind: 'unknown' }
  } catch (error) {
    // 4xx = Google ปฏิเสธชัดเจน ไม่มีอะไรถูกสร้าง; 5xx/เครือข่าย/หมดเวลา = อาจสร้างไปแล้ว
    if (error instanceof GoogleApiError && error.status >= 400 && error.status < 500 && error.status !== 429) return { kind: 'not_created', error }
    return { kind: 'unknown' }
  }
}

const markerOf = (opId: string) => `mu-setup:${opId}`

function createResource(gapi: Gapi, kind: ResourceKind, name: string, opId: string): Promise<Created> {
  if (kind === 'sheets') return sendCreate(() => gapi.json(`${DRIVE_FILES}?fields=id`, jsonInit('POST', { name, mimeType: SHEET_MIME, appProperties: { [OPERATION_PROPERTY]: opId } })))
  if (kind === 'forms') return sendCreate(() => gapi.json(FORMS_API, jsonInit('POST', { info: { title: name, documentTitle: name } })))
  return sendCreate(() => gapi.json(`${CAL_API}/calendars`, jsonInit('POST', { summary: name, description: `ปฏิทินที่สร้างจาก MU Esport Staff (${markerOf(opId)})`, timeZone: 'Asia/Bangkok' })))
}

/** ค้นหาทรัพยากรที่อาจถูกสร้างไปแล้วจากคำสั่งที่ไม่ทราบผล ผลว่างไม่ได้ยืนยันว่าไม่มี */
async function findCreated(gapi: Gapi, op: OperationRow): Promise<string[]> {
  if (op.kind === 'calendar') {
    const data = await gapi.json(`${CAL_API}/users/me/calendarList?maxResults=250&minAccessRole=owner`)
    return ((data.items ?? []) as Record<string, any>[]).filter((c) => typeof c.description === 'string' && c.description.includes(markerOf(op.id))).map((c) => String(c.id))
  }
  const search = async (q: string) => {
    const data = await gapi.json(`${DRIVE_FILES}?${new URLSearchParams({ q, fields: 'files(id)', spaces: 'drive' })}`)
    return ((data.files ?? []) as { id?: string }[]).map((f) => f.id).filter((id): id is string => typeof id === 'string')
  }
  const tagged = await search(`appProperties has { key='${OPERATION_PROPERTY}' and value='${op.id}' } and trashed = false`)
  if (tagged.length > 0 || op.kind !== 'forms') return tagged
  // ฟอร์มสร้างผ่าน Forms API ซึ่งติดป้ายตอนสร้างไม่ได้: หาจากชื่อและเวลาที่ส่งคำสั่ง (เห็นเฉพาะไฟล์ของแอปนี้ตามสิทธิ์ drive.file)
  const since = new Date(Date.parse(op.create_attempted_at!) - 60_000).toISOString()
  return search(`mimeType = '${FORM_MIME}' and name = '${op.name.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}' and createdTime > '${since}' and trashed = false`)
}

const getOperation = (env: AppEnv, id: string) => env.DB.prepare('SELECT * FROM setup_operations WHERE id = ?').bind(id).first<OperationRow>()

async function create(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const key = idempotencyKey(ctx.request)
  const body = await readJson(ctx.request)
  if (!isResourceKind(body.kind)) throw invalid('ชนิดแหล่งข้อมูลไม่ถูกต้อง', 'kind')
  const kind = body.kind
  const name = text(body, 'name', 'ชื่อ', 100, true)
  const env = ctx.env

  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO setup_operations (id, kind, user_id, idem_key, name, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
     ON CONFLICT (user_id, idem_key) DO NOTHING`,
  )
    .bind(crypto.randomUUID(), kind, session.user.id, key, name, now, now)
    .run()
  let op = (await env.DB.prepare('SELECT * FROM setup_operations WHERE user_id = ? AND idem_key = ?').bind(session.user.id, key).first<OperationRow>())!
  if (op.kind !== kind || op.name !== name) throw new HttpError(422, 'idempotency_mismatch', 'คำขอนี้ซ้ำกับรายการก่อนหน้าแต่ข้อมูลไม่ตรงกัน โหลดหน้าใหม่แล้วลองอีกครั้ง')
  const linked = await loadResource(env, kind)
  if (op.status === 'completed' && linked?.resourceId === op.resource_id) return json({ status: await syncStatus(env, kind), replayed: true })
  if (linked) await requireFree(env, kind)

  const scopes = await grantedScopes(env)
  if (kind === 'calendar' ? !(scopes.has(CAL_APP_CREATED_SCOPE) || scopes.has(CAL_EVENTS_SCOPE)) : !scopes.has(DRIVE_FILE_SCOPE)) {
    throw new HttpError(409, 'missing_scope', `บัญชี Google ของชมรมยังไม่ได้อนุญาตสิทธิ์ที่ต้องใช้สร้าง${KIND_LABEL[kind]} ขอสิทธิ์ก่อนแล้วลองอีกครั้ง ยังไม่ได้สร้างอะไร`)
  }

  // ทำได้ทีละหนึ่งคำขอต่อหนึ่งงาน: คำขอซ้ำที่มาระหว่างนี้ไม่สร้างทรัพยากรซ้อน
  const owner = crypto.randomUUID()
  const claimed = await env.DB.prepare(
    `UPDATE setup_operations SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
      WHERE id = ? AND status IN ('pending', 'resource_created') AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(owner, new Date(Date.now() + LEASE_MS).toISOString(), now, op.id, now)
    .run()
  if (claimed.meta.changes !== 1) {
    if (op.status === 'failed') throw new HttpError(409, 'operation_needs_review', `งานสร้าง${KIND_LABEL[kind]}นี้ต้องตรวจใน Google เอง ระบบทำต่อให้ไม่ได้`)
    throw new HttpError(409, 'operation_in_progress', `กำลังสร้าง${KIND_LABEL[kind]}นี้อยู่จากคำขอก่อนหน้า รอสักครู่แล้วลองอีกครั้ง ระบบจะไม่สร้างซ้ำ`)
  }
  const note = (code: string, status?: OperationRow['status']) =>
    env.DB.prepare('UPDATE setup_operations SET last_error = ?, status = COALESCE(?, status), updated_at = ? WHERE id = ? AND lease_owner = ?').bind(code, status ?? null, nowIso(), op.id, owner).run()

  try {
    op = (await getOperation(env, op.id))!
    const gapi = makeGapi(env)
    let resourceId = op.resource_id

    if (!resourceId && op.create_attempted_at) {
      const found = await findCreated(gapi, op)
      if (found.length > 1) {
        await note('multiple_resources', 'failed')
        throw new HttpError(409, 'operation_needs_review', `พบ${KIND_LABEL[kind]}ของงานนี้มากกว่าหนึ่งรายการในบัญชี Google ของชมรม ระบบจึงไม่ทำต่อ ตรวจและลบรายการที่ซ้ำใน Google แล้วใช้ “เลือกข้อมูลที่มีอยู่” แทน`)
      }
      if (found.length === 1) resourceId = found[0]
      else {
        const canConfirm = Date.now() - Date.parse(op.create_attempted_at) >= CONFIRM_CREATE_AFTER_MS
        if (!(body.confirmCreate === true && canConfirm)) {
          await note('create_unknown')
          throw new HttpError(409, 'operation_create_unknown', `ไม่ทราบว่า Google สร้าง${KIND_LABEL[kind]}ของงานนี้แล้วหรือยัง (คำสั่งไปถึง Google แต่ไม่ได้รับคำตอบที่ยืนยันได้) ระบบค้นหาแล้วยังไม่พบ จึงยังไม่สร้างใหม่เพื่อไม่ให้เกิดรายการซ้ำ ${canConfirm ? 'ถ้าตรวจในบัญชี Google ของชมรมแล้วว่าไม่มี กดยืนยันให้สร้างใหม่ได้' : 'ลองอีกครั้งในอีกสักครู่เพื่อค้นหาอีกครั้ง'}`, { canConfirmCreate: canConfirm, operationId: op.id })
        }
        await env.DB.prepare('UPDATE setup_operations SET create_attempted_at = NULL WHERE id = ? AND lease_owner = ? AND resource_id IS NULL').bind(op.id, owner).run()
        await audit(env, session.user.id, 'setup.create_reconfirmed', op.id, kind)
        op = { ...op, create_attempted_at: null }
      }
    }

    if (!resourceId) {
      // ให้แน่ใจว่ามี token ใช้ได้ก่อนทำเครื่องหมาย ข้อผิดพลาดตรงนี้แปลว่ายังไม่ได้ส่งคำสั่งสร้างแน่นอน
      await getAccessToken(env)
      const marked = await env.DB.prepare(
        'UPDATE setup_operations SET create_attempted_at = ?, updated_at = ? WHERE id = ? AND lease_owner = ? AND create_attempted_at IS NULL AND resource_id IS NULL',
      )
        .bind(nowIso(), nowIso(), op.id, owner)
        .run()
      if (marked.meta.changes !== 1) throw new HttpError(409, 'operation_in_progress', 'งานนี้กำลังทำอยู่จากคำขออื่น')
      const created = await createResource(gapi, kind, name, op.id)
      if (created.kind === 'not_created') {
        await env.DB.prepare('UPDATE setup_operations SET create_attempted_at = NULL WHERE id = ? AND lease_owner = ? AND resource_id IS NULL').bind(op.id, owner).run()
        throw created.error
      }
      if (created.kind === 'unknown') {
        await note('create_unknown')
        throw new HttpError(502, 'operation_create_unknown', `ไม่ทราบว่า Google สร้าง${KIND_LABEL[kind]}แล้วหรือยัง (คำสั่งไปถึง Google แต่ไม่ได้รับคำตอบที่ยืนยันได้) ระบบจะไม่สร้างใหม่เอง กด “ลองอีกครั้ง” เพื่อให้ระบบค้นหารายการเดิม`, { canConfirmCreate: false, operationId: op.id })
      }
      resourceId = created.id
      // ฟอร์มติดป้ายหลังสร้าง เพื่อให้ค้นเจอถ้าขั้นถัดไปล้มเหลว (ไม่สำเร็จก็ไม่กระทบ เพราะมี id แล้ว)
      if (kind === 'forms') await gapi.fetch(`${DRIVE_FILES}/${encodeURIComponent(resourceId)}`, jsonInit('PATCH', { appProperties: { [OPERATION_PROPERTY]: op.id } })).catch(() => undefined)
    }
    await env.DB.prepare(`UPDATE setup_operations SET resource_id = ?, status = 'resource_created', updated_at = ? WHERE id = ? AND resource_id IS NULL`).bind(resourceId, nowIso(), op.id).run()

    // เตรียมโครงสร้างตั้งต้น (ทำซ้ำได้) แล้วผูกกับระบบ
    if (kind === 'sheets') {
      const config = await initCreatedSheet(gapi, resourceId)
      await saveResource(env, { kind, resourceId, name, url: sheetUrl(resourceId, config.sheetId), origin: 'created', access: 'write', config: config as unknown as Record<string, unknown> }, session.user.id)
    } else if (kind === 'forms') {
      const mapping = await initCreatedForm(gapi, resourceId)
      await saveResource(env, { kind, resourceId, name, url: formEditUrl(resourceId), origin: 'created', access: 'write', config: { mapping } }, session.user.id)
    } else {
      await saveResource(env, { kind, resourceId, name, url: calendarUrl(resourceId), origin: 'created', access: 'write', config: { accessRole: 'owner', timeZone: 'Asia/Bangkok' } }, session.user.id)
      await readoptEvents(env, resourceId)
    }
    await env.DB.prepare(`UPDATE setup_operations SET status = 'completed', last_error = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`).bind(nowIso(), op.id).run()
    await audit(env, session.user.id, 'sync.linked', kind, 'created')
  } catch (error) {
    const known = error instanceof SyncDataError ? new HttpError(409, 'operation_needs_review', error.message) : toHttpError(error)
    if (!known.code.startsWith('operation_')) await note(known.code)
    const state = (await getOperation(env, op.id))!
    throw new HttpError(known.status, known.code, known.message, { ...known.extra, operationId: op.id, fileState: state.resource_id ? 'created' : state.create_attempted_at ? 'unknown' : 'none' })
  } finally {
    await env.DB.prepare('UPDATE setup_operations SET lease_owner = NULL, lease_expires_at = NULL WHERE id = ? AND lease_owner = ?').bind(op.id, owner).run().catch(() => undefined)
  }
  const first = await runSync(env, kind, { force: true })
  return json({ status: first.status }, 201)
}

/** นำงานสร้างที่ค้างออกจากรายการ (เก็บแถวไว้เป็นหลักฐาน ไม่ลบอะไรใน Google) */
async function dismiss(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const now = nowIso()
  const result = await ctx.env.DB.prepare(
    `UPDATE setup_operations SET status = 'completed', last_error = 'dismissed', updated_at = ?
      WHERE id = ? AND status != 'completed' AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(now, id, now)
    .run()
  if (result.meta.changes !== 1) throw new HttpError(409, 'operation_in_progress', 'งานนี้กำลังทำอยู่หรือเสร็จไปแล้ว จึงนำออกจากรายการไม่ได้')
  await audit(ctx.env, session.user.id, 'setup.operation_dismissed', id)
  return json(await overview(ctx.env))
}

export async function handleSetup(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 0 && method === 'GET') {
    requireUser(ctx, 'admin')
    return json(await overview(ctx.env))
  }
  if (parts.length === 1 && parts[0] === 'calendars' && method === 'GET') {
    requireUser(ctx, 'admin')
    try {
      return json({ calendars: (await listCalendars(makeGapi(ctx.env))).map((c) => ({ ...c, writable: canWrite(c.accessRole), selectable: canRead(c.accessRole) })) })
    } catch (error) {
      throw toHttpError(error)
    }
  }
  if (parts.length === 1 && parts[0] === 'student-id-column' && (method === 'GET' || method === 'POST')) return studentIdColumn(ctx)
  if (parts.length === 1 && method === 'POST') {
    if (parts[0] === 'create') return create(ctx)
    if (parts[0] === 'preview') return preview(ctx)
    if (parts[0] === 'link') return link(ctx)
  }
  if (parts.length === 2 && parts[0] === 'link' && method === 'DELETE' && isResourceKind(parts[1])) return unlink(ctx, parts[1])
  if (parts.length === 2 && parts[0] === 'operations' && method === 'DELETE') return dismiss(ctx, parts[1])
  return null
}
