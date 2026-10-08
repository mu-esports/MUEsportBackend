import type { FakeGoogle } from './helpers'

/**
 * Google Drive จำลองสำหรับทดสอบคลังไฟล์: files.list (คำค้น เรียง แบ่งหน้า), files.get, alt=media (Range), export
 * และ Sheets API แบบอ่านอย่างเดียว (แท็บ ข้อมูลตาราง แถว/คอลัมน์ที่ซ่อน) ของไฟล์ที่อยู่ในตัวจำลองนี้
 * ผลจากไฟล์นี้เป็นการทดสอบกับ mock เท่านั้น ไม่ใช่หลักฐานว่าต่อกับ Google จริงได้
 */
type Json = Record<string, any>

const reply = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })

const driveError = (status: number, reason: string) => reply({ error: { code: status, errors: [{ reason }] } }, status)

export const MIME = {
  doc: 'application/vnd.google-apps.document',
  sheet: 'application/vnd.google-apps.spreadsheet',
  slides: 'application/vnd.google-apps.presentation',
  form: 'application/vnd.google-apps.form',
  folder: 'application/vnd.google-apps.folder',
  shortcut: 'application/vnd.google-apps.shortcut',
  pdf: 'application/pdf',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
}

export interface FakeTab {
  sheetId: number
  title: string
  cells: string[][]
  rowCount?: number
  columnCount?: number
  hidden?: boolean
  hiddenRows?: number[]
  hiddenColumns?: number[]
}

export interface FakeFile {
  id: string
  name: string
  mimeType: string
  modifiedTime: string
  bytes?: Uint8Array
  /** ขนาดที่ Drive รายงาน (ค่าเริ่มต้น = ความยาวของ bytes) */
  size?: number
  parents?: string[]
  ownedByMe?: boolean
  trashed?: boolean
  canDownload?: boolean
  canEdit?: boolean
  shortcut?: { targetId: string; targetMimeType: string }
  /** ผลของการส่งออกเป็น PDF หรือ 'too_large' เมื่อ Google ปฏิเสธเพราะเกิน 10 MB */
  exported?: Uint8Array | 'too_large'
  tabs?: FakeTab[]
  /** บัญชีชมรมเปิดไม่ได้ (เช่น ถูกยกเลิกการแชร์): Google ตอบ 404 */
  inaccessible?: boolean
  thumbnailLink?: string
  thumbnailVersion?: string
}

export const PDF_BYTES = new TextEncoder().encode('%PDF-1.4\n% fake pdf body for tests\n%%EOF\n')

const unquote = (text: string) => text.replace(/\\(.)/g, '$1')

/** ตรวจเงื่อนไขของคำค้น Drive เฉพาะรูปแบบที่ระบบสร้าง ถ้าเจอรูปแบบอื่นให้ล้มเหลวชัด ๆ */
function matches(file: FakeFile, q: string): boolean {
  const mime = file.mimeType
  for (const part of q.split(' and ')) {
    let m: RegExpExecArray | null
    if (part === 'trashed = false') {
      if (file.trashed) return false
    } else if ((m = /^mimeType != '((?:[^'\\]|\\.)*)'$/.exec(part))) {
      if (mime === unquote(m[1])) return false
    } else if ((m = /^mimeType = '((?:[^'\\]|\\.)*)'$/.exec(part))) {
      if (mime !== unquote(m[1])) return false
    } else if ((m = /^name contains '((?:[^'\\]|\\.)*)'$/.exec(part))) {
      if (!file.name.toLowerCase().includes(unquote(m[1]).toLowerCase())) return false
    } else if (part === `mimeType contains 'image/'`) {
      if (!mime.startsWith('image/')) return false
    } else if (part === `not mimeType contains 'image/'`) {
      if (mime.startsWith('image/')) return false
    } else if (part.startsWith('(') && part.endsWith(')')) {
      const options = part.slice(1, -1).split(' or ').map((o) => /^mimeType = '(.*)'$/.exec(o)?.[1])
      if (options.some((o) => o === undefined)) throw new Error(`fake drive: unsupported query part ${part}`)
      if (!options.includes(mime)) return false
    } else {
      throw new Error(`fake drive: unsupported query part ${part}`)
    }
  }
  return true
}

export class FakeDrive {
  files = new Map<string, FakeFile>()
  rootId = 'root-folder-0001'
  /** คำขอ files.list ที่ได้รับ (ใช้ตรวจว่าระบบส่งพารามิเตอร์ใดไป) */
  lists: URLSearchParams[] = []
  incompleteSearch = false
  private counter = 0

  constructor(google: FakeGoogle) {
    // วางไว้หน้าสุด เพื่อให้ไฟล์ของตัวจำลองนี้ถูกตอบก่อนตัวจำลองอื่น
    google.services.unshift((url, method, init) => this.handle(url, method, init))
    this.files.set(this.rootId, { id: this.rootId, name: 'My Drive', mimeType: MIME.folder, modifiedTime: '2026-01-01T00:00:00.000Z' })
  }

  add(file: Partial<FakeFile> & { name: string; mimeType: string }): FakeFile {
    const id = file.id ?? `file-${String(++this.counter).padStart(6, '0')}`
    const stored: FakeFile = { modifiedTime: new Date(Date.UTC(2026, 8, 1, 0, this.counter)).toISOString(), parents: [this.rootId], ...file, id }
    this.files.set(id, stored)
    return stored
  }

  private meta(file: FakeFile): Json {
    const size = file.size ?? file.bytes?.length
    return {
      id: file.id, name: file.name, mimeType: file.mimeType, modifiedTime: file.modifiedTime, trashed: file.trashed === true,
      ...(size !== undefined ? { size: String(size) } : {}),
      webViewLink: file.mimeType === MIME.form ? `https://docs.google.com/forms/d/${file.id}/edit` : `https://drive.google.com/file/d/${file.id}/view?usp=drivesdk`,
      parents: file.parents ?? [], ownedByMe: file.ownedByMe ?? true,
      ...(file.shortcut ? { shortcutDetails: file.shortcut } : {}),
      capabilities: { canDownload: file.canDownload ?? true, canEdit: file.canEdit ?? true },
      ...(file.thumbnailLink ? { hasThumbnail: true, thumbnailLink: file.thumbnailLink, thumbnailVersion: file.thumbnailVersion } : {}),
    }
  }

  private handle(url: URL, method: string, init?: RequestInit): Response | undefined {
    if (method !== 'GET') return undefined
    if (url.origin === 'https://sheets.googleapis.com') return this.sheets(url)
    if (url.origin !== 'https://www.googleapis.com' || !url.pathname.startsWith('/drive/v3/files')) return undefined
    const [, , , , rawId, action] = url.pathname.split('/')
    if (!rawId) return this.list(url)
    const id = decodeURIComponent(rawId)
    const file = id === 'root' ? this.files.get(this.rootId) : this.files.get(id)
    if (!file) return undefined
    if (file.inaccessible) return driveError(404, 'notFound')

    if (action === 'export') {
      if (file.canDownload === false) return driveError(403, 'cannotDownloadFile')
      if (!file.mimeType.startsWith('application/vnd.google-apps.')) return driveError(403, 'fileNotExportable')
      if (file.exported === 'too_large') return driveError(403, 'exportSizeLimitExceeded')
      return new Response(file.exported ?? PDF_BYTES, { headers: { 'Content-Type': url.searchParams.get('mimeType') ?? '' } })
    }
    if (url.searchParams.get('alt') === 'media') {
      if (file.canDownload === false) return driveError(403, 'cannotDownloadFile')
      if (file.mimeType.startsWith('application/vnd.google-apps.')) return driveError(403, 'fileNotDownloadable')
      const bytes = file.bytes ?? new Uint8Array()
      const range = /^bytes=(\d+)-(\d*)$/.exec(new Headers(init?.headers).get('Range') ?? '')
      if (range) {
        const start = Number(range[1])
        if (start >= bytes.length) return new Response(null, { status: 416 })
        const end = Math.min(range[2] === '' ? bytes.length - 1 : Number(range[2]), bytes.length - 1)
        return new Response(bytes.slice(start, end + 1), {
          status: 206, headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': String(end - start + 1) },
        })
      }
      // Google ส่งชนิดเนื้อหาของตัวเองมาด้วย ระบบต้องไม่ใช้ค่านี้ตรง ๆ
      return new Response(bytes, { headers: { 'Content-Type': 'text/html', 'Content-Length': String(file.size ?? bytes.length) } })
    }
    return reply(this.meta(file))
  }

  private list(url: URL): Response | undefined {
    const q = url.searchParams.get('q') ?? ''
    // คำค้นของคลังไฟล์เท่านั้น คำค้นรูปแบบอื่น (เช่น หาไฟล์จากป้ายของงานสร้าง) ให้ตัวจำลองอื่นตอบ
    if (!q.startsWith('trashed = false and mimeType != ')) return undefined
    this.lists.push(url.searchParams)
    const found = [...this.files.values()].filter((file) => file.id !== this.rootId && !file.inaccessible && matches(file, q))
    const order = url.searchParams.get('orderBy')
    if (order === 'name_natural') found.sort((a, b) => a.name.localeCompare(b.name, 'th', { numeric: true }))
    else if (order === 'modifiedTime desc') found.sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime))
    else return driveError(400, 'invalid')
    const signature = `${q}|${order}`.length
    const token = url.searchParams.get('pageToken')
    let offset = 0
    if (token) {
      const parsed = /^~!tok!(\d+)!(\d+)$/.exec(token)
      if (!parsed || Number(parsed[2]) !== signature) return driveError(400, 'invalid')
      offset = Number(parsed[1])
    }
    const size = Number(url.searchParams.get('pageSize') ?? '100')
    const page = found.slice(offset, offset + size)
    return reply({
      files: page.map((file) => this.meta(file)),
      incompleteSearch: this.incompleteSearch,
      ...(offset + size < found.length ? { nextPageToken: `~!tok!${offset + size}!${signature}` } : {}),
    })
  }

  private sheets(url: URL): Response | undefined {
    const match = /^\/v4\/spreadsheets\/([^/:]+)$/.exec(url.pathname)
    const file = match ? this.files.get(decodeURIComponent(match[1])) : undefined
    if (!file?.tabs) return undefined
    if (url.searchParams.get('includeGridData') !== 'true') {
      return reply({
        properties: { title: file.name },
        sheets: file.tabs.map((tab) => ({
          properties: {
            sheetId: tab.sheetId, title: tab.title, sheetType: 'GRID', ...(tab.hidden ? { hidden: true } : {}),
            gridProperties: { rowCount: tab.rowCount ?? Math.max(tab.cells.length, 1000), columnCount: tab.columnCount ?? 26 },
          },
        })),
      })
    }
    const range = /^'((?:[^']|'')*)'!R(\d+)C(\d+):R(\d+)C(\d+)$/.exec(url.searchParams.get('ranges') ?? '')
    if (!range) return reply({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, 400)
    const tab = file.tabs.find((t) => t.title === range[1].replace(/''/g, "'"))
    if (!tab) return reply({ error: { code: 400, status: 'INVALID_ARGUMENT' } }, 400)
    const [firstRow, firstCol, lastRow, lastCol] = [Number(range[2]), Number(range[3]), Number(range[4]), Number(range[5])]
    const rowData = []
    const rowMetadata = []
    for (let r = firstRow - 1; r < lastRow; r++) {
      const cells = tab.cells[r] ?? []
      rowData.push({ values: Array.from({ length: lastCol - firstCol + 1 }, (_, c) => (cells[firstCol - 1 + c] ? { formattedValue: cells[firstCol - 1 + c] } : {})) })
      rowMetadata.push(tab.hiddenRows?.includes(r) ? { hiddenByUser: true } : {})
    }
    const columnMetadata = Array.from({ length: lastCol - firstCol + 1 }, (_, c) => (tab.hiddenColumns?.includes(firstCol - 1 + c) ? { hiddenByUser: true } : {}))
    return reply({ sheets: [{ data: [{ rowData, rowMetadata, columnMetadata }] }] })
  }
}
