// ตรวจหน้าไฟล์โดยจำลอง session/Google; เปิด npm run dev ก่อน ไม่มีการเขียนข้อมูลจริง
import { chromium } from 'playwright-core'
import { mockLibrary } from './ui-library-mock.mjs'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL ?? 'msedge' })
let passed = 0
const check = (name, ok) => { if (!ok) throw new Error(name); passed++; console.log(`PASS ${name}`) }
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'th-TH' })
    const page = await context.newPage()
    await page.route('**/api/session', (route) => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ authConfigured: true, user: null, member: { id: 'sample-member', name: 'สมาชิกตัวอย่าง', nickname: 'ตัวอย่าง', studentId: '6501234', mustChangePassword: false }, csrfToken: 'sample' }) }))
    const calls = await mockLibrary(page)
    let active = 0, maximum = 0
    await page.route('**/api/library/files/*/thumbnail?*', async (route) => {
      active++; maximum = Math.max(maximum, active)
      await new Promise(resolve => setTimeout(resolve, 100))
      await route.fallback()
      active--
    })
    await page.goto(`${BASE}/member/files`)
    await page.waitForFunction(() => [...document.querySelectorAll('.file-thumbnail img')].some(img => img.complete && img.naturalWidth > 0))
    check(`${width}: ภาพโหลดใกล้หน้าจอไม่เกิน 4 พร้อมกัน`, maximum <= 4 && calls.filter(c => c.includes('/thumbnail')).length < 25)
    check(`${width}: การ์ดไม่โหลดเนื้อหาเอกสารเต็ม`, !calls.some(c => c.includes('/content')))
    const before = calls.filter(c => /GET \/api\/library\/files(?:\?|$)/.test(c)).length
    await page.getByRole('button', { name: 'มุมมองรายการ', exact: true }).click()
    check(`${width}: สลับรายการไม่โหลดรายชื่อซ้ำ`, await page.locator('.file-grid-list .file-card').count() === 30 && calls.filter(c => /GET \/api\/library\/files(?:\?|$)/.test(c)).length === before)
    await page.getByRole('button', { name: 'มุมมองตาราง', exact: true }).click()
    await page.locator('.file-name').first().click()
    await page.locator('.preview-title').waitFor()
    let release
    const gate = new Promise(resolve => { release = resolve })
    const hold = async route => { await gate; await route.fallback() }
    await page.route(`${BASE}/api/library/files`, hold)
    const updating = page.waitForRequest(r => r.url() === `${BASE}/api/library/files`)
    await page.locator('.preview-back').click()
    await updating
    check(`${width}: กลับเห็นรายชื่อทันทีขณะคำขอใหม่ยังรอ`, await page.locator('.file-card').count() === 30 && await page.locator('.file-loading').count() === 0)
    release()
    await page.getByRole('button', { name: 'รีเฟรช', exact: true }).waitFor()
    await page.unroute(`${BASE}/api/library/files`, hold)

    // หมดอายุสำเนาในหน่วยความจำ + API ล้ม: ต้องเป็น error ที่ลองใหม่ได้ ไม่ค้าง skeleton
    await page.locator('.file-name').first().click()
    await page.locator('.preview-title').waitFor()
    await page.evaluate(() => { window.__savedNow = Date.now; Date.now = () => window.__savedNow() + 120000 })
    const fail = route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'google_error', message: 'โหลดรายการไม่สำเร็จ' }) })
    await page.route(`${BASE}/api/library/files`, fail)
    await page.locator('.preview-back').click()
    await page.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }).waitFor()
    check(`${width}: สำเนาหมดอายุแล้ว API ล้มไม่ค้างกำลังโหลด`, await page.locator('.file-loading').count() === 0)
    await page.evaluate(() => { Date.now = window.__savedNow; delete window.__savedNow })
    await page.unroute(`${BASE}/api/library/files`, fail)
    await page.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }).click()
    await page.locator('.file-card').first().waitFor()
    check(`${width}: ลองใหม่กลับมาแสดงไฟล์ได้`, await page.locator('.file-card').count() === 30)
    check(`${width}: ไม่มีเนื้อหาล้นแนวนอน`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth))
    await page.route('**/api/library/files/file-image-0006', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ file: { id: 'file-image-0006', name: 'รูปกิจกรรม.HEIC', kind: 'image', mimeType: 'image/heic', modifiedTime: new Date().toISOString(), size: 3000000, thumbnail: true, previewable: true }, preview: { kind: 'thumbnail', reason: null, maxBytes: 26214400 }, links: { open: null, edit: null }, fetchedAt: new Date().toISOString() }) }))
    await page.goto(`${BASE}/member/files/file-image-0006`)
    await page.waitForFunction(() => { const img = document.querySelector('.image-viewer img'); return img && !img.hidden && img.complete && img.naturalWidth > 0 })
    check(`${width}: HEIC แสดงภาพย่อพร้อมอธิบายความละเอียด`, await page.locator('.thumbnail-note').isVisible())
    await context.close()
  }
  console.log(`ผ่าน ${passed} ข้อ (จำลอง session/Google)`)
} finally { await browser.close() }
