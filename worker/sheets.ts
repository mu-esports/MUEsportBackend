import { sha256Hex } from './crypto'
import { nowIso } from './env'
import type { AppEnv } from './env'
import { HttpError } from './http'
import { audit } from './session'
import {
  batchAll, bumpDataVersion, GoogleApiError, isUnknownOutcome, jsonInit, makeGapi, outcomeUnknown, registerSyncer, requireWritable, SyncDataError, toHttpError,
  withLock,
} from './sync'
import type { Gapi, SyncIssue, SyncResource } from './sync'
import { bangkokToday, isStudentId, STUDENT_ID_RULE, versionConflict } from './validation'

/**
 * Google Sheets ↔ ทะเบียนสมาชิก
 * - จับคู่แถวด้วยรหัสสมาชิก (stable ID) ในคอลัมน์ที่กำหนด ไม่ใช้ลำดับแถว เพราะ sort/insert/delete เปลี่ยนตำแหน่งได้
 * - จับคู่คอลัมน์ด้วยข้อความหัวคอลัมน์ ไม่ใช้เลขคอลัมน์ จึงย้ายหรือแทรกคอลัมน์ในชีตได้
 * - เขียนกลับเฉพาะเซลล์ที่เปลี่ยนในคอลัมน์ที่ระบบดูแล ไม่ล้างชีต ไม่แตะคอลัมน์อื่น และไม่เขียนทับสูตร
 * - Sheets API ไม่มี compare-and-swap ระดับแถว: ระบบอ่านชีตทันทีก่อนเขียนและอ่านกลับหลังเขียนเพื่อยืนยัน
 *   ช่วงเวลาสั้น ๆ ระหว่างอ่านกับเขียนยังเป็น race ที่เหลืออยู่ (ดู README)
 */
export const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'
export const SHEET_MIME = 'application/vnd.google-apps.spreadsheet'
const MAX_ROWS = 5000
const MAX_ID_ASSIGN = 100

// studentId อยู่ท้ายสุด: ชีตที่เว็บสร้างไว้ก่อนมีฟิลด์นี้ยังมีหัวตารางเดิมครบตามลำดับ และเพิ่มคอลัมน์รหัสนักศึกษาต่อท้ายได้
export const MEMBER_FIELDS = ['id', 'name', 'nickname', 'role', 'status', 'contact', 'note', 'addedAt', 'studentId'] as const
export type MemberField = (typeof MEMBER_FIELDS)[number]

export const DEFAULT_HEADERS: Record<MemberField, string> = {
  id: 'รหัสสมาชิก (ระบบใช้จับคู่ ห้ามแก้)',
  name: 'ชื่อ',
  nickname: 'ชื่อเล่น',
  role: 'บทบาท',
  status: 'สถานะ',
  contact: 'ช่องทางติดต่อ',
  note: 'หมายเหตุ',
  addedAt: 'วันที่เพิ่ม',
  studentId: 'รหัสนักศึกษา',
}
export const FIELD_LABELS: Record<MemberField, string> = {
  id: 'รหัสสมาชิก', name: 'ชื่อ', nickname: 'ชื่อเล่น', role: 'บทบาท', status: 'สถานะ', contact: 'ช่องทางติดต่อ', note: 'หมายเหตุ', addedAt: 'วันที่เพิ่ม',
  studentId: 'รหัสนักศึกษา',
}
const HEADER_HINTS: Record<MemberField, string[]> = {
  id: ['รหัสสมาชิก', 'รหัส', 'id', 'member id'],
  name: ['ชื่อ', 'ชื่อ-นามสกุล', 'ชื่อ นามสกุล', 'ชื่อสมาชิก', 'name', 'full name'],
  nickname: ['ชื่อเล่น', 'nickname'],
  role: ['บทบาท', 'ตำแหน่ง', 'role'],
  status: ['สถานะ', 'status'],
  contact: ['ช่องทางติดต่อ', 'ติดต่อ', 'contact', 'discord', 'อีเมล', 'email'],
  note: ['หมายเหตุ', 'note', 'notes'],
  addedAt: ['วันที่เพิ่ม', 'วันที่สมัคร', 'วันที่', 'added', 'date'],
  studentId: ['รหัสนักศึกษา', 'รหัส นศ.', 'รหัส นศ', 'รหัสนศ.', 'รหัสนศ', 'เลขประจำตัวนักศึกษา', 'student id', 'studentid', 'student no', 'student number'],
}

export interface SheetConfig {
  sheetId: number
  /** เลขแถวของหัวตาราง (เริ่มที่ 1) */
  headerRow: number
  /** ข้อความหัวคอลัมน์ของแต่ละฟิลด์ที่ระบบดูแล ต้องมี id และ name */
  columns: Partial<Record<MemberField, string>>
}

export const sheetUrl = (spreadsheetId: string, sheetId = 0) => `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${sheetId}`

const norm = (value: unknown) => (typeof value === 'string' ? value : value === null || value === undefined ? '' : String(value)).trim()
const normHeader = (value: unknown) => norm(value).toLowerCase().replace(/\s+/g, ' ')

const ROLE_WORDS: Record<string, string> = { member: 'member', สมาชิก: 'member', staff: 'staff', ทีมงาน: 'staff', admin: 'admin', ผู้ดูแล: 'admin' }
const STATUS_WORDS: Record<string, string> = {
  active: 'active', ใช้งาน: 'active', suspended: 'suspended', พักการใช้งาน: 'suspended', พัก: 'suspended',
}
const ROLE_OUT: Record<string, string> = { member: 'สมาชิก', staff: 'ทีมงาน', admin: 'ผู้ดูแล' }
const STATUS_OUT: Record<string, string> = { active: 'ใช้งาน', suspended: 'พักการใช้งาน' }

/** รับ YYYY-MM-DD หรือ วัน/เดือน/ปี (ค.ศ. หรือ พ.ศ.) คืน YYYY-MM-DD หรือ null เมื่ออ่านไม่ได้ */
export function parseSheetDate(raw: string): string | null {
  let y: number, m: number, d: number
  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(raw)
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(raw)
  if (iso) [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])]
  else if (dmy) [d, m, y] = [Number(dmy[1]), Number(dmy[2]), Number(dmy[3])]
  else return null
  if (y > 2400) y -= 543
  const date = new Date(Date.UTC(y, m - 1, d))
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null
  return date.toISOString().slice(0, 10)
}

export interface MemberValues {
  name: string
  nickname: string
  role: string
  status: string
  contact: string
  note: string
  addedAt: string
  /** ข้อความในช่องรหัสนักศึกษาตามที่ชีตแสดง (ว่างเมื่อไม่ได้กรอกหรือชีตไม่มีคอลัมน์นี้) ค่านี้จะถูกใช้เมื่อผ่านการตรวจรูปแบบและไม่ซ้ำเท่านั้น */
  studentId: string
}

/** ค่าที่เขียนลงเซลล์ของแต่ละฟิลด์ */
const cellValue = (field: MemberField, id: string, v: MemberValues): string =>
  field === 'id' ? id : field === 'role' ? ROLE_OUT[v.role] : field === 'status' ? STATUS_OUT[v.status] : v[field]

export type StudentIdIssue = '' | 'invalid' | 'duplicate' | 'taken'

interface ParsedRow {
  /** ดัชนีแถวในชีต (เริ่มที่ 0) */
  index: number
  id: string
  values: MemberValues | null
  problems: string[]
  /** ฟิลด์ที่เว้นว่างในชีตและระบบเติมค่าเริ่มต้นให้ */
  blankAddedAt: boolean
  /** ปัญหาของช่องรหัสนักศึกษาที่ดูได้จากชีตอย่างเดียว ไม่ทำให้ข้อมูลอื่นของแถวถูกข้าม */
  studentIdIssue: StudentIdIssue
}

export interface SheetTable {
  /** ดัชนีคอลัมน์ของแต่ละฟิลด์ (เริ่มที่ 0) */
  cols: Partial<Record<MemberField, number>>
  rows: ParsedRow[]
  /** แถวที่มีข้อมูลแต่ยังไม่มีรหัส */
  withoutId: ParsedRow[]
  duplicateIds: Set<string>
  issues: SyncIssue[]
  headers: string[]
  hash: string
  rowCount: number
}

/** อ่านทั้งแท็บด้วย sheetId (ไม่ขึ้นกับชื่อแท็บ จึงเปลี่ยนชื่อแท็บใน Google ได้) */
export async function readGrid(gapi: Gapi, spreadsheetId: string, sheetId: number, render: 'FORMATTED_VALUE' | 'FORMULA' = 'FORMATTED_VALUE', rows?: [number, number]): Promise<unknown[][]> {
  const gridRange: Record<string, number> = { sheetId }
  if (rows) [gridRange.startRowIndex, gridRange.endRowIndex] = rows
  const data = await gapi.json<{ valueRanges?: { valueRange?: { values?: unknown[][] } }[] }>(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchGetByDataFilter`,
    jsonInit('POST', { dataFilters: [{ gridRange }], valueRenderOption: render, majorDimension: 'ROWS' }),
  )
  if (!Array.isArray(data.valueRanges) || data.valueRanges.length !== 1) throw new SyncDataError('ไม่พบแท็บของชีตที่เชื่อมไว้ อาจถูกลบจากไฟล์ ให้ผู้ดูแลเลือกแหล่งข้อมูลใหม่')
  const values = data.valueRanges[0].valueRange?.values ?? []
  if (!Array.isArray(values)) throw new SyncDataError('Google Sheets ตอบข้อมูลในรูปแบบที่ระบบอ่านไม่ได้')
  return values
}

/** หาคอลัมน์จากข้อความหัวคอลัมน์ที่จับคู่ไว้ คอลัมน์ที่หายหรือซ้ำทำให้ซิงค์หยุดพร้อมบอกเหตุผล ไม่เดาคอลัมน์แทน */
function resolveColumns(headers: string[], config: SheetConfig): Partial<Record<MemberField, number>> {
  const cols: Partial<Record<MemberField, number>> = {}
  for (const field of MEMBER_FIELDS) {
    const wanted = config.columns[field]
    if (!wanted) continue
    const matches = headers.map((h, i) => (normHeader(h) === normHeader(wanted) ? i : -1)).filter((i) => i >= 0)
    if (matches.length === 0) throw new SyncDataError(`ไม่พบคอลัมน์ “${wanted}” (${FIELD_LABELS[field]}) ในแถวหัวตารางของชีต อาจถูกเปลี่ยนชื่อหรือลบ แก้หัวคอลัมน์กลับ หรือให้ผู้ดูแลจับคู่คอลัมน์ใหม่`)
    if (matches.length > 1) throw new SyncDataError(`มีคอลัมน์ชื่อ “${wanted}” มากกว่าหนึ่งคอลัมน์ในชีต ระบบจึงไม่รู้ว่าต้องใช้คอลัมน์ใด เปลี่ยนชื่อคอลัมน์ที่ซ้ำให้ต่างกัน`)
    cols[field] = matches[0]
  }
  if (cols.id === undefined || cols.name === undefined) throw new SyncDataError('การจับคู่คอลัมน์ไม่ครบ ต้องมีคอลัมน์รหัสสมาชิกและชื่อ ให้ผู้ดูแลจับคู่คอลัมน์ใหม่')
  return cols
}

export function parseTable(values: unknown[][], config: SheetConfig, hash: string): SheetTable {
  if (values.length > MAX_ROWS) throw new SyncDataError(`ชีตมีมากกว่า ${MAX_ROWS.toLocaleString('en-US')} แถว เกินที่ระบบรองรับ`)
  const headerIndex = config.headerRow - 1
  const headers = (values[headerIndex] ?? []).map(norm)
  const cols = resolveColumns(headers, config)
  const cell = (row: unknown[], field: MemberField) => (cols[field] === undefined ? '' : norm(row[cols[field]!]))

  const rows: ParsedRow[] = []
  const withoutId: ParsedRow[] = []
  const seen = new Map<string, number>()
  const duplicateIds = new Set<string>()
  const issues: SyncIssue[] = []
  const today = bangkokToday()

  for (let index = headerIndex + 1; index < values.length; index++) {
    const raw = Array.isArray(values[index]) ? values[index] : []
    if (MEMBER_FIELDS.every((field) => cell(raw, field) === '')) continue
    const where = `แถว ${index + 1}`
    const problems: string[] = []
    const name = cell(raw, 'name')
    if (!name) problems.push('ไม่มีชื่อ')
    else if (name.length > 100) problems.push('ชื่อยาวเกิน 100 ตัวอักษร')
    const nickname = cell(raw, 'nickname')
    if (nickname.length > 40) problems.push('ชื่อเล่นยาวเกิน 40 ตัวอักษร')
    const roleRaw = cell(raw, 'role')
    const role = roleRaw ? ROLE_WORDS[roleRaw.toLowerCase()] : 'member'
    if (!role) problems.push(`บทบาท “${roleRaw}” ไม่ใช่ค่าที่รองรับ (สมาชิก / ทีมงาน / ผู้ดูแล)`)
    const statusRaw = cell(raw, 'status')
    const status = statusRaw ? STATUS_WORDS[statusRaw.toLowerCase()] : 'active'
    if (!status) problems.push(`สถานะ “${statusRaw}” ไม่ใช่ค่าที่รองรับ (ใช้งาน / พักการใช้งาน)`)
    const contact = cell(raw, 'contact')
    if (contact.length > 200) problems.push('ช่องทางติดต่อยาวเกิน 200 ตัวอักษร')
    const note = cell(raw, 'note')
    if (note.length > 2000) problems.push('หมายเหตุยาวเกิน 2,000 ตัวอักษร')
    const dateRaw = cell(raw, 'addedAt')
    const addedAt = dateRaw ? parseSheetDate(dateRaw) : today
    if (!addedAt) problems.push(`วันที่เพิ่ม “${dateRaw}” อ่านไม่ได้ ใช้รูปแบบ ปปปป-ดด-วว หรือ วว/ดด/ปปปป`)

    const id = cell(raw, 'id')
    if (id.length > 64) problems.push('รหัสสมาชิกยาวเกิน 64 ตัวอักษร')
    // รหัสนักศึกษาผิดรูปแบบไม่ทำให้ทั้งแถวถูกข้าม: ข้อมูลอื่นยังซิงค์ตามปกติ ส่วนรหัสนักศึกษาคงค่าเดิมในเว็บไว้จนกว่าจะแก้ที่ชีต
    const studentId = cell(raw, 'studentId')
    const studentIdIssue: StudentIdIssue = studentId !== '' && !isStudentId(studentId) ? 'invalid' : ''
    if (studentIdIssue) issues.push({ code: 'invalid_student_id', where, message: `รหัสนักศึกษาในแถวนี้${STUDENT_ID_RULE} ระบบจึงยังไม่ใช้ค่านี้` })
    const parsed: ParsedRow = {
      index,
      id,
      values: problems.length === 0 ? { name, nickname, role: role!, status: status!, contact, note, addedAt: addedAt!, studentId } : null,
      problems,
      blankAddedAt: dateRaw === '',
      studentIdIssue,
    }
    if (problems.length > 0) issues.push({ code: 'invalid_row', where, message: problems.join(' · ') })
    if (!id) {
      withoutId.push(parsed)
      continue
    }
    if (seen.has(id)) {
      duplicateIds.add(id)
      issues.push({ code: 'duplicate_id', where: `แถว ${seen.get(id)! + 1} และ ${index + 1}`, message: 'รหัสสมาชิกซ้ำกัน ระบบจึงไม่อัปเดตสมาชิกรหัสนี้จนกว่าจะแก้ให้เหลือแถวเดียว' })
    } else {
      seen.set(id, index)
    }
    rows.push(parsed)
  }

  // รหัสนักศึกษาเดียวกันอยู่มากกว่าหนึ่งแถว: ไม่รู้ว่าเป็นของใคร จึงไม่ใช้กับแถวใดเลย (ไม่รวมบัญชี ไม่ย้ายเจ้าของ)
  const byStudentId = new Map<string, ParsedRow[]>()
  for (const row of [...rows, ...withoutId]) {
    if (!row.values || row.studentIdIssue || row.values.studentId === '') continue
    const key = row.values.studentId.toLowerCase()
    byStudentId.set(key, [...(byStudentId.get(key) ?? []), row])
  }
  for (const group of byStudentId.values()) {
    if (group.length < 2) continue
    for (const row of group) row.studentIdIssue = 'duplicate'
    issues.push({
      code: 'duplicate_student_id',
      where: `แถว ${group.map((row) => row.index + 1).join(' และ ')}`,
      message: 'รหัสนักศึกษาซ้ำกัน ระบบจึงยังไม่ใช้รหัสนี้กับแถวใดเลย และเปิดบัญชีสมาชิกของแถวเหล่านี้ไม่ได้จนกว่าจะแก้ให้ไม่ซ้ำ',
    })
  }
  return { cols, rows, withoutId, duplicateIds, issues, headers, hash, rowCount: rows.length + withoutId.length }
}

export async function readTable(gapi: Gapi, resource: SyncResource): Promise<SheetTable> {
  const config = resource.config as unknown as SheetConfig
  const values = await readGrid(gapi, resource.resourceId, config.sheetId)
  return parseTable(values, config, await sha256Hex(JSON.stringify(values)))
}

/** เขียนเฉพาะเซลล์ที่ระบุ (แถว/คอลัมน์เริ่มที่ 0) ด้วยค่าแบบ RAW เพื่อให้ข้อความถูกเก็บตรงตัว */
async function writeCells(gapi: Gapi, spreadsheetId: string, sheetId: number, cells: { row: number; col: number; value: string }[]): Promise<void> {
  if (cells.length === 0) return
  await gapi.json(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}/values:batchUpdateByDataFilter`,
    jsonInit('POST', {
      valueInputOption: 'RAW',
      data: cells.map((c) => ({
        dataFilter: { gridRange: { sheetId, startRowIndex: c.row, endRowIndex: c.row + 1, startColumnIndex: c.col, endColumnIndex: c.col + 1 } },
        majorDimension: 'ROWS',
        values: [[c.value]],
      })),
    }),
  )
}

/** ต่อแถวใหม่ท้ายข้อมูลของแท็บ (Google เลือกตำแหน่งแถวเอง จึงไม่ชนกับแถวที่คนอื่นกำลังเพิ่ม) */
async function appendRows(gapi: Gapi, spreadsheetId: string, sheetId: number, rows: string[][]): Promise<void> {
  if (rows.length === 0) return
  await gapi.json(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`,
    jsonInit('POST', {
      requests: [
        {
          appendCells: {
            sheetId,
            fields: 'userEnteredValue',
            rows: rows.map((row) => ({ values: row.map((value) => (value === '' ? {} : { userEnteredValue: { stringValue: value } })) })),
          },
        },
      ],
    }),
  )
}

const rowFor = (cols: SheetTable['cols'], id: string, values: MemberValues): string[] => {
  const width = Math.max(...Object.values(cols)) + 1
  const row = new Array<string>(width).fill('')
  for (const field of MEMBER_FIELDS) if (cols[field] !== undefined) row[cols[field]!] = cellValue(field, id, values)
  return row
}

// ---------- ชีต → D1 ----------

interface MemberRow {
  id: string
  name: string
  nickname: string
  role: string
  status: string
  contact: string
  note: string
  added_at: string
  version: number
  source: string
  source_resource_id: string | null
  source_state: string
  source_hash: string | null
  student_id: string
  student_id_origin: 'web' | 'sheet'
  student_id_issue: StudentIdIssue
  student_id_claimed: string
}

const SYNC_USER = 'google-sync'

// ---------- รหัสนักศึกษา: ตัดสินค่าที่ใช้จริงจากสิ่งที่ชีตระบุ ----------

export interface StudentIdState {
  /** ค่าที่ทะเบียนใช้จริง */
  studentId: string
  origin: 'web' | 'sheet'
  issue: StudentIdIssue
  /** ค่าที่ชีตระบุแต่ยังไม่ถูกใช้ (เมื่อ issue ไม่ว่าง) */
  claimed: string
}

/**
 * ตัดสินรหัสนักศึกษาของสมาชิกแต่ละคนจากค่าที่ชีตระบุ โดยไม่ให้มีรหัสซ้ำกันและไม่ย้ายรหัสของใครไปให้คนอื่นเอง
 * - ชีตระบุค่าที่ถูกรูปแบบและไม่ซ้ำ → ใช้ค่านั้น
 * - ช่องในชีตว่าง → ล้างเฉพาะค่าที่เคยมาจากชีต ค่าที่กรอกในเว็บคงไว้ (ระบบจะเขียนกลับลงช่องที่ว่างให้เมื่อมีสิทธิ์เขียน)
 * - ค่าที่ผิดรูปแบบ ซ้ำกันในชีต หรือชนกับรหัสที่สมาชิกคนอื่นถืออยู่ → คงค่าเดิมของทุกฝ่าย แล้วบันทึกเป็นปัญหาให้ผู้ดูแลแก้ที่ชีต
 * @param current ค่าปัจจุบันของสมาชิกทุกคนในระบบ (รวมคนที่ไม่อยู่ในชีต)
 * @param claims ค่าที่ชีตระบุ เฉพาะแถวที่ใช้ได้
 */
export function planStudentIds(
  current: Map<string, { studentId: string; origin: 'web' | 'sheet' }>,
  claims: Map<string, { value: string; issue: StudentIdIssue }>,
): Map<string, StudentIdState> {
  const now = (id: string) => current.get(id) ?? { studentId: '', origin: 'web' as const }
  const plan = new Map<string, StudentIdState>()
  for (const [id, claim] of claims) {
    const before = now(id)
    if (claim.issue) plan.set(id, { ...before, issue: claim.issue, claimed: claim.value.slice(0, 64) })
    else if (claim.value === '') plan.set(id, { studentId: before.origin === 'sheet' ? '' : before.studentId, origin: 'web', issue: '', claimed: '' })
    else plan.set(id, { studentId: claim.value, origin: 'sheet', issue: '', claimed: '' })
  }
  // ค่าสุดท้ายต้องไม่ซ้ำกับใคร: เมื่อชนกัน ฝ่ายที่กำลังจะเปลี่ยนค่าเป็นฝ่ายถอยกลับไปใช้ค่าเดิมของตัวเอง
  // การถอยอาจทำให้ชนกับอีกคนที่กำลังจะรับค่านั้น จึงตรวจซ้ำจนไม่มีใครต้องถอย (จำนวนผู้เปลี่ยนค่าลดลงทุกรอบ)
  for (;;) {
    const holders = new Map<string, string[]>()
    for (const id of new Set([...current.keys(), ...plan.keys()])) {
      const value = (plan.get(id) ?? now(id)).studentId.toLowerCase()
      if (value) holders.set(value, [...(holders.get(value) ?? []), id])
    }
    let reverted = false
    for (const ids of holders.values()) {
      if (ids.length < 2) continue
      for (const id of ids) {
        const planned = plan.get(id)
        const before = now(id)
        if (!planned || planned.studentId.toLowerCase() === before.studentId.toLowerCase()) continue
        plan.set(id, { ...before, issue: 'taken', claimed: planned.studentId.slice(0, 64) })
        reverted = true
      }
    }
    if (!reverted) return plan
  }
}

/** ปรับสำเนาใน D1 ให้ตรงกับชีตที่อ่านมา คืน true เมื่อมีแถวเปลี่ยน */
export async function applyTable(env: AppEnv, resource: SyncResource, table: SheetTable): Promise<boolean> {
  const { results: existing } = await env.DB.prepare('SELECT * FROM members').all<MemberRow>()
  const byId = new Map(existing.map((m) => [m.id, m]))
  const statements: D1PreparedStatement[] = []
  const now = nowIso()
  const present = new Set<string>()

  for (const row of table.rows) {
    present.add(row.id)
    // แถวที่ผิดรูปแบบหรือรหัสซ้ำ: คงสำเนาเดิมไว้ ไม่ทับด้วยค่าที่ไม่แน่ใจ และไม่ถือว่าหายจากชีต
    if (!row.values || table.duplicateIds.has(row.id)) continue
    const v = row.values
    const hash = await sha256Hex(JSON.stringify([v.name, v.nickname, v.role, v.status, v.contact, v.note, v.addedAt]))
    const current = byId.get(row.id)
    if (!current) {
      statements.push(
        env.DB.prepare(
          `INSERT INTO members (id, name, nickname, role, status, contact, note, added_at, version, created_by, updated_by, created_at, updated_at,
                                source, source_resource_id, source_state, source_hash)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'sheets', ?, 'ok', ?)`,
        ).bind(row.id, v.name, v.nickname, v.role, v.status, v.contact, v.note, v.addedAt, SYNC_USER, SYNC_USER, now, now, resource.resourceId, hash),
      )
    } else if (current.source_hash !== hash || current.source !== 'sheets' || current.source_state !== 'ok' || current.source_resource_id !== resource.resourceId) {
      const same =
        current.name === v.name && current.nickname === v.nickname && current.role === v.role && current.status === v.status &&
        current.contact === v.contact && current.note === v.note && current.added_at === v.addedAt
      statements.push(
        env.DB.prepare(
          `UPDATE members SET name = ?, nickname = ?, role = ?, status = ?, contact = ?, note = ?, added_at = ?, version = version + ?,
                  updated_by = CASE WHEN ? = 1 THEN ? ELSE updated_by END, updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END,
                  source = 'sheets', source_resource_id = ?, source_state = 'ok', source_hash = ?, source_missing_at = NULL
            WHERE id = ?`,
        ).bind(v.name, v.nickname, v.role, v.status, v.contact, v.note, v.addedAt, same ? 0 : 1, same ? 0 : 1, SYNC_USER, same ? 0 : 1, now, resource.resourceId, hash, row.id),
      )
    }
  }

  // แถวที่หายจากชีต: ทำเครื่องหมายว่าไม่พบต้นฉบับ เก็บข้อมูลไว้ ไม่ลบสมาชิกอัตโนมัติ
  const missing = existing.filter((m) => m.source === 'sheets' && m.source_resource_id === resource.resourceId && m.source_state === 'ok' && !present.has(m.id))
  for (const member of missing) {
    statements.push(env.DB.prepare(`UPDATE members SET source_state = 'missing', source_missing_at = ?, version = version + 1 WHERE id = ?`).bind(now, member.id))
  }

  // รหัสนักศึกษา: ล้างค่าเดิมของคนที่กำลังจะเปลี่ยนก่อน แล้วจึงใส่ค่าใหม่ เพื่อให้การสลับรหัสระหว่างสองแถวไม่ชน unique index กลางทาง
  const clears: D1PreparedStatement[] = []
  if (table.cols.studentId !== undefined) {
    const claims = new Map<string, { value: string; issue: StudentIdIssue }>()
    for (const row of table.rows) {
      if (row.values && !table.duplicateIds.has(row.id)) claims.set(row.id, { value: row.values.studentId, issue: row.studentIdIssue })
    }
    const plan = planStudentIds(new Map(existing.map((m) => [m.id, { studentId: m.student_id, origin: m.student_id_origin }])), claims)
    for (const [id, next] of plan) {
      const before = byId.get(id)
      const was = before
        ? { studentId: before.student_id, origin: before.student_id_origin, issue: before.student_id_issue, claimed: before.student_id_claimed }
        : { studentId: '', origin: 'web', issue: '', claimed: '' }
      if (was.studentId === next.studentId && was.origin === next.origin && was.issue === next.issue && was.claimed === next.claimed) continue
      const valueChanged = was.studentId !== next.studentId
      if (valueChanged && was.studentId !== '') clears.push(env.DB.prepare(`UPDATE members SET student_id = '' WHERE id = ?`).bind(id))
      statements.push(
        env.DB.prepare(
          `UPDATE members SET student_id = ?, student_id_origin = ?, student_id_issue = ?, student_id_claimed = ?, version = version + ?,
                  updated_by = CASE WHEN ? = 1 THEN ? ELSE updated_by END, updated_at = CASE WHEN ? = 1 THEN ? ELSE updated_at END
            WHERE id = ?`,
        ).bind(next.studentId, next.origin, next.issue, next.claimed, valueChanged ? 1 : 0, valueChanged ? 1 : 0, SYNC_USER, valueChanged ? 1 : 0, now, id),
      )
    }
  } else if (existing.some((m) => m.source === 'sheets' && m.source_resource_id === resource.resourceId && (m.student_id_origin !== 'web' || m.student_id_issue !== ''))) {
    // ชีตนี้ไม่มีคอลัมน์รหัสนักศึกษา: ค่าในเว็บเป็นค่าหลัก และปัญหาที่เคยบันทึกจากคอลัมน์เดิมไม่เกี่ยวข้องแล้ว
    statements.push(
      env.DB.prepare(`UPDATE members SET student_id_origin = 'web', student_id_issue = '', student_id_claimed = '' WHERE source = 'sheets' AND source_resource_id = ?`).bind(resource.resourceId),
    )
  }

  await batchAll(env, [...clears, ...statements])
  for (const member of missing.slice(0, 20)) await audit(env, null, 'member.source_missing', member.id, resource.resourceId)
  return statements.length > 0
}

/** ปัญหาของรหัสนักศึกษาที่ต้องดูจากข้อมูลในระบบประกอบ (ชนกับรหัสที่สมาชิกคนอื่นถืออยู่ หรือยังไม่ได้อยู่ในชีต) */
async function studentIdIssues(env: AppEnv, resource: SyncResource, table: SheetTable): Promise<SyncIssue[]> {
  if (table.cols.studentId === undefined) return []
  const { results } = await env.DB.prepare(
    `SELECT id, student_id, student_id_origin, student_id_issue FROM members WHERE student_id_issue = 'taken' OR (student_id <> '' AND student_id_origin = 'web')`,
  ).all<Pick<MemberRow, 'id' | 'student_id' | 'student_id_origin' | 'student_id_issue'>>()
  const byId = new Map(results.map((m) => [m.id, m]))
  const issues: SyncIssue[] = []
  for (const row of table.rows) {
    const member = byId.get(row.id)
    if (!member || !row.values) continue
    const where = `แถว ${row.index + 1}`
    if (member.student_id_issue === 'taken') {
      issues.push({ code: 'student_id_taken', where, message: 'รหัสนักศึกษาในแถวนี้ตรงกับรหัสที่สมาชิกอีกคนในระบบใช้อยู่ ระบบจึงยังไม่ใช้ค่านี้ ตรวจว่าแถวใดถูกต้องแล้วแก้ให้ไม่ซ้ำ' })
    } else if (row.values.studentId === '' && member.student_id_origin === 'web' && resource.access !== 'write') {
      issues.push({ code: 'student_id_not_in_sheet', where, message: 'สมาชิกแถวนี้มีรหัสนักศึกษาที่กรอกไว้ในเว็บ แต่ช่องในชีตยังว่าง และเว็บไม่มีสิทธิ์เขียนชีตนี้ พิมพ์รหัสนักศึกษาลงในชีตเพื่อให้ตรงกัน' })
    }
  }
  return issues
}

/**
 * รหัสนักศึกษาที่กรอกไว้ในเว็บก่อนชีตจะมีคอลัมน์นี้: เขียนลงช่องที่ยังว่างของแถวสมาชิกคนนั้น เพื่อให้ชีตกับเว็บตรงกัน
 * เขียนเฉพาะช่องที่ว่างจริง (ตรวจแบบสูตรทันทีก่อนเขียน) และแถวต้องยังเป็นของรหัสสมาชิกเดิม ไม่เขียนทับค่าหรือสูตรใด
 */
async function fillStudentIds(env: AppEnv, gapi: Gapi, resource: SyncResource, table: SheetTable): Promise<boolean> {
  const col = table.cols.studentId
  if (col === undefined || resource.access !== 'write') return false
  const { results } = await env.DB.prepare(`SELECT id, student_id FROM members WHERE student_id <> '' AND student_id_origin = 'web'`).all<{ id: string; student_id: string }>()
  if (results.length === 0) return false
  const fromWeb = new Map(results.map((m) => [m.id, m.student_id]))
  const targets = table.rows.filter((row) => row.values && !table.duplicateIds.has(row.id) && row.values.studentId === '' && fromWeb.has(row.id)).slice(0, MAX_ID_ASSIGN)
  if (targets.length === 0) return false
  const config = resource.config as unknown as SheetConfig
  const raw = await readGrid(gapi, resource.resourceId, config.sheetId, 'FORMULA')
  const cells = targets
    .filter((row) => norm(raw[row.index]?.[table.cols.id!]) === row.id && norm(raw[row.index]?.[col]) === '')
    .map((row) => ({ row: row.index, col, value: fromWeb.get(row.id)! }))
  if (cells.length === 0) return false
  await writeCells(gapi, resource.resourceId, config.sheetId, cells)
  return true
}

/** แถวที่พิมพ์เพิ่มใน Google โดยยังไม่มีรหัส: ระบบออกรหัสและเขียนลงเฉพาะเซลล์รหัส (และวันที่เพิ่มถ้าเว้นว่าง) ของแถวนั้น */
async function assignIds(gapi: Gapi, resource: SyncResource, table: SheetTable): Promise<boolean> {
  const targets = table.withoutId.filter((row) => row.values).slice(0, MAX_ID_ASSIGN)
  if (targets.length === 0 || resource.access !== 'write') return false
  const config = resource.config as unknown as SheetConfig
  const cells: { row: number; col: number; value: string }[] = []
  for (const row of targets) {
    cells.push({ row: row.index, col: table.cols.id!, value: crypto.randomUUID() })
    if (row.blankAddedAt && table.cols.addedAt !== undefined) cells.push({ row: row.index, col: table.cols.addedAt, value: row.values!.addedAt })
  }
  await writeCells(gapi, resource.resourceId, config.sheetId, cells)
  return true
}

registerSyncer('sheets', async ({ env, gapi, resource, remoteVersion }) => {
  let table = await readTable(gapi, resource!)
  // ออกรหัสให้แถวใหม่แล้วอ่านซ้ำ เพื่อให้สำเนาใน D1 มาจากสิ่งที่อยู่ในชีตจริงหลังเขียน
  if (await assignIds(gapi, resource!, table)) table = await readTable(gapi, resource!)
  const extra: SyncIssue[] = []
  try {
    if (await fillStudentIds(env, gapi, resource!, table)) table = await readTable(gapi, resource!)
  } catch (error) {
    // Google ไม่รับการเขียนช่องรหัสนักศึกษา (เช่น ช่วงที่ถูกป้องกัน): ไม่ทำให้การซิงค์ข้อมูลอื่นหยุด
    if (!(error instanceof GoogleApiError) || error.status >= 500 || error.status === 429) throw error
    extra.push({ code: 'student_id_fill_failed', message: 'Google ไม่ให้เว็บเขียนรหัสนักศึกษาลงช่องที่ว่างในชีต (อาจเป็นช่วงที่ถูกป้องกัน) พิมพ์รหัสนักศึกษาลงในชีตเองเพื่อให้ตรงกับในเว็บ' })
  }
  const issues = [...table.issues, ...extra]
  for (const row of table.withoutId) {
    if (row.values) issues.push({ code: 'no_id', where: `แถว ${row.index + 1}`, message: resource!.access === 'write' ? 'ยังไม่มีรหัสสมาชิก ระบบจะออกรหัสให้ในรอบถัดไป' : 'ยังไม่มีรหัสสมาชิก และเว็บไม่มีสิทธิ์เขียนชีตนี้ จึงยังไม่นำเข้า' })
  }
  if (table.hash === remoteVersion) return { changed: false, issues: [...issues, ...(await studentIdIssues(env, resource!, table))] }
  const changed = await applyTable(env, resource!, table)
  return { changed, remoteVersion: table.hash, issues: [...issues, ...(await studentIdIssues(env, resource!, table))] }
})

// ---------- เว็บ → ชีต ----------

const getRow = (env: AppEnv, id: string) => env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<MemberRow>()

async function refreshed(env: AppEnv, gapi: Gapi, resource: SyncResource): Promise<SheetTable> {
  const table = await readTable(gapi, resource)
  if (await applyTable(env, resource, table)) await bumpDataVersion(env, 'sheets')
  await env.DB.prepare(`UPDATE sync_state SET remote_version = ?, updated_at = ? WHERE kind = 'sheets' AND resource_id = ?`).bind(table.hash, nowIso(), resource.resourceId).run()
  return table
}

const matches = (row: ParsedRow | undefined, values: MemberValues, fields: MemberField[]) =>
  !!row?.values && fields.every((field) => field === 'id' || row.values![field as keyof MemberValues] === values[field as keyof MemberValues])

/** เพิ่มสมาชิกจากเว็บ: ต่อแถวใหม่ในชีต แล้วอ่านกลับเพื่อยืนยันก่อนบอกว่าสำเร็จ */
export async function appendMember(env: AppEnv, resource: SyncResource, id: string, input: Omit<MemberValues, 'addedAt'>): Promise<void> {
  requireWritable(resource, 'ชีต')
  const gapi = makeGapi(env)
  const config = resource.config as unknown as SheetConfig
  const values: MemberValues = { ...input, addedAt: bangkokToday() }
  await withLock(env, 'sheets', async () => {
  try {
    const before = await refreshed(env, gapi, resource)
    // คำขอเดิมที่ลองใหม่: ถ้าแถวของรหัสนี้อยู่ในชีตแล้ว ไม่ต่อแถวซ้ำ
    if (before.rows.some((row) => row.id === id)) return
    for (const field of ['nickname', 'role', 'status', 'contact', 'note'] as const) {
      const blank = field === 'role' ? values.role === 'member' : field === 'status' ? values.status === 'active' : values[field] === ''
      if (before.cols[field] === undefined && !blank) {
        throw new HttpError(422, 'column_not_mapped', `ชีตที่เชื่อมไว้ไม่มีคอลัมน์${FIELD_LABELS[field]} จึงบันทึกค่านี้ไม่ได้ ให้ผู้ดูแลเพิ่มและจับคู่คอลัมน์ก่อน`, { field })
      }
    }
    try {
      await appendRows(gapi, resource.resourceId, config.sheetId, [rowFor(before.cols, id, values)])
    } catch (error) {
      if (isUnknownOutcome(error)) throw outcomeUnknown('สมาชิกใหม่ลงชีต')
      throw error
    }
    const after = await refreshed(env, gapi, resource)
    if (!after.rows.some((row) => row.id === id && row.values)) {
      throw new HttpError(502, 'saved_unverified', 'Google Sheets รับคำสั่งเพิ่มแถวแล้ว แต่ระบบอ่านกลับไม่พบแถวใหม่ เปิดชีตเพื่อตรวจก่อนเพิ่มซ้ำ')
    }
  } catch (error) {
    throw toHttpError(error)
  }
  })
}

/**
 * แก้สมาชิกจากเว็บ: อ่านชีตล่าสุดก่อน ถ้าแถวนี้ถูกแก้ใน Google หลังจากที่ผู้ใช้เปิดฟอร์ม จะได้ version_conflict
 * จากนั้นเขียนเฉพาะเซลล์ที่เปลี่ยน และอ่านกลับเพื่อยืนยัน
 */
export async function updateMemberRow(env: AppEnv, resource: SyncResource, id: string, changes: Partial<Omit<MemberValues, 'addedAt'>>, expectedVersion: number): Promise<void> {
  requireWritable(resource, 'ชีต')
  const gapi = makeGapi(env)
  const config = resource.config as unknown as SheetConfig
  await withLock(env, 'sheets', async () => {
  try {
    const table = await refreshed(env, gapi, resource)
    const current = await getRow(env, id)
    if (!current) throw new HttpError(404, 'not_found', 'ไม่พบสมาชิกนี้ อาจถูกลบหรือลิงก์ไม่ถูกต้อง')
    if (current.source_state === 'missing') {
      throw new HttpError(409, 'source_missing', 'ไม่พบแถวของสมาชิกนี้ในชีตแล้ว จึงแก้จากเว็บไม่ได้ ตรวจชีตต้นฉบับ ถ้าแถวถูกลบโดยไม่ตั้งใจให้กู้คืนจากประวัติเวอร์ชันของ Google Sheets')
    }
    if (current.version !== expectedVersion) throw versionConflict(toApiMember(current))
    const row = table.rows.find((r) => r.id === id)
    if (!row?.values || table.duplicateIds.has(id)) {
      throw new HttpError(409, 'source_row_invalid', `แถวของสมาชิกนี้ในชีตมีปัญหา (แถว ${row ? row.index + 1 : '?'}) แก้ที่ชีตให้ถูกต้องก่อน แล้วจึงแก้จากเว็บได้`)
    }

    const target: MemberValues = { ...row.values, ...changes }
    const fields = (Object.keys(changes) as (keyof typeof changes)[]).filter((field) => row.values![field] !== target[field])
    if (fields.length === 0) return
    for (const field of fields) {
      if (table.cols[field] === undefined) {
        throw new HttpError(422, 'column_not_mapped', `ชีตที่เชื่อมไว้ไม่มีคอลัมน์${FIELD_LABELS[field]} จึงแก้ค่านี้จากเว็บไม่ได้ ให้ผู้ดูแลเพิ่มและจับคู่คอลัมน์ก่อน`, { field })
      }
    }

    // อ่านแถวนี้แบบสูตรทันทีก่อนเขียน: ยืนยันว่าแถวยังเป็นของรหัสเดิม และเซลล์ที่จะเขียนไม่ใช่สูตร
    const [raw = []] = await readGrid(gapi, resource.resourceId, config.sheetId, 'FORMULA', [row.index, row.index + 1])
    if (norm(raw[table.cols.id!]) !== id) {
      throw new HttpError(409, 'source_moved', 'แถวในชีตถูกย้ายระหว่างที่กำลังบันทึก ยังไม่ได้เขียนอะไร กดบันทึกอีกครั้ง')
    }
    const formula = fields.find((field) => norm(raw[table.cols[field]!]).startsWith('='))
    if (formula) {
      throw new HttpError(409, 'cell_is_formula', `ช่อง${FIELD_LABELS[formula]}ของสมาชิกนี้ในชีตเป็นสูตร ระบบไม่เขียนทับสูตร แก้ค่านี้ที่ชีตโดยตรง`, { field: formula })
    }

    try {
      await writeCells(gapi, resource.resourceId, config.sheetId, fields.map((field) => ({ row: row.index, col: table.cols[field]!, value: cellValue(field, id, target) })))
    } catch (error) {
      if (isUnknownOutcome(error)) throw outcomeUnknown('การแก้ไขลงชีต')
      throw error
    }

    const after = await refreshed(env, gapi, resource)
    if (matches(after.rows.find((r) => r.id === id), target, fields)) return
    // ตรวจกรณีแถวถูกเรียง/แทรกในช่วงสั้น ๆ ระหว่างอ่านกับเขียน ทำให้ค่าลงผิดแถว
    const atOldIndex = [...after.rows, ...after.withoutId].find((r) => r.index === row.index)
    if (atOldIndex && atOldIndex.id !== id && matches(atOldIndex, target, fields)) {
      await audit(env, null, 'member.write_misplaced', id, `row ${row.index + 1}`)
      throw new HttpError(502, 'write_misplaced', `แถวในชีตถูกย้ายพร้อมกับที่ระบบกำลังเขียน ค่าที่บันทึกจึงอาจไปอยู่ที่แถว ${row.index + 1} ซึ่งตอนนี้เป็นของสมาชิกคนอื่น เปิดชีตเพื่อตรวจและแก้แถวนั้นทันที (ดูประวัติเวอร์ชันของ Google Sheets ได้)`)
    }
    throw new HttpError(502, 'saved_unverified', 'Google Sheets รับการบันทึกแล้ว แต่ค่าที่อ่านกลับไม่ตรงกับที่ส่ง (อาจมีคนแก้แถวเดียวกันพร้อมกัน) ตรวจค่าล่าสุดก่อนบันทึกซ้ำ')
  } catch (error) {
    throw toHttpError(error)
  }
  })
}

interface ApiMember {
  id: string
  name: string
  nickname: string
  role: string
  status: string
  contact: string
  note: string
  addedAt: string
  version: number
  source: string
  sourceState: string
}
export const toApiMember = (row: MemberRow & { created_at?: string; updated_at?: string }): ApiMember & { createdAt?: string; updatedAt?: string; studentId: string } => ({
  id: row.id,
  name: row.name,
  nickname: row.nickname,
  studentId: row.student_id,
  role: row.role,
  status: row.status,
  contact: row.contact,
  note: row.note,
  addedAt: row.added_at,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  source: row.source,
  sourceState: row.source_state,
})

// ---------- ตั้งค่า: ดูตัวอย่างและย้ายข้อมูลเดิมขึ้นชีต ----------

export interface SheetTab {
  sheetId: number
  title: string
  columnCount: number
}

export async function listTabs(gapi: Gapi, spreadsheetId: string): Promise<{ title: string; tabs: SheetTab[] }> {
  const data = await gapi.json<{ properties?: { title?: string }; sheets?: { properties?: { sheetId?: number; title?: string; sheetType?: string; gridProperties?: { columnCount?: number } } }[] }>(
    `${SHEETS_API}/${encodeURIComponent(spreadsheetId)}?fields=properties.title,sheets.properties(sheetId,title,sheetType,gridProperties.columnCount)`,
  )
  const tabs = (data.sheets ?? [])
    .map((s) => s.properties)
    .filter((p): p is NonNullable<typeof p> => !!p && typeof p.sheetId === 'number' && (p.sheetType ?? 'GRID') === 'GRID')
    .map((p) => ({ sheetId: p.sheetId!, title: p.title ?? '', columnCount: p.gridProperties?.columnCount ?? 26 }))
  return { title: data.properties?.title ?? '', tabs }
}

/** เดาการจับคู่จากหัวคอลัมน์ ผู้ดูแลตรวจและแก้ได้ก่อนยืนยัน */
export function suggestColumns(headers: string[]): Partial<Record<MemberField, string>> {
  const out: Partial<Record<MemberField, string>> = {}
  const used = new Set<number>()
  for (const field of MEMBER_FIELDS) {
    const index = headers.findIndex((h, i) => !used.has(i) && h !== '' && (normHeader(h) === normHeader(DEFAULT_HEADERS[field]) || HEADER_HINTS[field].includes(normHeader(h))))
    if (index >= 0) {
      out[field] = headers[index]
      used.add(index)
    }
  }
  return out
}

export interface SheetPreview {
  headers: string[]
  columns: Partial<Record<MemberField, string>>
  /** null เมื่อยังจับคู่ไม่ครบหรือชีตผิดรูปแบบ พร้อมเหตุผลใน problem */
  stats: { rows: number; withId: number; withoutId: number; invalid: number; duplicateIds: number; matchedLocal: number; newFromSheet: number; localOnly: number } | null
  problem: string | null
  issues: SyncIssue[]
}

export async function previewSheet(env: AppEnv, gapi: Gapi, spreadsheetId: string, sheetId: number, headerRow: number, columns?: Partial<Record<MemberField, string>>): Promise<SheetPreview> {
  const values = await readGrid(gapi, spreadsheetId, sheetId)
  const headers = (values[headerRow - 1] ?? []).map(norm)
  const mapping = columns ?? suggestColumns(headers)
  const { results: local } = await env.DB.prepare('SELECT id FROM members').all<{ id: string }>()
  const localIds = new Set(local.map((m) => m.id))
  if (!mapping.name) return { headers, columns: mapping, stats: null, problem: 'ยังไม่ได้จับคู่คอลัมน์ชื่อ', issues: [] }
  try {
    // ชีตที่ยังไม่มีคอลัมน์รหัส: นับแถวโดยใช้คอลัมน์ชื่อแทนชั่วคราว (ทุกแถวจะถือว่ายังไม่มีรหัส)
    const config: SheetConfig = { sheetId, headerRow, columns: mapping.id ? mapping : { ...mapping, id: mapping.name } }
    const table = parseTable(values, config, '')
    const rows = mapping.id ? table.rows : []
    const withoutId = mapping.id ? table.withoutId : [...table.rows, ...table.withoutId]
    const matched = rows.filter((r) => localIds.has(r.id)).length
    return {
      headers,
      columns: mapping,
      stats: {
        rows: table.rowCount,
        withId: rows.length,
        withoutId: withoutId.length,
        invalid: table.issues.filter((i) => i.code === 'invalid_row').length,
        duplicateIds: mapping.id ? table.duplicateIds.size : 0,
        matchedLocal: matched,
        newFromSheet: table.rowCount - matched,
        localOnly: localIds.size - matched,
      },
      problem: null,
      issues: (mapping.id ? table.issues : table.issues.filter((i) => i.code === 'invalid_row')).slice(0, 20),
    }
  } catch (error) {
    if (error instanceof SyncDataError) return { headers, columns: mapping, stats: null, problem: error.message, issues: [] }
    throw error
  }
}

/** เขียนแถวหัวตารางของชีตที่เว็บสร้าง เฉพาะเมื่อแถวแรกยังว่าง (ทำซ้ำได้โดยไม่ทับของเดิม) */
export async function initCreatedSheet(gapi: Gapi, spreadsheetId: string): Promise<SheetConfig> {
  const { tabs } = await listTabs(gapi, spreadsheetId)
  if (tabs.length === 0) throw new SyncDataError('ไฟล์ชีตที่สร้างไม่มีแท็บให้ใช้')
  const sheetId = tabs[0].sheetId
  const [first = []] = await readGrid(gapi, spreadsheetId, sheetId, 'FORMATTED_VALUE', [0, 1])
  const headers = MEMBER_FIELDS.map((field) => DEFAULT_HEADERS[field])
  // ช่องหัวตารางที่มีข้อความอยู่แล้วต้องตรงกับหัวของระบบ ช่องที่ยังว่างจึงเขียนเติมได้ (รวมชีตที่เริ่มสร้างไว้ก่อนมีคอลัมน์รหัสนักศึกษา)
  if (headers.some((h, i) => norm(first[i]) !== '' && normHeader(first[i]) !== normHeader(h))) {
    throw new SyncDataError('ชีตที่สร้างไว้มีข้อมูลในแถวแรกที่ไม่ใช่หัวตารางของระบบ จึงไม่เขียนทับ เปิดชีตเพื่อตรวจ')
  }
  await writeCells(gapi, spreadsheetId, sheetId, headers.map((value, col) => ({ row: 0, col, value })).filter((cell) => norm(first[cell.col]) === ''))
  return { sheetId, headerRow: 1, columns: { ...DEFAULT_HEADERS } }
}

/** เพิ่มหัวคอลัมน์ใหม่ในคอลัมน์ว่างถัดจากคอลัมน์สุดท้ายที่มีหัว ไม่แตะคอลัมน์เดิม */
export async function addHeaderColumn(gapi: Gapi, spreadsheetId: string, tab: SheetTab, headerRow: number, header: string): Promise<string> {
  const [headers = []] = await readGrid(gapi, spreadsheetId, tab.sheetId, 'FORMATTED_VALUE', [headerRow - 1, headerRow])
  let col = headers.length
  while (col > 0 && norm(headers[col - 1]) === '') col--
  if (col >= tab.columnCount) {
    await gapi.json(`${SHEETS_API}/${encodeURIComponent(spreadsheetId)}:batchUpdate`, jsonInit('POST', { requests: [{ appendDimension: { sheetId: tab.sheetId, dimension: 'COLUMNS', length: 1 } }] }))
  }
  await writeCells(gapi, spreadsheetId, tab.sheetId, [{ row: headerRow - 1, col, value: header }])
  return header
}

/** ชีตเดิมที่ไม่มีคอลัมน์รหัสสมาชิก: เพิ่มหัวคอลัมน์รหัสต่อท้าย */
export const addIdColumn = (gapi: Gapi, spreadsheetId: string, tab: SheetTab, headerRow: number) => addHeaderColumn(gapi, spreadsheetId, tab, headerRow, DEFAULT_HEADERS.id)

const nameKey = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ')

/** ก่อนย้าย: จำนวนสมาชิกที่อยู่เฉพาะในเว็บ และคนที่ชื่อตรงกับแถวที่มีอยู่แล้วในชีต (อาจเป็นคนเดียวกันที่รหัสไม่ตรง) ให้ผู้ดูแลตัดสิน */
export async function previewLocalMembers(env: AppEnv, resource: SyncResource): Promise<{ count: number; duplicates: { id: string; title: string; detail: string }[] }> {
  try {
    const table = await readTable(makeGapi(env), resource)
    const inSheet = new Set(table.rows.map((r) => r.id))
    const names = new Set([...table.rows, ...table.withoutId].filter((r) => r.values).map((r) => nameKey(r.values!.name)))
    const { results: local } = await env.DB.prepare(`SELECT id, name, nickname FROM members WHERE source = 'local' ORDER BY name`).all<{ id: string; name: string; nickname: string }>()
    const pending = local.filter((m) => !inSheet.has(m.id))
    return { count: pending.length, duplicates: pending.filter((m) => names.has(nameKey(m.name))).map((m) => ({ id: m.id, title: m.name, detail: m.nickname })) }
  } catch (error) {
    throw toHttpError(error)
  }
}

/** ย้ายสมาชิกที่อยู่เฉพาะในเว็บขึ้นชีต: ต่อแถวใหม่พร้อมรหัสเดิม ทำซ้ำได้ (แถวที่รหัสอยู่ในชีตแล้วจะไม่ถูกต่อซ้ำ) */
export async function pushLocalMembers(env: AppEnv, resource: SyncResource, skipIds: string[] = []): Promise<{ pushed: number; remaining: number; skipped: number }> {
  requireWritable(resource, 'ชีต')
  const gapi = makeGapi(env)
  const config = resource.config as unknown as SheetConfig
  return withLock(env, 'sheets', async () => {
  try {
    const table = await refreshed(env, gapi, resource)
    const inSheet = new Set(table.rows.map((r) => r.id))
    const { results: local } = await env.DB.prepare(`SELECT * FROM members WHERE source = 'local' ORDER BY added_at, name`).all<MemberRow>()
    const skip = new Set(skipIds)
    const pending = local.filter((m) => !inSheet.has(m.id) && !skip.has(m.id)).slice(0, 500)
    if (pending.length > 0) {
      try {
        await appendRows(gapi, resource.resourceId, config.sheetId, pending.map((m) =>
          rowFor(table.cols, m.id, { name: m.name, nickname: m.nickname, role: m.role, status: m.status, contact: m.contact, note: m.note, addedAt: m.added_at, studentId: m.student_id })))
      } catch (error) {
        if (isUnknownOutcome(error)) throw outcomeUnknown('รายชื่อสมาชิกลงชีต')
        throw error
      }
      await refreshed(env, gapi, resource)
    }
    const { results: left } = await env.DB.prepare(`SELECT id FROM members WHERE source = 'local'`).all<{ id: string }>()
    const skipped = left.filter((m) => skip.has(m.id)).length
    return { pushed: pending.length, remaining: left.length - skipped, skipped }
  } catch (error) {
    throw toHttpError(error)
  }
  })
}

export { GoogleApiError }
