// คลังไฟล์ชมรมจำลองสำหรับชุดตรวจ UI: ตอบ /api/library/* ในเบราว์เซอร์ทดสอบด้วยข้อมูลสมมติ
// ใช้ดูสถานะของหน้าจอเท่านั้น เพราะเครื่องพัฒนาไม่มีการเชื่อม Google จริง
// การคุยกับ Google Drive/Sheets/Forms ของ Worker (สิทธิ์ การแบ่งหน้า ชนิดไฟล์ ขนาด) ตรวจใน `npm test` ด้วย Google จำลองฝั่ง server
// ไม่มีข้อใดที่ใช้ไฟล์นี้เป็นการตรวจกับ Google จริง
import { deflateSync } from 'node:zlib'

/** PDF ขนาดเล็กที่ถูกต้องตามรูปแบบ (ข้อความหน้าเดียวต่อหน้า) สร้างในหน่วยความจำ ไม่อ่านไฟล์จากที่ใด */
export function makePdf(pages = ['MU Esport sample document']) {
  const objects = []
  const add = (body) => {
    objects.push(body)
    return objects.length
  }
  const fontId = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pagesId = objects.length + 1 + pages.length * 2
  const kids = []
  for (const text of pages) {
    const stream = `BT /F1 20 Tf 60 760 Td (${text.replace(/[()\\]/g, '')}) Tj ET\n0.11 0.31 0.85 rg 60 700 475 4 re f`
    const contentId = add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    kids.push(add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`))
  }
  add(`<< /Type /Pages /Kids [${kids.map((id) => `${id} 0 R`).join(' ')}] /Count ${kids.length} >>`)
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  let out = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((body, index) => {
    offsets.push(out.length)
    out += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')}`
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(out, 'latin1')
}

// ภาพจำลองขนาดจริง 256x320: ตรวจว่า intrinsic size ไม่ดัน grid ให้ล้นจอเหมือนภาพ 1x1
function sampleThumbnail() {
  const crc = (bytes) => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type), length = Buffer.alloc(4), checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length); checksum.writeUInt32BE(crc(Buffer.concat([name, data])))
    return Buffer.concat([length, name, data, checksum])
  }
  const width = 256, height = 320, pixels = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = y * (width * 3 + 1) + 1 + x * 3
    const blue = x >= 24 && x < 232 && y >= 26 && y < 55
    const line = x >= 24 && x < 218 && y > 80 && y < 270 && y % 26 < 5
    const color = blue ? [29, 78, 216] : line ? [203, 213, 225] : [255, 255, 255]
    pixels.set(color, offset)
  }
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0); header.writeUInt32BE(height, 4); header[8] = 8; header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
const PNG = sampleThumbnail()

const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
const LONG_NAME = 'รายงานสรุปผลการแข่งขันภายในชมรมและข้อเสนอแนะจากสมาชิกทุกทีม ประจำภาคเรียนที่ 1 ปีการศึกษา 2569 ฉบับปรับปรุงครั้งที่ 3 (ร่างสำหรับที่ประชุมใหญ่)'

/** ไฟล์สมมติครบทุกชนิดที่หน้าจอต้องรองรับ */
export const MOCK_FILES = [
  { id: 'file-doc-0001', name: 'แผนงานชมรม ภาคเรียนที่ 1', kind: 'doc', mimeType: 'application/vnd.google-apps.document', modifiedTime: iso(12), size: null, shortcut: false, shared: false, folder: 'เอกสารประชุม', previewable: true },
  { id: 'file-sheet-0002', name: 'ตารางซ้อมและห้องที่ใช้', kind: 'sheet', mimeType: 'application/vnd.google-apps.spreadsheet', modifiedTime: iso(95), size: null, shortcut: false, shared: false, folder: null, previewable: true },
  { id: 'file-form-0003', name: 'ใบสมัครสมาชิกใหม่', kind: 'form', mimeType: 'application/vnd.google-apps.form', modifiedTime: iso(300), size: null, shortcut: false, shared: false, folder: null, previewable: true },
  { id: 'file-slides-0004', name: 'สไลด์เปิดบ้านชมรม', kind: 'slides', mimeType: 'application/vnd.google-apps.presentation', modifiedTime: iso(1500), size: null, shortcut: false, shared: true, folder: null, previewable: true },
  { id: 'file-pdf-0005', name: LONG_NAME, kind: 'pdf', mimeType: 'application/pdf', modifiedTime: iso(2900), size: 184_320, shortcut: false, shared: false, folder: 'รายงาน', previewable: true },
  { id: 'file-image-0006', name: 'โปสเตอร์รับสมัคร.png', kind: 'image', mimeType: 'image/png', modifiedTime: iso(4400), size: 68, shortcut: false, shared: false, folder: null, previewable: true },
  { id: 'file-office-0007', name: 'ระเบียบการใช้ห้อง.docx', kind: 'office', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', modifiedTime: iso(6000), size: 24_576, shortcut: false, shared: false, folder: null, previewable: false },
  { id: 'file-text-0008', name: 'บันทึกสั้น.txt', kind: 'text', mimeType: 'text/plain', modifiedTime: iso(7300), size: 120, shortcut: true, shared: false, folder: null, previewable: true },
  { id: 'file-video-0009', name: 'คลิปไฮไลต์รอบชิง.mp4', kind: 'video', mimeType: 'video/mp4', modifiedTime: iso(9000), size: 31_457_280, shortcut: false, shared: false, folder: null, previewable: false },
]
const EXTRA = Array.from({ length: 36 }, (_, i) => ({
  id: `file-extra-${String(i + 1).padStart(4, '0')}`, name: `เอกสารประกอบ ${String(i + 1).padStart(2, '0')}`, kind: 'pdf', mimeType: 'application/pdf', modifiedTime: iso(10_000 + i * 60), size: 20_480,
  shortcut: false, shared: false, folder: null, previewable: true,
}))
const ALL = [...MOCK_FILES, ...EXTRA]
// ทดสอบภาพย่อผ่าน API ของเว็บ ไม่ใช้ URL Google หรือ credential ใน browser
ALL.forEach((file) => { file.thumbnail = ['doc', 'sheet', 'slides', 'pdf', 'image'].includes(file.kind) })

const SHEET_ROWS = Array.from({ length: 260 }, (_, i) => ({ number: i + 1, cells: i === 0 ? ['วัน', 'เวลา', 'ห้อง', 'ทีม'] : [`วันที่ ${i}`, '18:00–20:00', i % 2 ? 'ห้องชมรม' : 'ห้อง 204', `ทีม ${(i % 5) + 1}`] }))

const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json; charset=utf-8', headers: { 'Cache-Control': 'no-store' }, body: JSON.stringify(body) })

/**
 * ตอบ /api/library/* ของหน้านี้ด้วยข้อมูลสมมติ
 * @param {import('playwright-core').Page} page
 * @param {{ audience?: 'staff' | 'member', mode?: { list?: 'ok' | 'unavailable' | 'missing_scope' | 'error' | 'stale' | 'empty' }, calls?: string[] }} options
 */
export async function mockLibrary(page, options = {}) {
  const audience = options.audience ?? 'member'
  const mode = options.mode ?? {}
  const calls = options.calls ?? []
  const pdf = makePdf(['MU Esport - page 1', 'MU Esport - page 2', 'MU Esport - page 3'])
  await page.route('**/api/library/**', (route) => {
    const url = new URL(route.request().url())
    calls.push(`${route.request().method()} ${url.pathname}${url.search}`)
    const parts = url.pathname.split('/').filter(Boolean).slice(2)
    if (parts[0] === 'status') {
      const enabled = (mode.list ?? 'ok') === 'ok' || mode.list === 'stale' || mode.list === 'empty'
      return json(route, {
        enabled, reason: enabled ? null : audience === 'member' ? 'unavailable' : (mode.list === 'missing_scope' ? 'missing_scope' : 'not_connected'),
        message: enabled ? null : audience === 'member' ? 'คลังไฟล์ของชมรมยังไม่พร้อมใช้งานในตอนนี้ ติดต่อทีมงาน' : 'ยังไม่ได้เปิดใช้คลังไฟล์ Google: บัญชีชมรมยังไม่ได้อนุญาตให้เว็บอ่านไฟล์ของชมรม ให้ผู้ดูแลกด “เปิดใช้คลังไฟล์ Google”',
        canEnable: !enabled && audience === 'staff' && mode.list === 'missing_scope', lastSuccessAt: enabled ? iso(1) : null,
        limits: { previewBytes: 26214400, textBytes: 524288, sheetRows: 200, sheetColumns: 40, pageSize: 30 },
      })
    }
    if (parts[0] !== 'files') return json(route, { error: 'not_found', message: 'ไม่พบเส้นทาง API นี้' }, 404)

    if (parts.length === 1) {
      const state = mode.list ?? 'ok'
      if (state === 'unavailable' || state === 'missing_scope') {
        return json(route, {
          error: 'library_unavailable', reason: state === 'missing_scope' ? 'missing_scope' : 'not_connected',
          message: audience === 'member' ? 'คลังไฟล์ของชมรมยังไม่พร้อมใช้งานในตอนนี้ ติดต่อทีมงาน' : state === 'missing_scope'
            ? 'ยังไม่ได้เปิดใช้คลังไฟล์ Google: บัญชีชมรมยังไม่ได้อนุญาตให้เว็บอ่านไฟล์ของชมรม ให้ผู้ดูแลกด “เปิดใช้คลังไฟล์ Google”'
            : 'ยังไม่ได้เชื่อมบัญชี Google ของชมรม จึงยังไม่มีคลังไฟล์ ให้ผู้ดูแลเชื่อมที่หน้าแหล่งข้อมูล',
        }, 409)
      }
      if (state === 'error') return json(route, { error: 'google_error', message: 'โหลดรายการไฟล์จาก Google ไม่สำเร็จ กดรีเฟรชเพื่อลองอีกครั้ง' }, 502)
      const q = (url.searchParams.get('q') ?? '').toLowerCase()
      const type = url.searchParams.get('type') ?? 'all'
      const sort = url.searchParams.get('sort') ?? 'modified'
      const limit = Number(url.searchParams.get('limit') ?? 30)
      let found = state === 'empty' ? [] : ALL.filter((f) => (!q || f.name.toLowerCase().includes(q)) && (type === 'all' || f.kind === type || (type === 'other' && ['text', 'video', 'other'].includes(f.kind))))
      found = [...found].sort((a, b) => (sort === 'name' ? a.name.localeCompare(b.name, 'th') : b.modifiedTime.localeCompare(a.modifiedTime)))
      const offset = Number(url.searchParams.get('pageToken') ?? 0)
      const pageFiles = found.slice(offset, offset + limit)
      return json(route, {
        files: pageFiles, nextPageToken: offset + limit < found.length ? String(offset + limit) : null, incomplete: false,
        fetchedAt: state === 'stale' ? iso(45) : new Date().toISOString(), pageSize: limit, stale: state === 'stale',
        ...(state === 'stale' ? { error: { code: 'rate_limited', message: 'Google จำกัดจำนวนคำขอชั่วคราว รอสักครู่แล้วกดรีเฟรชอีกครั้ง' } } : {}),
      })
    }

    const file = ALL.find((f) => f.id === parts[1])
    if (!file) return json(route, { error: 'file_unavailable', message: 'เปิดไฟล์นี้ไม่ได้: ไฟล์อาจถูกลบ ย้ายไปถังขยะ หรือบัญชี Google ของชมรมไม่มีสิทธิ์เข้าถึงแล้ว' }, 404)
    const previewKind = { doc: 'pdf', slides: 'pdf', pdf: 'pdf', sheet: 'sheet', form: 'form', image: 'image', text: 'text' }[file.kind] ?? 'none'
    if (parts.length === 2) {
      const open = `https://drive.google.com/file/d/${file.id}/view?usp=drivesdk`
      const editor = { doc: 'Google Docs', sheet: 'Google Sheets', slides: 'Google Slides', form: 'Google Forms' }[file.kind]
      return json(route, {
        file,
        preview: { kind: previewKind, reason: previewKind === 'none' ? (file.kind === 'video' ? 'unsupported' : 'unsupported') : null, maxBytes: 26214400 },
        links: {
          // เหมือนที่ server ตอบ: ปุ่มแก้ไขมีเฉพาะทีมงาน และสมาชิกไม่ได้ลิงก์หน้าแก้ฟอร์ม
          open: audience === 'staff' || file.kind !== 'form' ? open : null,
          edit: audience === 'staff' && editor ? { url: open, label: `แก้ไขใน ${editor}` } : null,
        },
        ...(audience === 'staff' ? { registered: null } : {}),
        fetchedAt: new Date().toISOString(),
      })
    }
    if (parts[2] === 'thumbnail') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
    if (parts[2] === 'content') {
      if (previewKind === 'image') return route.fulfill({ status: 200, contentType: 'image/png', body: PNG })
      if (previewKind === 'pdf') return route.fulfill({ status: 200, contentType: 'application/pdf', body: pdf })
      return json(route, { error: 'preview_unsupported', message: 'ไฟล์ชนิดนี้ไม่มีตัวอย่างแบบนี้ในเว็บ' }, 415)
    }
    if (parts[2] === 'sheet') {
      const tab = url.searchParams.get('tab') ?? '0'
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const tabs = [{ id: 0, title: 'ตารางซ้อม', rowCount: 1000, columnCount: 4 }, { id: 7, title: 'สรุป', rowCount: 20, columnCount: 2 }]
      if (tab === '7') {
        return json(route, { title: file.name, tabs, tab: 7, rows: [{ number: 1, cells: ['จำนวนวันซ้อม', '259'] }], columns: [1, 2], range: { firstRow: 1, lastRow: 20, firstColumn: 1, lastColumn: 2, totalRows: 20, totalColumns: 2 }, hasMoreRows: false, truncatedColumns: false, hiddenRows: 0, hiddenColumns: 0 })
      }
      const last = Math.min(offset + 200, 1000)
      return json(route, { title: file.name, tabs, tab: 0, rows: SHEET_ROWS.slice(offset, last), columns: [1, 2, 3, 4], range: { firstRow: offset + 1, lastRow: last, firstColumn: 1, lastColumn: 4, totalRows: 1000, totalColumns: 4 }, hasMoreRows: last < 1000, truncatedColumns: false, hiddenRows: 0, hiddenColumns: 0 })
    }
    if (parts[2] === 'form') {
      return json(route, {
        title: 'ใบสมัครสมาชิกใหม่', description: 'กรอกเพื่อสมัครเข้าชมรม ใช้เวลาประมาณ 2 นาที', responderUrl: `https://docs.google.com/forms/d/e/${file.id}/viewform`,
        items: [
          { kind: 'short_text', title: 'ชื่อ-นามสกุล', description: '', required: true, options: [], rows: [] },
          { kind: 'checkbox', title: 'เกมที่สนใจ', description: 'เลือกได้หลายข้อ', required: false, options: ['Valorant', 'RoV', 'อื่น ๆ'], rows: [] },
          { kind: 'section', title: 'ส่วนที่ 2: เวลาว่าง', description: '', required: false, options: [], rows: [] },
        ],
      })
    }
    if (parts[2] === 'text') return json(route, { text: 'นัดซ้อมวันศุกร์ 18:00\n<b>ข้อความนี้ต้องแสดงเป็นตัวอักษร ไม่ใช่ตัวหนา</b>', bytes: 120, totalBytes: 120, truncated: false, maxBytes: 524288 })
    return json(route, { error: 'not_found', message: 'ไม่พบเส้นทาง API นี้' }, 404)
  })
  return calls
}

export { LONG_NAME }
