import { api, notifyUnauthorized } from '../api/client'

/** คลังไฟล์ชมรม: ทุกคำขอผ่าน API ของเว็บซึ่งตรวจ session เอง หน้าเว็บไม่เคยได้ token ของ Google */
export type FileKind = 'doc' | 'sheet' | 'slides' | 'form' | 'pdf' | 'image' | 'office' | 'text' | 'drawing' | 'video' | 'audio' | 'folder' | 'other'
export type PreviewKind = 'pdf' | 'sheet' | 'form' | 'image' | 'text' | 'none'
export type FileType = 'all' | 'doc' | 'sheet' | 'slides' | 'form' | 'pdf' | 'image' | 'office' | 'other'
export type SortKey = 'modified' | 'name'

export interface LibraryFile {
  id: string
  name: string
  kind: FileKind
  mimeType: string
  modifiedTime: string | null
  size: number | null
  /** ทางลัดไปยังไฟล์อื่น (ชนิดที่แสดงคือชนิดของไฟล์ปลายทาง) */
  shortcut: boolean
  /** ไฟล์ที่คนอื่นแชร์ให้บัญชีชมรม */
  shared: boolean
  folder: string | null
  previewable: boolean
}

export interface FileListPage {
  files: LibraryFile[]
  /** ไม่เป็น null = ยังมีไฟล์อีก หน้านี้ไม่ใช่รายการทั้งหมด */
  nextPageToken: string | null
  /** Google แจ้งว่าผลค้นหาอาจไม่ครบ */
  incomplete: boolean
  /** เวลาที่ได้ข้อมูลชุดนี้จาก Google จริง */
  fetchedAt: string
  /** Google ล้มเหลว จึงแสดงชุดที่เก็บไว้ล่าสุด */
  stale: boolean
  error?: { code: string; message: string }
  pageSize: number
}

export interface LibraryStatus {
  enabled: boolean
  reason: string | null
  message: string | null
  canEnable: boolean
  lastSuccessAt: string | null
  limits: { previewBytes: number; textBytes: number; sheetRows: number; sheetColumns: number; pageSize: number }
}

export type NoPreviewReason = 'folder' | 'unsupported' | 'too_large' | 'download_disabled'

export interface FileDetail {
  file: LibraryFile
  preview: { kind: PreviewKind; reason: NoPreviewReason | null; maxBytes: number }
  links: { open: string | null; edit: { url: string; label: string } | null }
  /** มีเฉพาะฝั่งทีมงาน: เอกสารนี้ลงทะเบียนไว้ในเว็บหรือไม่ */
  registered?: { documentId: string } | null
  fetchedAt: string
}

export interface SheetData {
  title: string
  tabs: { id: number; title: string; rowCount: number; columnCount: number }[]
  tab: number | null
  rows: { number: number; cells: string[] }[]
  /** เลขคอลัมน์ (เริ่มที่ 1) ของแต่ละช่องใน rows */
  columns?: number[]
  range: { firstRow: number; lastRow: number; firstColumn: number; lastColumn: number; totalRows: number; totalColumns: number } | null
  hasMoreRows: boolean
  truncatedColumns: boolean
  hiddenRows: number
  hiddenColumns: number
}

export interface FormData {
  title: string
  description: string
  responderUrl: string | null
  items: { kind: string; title: string; description: string; required: boolean; options: string[]; rows: string[] }[]
}

export interface TextData {
  text: string
  bytes: number
  totalBytes: number | null
  truncated: boolean
  maxBytes: number
}

export interface ListQuery {
  q: string
  type: FileType
  sort: SortKey
}

const fileUrl = (id: string) => `/api/library/files/${encodeURIComponent(id)}`

export const libraryApi = {
  status: () => api<LibraryStatus>('/api/library/status'),
  list(query: ListQuery, options: { pageToken?: string; fresh?: boolean; limit?: number } = {}) {
    const params = new URLSearchParams()
    if (query.q.trim()) params.set('q', query.q.trim())
    if (query.type !== 'all') params.set('type', query.type)
    if (query.sort !== 'modified') params.set('sort', query.sort)
    if (options.pageToken) params.set('pageToken', options.pageToken)
    if (options.fresh) params.set('fresh', '1')
    if (options.limit) params.set('limit', String(options.limit))
    const text = params.toString()
    return api<FileListPage>(`/api/library/files${text ? `?${text}` : ''}`)
  },
  detail: (id: string) => api<FileDetail>(fileUrl(id)),
  sheet: (id: string, tab: number | null, offset: number) => {
    const params = new URLSearchParams()
    if (tab !== null) params.set('tab', String(tab))
    if (offset) params.set('offset', String(offset))
    const text = params.toString()
    return api<SheetData>(`${fileUrl(id)}/sheet${text ? `?${text}` : ''}`)
  },
  form: (id: string) => api<FormData>(`${fileUrl(id)}/form`),
  text: (id: string) => api<TextData>(`${fileUrl(id)}/text`),
  /** URL ของเนื้อหาสำหรับตัวอย่างแบบ PDF/รูปภาพ (เบราว์เซอร์ส่ง cookie ของเว็บไปเอง และ server ตรวจ session ทุกครั้ง) */
  contentUrl: (id: string) => `${fileUrl(id)}/content`,
}

/** อ่านเหตุผลจาก server เมื่อโหลดเนื้อหาไฟล์ไม่ได้ (เช่น ไฟล์ใหญ่เกิน ถูกลบ หรือเซสชันหมดอายุ) คืน null เมื่อ server ส่งเนื้อหาได้ตามปกติ */
export async function contentError(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, { headers: { Range: 'bytes=0-0' }, credentials: 'same-origin', cache: 'no-store' })
    if (response.ok) {
      await response.body?.cancel()
      return null
    }
    if (response.status === 401) notifyUnauthorized()
    const data = (await response.json().catch(() => null)) as { message?: unknown } | null
    return typeof data?.message === 'string' ? data.message : null
  } catch {
    return 'เชื่อมต่อระบบกลางไม่ได้ ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง'
  }
}

export const KIND_LABELS: Record<FileKind, string> = {
  doc: 'Google Docs',
  sheet: 'Google Sheets',
  slides: 'Google Slides',
  form: 'Google Forms',
  pdf: 'PDF',
  image: 'รูปภาพ',
  office: 'ไฟล์ Office',
  text: 'ไฟล์ข้อความ',
  drawing: 'Google Drawings',
  video: 'วิดีโอ',
  audio: 'เสียง',
  folder: 'โฟลเดอร์',
  other: 'ไฟล์อื่น ๆ',
}

export const TYPE_OPTIONS: { value: FileType; label: string }[] = [
  { value: 'all', label: 'ทุกประเภท' },
  { value: 'doc', label: 'Google Docs' },
  { value: 'sheet', label: 'Google Sheets' },
  { value: 'slides', label: 'Google Slides' },
  { value: 'form', label: 'Google Forms' },
  { value: 'pdf', label: 'PDF' },
  { value: 'image', label: 'รูปภาพ' },
  { value: 'office', label: 'ไฟล์ Office' },
  { value: 'other', label: 'อื่น ๆ' },
]

export function formatBytes(size: number | null): string {
  if (size === null) return ''
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`
  return `${(size / 1024 / 1024).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`
}
