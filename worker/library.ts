import { sha256Hex } from './crypto'
import { nowIso } from './env'
import type { AppEnv, Ctx, Session } from './env'
import { describeItem, FORMS_API } from './gforms'
import { DRIVE_READONLY_SCOPE, getAccessToken, loadConnection, missingConnectConfig } from './google'
import { HttpError, json } from './http'
import { requireViewer } from './session'
import { SHEETS_API } from './sheets'
import { classify, GoogleApiError, makeGapi, toApiError } from './sync'
import type { Gapi } from './sync'

/**
 * คลังไฟล์ชมรม: รายการและตัวอย่าง (อ่านอย่างเดียว) ของไฟล์ทั้งหมดที่บัญชี Google ของชมรมเข้าถึงได้
 * - ใช้ token ของบัญชีชมรมที่เชื่อมอยู่บน Worker เท่านั้น ไม่ใช้บัญชีของสมาชิกหรือของทีมงาน และ token ไม่ถูกส่งให้เบราว์เซอร์ในรูปใด
 * - ทุกเส้นทางตรวจ session ทุกครั้ง: ทีมงาน หรือสมาชิกที่บัญชีเปิดใช้งานและเปลี่ยนรหัสผ่านชั่วคราวแล้ว
 * - รับเฉพาะรหัสไฟล์ของ Drive แล้วประกอบ URL ของ Google API เอง ไม่รับ URL จากเบราว์เซอร์ จึงไม่ใช่ proxy ไปที่อื่น
 * - แยกจากแหล่งข้อมูลที่ซิงค์ (ชีตทะเบียน ปฏิทิน ฟอร์มที่นำคำตอบเข้า): การเห็นไฟล์ในคลังไม่ทำให้ไฟล์นั้นถูกนำไปสร้างข้อมูลในระบบ
 * - ไม่แก้สิทธิ์การแชร์ของไฟล์ใด และไม่เขียนอะไรลง Google
 */
const DRIVE_FILES = 'https://www.googleapis.com/drive/v3/files'

export const PAGE_SIZE = 30
/** ขนาดสูงสุดของไฟล์ PDF/รูปภาพที่ส่งเป็นตัวอย่างผ่านเว็บ */
export const MAX_PREVIEW_BYTES = 25 * 1024 * 1024
/** ขนาดสูงสุดของไฟล์ข้อความที่อ่านมาแสดง (ส่วนที่เกินไม่ถูกอ่าน และหน้าเว็บบอกว่าแสดงไม่ครบ) */
export const MAX_TEXT_BYTES = 512 * 1024
export const SHEET_ROWS = 200
export const SHEET_COLUMNS = 40

/** รายการที่เพิ่งดึงจาก Google ใช้ซ้ำได้ภายในเวลานี้ เพื่อไม่เรียก Drive ทุกครั้งที่มีคนเปิดหน้า */
const CACHE_TTL_MS = 60_000
/** ปุ่ม “รีเฟรช” ข้ามสำเนาชั่วคราวได้ แต่ไม่ถี่กว่าเวลานี้ต่อหนึ่งคำค้น */
const FRESH_MIN_MS = 10_000
/** สำเนาชั่วคราวที่เก่ากว่านี้ไม่ใช้แสดงแทนเมื่อ Google ล้มเหลว */
const STALE_MAX_MS = 24 * 60 * 60_000
const FOLDER_TTL_MS = 60 * 60_000
const MAX_FOLDER_LOOKUPS = 6
const MAX_BACKOFF_MS = 30 * 60_000

const MIME = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
  form: 'application/vnd.google-apps.form',
  drawing: 'application/vnd.google-apps.drawing',
  folder: 'application/vnd.google-apps.folder',
  shortcut: 'application/vnd.google-apps.shortcut',
  pdf: 'application/pdf',
} as const

const OFFICE_MIMES = [
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
]
/** รูปภาพที่เบราว์เซอร์แสดงได้และไม่มีสคริปต์ในตัว (SVG ไม่อยู่ในรายการโดยเจตนา) */
const IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp']
const TEXT_MIMES = ['text/plain', 'text/csv', 'text/markdown', 'text/tab-separated-values']

export type FileKind = 'doc' | 'sheet' | 'slides' | 'form' | 'pdf' | 'image' | 'office' | 'text' | 'drawing' | 'video' | 'audio' | 'folder' | 'other'
export type PreviewKind = 'pdf' | 'sheet' | 'form' | 'image' | 'thumbnail' | 'text' | 'none'

export function kindOf(mimeType: string): FileKind {
  if (mimeType === MIME.doc) return 'doc'
  if (mimeType === MIME.sheet) return 'sheet'
  if (mimeType === MIME.slides) return 'slides'
  if (mimeType === MIME.form) return 'form'
  if (mimeType === MIME.drawing) return 'drawing'
  if (mimeType === MIME.folder) return 'folder'
  if (mimeType === MIME.pdf) return 'pdf'
  if (OFFICE_MIMES.includes(mimeType)) return 'office'
  if (mimeType.startsWith('image/')) return 'image'
  if (TEXT_MIMES.includes(mimeType)) return 'text'
  if (mimeType.startsWith('video/')) return 'video'
  if (mimeType.startsWith('audio/')) return 'audio'
  return 'other'
}

/** วิธีแสดงตัวอย่างในเว็บของไฟล์แต่ละชนิด (none = ไม่มีตัวอย่างในเว็บ ใช้ปุ่มเปิดต้นฉบับ) */
export function previewOf(mimeType: string): PreviewKind {
  if (mimeType === MIME.doc || mimeType === MIME.slides || mimeType === MIME.drawing || mimeType === MIME.pdf) return 'pdf'
  if (mimeType === MIME.sheet) return 'sheet'
  if (mimeType === MIME.form) return 'form'
  if (IMAGE_MIMES.includes(mimeType)) return 'image'
  if (TEXT_MIMES.includes(mimeType)) return 'text'
  return 'none'
}

// ---------- ความพร้อมของคลัง ----------

type LibraryReason = 'not_configured' | 'not_connected' | 'needs_reconnect' | 'connection_error' | 'missing_scope'

interface Readiness {
  /** มีสิทธิ์อ่านไฟล์ทั้งหมดของบัญชีชมรม (drive.readonly) และการเชื่อมใช้งานได้ */
  enabled: boolean
  /** การเชื่อมใช้งานได้ แม้ยังไม่ได้เปิดใช้คลัง (ทีมงานยังเปิดตัวอย่างของไฟล์ที่เว็บสร้างเองได้) */
  connected: boolean
  reason: LibraryReason | null
}

/** ตรวจจากสิทธิ์ที่ Google ยืนยันว่าได้รับจริงครั้งล่าสุด ไม่เดาจากการที่เชื่อมบัญชีแล้ว */
async function readiness(env: AppEnv): Promise<Readiness> {
  if ((await missingConnectConfig(env)).length > 0) return { enabled: false, connected: false, reason: 'not_configured' }
  const row = await loadConnection(env)
  if (!row || row.status === 'disconnected' || !row.refresh_token_enc) return { enabled: false, connected: false, reason: 'not_connected' }
  if (row.status === 'needs_reconnect') return { enabled: false, connected: false, reason: 'needs_reconnect' }
  const granted = row.scopes.split(' ').includes(DRIVE_READONLY_SCOPE)
  if (!granted) return { enabled: false, connected: true, reason: 'missing_scope' }
  return { enabled: true, connected: true, reason: row.status === 'error' ? 'connection_error' : null }
}

const REASON_TEXT: Record<LibraryReason, string> = {
  not_configured: 'เว็บไซต์ยังไม่ได้ตั้งค่าการเชื่อม Google จึงยังไม่มีคลังไฟล์',
  not_connected: 'ยังไม่ได้เชื่อมบัญชี Google ของชมรม จึงยังไม่มีคลังไฟล์ ให้ผู้ดูแลเชื่อมที่หน้าแหล่งข้อมูล',
  needs_reconnect: 'การเชื่อม Google ของชมรมใช้ไม่ได้แล้ว จึงเปิดคลังไฟล์ไม่ได้ ให้ผู้ดูแลเชื่อมใหม่ที่หน้าแหล่งข้อมูล',
  connection_error: 'ติดต่อ Google ครั้งล่าสุดไม่สำเร็จ',
  missing_scope: 'ยังไม่ได้เปิดใช้คลังไฟล์ Google: บัญชีชมรมยังไม่ได้อนุญาตให้เว็บอ่านไฟล์ของชมรม ให้ผู้ดูแลกด “เปิดใช้คลังไฟล์ Google”',
}
const MEMBER_UNAVAILABLE = 'คลังไฟล์ของชมรมยังไม่พร้อมใช้งานในตอนนี้ ติดต่อทีมงาน'

/** คลังยังไม่พร้อม = สถานะของระบบ ไม่ใช่ "ไม่มีไฟล์": ตอบเป็นข้อผิดพลาดที่บอกสาเหตุ ไม่ตอบเป็นรายการว่าง */
function notReady(session: Session, state: Readiness): HttpError {
  const reason = state.reason ?? 'missing_scope'
  return new HttpError(409, 'library_unavailable', session.kind === 'member' ? MEMBER_UNAVAILABLE : REASON_TEXT[reason], { reason })
}

/** ต้องเปิดใช้คลังแล้ว (ใช้กับรายการไฟล์ และทุกเส้นทางเมื่อผู้ขอเป็นสมาชิก) */
async function requireEnabled(env: AppEnv, session: Session): Promise<void> {
  const state = await readiness(env)
  if (!state.enabled) throw notReady(session, state)
}

/**
 * เปิดไฟล์รายตัว: สมาชิกต้องมีคลังที่เปิดใช้แล้วเสมอ ส่วนทีมงานเปิดได้เมื่อการเชื่อมใช้งานได้
 * (เอกสารที่เว็บสร้างไว้ก่อนเปิดใช้คลังยังดูตัวอย่างได้ด้วยสิทธิ์เดิม Google เป็นผู้ตัดสินว่า token นี้อ่านไฟล์ใดได้)
 */
async function requireFileAccess(env: AppEnv, session: Session): Promise<void> {
  const state = await readiness(env)
  if (session.kind === 'member' ? !state.enabled : !state.connected) throw notReady(session, state)
}

// ---------- ข้อผิดพลาดจาก Google ----------

const fileUnavailable = () =>
  new HttpError(404, 'file_unavailable', 'เปิดไฟล์นี้ไม่ได้: ไฟล์อาจถูกลบ ย้ายไปถังขยะ หรือบัญชี Google ของชมรมไม่มีสิทธิ์เข้าถึงแล้ว')

const DOWNLOAD_BLOCKED = new Set(['cannotDownloadFile', 'cannotDownloadAbusiveFile', 'downloadQuotaExceeded', 'fileNotDownloadable'])

/** แปลงข้อผิดพลาดของ Google เป็นคำตอบที่บอกสถานะจริงของไฟล์ โดยไม่ส่งรายละเอียดภายในของ Google ต่อ */
function fileError(error: unknown, session: Session): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof GoogleApiError) {
    if (error.reason === 'exportSizeLimitExceeded') {
      return new HttpError(413, 'export_too_large', 'เอกสารนี้ใหญ่เกินกว่าที่ Google ยอมส่งออกเป็นตัวอย่าง (จำกัดผลลัพธ์ 10 MB) จึงแสดงในเว็บไม่ได้ ใช้ปุ่มเปิดต้นฉบับแทน')
    }
    if (DOWNLOAD_BLOCKED.has(error.reason)) {
      return new HttpError(403, 'download_disabled', 'เจ้าของไฟล์ไม่อนุญาตให้ดาวน์โหลดหรือคัดลอกไฟล์นี้ จึงแสดงตัวอย่างในเว็บไม่ได้ ใช้ปุ่มเปิดต้นฉบับแทน')
    }
    const known = classify(error)
    if (known.code === 'missing_scope') return notReady(session, { enabled: false, connected: true, reason: 'missing_scope' })
    if (known.code === 'resource_unavailable') return fileUnavailable()
    if (known.code === 'rate_limited') return new HttpError(429, 'rate_limited', 'Google จำกัดจำนวนคำขอชั่วคราว รอสักครู่แล้วกดลองอีกครั้ง', { retryAfterSeconds: known.retryAfterSeconds ?? 30 })
    return new HttpError(502, 'google_error', 'Google ตอบกลับผิดพลาด ยังเปิดไฟล์ไม่ได้ในตอนนี้ กดลองอีกครั้งในอีกสักครู่')
  }
  const known = classify(error)
  return new HttpError(known.code === 'budget' ? 503 : 502, known.code === 'internal_error' ? 'google_error' : known.code, known.code === 'internal_error' ? 'ระบบขัดข้องระหว่างเปิดไฟล์ ลองอีกครั้งในอีกสักครู่' : known.message)
}

// ---------- metadata ของไฟล์ ----------

interface DriveFile {
  id: string
  name?: string
  mimeType?: string
  modifiedTime?: string
  size?: string
  webViewLink?: string
  trashed?: boolean
  parents?: string[]
  ownedByMe?: boolean
  shortcutDetails?: { targetId?: string; targetMimeType?: string }
  capabilities?: { canDownload?: boolean; canEdit?: boolean }
  hasThumbnail?: boolean
  thumbnailLink?: string
  thumbnailVersion?: string
}

const FILE_FIELDS = 'id,name,mimeType,modifiedTime,size,webViewLink,trashed,parents,ownedByMe,hasThumbnail,thumbnailLink,thumbnailVersion,shortcutDetails(targetId,targetMimeType),capabilities(canDownload,canEdit)'
// รายการต้องรู้เพียงว่ามีภาพย่อ ไม่ต้องอ่าน URL ภาพหรือรุ่นภาพจนกว่าจะเปิดภาพจริง
const LIST_FIELDS = `nextPageToken,incompleteSearch,files(${FILE_FIELDS.replace(',thumbnailLink,thumbnailVersion', '')})`

const FILE_ID = /^[A-Za-z0-9_-]{5,200}$/

/** ลิงก์เปิดต้นฉบับใช้ค่าที่ Google ให้มาใน metadata และต้องเป็นหน้าของ Google เท่านั้น */
function googleLink(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && /(^|\.)google\.com$/.test(url.hostname) ? url.href : null
  } catch {
    return null
  }
}

const sizeOf = (file: DriveFile) => {
  const size = Number(file.size)
  return file.size !== undefined && Number.isFinite(size) ? size : null
}

/** รายการหนึ่งไฟล์ตามที่หน้าเว็บแสดง: ชนิดของทางลัดคือชนิดของไฟล์ปลายทาง */
function toItem(file: DriveFile, folder: string | null) {
  const shortcut = file.mimeType === MIME.shortcut
  const mimeType = shortcut ? (file.shortcutDetails?.targetMimeType ?? '') : (file.mimeType ?? '')
  return {
    id: file.id,
    name: file.name || 'ไม่มีชื่อ',
    kind: kindOf(mimeType),
    mimeType,
    modifiedTime: file.modifiedTime ?? null,
    size: sizeOf(file),
    shortcut,
    /** ไฟล์ที่คนอื่นแชร์ให้บัญชีชมรม (ไม่ได้อยู่ใน Drive ของชมรมเอง) */
    shared: file.ownedByMe === false,
    folder,
    // ไม่ส่ง URL ภาพย่อหรือ token ของ Google ให้ browser: โหลดผ่าน endpoint ที่ตรวจ session
    thumbnail: !shortcut && file.hasThumbnail === true && file.capabilities?.canDownload !== false,
    previewable: previewOf(mimeType) !== 'none' || (file.hasThumbnail === true && file.capabilities?.canDownload !== false),
  }
}

async function getFile(gapi: Gapi, id: string): Promise<DriveFile> {
  return gapi.json<DriveFile>(`${DRIVE_FILES}/${encodeURIComponent(id)}?fields=${encodeURIComponent(FILE_FIELDS)}&supportsAllDrives=true`)
}

interface Resolved {
  /** ไฟล์ตามรหัสที่ขอ (อาจเป็นทางลัด) ใช้ชื่อและลิงก์ของรายการนี้แสดงผล */
  file: DriveFile
  /** ไฟล์ที่ใช้อ่านเนื้อหาจริง (ปลายทางของทางลัด หรือไฟล์เดียวกัน) */
  target: DriveFile
}

/**
 * อ่าน metadata ด้วย token ของบัญชีชมรมทุกครั้ง: ไฟล์ที่ Google ไม่ให้บัญชีชมรมเปิด ถูกลบ หรืออยู่ในถังขยะ ถือว่าเปิดไม่ได้
 * ทางลัดถูกตามไปยังปลายทางหนึ่งชั้น และ Google ตรวจสิทธิ์ของปลายทางเองอีกครั้ง
 */
async function resolveFile(gapi: Gapi, id: string, session: Session): Promise<Resolved> {
  if (!FILE_ID.test(id)) throw new HttpError(404, 'file_unavailable', 'ลิงก์ของไฟล์ไม่ถูกต้อง')
  try {
    const file = await getFile(gapi, id)
    if (file.trashed === true) throw fileUnavailable()
    if (file.mimeType !== MIME.shortcut) return { file, target: file }
    const targetId = file.shortcutDetails?.targetId ?? ''
    if (!FILE_ID.test(targetId)) throw fileUnavailable()
    let target: DriveFile
    try {
      target = await getFile(gapi, targetId)
    } catch (error) {
      if (error instanceof GoogleApiError && (error.status === 404 || error.status === 403)) {
        throw new HttpError(404, 'file_unavailable', 'ทางลัดนี้ชี้ไปยังไฟล์ที่บัญชี Google ของชมรมเปิดไม่ได้แล้ว (ไฟล์ปลายทางอาจถูกลบหรือยกเลิกการแชร์)')
      }
      throw error
    }
    if (target.trashed === true || target.mimeType === MIME.shortcut) throw fileUnavailable()
    return { file, target }
  } catch (error) {
    throw fileError(error, session)
  }
}

type NoPreviewReason = 'folder' | 'unsupported' | 'too_large' | 'download_disabled'

/** ตัดสินว่าแสดงตัวอย่างในเว็บได้หรือไม่ จากชนิด ขนาด และสิทธิ์ที่ Google ระบุใน metadata (ไม่เดา) */
function previewPlan(target: DriveFile): { kind: PreviewKind; reason: NoPreviewReason | null } {
  const mimeType = target.mimeType ?? ''
  if (mimeType === MIME.folder) return { kind: 'none', reason: 'folder' }
  const kind = previewOf(mimeType)
  if (kind === 'none' && target.hasThumbnail && target.capabilities?.canDownload !== false) return { kind: 'thumbnail', reason: null }
  if (kind === 'none') return { kind, reason: 'unsupported' }
  // ไฟล์ Google (เอกสาร/สไลด์/ชีต/ฟอร์ม) อ่านผ่าน API ของแต่ละชนิด; ไฟล์ทั่วไปต้องดาวน์โหลดได้
  if (target.capabilities?.canDownload === false) return { kind: 'none', reason: 'download_disabled' }
  const size = sizeOf(target)
  if ((kind === 'image' || (kind === 'pdf' && mimeType === MIME.pdf)) && size !== null && size > MAX_PREVIEW_BYTES) return { kind: 'none', reason: 'too_large' }
  return { kind, reason: null }
}

const EDIT_LABEL: Partial<Record<FileKind, string>> = { doc: 'Google Docs', sheet: 'Google Sheets', slides: 'Google Slides', form: 'Google Forms', drawing: 'Google Drawings' }

// ---------- สำเนาชั่วคราวและการเว้นระยะ ----------

interface CacheRow {
  body_json: string
  fetched_at: string
}

const readCache = (env: AppEnv, key: string) => env.DB.prepare('SELECT body_json, fetched_at FROM library_cache WHERE key = ?').bind(key).first<CacheRow>()

async function writeCache(env: AppEnv, key: string, body: unknown, now: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('INSERT INTO library_cache (key, body_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET body_json = excluded.body_json, fetched_at = excluded.fetched_at').bind(key, JSON.stringify(body), now),
    // เก็บกวาดสำเนาที่เก่าเกินกว่าจะใช้แสดง
    env.DB.prepare('DELETE FROM library_cache WHERE fetched_at < ?').bind(new Date(Date.now() - STALE_MAX_MS).toISOString()),
  ])
}

interface StateRow {
  failure_count: number
  next_attempt_at: string | null
  last_error_code: string | null
  last_success_at: string | null
}

const readState = (env: AppEnv) => env.DB.prepare(`SELECT failure_count, next_attempt_at, last_error_code, last_success_at FROM library_state WHERE id = 'drive'`).first<StateRow>()

const noteSuccess = (env: AppEnv, now: string) =>
  env.DB.prepare(
    `INSERT INTO library_state (id, failure_count, next_attempt_at, last_error_code, last_success_at, updated_at) VALUES ('drive', 0, NULL, NULL, ?, ?)
     ON CONFLICT (id) DO UPDATE SET failure_count = 0, next_attempt_at = NULL, last_error_code = NULL, last_success_at = excluded.last_success_at, updated_at = excluded.updated_at`,
  ).bind(now, now).run()

/** Google จำกัดคำขอหรือล่ม: เว้นระยะก่อนเรียกครั้งถัดไป (ยืดขึ้นเมื่อพลาดซ้ำ) เพื่อไม่ยิงซ้ำทุกครั้งที่มีคนเปิดหน้า */
async function noteFailure(env: AppEnv, code: string, retryAfterSeconds: number | null): Promise<void> {
  const transient = code === 'rate_limited' || code === 'google_unavailable'
  const previous = (await readState(env))?.failure_count ?? 0
  const delay = transient ? Math.max((retryAfterSeconds ?? 0) * 1000, Math.min(MAX_BACKOFF_MS, 15_000 * 2 ** Math.min(previous, 7))) : 0
  const now = nowIso()
  await env.DB.prepare(
    `INSERT INTO library_state (id, failure_count, next_attempt_at, last_error_code, last_success_at, updated_at) VALUES ('drive', 1, ?, ?, NULL, ?)
     ON CONFLICT (id) DO UPDATE SET failure_count = library_state.failure_count + 1, next_attempt_at = excluded.next_attempt_at, last_error_code = excluded.last_error_code, updated_at = excluded.updated_at`,
  ).bind(delay ? new Date(Date.now() + delay).toISOString() : null, code, now).run()
}

// ---------- รายการไฟล์ ----------

export const FILE_TYPES = ['all', 'doc', 'sheet', 'slides', 'form', 'pdf', 'image', 'office', 'other'] as const
type FileType = (typeof FILE_TYPES)[number]
type SortKey = 'modified' | 'name'

const quote = (value: string) => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`

const NAMED_TYPES: Partial<Record<FileType, string>> = { doc: MIME.doc, sheet: MIME.sheet, slides: MIME.slides, form: MIME.form, pdf: MIME.pdf }

/** ชนิดจริงของไฟล์ (หรือของไฟล์ปลายทางเมื่อเป็นทางลัด) อยู่ในหมวดนี้หรือไม่ ตัดสินจาก MIME type เท่านั้น ไม่ดูชื่อหรือนามสกุลไฟล์ */
export function inType(mimeType: string, type: FileType): boolean {
  if (type === 'all') return true
  if (NAMED_TYPES[type]) return mimeType === NAMED_TYPES[type]
  if (type === 'image') return mimeType.startsWith('image/')
  if (type === 'office') return OFFICE_MIMES.includes(mimeType)
  // other = ไม่อยู่ในหมวดใดข้างต้น
  return !Object.values(NAMED_TYPES).includes(mimeType) && !OFFICE_MIMES.includes(mimeType) && !mimeType.startsWith('image/') && mimeType !== MIME.folder
}

/**
 * คำค้นของ Drive สร้างที่ server จากตัวเลือกที่กำหนดไว้เท่านั้น ไม่รับคำค้นดิบจากเบราว์เซอร์
 * หมวดประเภทขอ "ไฟล์ชนิดนั้น หรือทางลัด" จาก Google: Drive ค้นตามชนิดของไฟล์ปลายทางของทางลัดไม่ได้
 * ทางลัดที่ปลายทางไม่ใช่ชนิดของหมวดจึงถูกคัดออกที่ server หลังได้ผล (ดู fetchList) ไม่ได้คัดในเบราว์เซอร์
 */
export function buildQuery(search: string, type: FileType): string {
  // ไม่แสดงไฟล์ในถังขยะ และไม่แสดงโฟลเดอร์เป็นรายการไฟล์ (ชื่อโฟลเดอร์ของแต่ละไฟล์แสดงประกอบแทน)
  const parts = ['trashed = false', `mimeType != ${quote(MIME.folder)}`]
  if (search) parts.push(`name contains ${quote(search)}`)
  const shortcut = `mimeType = ${quote(MIME.shortcut)}`
  if (NAMED_TYPES[type]) parts.push(`(mimeType = ${quote(NAMED_TYPES[type]!)} or ${shortcut})`)
  else if (type === 'image') parts.push(`(mimeType contains 'image/' or ${shortcut})`)
  else if (type === 'office') parts.push(`(${OFFICE_MIMES.map((m) => `mimeType = ${quote(m)}`).join(' or ')} or ${shortcut})`)
  else if (type === 'other') {
    // ทางลัดไม่ถูกตัดออกด้วยเงื่อนไขด้านล่างอยู่แล้ว (ชนิดของตัวทางลัดเองไม่อยู่ในรายการ)
    for (const mime of [MIME.doc, MIME.sheet, MIME.slides, MIME.form, MIME.pdf, ...OFFICE_MIMES]) parts.push(`mimeType != ${quote(mime)}`)
    parts.push(`not mimeType contains 'image/'`)
  }
  return parts.join(' and ')
}

interface ListParams {
  search: string
  type: FileType
  sort: SortKey
  pageToken: string
  limit: number
}

function listParams(url: URL): ListParams {
  const search = (url.searchParams.get('q') ?? '').trim()
  if (search.length > 100) throw new HttpError(422, 'validation_failed', 'คำค้นหายาวได้ไม่เกิน 100 ตัวอักษร', { field: 'q' })
  const type = (url.searchParams.get('type') ?? 'all') as FileType
  if (!FILE_TYPES.includes(type)) throw new HttpError(422, 'validation_failed', 'ประเภทไฟล์ไม่ถูกต้อง', { field: 'type' })
  const sort = (url.searchParams.get('sort') ?? 'modified') as SortKey
  if (sort !== 'modified' && sort !== 'name') throw new HttpError(422, 'validation_failed', 'การเรียงลำดับไม่ถูกต้อง', { field: 'sort' })
  const pageToken = url.searchParams.get('pageToken') ?? ''
  // token ของหน้าถัดไปเป็นค่าทึบที่ Google ออกให้: ส่งต่อเฉพาะรูปแบบที่เป็นไปได้ ไม่ตีความ
  if (pageToken && !/^[\x21-\x7e]{1,4000}$/.test(pageToken)) throw new HttpError(422, 'validation_failed', 'ตำแหน่งหน้าถัดไปไม่ถูกต้อง', { field: 'pageToken' })
  const rawLimit = url.searchParams.get('limit')
  const limit = rawLimit === null ? PAGE_SIZE : Number(rawLimit)
  if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) throw new HttpError(422, 'validation_failed', 'จำนวนรายการต่อหน้าไม่ถูกต้อง', { field: 'limit' })
  return { search, type, sort, pageToken, limit }
}

/** ชื่อโฟลเดอร์ของไฟล์ในหน้านี้: ดูจากสำเนาชั่วคราวก่อน และถาม Google เพิ่มได้จำกัดจำนวนต่อคำขอ (ที่เหลือแสดงโดยไม่มีชื่อโฟลเดอร์) */
async function folderNames(env: AppEnv, gapi: Gapi, files: DriveFile[]): Promise<Map<string, string | null>> {
  const ids = [...new Set(files.map((f) => f.parents?.[0]).filter((id): id is string => typeof id === 'string' && FILE_ID.test(id)))]
  const names = new Map<string, string | null>()
  if (ids.length === 0) return names
  const freshAfter = new Date(Date.now() - FOLDER_TTL_MS).toISOString()
  const keys = ['folder:root', ...ids.map((id) => `folder:${id}`)]
  const { results } = await env.DB.prepare(`SELECT key, body_json, fetched_at FROM library_cache WHERE key IN (${keys.map(() => '?').join(',')}) AND fetched_at >= ?`)
    .bind(...keys, freshAfter)
    .all<{ key: string; body_json: string }>()
  const cached = new Map(results.map((row) => [row.key.slice('folder:'.length), JSON.parse(row.body_json) as { id?: string; name: string | null }]))

  // โฟลเดอร์บนสุดของ Drive ชมรมไม่ต้องแสดงชื่อ: รู้รหัสจากการถาม Google หนึ่งครั้ง แล้วจำไว้
  let rootId = cached.get('root')?.id ?? null
  const now = nowIso()
  const store: D1PreparedStatement[] = []
  const remember = (id: string, body: unknown) =>
    store.push(env.DB.prepare('INSERT INTO library_cache (key, body_json, fetched_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET body_json = excluded.body_json, fetched_at = excluded.fetched_at').bind(`folder:${id}`, JSON.stringify(body), now))
  if (!cached.has('root')) {
    try {
      rootId = (await gapi.json<{ id?: string }>(`${DRIVE_FILES}/root?fields=id`)).id ?? null
      remember('root', { id: rootId, name: null })
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error
    }
  }
  const pending: string[] = []
  for (const id of ids) {
    if (id === rootId) names.set(id, null)
    else if (cached.has(id)) names.set(id, cached.get(id)!.name)
    else if (pending.length < Math.min(MAX_FOLDER_LOOKUPS, gapi.remaining())) pending.push(id)
  }
  // ชื่อโฟลเดอร์ไม่ต้องรอ Google ทีละอัน และยังจำกัดจำนวนคำขอเท่าเดิม
  await Promise.all(pending.map(async (id) => {
      let name: string | null = null
      try {
        name = (await gapi.json<{ name?: string }>(`${DRIVE_FILES}/${encodeURIComponent(id)}?fields=name&supportsAllDrives=true`)).name ?? null
      } catch (error) {
        // โฟลเดอร์ของไฟล์ที่ถูกแชร์มามักเปิดไม่ได้: ไม่แสดงชื่อ แต่ไฟล์ยังอยู่ในรายการ
        if (!(error instanceof GoogleApiError) || !(error.status === 403 || error.status === 404)) throw error
      }
      names.set(id, name)
      remember(id, { name })
  }))
  if (store.length > 0) await env.DB.batch(store)
  return names
}

interface ListBody {
  files: ReturnType<typeof toItem>[]
  nextPageToken: string | null
  /** Google แจ้งว่าการค้นหาครั้งนี้อาจได้ผลไม่ครบ */
  incomplete: boolean
}

/**
 * จำนวนหน้าของ Google ที่ถามต่อได้ในคำขอเดียว เมื่อหน้าที่ได้มีแต่ทางลัดไปยังไฟล์ชนิดอื่น (ถูกคัดออกหมด)
 * ครบจำนวนแล้วยังไม่พบ: ตอบรายการว่างพร้อม nextPageToken เพื่อให้หน้าเว็บบอกว่ายังค้นไม่จบ ไม่ใช่ "ไม่มีไฟล์"
 */
const MAX_FILTER_PAGES = 3

async function fetchList(env: AppEnv, params: ListParams): Promise<ListBody> {
  const gapi = makeGapi(env, 1 + MAX_FILTER_PAGES + MAX_FOLDER_LOOKUPS)
  const query = new URLSearchParams({
    q: buildQuery(params.search, params.type),
    orderBy: params.sort === 'name' ? 'name_natural' : 'modifiedTime desc',
    pageSize: String(params.limit),
    fields: LIST_FIELDS,
    spaces: 'drive',
    corpora: 'user',
    // รวมไฟล์ในไดรฟ์ที่แชร์ซึ่งบัญชีชมรมเข้าถึงได้
    supportsAllDrives: 'true',
    includeItemsFromAllDrives: 'true',
  })
  let pageToken = params.pageToken
  let files: DriveFile[] = []
  let incomplete = false
  for (let page = 0; page < MAX_FILTER_PAGES; page++) {
    if (pageToken) query.set('pageToken', pageToken)
    const data = await gapi.json<{ files?: DriveFile[]; nextPageToken?: string; incompleteSearch?: boolean }>(`${DRIVE_FILES}?${query}`)
    if (!Array.isArray(data.files)) throw new GoogleApiError(502, 'malformed_list')
    // ชนิดของหมวดตัดสินจาก MIME type จริง: ไฟล์ปกติใช้ชนิดของตัวเอง ทางลัดใช้ชนิดของไฟล์ปลายทาง
    files = data.files.filter(
      (f) => typeof f.id === 'string' && f.trashed !== true && f.mimeType !== MIME.folder &&
        inType(f.mimeType === MIME.shortcut ? (f.shortcutDetails?.targetMimeType ?? '') : (f.mimeType ?? ''), params.type),
    )
    incomplete = incomplete || data.incompleteSearch === true
    pageToken = typeof data.nextPageToken === 'string' && data.nextPageToken ? data.nextPageToken : ''
    // ได้ไฟล์ของหมวดนี้แล้ว หรือ Google ไม่มีหน้าถัดไป: จบ ไม่ไล่ดึงทั้งบัญชี
    if (files.length > 0 || !pageToken) break
  }
  const folders = await folderNames(env, gapi, files).catch(() => new Map<string, string | null>())
  return {
    files: files.map((file) => toItem(file, folders.get(file.parents?.[0] ?? '') ?? null)),
    nextPageToken: pageToken || null,
    incomplete,
  }
}

/**
 * GET /api/library/files — หนึ่งหน้าของรายการไฟล์ (ค้นชื่อ กรองประเภท เรียง และโหลดหน้าถัดไปด้วย nextPageToken)
 * - ดึงเฉพาะ metadata ของหน้าที่ขอ ไม่ดึงเนื้อหาไฟล์ และไม่ไล่ดึงทั้งบัญชี
 * - nextPageToken ไม่เป็น null = ยังมีรายการอีก หน้านี้ไม่ใช่รายการทั้งหมด
 * - fetchedAt = เวลาที่ได้ข้อมูลชุดนี้จาก Google จริง; stale = Google ล้มเหลวจึงแสดงชุดที่เก็บไว้ล่าสุดแทน พร้อมสาเหตุ
 */
async function list(ctx: Ctx): Promise<Response> {
  const session = requireViewer(ctx)
  await requireEnabled(ctx.env, session)
  const params = listParams(ctx.url)
  const fresh = ctx.url.searchParams.get('fresh') === '1'
  // v3: หมวดประเภทรวมทางลัดตามชนิดของไฟล์ปลายทาง (สำเนาของรุ่นก่อนไม่มีทางลัดในหมวด จึงไม่นำมาใช้)
  const key = `list:v3:${await sha256Hex(JSON.stringify(params))}`
  const cached = await readCache(ctx.env, key)
  const age = cached ? Date.now() - Date.parse(cached.fetched_at) : Infinity
  const reply = (body: ListBody, fetchedAt: string, extra: Record<string, unknown> = {}) => json({ ...body, fetchedAt, pageSize: params.limit, stale: false, ...extra })
  if (cached && age < (fresh ? FRESH_MIN_MS : CACHE_TTL_MS)) return reply(JSON.parse(cached.body_json) as ListBody, cached.fetched_at)

  const usable = cached && age < STALE_MAX_MS ? cached : null
  const failed = (code: string, message: string, retryAfterSeconds: number | null) => {
    // มีชุดที่เก็บไว้: แสดงชุดนั้นพร้อมบอกว่าไม่ใช่ข้อมูลล่าสุดและเพราะอะไร ไม่มี: ตอบเป็นข้อผิดพลาด ไม่ตอบเป็นรายการว่าง
    if (usable) return reply(JSON.parse(usable.body_json) as ListBody, usable.fetched_at, { stale: true, error: { code, message } })
    throw new HttpError(code === 'rate_limited' ? 429 : 502, code, message, retryAfterSeconds ? { retryAfterSeconds } : {})
  }
  const state = await readState(ctx.env)
  if (state?.next_attempt_at && Date.parse(state.next_attempt_at) > Date.now()) {
    const wait = Math.ceil((Date.parse(state.next_attempt_at) - Date.now()) / 1000)
    return failed('rate_limited', 'Google จำกัดจำนวนคำขอหรือขัดข้องชั่วคราว ระบบเว้นระยะก่อนถามใหม่ ลองรีเฟรชอีกครั้งในอีกสักครู่', wait)
  }

  try {
    const body = await fetchList(ctx.env, params)
    const now = nowIso()
    await writeCache(ctx.env, key, body, now)
    if (state?.failure_count || !state?.last_success_at || Date.now() - Date.parse(state.last_success_at) > CACHE_TTL_MS) await noteSuccess(ctx.env, now)
    return reply(body, now)
  } catch (error) {
    if (error instanceof HttpError && ['google_not_connected', 'google_needs_reconnect', 'encryption_not_configured'].includes(error.code)) {
      throw notReady(session, { enabled: false, connected: false, reason: error.code === 'google_needs_reconnect' ? 'needs_reconnect' : 'not_connected' })
    }
    const known = classify(error)
    if (known.code === 'missing_scope') throw notReady(session, { enabled: false, connected: true, reason: 'missing_scope' })
    if (error instanceof GoogleApiError && error.status === 400 && params.pageToken) {
      throw new HttpError(409, 'page_expired', 'ตำแหน่งหน้าถัดไปใช้ไม่ได้แล้ว (รายการใน Google เปลี่ยนไป) โหลดรายการใหม่จากต้น')
    }
    console.error('library list failed', known.code)
    await noteFailure(ctx.env, known.code, known.retryAfterSeconds)
    const message = known.code === 'rate_limited' ? 'Google จำกัดจำนวนคำขอชั่วคราว รอสักครู่แล้วกดรีเฟรชอีกครั้ง' : 'โหลดรายการไฟล์จาก Google ไม่สำเร็จ กดรีเฟรชเพื่อลองอีกครั้ง'
    return failed(known.code === 'rate_limited' ? 'rate_limited' : 'google_error', message, known.retryAfterSeconds)
  }
}

/** GET /api/library/status — คลังพร้อมใช้หรือไม่ และเพราะอะไร (ไม่เรียก Google) */
async function status(ctx: Ctx): Promise<Response> {
  const session = requireViewer(ctx)
  const state = await readiness(ctx.env)
  const drive = await readState(ctx.env)
  const admin = session.kind === 'staff' && session.user.role === 'admin'
  return json({
    enabled: state.enabled,
    // สมาชิกเห็นเพียงว่าพร้อมหรือไม่พร้อม รายละเอียดของการเชื่อมเป็นข้อมูลของทีมงาน
    reason: session.kind === 'member' ? (state.enabled ? null : 'unavailable') : state.reason,
    message: state.enabled ? null : session.kind === 'member' ? MEMBER_UNAVAILABLE : REASON_TEXT[state.reason ?? 'missing_scope'],
    /** ผู้ดูแลกดขอสิทธิ์อ่านไฟล์ของชมรมได้ (ต้องเชื่อมบัญชีชมรมแล้ว) */
    canEnable: admin && !state.enabled && state.reason === 'missing_scope',
    lastSuccessAt: drive?.last_success_at ?? null,
    limits: { previewBytes: MAX_PREVIEW_BYTES, textBytes: MAX_TEXT_BYTES, sheetRows: SHEET_ROWS, sheetColumns: SHEET_COLUMNS, pageSize: PAGE_SIZE },
  })
}

// ---------- รายละเอียดและตัวอย่างของไฟล์ ----------

/** GET /api/library/files/:id — metadata ล่าสุดจาก Google วิธีแสดงตัวอย่าง และลิงก์เปิดต้นฉบับตามสิทธิ์ของผู้ขอ */
async function detail(ctx: Ctx, id: string): Promise<Response> {
  const session = requireViewer(ctx)
  await requireFileAccess(ctx.env, session)
  const gapi = makeGapi(ctx.env, 4)
  const { file, target } = await resolveFile(gapi, id, session)
  const plan = previewPlan(target)
  const item = toItem(file, null)
  const kind = kindOf(target.mimeType ?? '')
  const open = googleLink(target.webViewLink)
  const staff = session.kind === 'staff'
  const editor = EDIT_LABEL[kind]
  let registered: { documentId: string } | null = null
  if (staff && kind === 'doc') {
    const row = await ctx.env.DB.prepare('SELECT id FROM documents WHERE google_document_id = ?').bind(target.id).first<{ id: string }>()
    registered = row ? { documentId: row.id } : null
  }
  return json({
    file: { ...item, kind, mimeType: target.mimeType ?? '', size: sizeOf(target), modifiedTime: target.modifiedTime ?? item.modifiedTime },
    preview: { kind: plan.kind, reason: plan.reason, maxBytes: MAX_PREVIEW_BYTES },
    links: {
      // หน้าแก้ฟอร์มใช้ได้เฉพาะผู้มีสิทธิ์แก้: สมาชิกได้ลิงก์หน้าตอบฟอร์มจากตัวอย่างของฟอร์มแทน
      open: staff || kind !== 'form' ? open : null,
      // ปุ่มแก้ไขมีเฉพาะทีมงาน และเป็นลิงก์ของ Google เอง: สิทธิ์แก้จริงขึ้นกับบัญชี Google ที่คนนั้นล็อกอิน
      edit: staff && editor && open ? { url: open, label: target.capabilities?.canEdit === true ? `แก้ไขใน ${editor}` : `เปิดใน ${editor}` } : null,
    },
    ...(staff ? { registered } : {}),
    fetchedAt: nowIso(),
  })
}

const CONTENT_HEADERS = {
  // เนื้อหาส่วนตัว: ไม่ให้ cache ใดเก็บ และเบราว์เซอร์ต้องขอผ่านการตรวจ session ใหม่ทุกครั้ง
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  // ถ้ามีคนเปิด URL นี้ตรง ๆ เนื้อหาจะไม่ถูกรันเป็นหน้าเว็บของระบบ
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'X-Robots-Tag': 'noindex',
}

const HEADER_TIMEOUT_MS = 20_000

/** เรียก Google เพื่อส่งเนื้อหาต่อแบบ stream: จำกัดเวลารอเฉพาะช่วงก่อนได้ส่วนหัวของคำตอบ */
async function googleStream(env: AppEnv, url: string, headers: Record<string, string>): Promise<Response> {
  const call = async (token: string) => {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), HEADER_TIMEOUT_MS)
    try {
      return await fetch(url, { headers: { ...headers, Authorization: `Bearer ${token}` }, signal: controller.signal })
    } catch {
      throw new HttpError(502, 'google_unavailable', 'ติดต่อ Google ไม่สำเร็จ ลองอีกครั้งในอีกสักครู่')
    } finally {
      clearTimeout(timer)
    }
  }
  const response = await call(await getAccessToken(env))
  if (response.status !== 401) return response
  return call(await getAccessToken(env, true))
}

const RANGE = /^bytes=(\d{1,15}-\d{0,15}|-\d{1,15})$/

/** รับ URL ที่มาจาก metadata ของ Google เท่านั้น และไม่ส่ง credential ตาม redirect ไป host อื่น */
function safeThumbnailUrl(value: string | undefined): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    const host = url.hostname
    return url.protocol === 'https:' && !url.username && !url.password && !url.port &&
      (host === 'googleusercontent.com' || host.endsWith('.googleusercontent.com') || /^lh\d+\.google\.com$/.test(host) || host === 'drive.google.com') ? url.href : null
  } catch { return null }
}

const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024

/** GET .../thumbnail: ภาพขนาดย่อจาก Drive ไม่ดาวน์โหลดเอกสารเต็มเพื่อสร้างการ์ด */
async function thumbnail(ctx: Ctx, id: string): Promise<Response> {
  const session = requireViewer(ctx)
  await requireFileAccess(ctx.env, session)
  // ตรวจสิทธิ์ต้นฉบับและปลายทางใหม่ทุกครั้ง แม้ภาพอยู่ใน cache แล้ว
  const { target } = await resolveFile(makeGapi(ctx.env, 3), id, session)
  if (target.capabilities?.canDownload === false) throw fileError(new GoogleApiError(403, 'cannotDownloadFile'), session)
  const source = safeThumbnailUrl(target.thumbnailLink)
  if (!target.hasThumbnail || !source) throw new HttpError(404, 'thumbnail_unavailable', 'Google ยังไม่มีภาพตัวอย่างของไฟล์นี้')
  const version = target.thumbnailVersion ?? target.modifiedTime ?? source
  const cacheKey = new Request(new URL(`/__library-thumbnail/${await sha256Hex(`${target.id}:${version}`)}`, ctx.url.origin))
  const cached = await caches.default.match(cacheKey)
  const output = (body: BodyInit | null, type: string) => new Response(body, { headers: { ...CONTENT_HEADERS, 'Content-Type': type } })
  if (cached) return output(cached.body, cached.headers.get('Content-Type') ?? 'image/jpeg')

  const download = async (token: string) => {
    let url = source
    for (let redirects = 0; redirects < 4; redirects++) {
      const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'manual', signal: AbortSignal.timeout(10_000) })
      if (![301, 302, 303, 307, 308].includes(response.status)) return response
      const location = response.headers.get('Location')
      await response.body?.cancel()
      const next = location ? safeThumbnailUrl(new URL(location, url).href) : null
      if (!next) throw new HttpError(502, 'thumbnail_unavailable', 'โหลดภาพตัวอย่างจาก Google ไม่สำเร็จ')
      url = next
    }
    throw new HttpError(502, 'thumbnail_unavailable', 'โหลดภาพตัวอย่างจาก Google ไม่สำเร็จ')
  }
  let upstream: Response
  try {
    upstream = await download(await getAccessToken(ctx.env))
    if (upstream.status === 401) { await upstream.body?.cancel(); upstream = await download(await getAccessToken(ctx.env, true)) }
    if (!upstream.ok) throw await toApiError(upstream)
  } catch (error) { throw fileError(error, session) }
  const type = (upstream.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
  if (!IMAGE_MIMES.includes(type) || Number(upstream.headers.get('Content-Length')) > MAX_THUMBNAIL_BYTES) {
    await upstream.body?.cancel()
    throw new HttpError(415, 'thumbnail_unavailable', 'รูปแบบภาพตัวอย่างจาก Google ใช้งานไม่ได้')
  }
  const reader = upstream.body?.getReader()
  if (!reader) throw new HttpError(502, 'thumbnail_unavailable', 'Google ไม่ส่งภาพตัวอย่างมา')
  const chunks: Uint8Array[] = []
  let length = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    length += value.byteLength
    if (length > MAX_THUMBNAIL_BYTES) { await reader.cancel(); throw new HttpError(413, 'thumbnail_unavailable', 'ภาพตัวอย่างใหญ่เกินกำหนด') }
    chunks.push(value)
  }
  const bytes = new Uint8Array(length)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  // cache ภายใน Worker เท่านั้น: URL ภายในนี้ไม่มี route สาธารณะ และคำตอบให้ browser เป็น no-store
  await caches.default.put(cacheKey, new Response(bytes, { headers: { 'Content-Type': type, 'Cache-Control': 'public, max-age=300' } })).catch(() => undefined)
  return output(bytes, type)
}

/**
 * GET /api/library/files/:id/content — เนื้อหาสำหรับตัวอย่างแบบ PDF หรือรูปภาพ ส่งต่อจาก Google เป็น stream
 * - เอกสาร/สไลด์/ภาพวาดของ Google: ส่งออกเป็น PDF; ไฟล์ PDF และรูปภาพ: ส่งไฟล์ตามจริง รองรับ Range
 * - ชนิดของเนื้อหากำหนดที่ server จากรายการที่อนุญาตเท่านั้น ไม่ใช้ค่าที่ Google หรือเบราว์เซอร์ส่งมา
 */
async function content(ctx: Ctx, id: string): Promise<Response> {
  const session = requireViewer(ctx)
  await requireFileAccess(ctx.env, session)
  const { file, target } = await resolveFile(makeGapi(ctx.env, 3), id, session)
  const plan = previewPlan(target)
  if (plan.kind !== 'pdf' && plan.kind !== 'image') {
    if (plan.reason === 'too_large') throw new HttpError(413, 'file_too_large', `ไฟล์นี้ใหญ่เกิน ${MAX_PREVIEW_BYTES / 1024 / 1024} MB จึงแสดงตัวอย่างในเว็บไม่ได้ ใช้ปุ่มเปิดต้นฉบับแทน`)
    if (plan.reason === 'download_disabled') throw fileError(new GoogleApiError(403, 'cannotDownloadFile'), session)
    throw new HttpError(415, 'preview_unsupported', 'ไฟล์ชนิดนี้ไม่มีตัวอย่างแบบนี้ในเว็บ')
  }
  const mimeType = target.mimeType ?? ''
  const exported = mimeType !== MIME.pdf && plan.kind === 'pdf'
  const base = `${DRIVE_FILES}/${encodeURIComponent(target.id)}`
  const upstreamHeaders: Record<string, string> = {}
  const range = ctx.request.headers.get('Range')
  // การส่งออกของ Google ไม่รองรับ Range จึงส่งต่อ Range เฉพาะไฟล์ที่ดาวน์โหลดตามจริง
  if (!exported && range && RANGE.test(range)) upstreamHeaders.Range = range
  let upstream: Response
  try {
    upstream = await googleStream(ctx.env, exported ? `${base}/export?mimeType=${encodeURIComponent(MIME.pdf)}` : `${base}?alt=media&supportsAllDrives=true`, upstreamHeaders)
    if (!upstream.ok) throw await toApiError(upstream)
  } catch (error) {
    throw fileError(error, session)
  }
  const length = Number(upstream.headers.get('Content-Length'))
  if (!exported && upstream.status === 200 && Number.isFinite(length) && length > MAX_PREVIEW_BYTES) {
    await upstream.body?.cancel()
    throw new HttpError(413, 'file_too_large', `ไฟล์นี้ใหญ่เกิน ${MAX_PREVIEW_BYTES / 1024 / 1024} MB จึงแสดงตัวอย่างในเว็บไม่ได้ ใช้ปุ่มเปิดต้นฉบับแทน`)
  }
  const headers = new Headers(CONTENT_HEADERS)
  headers.set('Content-Type', plan.kind === 'pdf' ? MIME.pdf : mimeType)
  const name = `${(file.name || 'file').replace(/[\r\n"\\/]/g, ' ').slice(0, 150)}${exported ? '.pdf' : ''}`
  headers.set('Content-Disposition', `inline; filename*=UTF-8''${encodeURIComponent(name)}`)
  for (const header of ['Content-Length', 'Content-Range']) {
    const value = upstream.headers.get(header)
    if (value) headers.set(header, value)
  }
  if (!exported) headers.set('Accept-Ranges', 'bytes')
  return new Response(upstream.body, { status: upstream.status === 206 ? 206 : 200, headers })
}

/** GET /api/library/files/:id/text — ไฟล์ข้อความ ส่งเป็นข้อความใน JSON (หน้าเว็บแสดงแบบ escape ไม่ตีความเป็น HTML) */
async function textPreview(ctx: Ctx, id: string): Promise<Response> {
  const session = requireViewer(ctx)
  await requireFileAccess(ctx.env, session)
  const { target } = await resolveFile(makeGapi(ctx.env, 3), id, session)
  if (previewPlan(target).kind !== 'text') throw new HttpError(415, 'preview_unsupported', 'ไฟล์ชนิดนี้ไม่มีตัวอย่างแบบข้อความในเว็บ')
  if (sizeOf(target) === 0) return json({ text: '', bytes: 0, totalBytes: 0, truncated: false, maxBytes: MAX_TEXT_BYTES })
  let upstream: Response
  try {
    upstream = await googleStream(ctx.env, `${DRIVE_FILES}/${encodeURIComponent(target.id)}?alt=media&supportsAllDrives=true`, { Range: `bytes=0-${MAX_TEXT_BYTES - 1}` })
    if (!upstream.ok) throw await toApiError(upstream)
  } catch (error) {
    throw fileError(error, session)
  }
  const bytes = new Uint8Array(await upstream.arrayBuffer()).slice(0, MAX_TEXT_BYTES)
  const total = sizeOf(target)
  return json({
    text: new TextDecoder('utf-8').decode(bytes),
    bytes: bytes.length,
    totalBytes: total,
    /** true = แสดงเฉพาะส่วนต้นของไฟล์ ไม่ใช่ทั้งไฟล์ */
    truncated: total !== null ? total > bytes.length : bytes.length >= MAX_TEXT_BYTES,
    maxBytes: MAX_TEXT_BYTES,
  })
}

interface SheetMeta {
  properties?: { title?: string }
  sheets?: { properties?: { sheetId?: number; title?: string; sheetType?: string; hidden?: boolean; gridProperties?: { rowCount?: number; columnCount?: number } } }[]
}

interface GridData {
  sheets?: {
    data?: {
      rowData?: { values?: { formattedValue?: string }[] }[]
      rowMetadata?: { hiddenByUser?: boolean; hiddenByFilter?: boolean }[]
      columnMetadata?: { hiddenByUser?: boolean }[]
    }[]
  }[]
}

/**
 * GET /api/library/files/:id/sheet?tab=&offset= — ตารางของหนึ่งแท็บ ทีละช่วงแถว พร้อมบอกขอบเขตที่แสดงจริง
 * แท็บ แถว และคอลัมน์ที่ซ่อนไว้ใน Google Sheets ไม่ถูกแสดง (เหมือนผู้ที่มีสิทธิ์ดูอย่างเดียว)
 */
async function sheetPreview(ctx: Ctx, id: string): Promise<Response> {
  const session = requireViewer(ctx)
  await requireFileAccess(ctx.env, session)
  const gapi = makeGapi(ctx.env, 5)
  const { target } = await resolveFile(gapi, id, session)
  if (previewPlan(target).kind !== 'sheet') throw new HttpError(415, 'preview_unsupported', 'ไฟล์นี้ไม่ใช่ Google Sheets จึงไม่มีตัวอย่างแบบตาราง')
  const offsetRaw = ctx.url.searchParams.get('offset') ?? '0'
  const offset = Number(offsetRaw)
  if (!Number.isInteger(offset) || offset < 0 || offset > 5_000_000) throw new HttpError(422, 'validation_failed', 'ตำแหน่งแถวไม่ถูกต้อง', { field: 'offset' })
  const base = `${SHEETS_API}/${encodeURIComponent(target.id)}`
  try {
    const meta = await gapi.json<SheetMeta>(`${base}?fields=${encodeURIComponent('properties.title,sheets.properties(sheetId,title,sheetType,hidden,gridProperties(rowCount,columnCount))')}`)
    const tabs = (meta.sheets ?? [])
      .map((s) => s.properties)
      .filter((p): p is NonNullable<typeof p> => !!p && typeof p.sheetId === 'number' && (p.sheetType ?? 'GRID') === 'GRID' && p.hidden !== true)
      .map((p) => ({ id: p.sheetId!, title: p.title ?? '', rowCount: p.gridProperties?.rowCount ?? 0, columnCount: p.gridProperties?.columnCount ?? 0 }))
    const title = meta.properties?.title ?? ''
    if (tabs.length === 0) return json({ title, tabs: [], tab: null, rows: [], range: null, hasMoreRows: false, truncatedColumns: false, hiddenRows: 0, hiddenColumns: 0 })

    const wanted = ctx.url.searchParams.get('tab')
    const tab = wanted === null ? tabs[0] : tabs.find((t) => String(t.id) === wanted)
    if (!tab) throw new HttpError(404, 'tab_not_found', 'ไม่พบแท็บนี้ในไฟล์แล้ว (อาจถูกลบ ซ่อน หรือเปลี่ยนใน Google Sheets) เลือกแท็บอื่น')
    if (offset >= tab.rowCount) {
      return json({ title, tabs, tab: tab.id, rows: [], range: null, hasMoreRows: false, truncatedColumns: tab.columnCount > SHEET_COLUMNS, hiddenRows: 0, hiddenColumns: 0 })
    }
    const lastRow = Math.min(offset + SHEET_ROWS, tab.rowCount)
    const lastColumn = Math.max(1, Math.min(SHEET_COLUMNS, tab.columnCount))
    const range = `'${tab.title.replace(/'/g, "''")}'!R${offset + 1}C1:R${lastRow}C${lastColumn}`
    const fields = 'sheets(data(rowData(values(formattedValue)),rowMetadata(hiddenByUser,hiddenByFilter),columnMetadata(hiddenByUser)))'
    const grid = await gapi.json<GridData>(`${base}?ranges=${encodeURIComponent(range)}&includeGridData=true&fields=${encodeURIComponent(fields)}`)
    const block = grid.sheets?.[0]?.data?.[0] ?? {}
    const hiddenColumn = (index: number) => block.columnMetadata?.[index]?.hiddenByUser === true
    const hiddenRow = (index: number) => block.rowMetadata?.[index]?.hiddenByUser === true || block.rowMetadata?.[index]?.hiddenByFilter === true
    const columns = Array.from({ length: lastColumn }, (_, index) => index).filter((index) => !hiddenColumn(index))
    const rows: { number: number; cells: string[] }[] = []
    let hiddenRows = 0
    for (let index = 0; index < lastRow - offset; index++) {
      if (hiddenRow(index)) {
        hiddenRows++
        continue
      }
      const values = block.rowData?.[index]?.values ?? []
      rows.push({ number: offset + index + 1, cells: columns.map((column) => (typeof values[column]?.formattedValue === 'string' ? values[column].formattedValue! : '')) })
    }
    // ตัดแถวว่างท้ายช่วงออกจากคำตอบ (ขอบเขตที่อ่านจริงยังรายงานใน range)
    while (rows.length > 0 && rows[rows.length - 1].cells.every((cell) => cell === '')) rows.pop()
    return json({
      title,
      tabs,
      tab: tab.id,
      rows,
      columns: columns.map((column) => column + 1),
      // ขอบเขตที่อ่านจาก Google ในคำขอนี้ ไม่ใช่ทั้งชีตเสมอไป
      range: { firstRow: offset + 1, lastRow, firstColumn: 1, lastColumn, totalRows: tab.rowCount, totalColumns: tab.columnCount },
      hasMoreRows: lastRow < tab.rowCount,
      truncatedColumns: tab.columnCount > SHEET_COLUMNS,
      hiddenRows,
      hiddenColumns: lastColumn - columns.length,
    })
  } catch (error) {
    throw fileError(error, session)
  }
}

/**
 * GET /api/library/files/:id/form — ชื่อ คำอธิบาย และคำถามของ Google Forms (อ่านอย่างเดียว)
 * ไม่มีคำตอบของผู้ตอบ: คำตอบและการนำเข้าสมาชิกเป็นเครื่องมือของทีมงานในหน้าฟอร์ม
 */
async function formPreview(ctx: Ctx, id: string): Promise<Response> {
  const session = requireViewer(ctx)
  await requireFileAccess(ctx.env, session)
  const gapi = makeGapi(ctx.env, 4)
  const { target } = await resolveFile(gapi, id, session)
  if (previewPlan(target).kind !== 'form') throw new HttpError(415, 'preview_unsupported', 'ไฟล์นี้ไม่ใช่ Google Forms จึงไม่มีตัวอย่างแบบฟอร์ม')
  try {
    const form = await gapi.json<Record<string, any>>(`${FORMS_API}/${encodeURIComponent(target.id)}`)
    const isQuiz = form.settings?.quizSettings?.isQuiz === true
    const items = ((Array.isArray(form.items) ? form.items : []) as Record<string, any>[]).map((item) => {
      const view = describeItem(item, isQuiz)
      return {
        kind: view.kind,
        title: view.title,
        description: view.description,
        required: view.required,
        options: view.options.map((option) => (option.isOther ? 'อื่น ๆ' : option.value)),
        rows: view.questions.map((question) => question.label).filter((label) => label !== ''),
      }
    })
    return json({
      title: typeof form.info?.title === 'string' ? form.info.title : '',
      description: typeof form.info?.description === 'string' ? form.info.description : '',
      // หน้าตอบฟอร์มของ Google (ลิงก์ที่ Google ให้มา): การตอบและสิทธิ์เข้าฟอร์มเป็นไปตามการตั้งค่าของฟอร์มนั้น
      responderUrl: googleLink(form.responderUri),
      items,
    })
  } catch (error) {
    throw fileError(error, session)
  }
}

export async function handleLibrary(ctx: Ctx, parts: string[]): Promise<Response | null> {
  // คลังอ่านได้อย่างเดียว: ไม่มีคำสั่งเปลี่ยนข้อมูลใด
  if (ctx.request.method !== 'GET') return null
  if (parts.length === 1 && parts[0] === 'status') return status(ctx)
  if (parts[0] !== 'files') return null
  if (parts.length === 1) return list(ctx)
  if (parts.length === 2) return detail(ctx, parts[1])
  if (parts.length === 3) {
    if (parts[2] === 'thumbnail') return thumbnail(ctx, parts[1])
    if (parts[2] === 'content') return content(ctx, parts[1])
    if (parts[2] === 'text') return textPreview(ctx, parts[1])
    if (parts[2] === 'sheet') return sheetPreview(ctx, parts[1])
    if (parts[2] === 'form') return formPreview(ctx, parts[1])
  }
  return null
}

/** สร้างหรือเปลี่ยนไฟล์จากเว็บแล้ว: ล้างสำเนาชั่วคราวของรายการ เพื่อให้ไฟล์ใหม่ปรากฏเมื่อโหลดรายการครั้งถัดไป */
export const invalidateLists = (env: AppEnv) => env.DB.prepare(`DELETE FROM library_cache WHERE key LIKE 'list:%'`).run().catch(() => undefined)
