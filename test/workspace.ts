import type { FakeGoogle } from './helpers'

/**
 * Google Sheets / Calendar / Forms / Drive จำลองสำหรับชุดทดสอบ Worker
 * ตอบตามรูปแบบของ API จริงเฉพาะส่วนที่ระบบใช้ และมีเมธอดจำลอง "คนแก้ที่ฝั่ง Google โดยตรง"
 * ผลจากไฟล์นี้เป็นการทดสอบกับ mock เท่านั้น ไม่ใช่หลักฐานว่าต่อกับ Google จริงได้
 */
type Json = Record<string, any>

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
const bodyOf = (init?: RequestInit): Json => JSON.parse((init?.body as string) ?? '{}') as Json

export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
export const FORM_MIME = 'application/vnd.google-apps.form'

export interface FakeSheet {
  id: string
  name: string
  canEdit: boolean
  trashed: boolean
  appProperties: Record<string, string>
  createdTime: string
  tabs: { sheetId: number; title: string; columnCount: number; cells: string[][] }[]
}

export interface FakeCalendar {
  id: string
  summary: string
  description: string
  accessRole: string
  events: Map<string, Json>
  /** รายการย่อยที่ Google กระจายให้ของแต่ละ series */
  instances: Map<string, Json[]>
  version: number
  changes: { version: number; id: string }[]
  /** token ที่ต่ำกว่าค่านี้ถือว่าหมดอายุ (410) */
  minToken: number
}

export interface FakeForm {
  formId: string
  name: string
  canEdit: boolean
  appProperties: Record<string, string>
  createdTime: string
  info: { title: string; description?: string; documentTitle: string }
  settings: Json
  items: Json[]
  revision: number
  responses: Json[]
}

export class FakeWorkspace {
  sheets = new Map<string, FakeSheet>()
  calendars = new Map<string, FakeCalendar>()
  forms = new Map<string, FakeForm>()
  /** จำนวนรายการต่อหน้าของ Calendar/Forms ใช้ทดสอบการแบ่งหน้า */
  pageSize = 250
  private counter = 0
  private etag = 0

  constructor(google: FakeGoogle) {
    google.services.push((url, method, init) => this.handle(url, method, init))
  }

  private next = (prefix: string) => `${prefix}${String(++this.counter).padStart(10, '0')}AbCdE`

  // ---------- เตรียมข้อมูลและจำลองการแก้ที่ฝั่ง Google ----------

  addSheet(name: string, rows: string[][], options: Partial<Pick<FakeSheet, 'canEdit'>> & { title?: string; sheetId?: number } = {}): FakeSheet {
    const sheet: FakeSheet = {
      id: this.next('sheet'), name, canEdit: options.canEdit ?? true, trashed: false, appProperties: {}, createdTime: new Date().toISOString(),
      tabs: [{ sheetId: options.sheetId ?? 0, title: options.title ?? 'Sheet1', columnCount: 26, cells: rows.map((r) => [...r]) }],
    }
    this.sheets.set(sheet.id, sheet)
    return sheet
  }

  cells(sheetId: string, tab = 0): string[][] {
    return this.sheets.get(sheetId)!.tabs[tab].cells
  }

  addCalendar(summary: string, accessRole = 'owner', id = `${this.next('cal')}@group.calendar.google.com`): FakeCalendar {
    const calendar: FakeCalendar = { id, summary, description: '', accessRole, events: new Map(), instances: new Map(), version: 1, changes: [], minToken: 0 }
    this.calendars.set(id, calendar)
    return calendar
  }

  private touch(calendar: FakeCalendar, id: string) {
    calendar.version++
    calendar.changes.push({ version: calendar.version, id })
  }

  /** เพิ่มหรือแก้กำหนดการจากฝั่ง Google Calendar โดยตรง */
  putEvent(calendarId: string, event: Json): Json {
    const calendar = this.calendars.get(calendarId)!
    const id = event.id ?? this.next('ev').toLowerCase()
    const previous = calendar.events.get(id) ?? {}
    const stored = { status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=${id}`, ...previous, ...event, id, etag: `"e${++this.etag}"`, updated: new Date().toISOString() }
    calendar.events.set(id, stored)
    this.touch(calendar, id)
    return stored
  }

  deleteEvent(calendarId: string, id: string) {
    const calendar = this.calendars.get(calendarId)!
    const event = calendar.events.get(id)!
    calendar.events.set(id, { id, status: 'cancelled', etag: `"e${++this.etag}"`, ...(event.recurringEventId ? { recurringEventId: event.recurringEventId } : {}) })
    this.touch(calendar, id)
  }

  addForm(title: string, items: Json[] = [], options: Partial<Pick<FakeForm, 'canEdit' | 'settings'>> = {}): FakeForm {
    const form: FakeForm = {
      formId: this.next('form'), name: title, canEdit: options.canEdit ?? true, appProperties: {}, createdTime: new Date().toISOString(),
      info: { title, documentTitle: title }, settings: options.settings ?? {}, items: [], revision: 1, responses: [],
    }
    for (const item of items) form.items.push(this.materialize(item))
    this.forms.set(form.formId, form)
    return form
  }

  /** เติม itemId/questionId ให้ item ใหม่เหมือนที่ Google ทำ */
  private materialize(item: Json): Json {
    const out = structuredClone(item)
    out.itemId ??= `i${(++this.counter).toString(16).padStart(7, '0')}`
    if (out.questionItem?.question) out.questionItem.question.questionId ??= `q${(++this.counter).toString(16).padStart(7, '0')}`
    for (const q of out.questionGroupItem?.questions ?? []) q.questionId ??= `q${(++this.counter).toString(16).padStart(7, '0')}`
    return out
  }

  /** แก้โครงสร้างฟอร์มจากฝั่ง Google Forms โดยตรง */
  editForm(formId: string, change: (form: FakeForm) => void) {
    const form = this.forms.get(formId)!
    change(form)
    form.items = form.items.map((item) => this.materialize(item))
    form.revision++
  }

  /** ผู้ตอบส่งคำตอบ (หรือแก้คำตอบเดิมเมื่อระบุ responseId) */
  submit(formId: string, answers: Record<string, string | string[]>, options: { responseId?: string; at?: string; email?: string } = {}): string {
    const form = this.forms.get(formId)!
    const at = options.at ?? new Date().toISOString()
    const encoded = Object.fromEntries(Object.entries(answers).map(([questionId, value]) => [questionId, { questionId, textAnswers: { answers: [value].flat().map((v) => ({ value: v })) } }]))
    const existing = form.responses.find((r) => r.responseId === options.responseId)
    if (existing) {
      existing.answers = encoded
      existing.lastSubmittedTime = at
      return existing.responseId
    }
    const responseId = options.responseId ?? this.next('r')
    form.responses.push({ responseId, createTime: at, lastSubmittedTime: at, ...(options.email ? { respondentEmail: options.email } : {}), answers: encoded })
    return responseId
  }

  // ---------- เส้นทางของ API ----------

  private handle(url: URL, method: string, init?: RequestInit): Response | undefined {
    if (url.origin === 'https://sheets.googleapis.com') return this.sheetsApi(url, method, init)
    if (url.origin === 'https://forms.googleapis.com') return this.formsApi(url, method, init)
    if (url.origin === 'https://www.googleapis.com' && url.pathname.startsWith('/calendar/v3/')) return this.calendarApi(url, method, init)
    if (url.origin === 'https://www.googleapis.com' && url.pathname.startsWith('/drive/v3/files')) return this.driveApi(url, method, init)
    return undefined
  }

  private driveApi(url: URL, method: string, init?: RequestInit): Response | undefined {
    const id = url.pathname.split('/')[4]
    if (!id && method === 'POST') {
      const body = bodyOf(init)
      if (body.mimeType !== SHEET_MIME) return undefined
      const sheet = this.addSheet(body.name, [])
      sheet.appProperties = body.appProperties ?? {}
      return reply({ id: sheet.id })
    }
    if (!id && method === 'GET') {
      const q = url.searchParams.get('q') ?? ''
      const byProperty = /key='muOperation' and value='([^']+)'/.exec(q)
      const files = [...this.sheets.values(), ...[...this.forms.values()].map((f) => ({ ...f, id: f.formId, trashed: false }))]
      if (byProperty) {
        const found = files.filter((f) => f.appProperties.muOperation === byProperty[1] && !f.trashed)
        // ไม่พบในบริการนี้: ปล่อยให้ตัวจำลองของ Docs ตอบ (เอกสารใช้ป้ายเดียวกัน)
        return found.length > 0 ? reply({ files: found.map((f) => ({ id: f.id })) }) : undefined
      }
      const byName = /mimeType = '([^']+)' and name = '((?:[^'\\]|\\.)*)' and createdTime > '([^']+)'/.exec(q)
      if (byName) {
        const name = byName[2].replace(/\\(.)/g, '$1')
        const found = [...this.forms.values()].filter((f) => byName[1] === FORM_MIME && f.name === name && f.createdTime > byName[3])
        return reply({ files: found.map((f) => ({ id: f.formId })) })
      }
      return undefined
    }
    const sheet = this.sheets.get(id)
    const form = this.forms.get(id)
    if (!sheet && !form) return undefined
    if (method === 'GET') {
      return reply({
        id, name: sheet?.name ?? form!.name, mimeType: sheet ? SHEET_MIME : FORM_MIME, trashed: sheet?.trashed ?? false,
        capabilities: { canEdit: sheet?.canEdit ?? form!.canEdit },
      })
    }
    if (method === 'PATCH') {
      const body = bodyOf(init)
      const target = (sheet ?? form)!
      if (body.appProperties) target.appProperties = { ...target.appProperties, ...body.appProperties }
      if (body.name) target.name = body.name
      return reply({ id })
    }
    return undefined
  }

  private sheetsApi(url: URL, method: string, init?: RequestInit): Response {
    const match = /^\/v4\/spreadsheets\/([^/:]+)(?:\/values)?(?::(\w+))?$/.exec(url.pathname)
    const rawId = match?.[1]
    const action = match?.[2]
    const sheet = this.sheets.get(decodeURIComponent(rawId ?? ''))
    if (!sheet || sheet.trashed) return reply({ error: { code: 404, status: 'NOT_FOUND' } }, 404)
    const tabOf = (sheetId: number) => sheet.tabs.find((t) => t.sheetId === sheetId)

    if (method === 'GET' && !action) {
      return reply({
        properties: { title: sheet.name },
        sheets: sheet.tabs.map((t) => ({ properties: { sheetId: t.sheetId, title: t.title, sheetType: 'GRID', gridProperties: { columnCount: t.columnCount } } })),
      })
    }
    if (method !== 'POST') return reply({ error: { code: 400 } }, 400)
    const body = bodyOf(init)

    if (action === 'batchGetByDataFilter') {
      const valueRanges = []
      for (const filter of body.dataFilters as Json[]) {
        const tab = tabOf(filter.gridRange.sheetId)
        if (!tab) continue
        const start = filter.gridRange.startRowIndex ?? 0
        const end = filter.gridRange.endRowIndex ?? tab.cells.length
        // เหมือน Google: ตัดเซลล์ว่างท้ายแถวและแถวว่างท้ายช่วง; FORMATTED_VALUE แสดงผลของสูตร ไม่ใช่ตัวสูตร
        const rows = tab.cells.slice(start, end).map((row) => {
          const shown = row.map((cell) => (body.valueRenderOption !== 'FORMULA' && cell.startsWith('=') ? `ผลของสูตร ${cell.slice(1)}` : cell))
          while (shown.length > 0 && shown[shown.length - 1] === '') shown.pop()
          return shown
        })
        while (rows.length > 0 && rows[rows.length - 1].length === 0) rows.pop()
        valueRanges.push({ valueRange: { range: `'${tab.title}'!A${start + 1}:Z${end}`, majorDimension: 'ROWS', ...(rows.length > 0 ? { values: rows } : {}) } })
      }
      return reply({ spreadsheetId: sheet.id, valueRanges })
    }
    if (!sheet.canEdit) return reply({ error: { code: 403, status: 'PERMISSION_DENIED' } }, 403)

    if (action === 'batchUpdateByDataFilter') {
      for (const entry of body.data as Json[]) {
        const range = entry.dataFilter.gridRange
        const tab = tabOf(range.sheetId)
        if (!tab || range.startColumnIndex >= tab.columnCount) return reply({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, 400)
        while (tab.cells.length <= range.startRowIndex) tab.cells.push([])
        const row = tab.cells[range.startRowIndex]
        while (row.length <= range.startColumnIndex) row.push('')
        row[range.startColumnIndex] = String(entry.values[0][0])
      }
      return reply({ spreadsheetId: sheet.id })
    }
    if (action === 'batchUpdate') {
      for (const request of body.requests as Json[]) {
        if (request.appendCells) {
          const tab = tabOf(request.appendCells.sheetId)
          if (!tab) return reply({ error: { code: 400 } }, 400)
          let last = tab.cells.length
          while (last > 0 && tab.cells[last - 1].every((c) => c === '')) last--
          tab.cells.length = last
          for (const row of request.appendCells.rows as Json[]) tab.cells.push((row.values as Json[]).map((v) => v.userEnteredValue?.stringValue ?? ''))
        } else if (request.appendDimension) {
          tabOf(request.appendDimension.sheetId)!.columnCount += request.appendDimension.length
        } else {
          return reply({ error: { code: 400 } }, 400)
        }
      }
      return reply({ spreadsheetId: sheet.id })
    }
    return reply({ error: { code: 404 } }, 404)
  }

  private calendarApi(url: URL, method: string, init?: RequestInit): Response {
    const parts = url.pathname.split('/').slice(3).map(decodeURIComponent)
    const visible = (calendar: FakeCalendar) => ({ id: calendar.id, summary: calendar.summary, description: calendar.description, accessRole: calendar.accessRole, timeZone: 'Asia/Bangkok' })

    if (parts[0] === 'users' && parts[2] === 'calendarList') {
      if (parts[3]) {
        const calendar = this.calendars.get(parts[3])
        return calendar ? reply(visible(calendar)) : reply({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404)
      }
      return reply({ items: [...this.calendars.values()].map(visible) })
    }
    if (parts[0] !== 'calendars') return reply({ error: { code: 404 } }, 404)
    if (!parts[1] && method === 'POST') {
      const body = bodyOf(init)
      const calendar = this.addCalendar(body.summary)
      calendar.description = body.description ?? ''
      return reply({ id: calendar.id, summary: calendar.summary })
    }
    const calendar = this.calendars.get(parts[1])
    if (!calendar || parts[2] !== 'events') return reply({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404)
    const writable = calendar.accessRole === 'owner' || calendar.accessRole === 'writer'
    const forbidden = () => reply({ error: { code: 403, errors: [{ reason: 'forbidden' }] } }, 403)
    const eventId = parts[3]

    if (!eventId && method === 'GET') {
      let items: Json[]
      const token = url.searchParams.get('syncToken')
      if (token) {
        const since = Number(token.replace('st-', ''))
        if (!token.startsWith('st-') || Number.isNaN(since) || since < calendar.minToken) return reply({ error: { code: 410, errors: [{ reason: 'fullSyncRequired' }] } }, 410)
        const ids = [...new Set(calendar.changes.filter((c) => c.version > since).map((c) => c.id))]
        items = ids.map((id) => calendar.events.get(id)!)
      } else {
        const timeMin = url.searchParams.get('timeMin')
        items = [...calendar.events.values()].filter((e) => e.status !== 'cancelled' && (!timeMin || !e.end || Date.parse(e.end.dateTime ?? `${e.end.date}T00:00:00Z`) >= Date.parse(timeMin)))
        if (url.searchParams.get('singleEvents') === 'true') items = items.filter((e) => !e.recurrence).concat([...calendar.instances.values()].flat())
      }
      const offset = Number(url.searchParams.get('pageToken') ?? '0')
      const page = items.slice(offset, offset + this.pageSize)
      const more = offset + this.pageSize < items.length
      return reply({ items: page, ...(more ? { nextPageToken: String(offset + this.pageSize) } : { nextSyncToken: `st-${calendar.version}` }) })
    }
    if (!eventId && method === 'POST') {
      if (!writable) return forbidden()
      const body = bodyOf(init)
      if (body.id && calendar.events.has(body.id)) return reply({ error: { code: 409, errors: [{ reason: 'duplicate' }] } }, 409)
      return reply(this.putEvent(calendar.id, { ...body, organizer: { self: true } }))
    }
    if (parts[4] === 'instances' && method === 'GET') {
      const master = calendar.events.get(eventId)
      if (!master || master.status === 'cancelled') return reply({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404)
      return reply({ items: (calendar.instances.get(eventId) ?? []).filter((i) => i.status !== 'cancelled') })
    }
    const event = calendar.events.get(eventId)
    if (!event) return reply({ error: { code: 404, errors: [{ reason: 'notFound' }] } }, 404)
    if (method === 'GET') return reply(event)
    if (method === 'PATCH') {
      if (!writable) return forbidden()
      if (event.status === 'cancelled') return reply({ error: { code: 410, errors: [{ reason: 'deleted' }] } }, 410)
      const match = new Headers(init?.headers).get('If-Match')
      if (match && match !== event.etag) return reply({ error: { code: 412, errors: [{ reason: 'conditionNotMet' }] } }, 412)
      return reply(this.putEvent(calendar.id, { ...bodyOf(init), id: eventId }))
    }
    return reply({ error: { code: 400 } }, 400)
  }

  private formJson = (form: FakeForm): Json => ({
    formId: form.formId, info: form.info, settings: form.settings, items: form.items, revisionId: `frev-${form.revision}`,
    responderUri: `https://docs.google.com/forms/d/e/${form.formId}/viewform`,
  })

  private formsApi(url: URL, method: string, init?: RequestInit): Response {
    const match = /^\/v1\/forms(?:\/([^/:]+))?(?:(:batchUpdate)|(\/responses))?$/.exec(url.pathname)
    if (!match) return reply({ error: { code: 404 } }, 404)
    if (!match[1] && method === 'POST') {
      const body = bodyOf(init)
      const form = this.addForm(body.info.title)
      form.name = body.info.documentTitle ?? body.info.title
      return reply(this.formJson(form))
    }
    const form = this.forms.get(decodeURIComponent(match[1] ?? ''))
    if (!form) return reply({ error: { code: 404, status: 'NOT_FOUND' } }, 404)

    if (match[3] && method === 'GET') {
      const filter = /^timestamp >= (.+)$/.exec(url.searchParams.get('filter') ?? '')
      const items = form.responses.filter((r) => !filter || r.lastSubmittedTime >= filter[1])
      const size = Math.min(Number(url.searchParams.get('pageSize') ?? '5000'), this.pageSize)
      const offset = Number(url.searchParams.get('pageToken') ?? '0')
      const more = offset + size < items.length
      return reply({ responses: items.slice(offset, offset + size), ...(more ? { nextPageToken: String(offset + size) } : {}) })
    }
    if (match[2] && method === 'POST') {
      if (!form.canEdit) return reply({ error: { code: 403, status: 'PERMISSION_DENIED' } }, 403)
      const body = bodyOf(init)
      if (body.writeControl?.requiredRevisionId !== `frev-${form.revision}`) return reply({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, 400)
      const items = structuredClone(form.items)
      const info = { ...form.info }
      for (const request of body.requests as Json[]) {
        if (request.updateFormInfo) {
          for (const field of String(request.updateFormInfo.updateMask).split(',')) (info as Json)[field] = request.updateFormInfo.info[field]
        } else if (request.createItem) {
          const index = request.createItem.location.index
          if (index < 0 || index > items.length) return reply({ error: { code: 400 } }, 400)
          items.splice(index, 0, this.materialize(request.createItem.item))
        } else if (request.updateItem) {
          const { item, location, updateMask } = request.updateItem
          const target = items[location.index]
          if (!target || target.itemId !== item.itemId) return reply({ error: { code: 400 } }, 400)
          // ใช้เฉพาะฟิลด์ใน updateMask เหมือน Google ฟิลด์อื่นของ item คงเดิม
          for (const path of String(updateMask).split(',')) {
            const keys = path.split('.')
            let from: Json = item
            let to: Json = target
            for (const key of keys.slice(0, -1)) {
              from = from?.[key] ?? {}
              to = to[key] ??= {}
            }
            to[keys[keys.length - 1]] = from?.[keys[keys.length - 1]]
          }
        } else {
          return reply({ error: { code: 400 } }, 400)
        }
      }
      form.items = items
      form.info = info
      form.revision++
      return reply({ form: this.formJson(form), replies: [], writeControl: { requiredRevisionId: `frev-${form.revision}` } })
    }
    if (method === 'GET') return reply(this.formJson(form))
    return reply({ error: { code: 400 } }, 400)
  }
}

/** สร้างการเชื่อม Google ของชมรมในฐานทดสอบ พร้อม scopes ที่ระบุ (ผ่านเส้นทาง OAuth จริงของ Worker กับ Google จำลอง) */
export const ALL_SCOPES = [
  'openid', 'email', 'https://www.googleapis.com/auth/drive.file', 'https://www.googleapis.com/auth/calendar.app.created',
  'https://www.googleapis.com/auth/calendar.calendarlist.readonly', 'https://www.googleapis.com/auth/calendar.events',
].join(' ')

import { encryptSecret } from '../worker/crypto'
import { call, CLUB_EMAIL, data, env } from './helpers'
import type { Actor } from './helpers'

export async function connectClub(google: FakeGoogle, scopes = ALL_SCOPES): Promise<void> {
  google.refreshTokens.set('refresh-secret-1', 'valid')
  await env.DB.prepare(
    `INSERT INTO google_connections (id, google_sub, email, scopes, refresh_token_enc, status, updated_at)
     VALUES ('club', 'club-sub', ?, ?, ?, 'connected', 'x')`,
  )
    .bind(CLUB_EMAIL, scopes, await encryptSecret(env.TOKEN_ENCRYPTION_KEY, 'refresh-secret-1'))
    .run()
}

/** สั่งซิงค์แบบผู้ใช้กดปุ่ม โดยข้ามช่วงเวลาขั้นต่ำระหว่างรอบ (ชุดทดสอบเรียกติดกันทันที) */
export async function syncNow(kind: string, as: Actor, options: { keepTimers?: boolean } = {}): Promise<Record<string, any>> {
  if (!options.keepTimers) await env.DB.prepare('UPDATE sync_state SET last_attempt_at = NULL, next_attempt_at = NULL WHERE kind = ?').bind(kind).run()
  const response = await call(`/api/sync/${kind}`, { method: 'POST', as, body: { force: true } })
  return data(response)
}

/** จำลอง "Google ทำคำสั่งแล้วแต่คำตอบหาย": ให้ตัวจำลองทำงานจริงหนึ่งครั้ง แล้วตอบ 500 แทน */
export function loseResponseOnce(google: FakeGoogle, ws: FakeWorkspace, match: (url: URL, method: string) => boolean): void {
  let used = false
  google.interceptors.push((url, init) => {
    const method = init?.method ?? 'GET'
    if (used || !match(url, method)) return undefined
    used = true
    ;(ws as unknown as { handle(u: URL, m: string, i?: RequestInit): Response | undefined }).handle(url, method, init)
    return new Response(JSON.stringify({ error: { code: 500 } }), { status: 500, headers: { 'Content-Type': 'application/json' } })
  })
}

export const googleCalls = (google: FakeGoogle, part: string) => google.calls.filter((c) => c.url.includes(part)).length
