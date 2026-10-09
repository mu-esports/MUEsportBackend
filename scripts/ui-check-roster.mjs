// ตรวจ UI ของงานรอบ “ลบบัญชี / หมวดไฟล์ / นักกีฬา / รูปโปรไฟล์” ในเบราว์เซอร์จริง: หน้าเว็บ + Worker + D1 local ผ่าน `vite dev`
// ใช้: `npm run check:ui:roster` (สคริปต์เตรียมฐานข้อมูลทดสอบ เปิดและปิด dev server เอง ที่พอร์ต 5183)
// ตัวแปร: UI_LIVE_PORT (ค่าเริ่มต้น 5183), UI_STATE_DIR (ค่าเริ่มต้น .wrangler/ui-test-state), BROWSER_CHANNEL (msedge | chrome)
//         ชุดตรวจที่ใช้พอร์ตและโฟลเดอร์เดียวกันรันพร้อมกันไม่ได้ ถ้าต้องรันซ้อนให้ตั้งทั้งสองค่าแยกกัน
//
// ขอบเขตของชุดนี้
// - [จริง]        = หน้าเว็บคุยกับ Worker และ D1 local จริง: ลบบัญชีเข้าสู่ระบบ โปรไฟล์นักกีฬา การย่อรูปในเบราว์เซอร์และการเก็บรูป และสิทธิ์ของ session
// - [จำลองคลัง]   = ตอบ /api/library/* ด้วยข้อมูลสมมติในเบราว์เซอร์ทดสอบ (scripts/ui-library-mock.mjs) เพื่อดูหน้าจอของหมวดไฟล์
//                   การขอรายการตามชนิดจาก Google ของ Worker (รวมทางลัดและการแบ่งหน้า) ตรวจใน `npm test` ด้วย Google จำลองฝั่ง server
// - [ตัดคำขอ]     = ชุดตรวจตัดหรือทิ้งคำตอบของคำขอในเบราว์เซอร์ทดสอบ เพื่อดูว่าหน้าเว็บทำอย่างไรเมื่อไม่ได้คำตอบ (server ยังเป็นของจริง)
// ไม่มีข้อใดในไฟล์นี้เป็นการตรวจกับ Google จริง และรูปที่ใช้เป็นภาพลวดลายที่สร้างขึ้นในหน่วยความจำ ไม่ใช่รูปของบุคคล
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { deflateSync } from 'node:zlib'
import { chromium } from 'playwright-core'
import { prepareLocalDatabase } from './local-fixtures.mjs'
import { loginWithPassword, makePasswordMaterial } from './member-password-client.mjs'
import { mockLibrary } from './ui-library-mock.mjs'

const PORT = Number(process.env.UI_LIVE_PORT ?? 5183)
const BASE = `http://localhost:${PORT}`
const CHANNEL = process.env.BROWSER_CHANNEL ?? 'msedge'
const STATE_DIR = process.env.UI_STATE_DIR ?? '.wrangler/ui-test-state'
const OUT = 'screenshots'
const THEME_KEY = 'mu-esport-staff:theme:v1'
mkdirSync(OUT, { recursive: true })

let failed = 0
let passed = 0
const check = (name, ok, extra = '') => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`)
}

const TEMP = 'Temp-Pass-7391'
const READY = 'Ready-Member-4410'
const LONG_PERSON = 'พรรณวดี ศรีสุวรรณรัตนาภรณ์พิพัฒน์กุลวงศ์เจริญทรัพย์ไพศาล (ชื่อยาวสำหรับทดสอบการตัดบรรทัด)'

// ---------- เตรียมฐานข้อมูลทดสอบและ dev server ----------
const actors = prepareLocalDatabase(
  STATE_DIR,
  [
    { key: 'admin', email: 'muesport2567@gmail.com', role: 'admin', name: 'MU Esport', sessions: 2 },
    { key: 'staff', email: 'staff.a@example.com', role: 'staff', name: 'ทีมงาน เอ' },
  ],
  [
    { key: 'mind', name: 'ณิชา ตัวอย่างสุข', nickname: 'มายด์', studentId: '0065002', password: READY, sessions: 2, contact: 'Discord: mind_sample', athlete: { game: 'Valorant', team: 'MU Alpha', position: 'Duelist', ign: 'mind#TH1' } },
    { key: 'meth', name: 'กฤตเมธ ตัวอย่างเกม', nickname: 'เมธ', studentId: '6500004', password: READY, sessions: 2 },
    { key: 'nam', name: 'ชลธิชา ทดลองใจ', nickname: 'น้ำ', studentId: '6500005', athlete: { game: 'RoV', status: 'inactive', note: 'พักช่วงสอบ' } },
    { key: 'phum', name: 'ภูมิ ทดสอบระบบ', nickname: 'ภูมิ', studentId: '6512345', password: TEMP, mustChange: true },
    { key: 'fah', name: 'อริสา ลองดู', nickname: 'ฟ้า' },
    { key: 'long', name: LONG_PERSON, nickname: 'แพรว', studentId: '6500099', athlete: { game: 'League of Legends: Wild Rift', team: 'MU Esport Championship Division Two', position: 'Support / In-game leader', ign: 'praew_the_longest_ign_in_the_roster' } },
    { key: 'viewer', name: 'พิมพ์ชนก ตัวอย่างชมรม', nickname: 'พิม', studentId: '6500010', password: READY, sessions: 1 },
  ],
)

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], {
  shell: true,
  env: { ...process.env, MU_STATE_DIR: STATE_DIR },
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverLog = ''
server.stdout.on('data', (chunk) => (serverLog += chunk))
server.stderr.on('data', (chunk) => (serverLog += chunk))
const stopServer = () => {
  if (server.pid === undefined) return
  if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(server.pid), '/T', '/F'])
  else server.kill('SIGTERM')
}

async function waitForServer() {
  for (let i = 0; i < 90; i++) {
    try {
      const res = await fetch(`${BASE}/api/session`)
      if (res.ok) return res.json()
    } catch {
      // ยังไม่พร้อม
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`dev server ไม่พร้อมภายในเวลา\n${serverLog}`)
}

// ---------- รูปทดสอบ: ภาพลวดลายที่สร้างในหน่วยความจำ ----------
function makePng(width, height, paint) {
  const crc = (bytes) => {
    let value = 0xffffffff
    for (const byte of bytes) {
      value ^= byte
      for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (value & 1 ? 0xedb88320 : 0)
    }
    return (value ^ 0xffffffff) >>> 0
  }
  const chunk = (type, data) => {
    const name = Buffer.from(type)
    const length = Buffer.alloc(4)
    const checksum = Buffer.alloc(4)
    length.writeUInt32BE(data.length)
    checksum.writeUInt32BE(crc(Buffer.concat([name, data])))
    return Buffer.concat([length, name, data, checksum])
  }
  const pixels = Buffer.alloc((width * 3 + 1) * height)
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) pixels.set(paint(x, y), y * (width * 3 + 1) + 1 + x * 3)
  const header = Buffer.alloc(13)
  header.writeUInt32BE(width, 0)
  header.writeUInt32BE(height, 4)
  header[8] = 8
  header[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', deflateSync(pixels)), chunk('IEND', Buffer.alloc(0))])
}
// 1200×800 (แนวนอน ใหญ่กว่า 512): กลางภาพเป็นวงกลมน้ำเงิน ขอบซ้ายขวาเป็นแถบแดง (ถูกตัดออกเมื่อครอบเป็นสี่เหลี่ยมจัตุรัสตรงกลาง)
const WIDE = makePng(1200, 800, (x, y) => (x < 150 || x >= 1050 ? [200, 30, 30] : (x - 600) ** 2 + (y - 400) ** 2 < 260 ** 2 ? [29, 78, 216] : [226, 232, 240]))
// 600×900 (แนวตั้ง): ลวดลายเขียว ใช้เป็นรูปที่สอง
const TALL = makePng(600, 900, (x, y) => ((x >> 5) + (y >> 5)) % 2 ? [22, 101, 52] : [220, 252, 231])
// 40×40: เล็กกว่าขนาดสูงสุด ต้องไม่ถูกขยาย
const TINY = makePng(40, 40, (x, y) => (x < 20 === y < 20 ? [124, 58, 237] : [237, 233, 254]))

const consoleErrors = []
const EXPECTED_NOISE = /Failed to load resource|due to access control checks/
const noteError = (text) => {
  if (!EXPECTED_NOISE.test(text)) consoleErrors.push(text)
}
let browser
let exitCode = 1

try {
  await waitForServer()
  console.log(`dev server พร้อมที่ ${BASE}`)
  browser = await chromium.launch({ channel: CHANNEL })

  async function newPage(width, height, actor, tokenIndex = 0, options = {}) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
    if (actor) await context.addCookies([{ name: 'mu_session', value: actor.tokens[tokenIndex], url: BASE, httpOnly: true, sameSite: 'Lax' }])
    if (options.theme) await context.addInitScript(([key, theme]) => localStorage.setItem(key, theme), [THEME_KEY, options.theme])
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    page.on('console', (m) => m.type() === 'error' && noteError(m.text()))
    page.on('pageerror', (e) => noteError(String(e)))
    return page
  }
  const memberPage = async (width, height, studentId, password) => {
    const page = await newPage(width, height, null)
    const res = await loginWithPassword(page.request, BASE, studentId, password)
    if (res.status() !== 200) throw new Error(`เข้าสู่ระบบสมาชิก ${studentId} ไม่สำเร็จ: ${res.status()} ${await res.text()}`)
    return page
  }

  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  const appears = (locator, timeout = 5000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
  const gone = (locator, timeout = 5000) => locator.waitFor({ state: 'detached', timeout }).then(() => true, () => false)
  const shot = async (page, name, fullPage = false) => {
    if (fullPage) await page.evaluate(() => window.scrollTo(0, 0))
    return page.screenshot({ path: `${OUT}/${name}.png`, fullPage })
  }
  const apiAs = async (page, path, options = {}) => {
    if (/\/account\/password$/.test(path) && options.body?.password) {
      options = { ...options, body: { ...options.body, passwordProof: makePasswordMaterial(options.body.password) } }
    }
    return page.evaluate(
      async ({ path, options }) => {
        const session = await (await fetch('/api/session')).json()
        const res = await fetch(path, {
          method: options.method ?? 'GET',
          headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': session.csrfToken ?? '', ...(options.key ? { 'Idempotency-Key': options.key } : {}) },
          body: options.body ? JSON.stringify(options.body) : undefined,
        })
        const text = await res.text()
        let body = null
        try {
          body = JSON.parse(text)
        } catch {
          // ไม่ใช่ JSON
        }
        return { status: res.status, body, text }
      },
      { path, options },
    )
  }
  /** ส่วนที่กดได้ที่มองเห็นและเตี้ยกว่า 44px ภายใน scope */
  const smallTargets = (page, scope = 'body') =>
    page.evaluate((scope) => {
      const out = []
      const root = document.querySelector(scope) ?? document.body
      for (const el of root.querySelectorAll('button, select, input:not([type=hidden]), textarea, a.button, .file-category, .file-card')) {
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || el.closest('[hidden]') || el.closest('.visually-hidden')) continue
        if (r.height < 43.5) out.push(`${el.tagName.toLowerCase()}:${(el.textContent || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 24)}=${Math.round(r.height * 10) / 10}`)
      }
      return out
    }, scope)
  /** contrast ของตัวอักษรเทียบกับพื้นหลังที่มองเห็นจริง */
  const contrast = (page, selector) =>
    page.evaluate((selector) => {
      const el = document.querySelector(selector)
      if (!el) return null
      const parse = (value) => {
        const n = (value.match(/[\d.]+/g) ?? []).map(Number)
        return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n.length > 3 ? n[3] : 1 }
      }
      const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
      const layers = []
      for (let node = el; node; node = node.parentElement) {
        const c = parse(getComputedStyle(node).backgroundColor)
        if (c.a > 0) layers.push(c)
        if (c.a === 1) break
      }
      const bg = layers.reverse().reduce((bottom, top) => over(top, bottom), { r: 255, g: 255, b: 255, a: 1 })
      const lum = ({ r, g, b }) => {
        const f = (v) => {
          const s = v / 255
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
        }
        return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
      }
      const fg = over(parse(getComputedStyle(el).color), bg)
      const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
      return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100
    }, selector)
  const focusedText = (page) => page.evaluate(() => (document.activeElement?.textContent ?? '').trim())
  const focusIs = (page, text) => page.waitForFunction(text => document.activeElement?.textContent?.trim() === text, text, { timeout: 2000 }).then(() => true, () => false)
  const dialogFits = (page) =>
    page.evaluate(() => {
      const panel = document.querySelector('dialog[open] .dialog-panel') ?? document.querySelector('dialog[open]')
      const r = panel.getBoundingClientRect()
      return r.left >= -0.5 && r.right <= window.innerWidth + 0.5 && r.top >= -0.5 && r.bottom <= window.innerHeight + 0.5
    })
  const accountOf = async (page, id) => (await apiAs(page, `/api/members/${id}/account`)).body?.account
  const memberOf = async (page, id) => (await apiAs(page, '/api/members')).body?.members.find((m) => m.id === id)

  const openMember = async (page, name) => {
    if (new URL(page.url()).pathname !== '/members') await page.goto(`${BASE}/members`)
    await page.locator('.members-table tbody tr').first().waitFor()
    await page.getByRole('button', { name: `ดูรายละเอียด ${name}` }).click()
    const dialog = page.locator('dialog[open]')
    await dialog.locator('.account-section').waitFor()
    return dialog
  }

  // ================= A. ลบบัญชีเข้าสู่ระบบของสมาชิก =================
  {
    const p = await newPage(1440, 900, actors.admin)
    let dialog = await openMember(p, 'กฤตเมธ ตัวอย่างเกม')
    const deleteButton = () => p.locator('dialog[open]').getByRole('button', { name: 'ลบบัญชีเข้าสู่ระบบ', exact: true })
    check('[จริง] ผู้ดูแล: รายละเอียดสมาชิกที่มีบัญชีมีปุ่ม “ลบบัญชีเข้าสู่ระบบ” อยู่คนละส่วนกับปุ่ม “ปิดบัญชี” พร้อมคำอธิบายความต่าง',
      (await deleteButton().isVisible()) && (await dialog.locator('.account-delete button').count()) === 1 &&
      (await dialog.locator('.account-section > .button-row').getByRole('button', { name: 'ปิดบัญชี', exact: true }).count()) === 1 &&
      (await dialog.locator('.account-section > .button-row').getByRole('button', { name: /ลบบัญชี/ }).count()) === 0 &&
      (await dialog.locator('.account-delete').innerText()).includes('ถ้าต้องการหยุดใช้ชั่วคราว ใช้ “ปิดบัญชี”'))
    await shot(p, 'admin-account-section-1440')

    // กล่องยืนยัน: บอกว่าจะลบของใคร ผลที่เกิด และยกเลิกได้
    await deleteButton().click()
    let confirm = p.locator('dialog[open]')
    await confirm.getByRole('heading', { name: 'ลบบัญชีเข้าสู่ระบบของ “กฤตเมธ ตัวอย่างเกม”?' }).waitFor()
    const body = await confirm.innerText()
    check('[จริง] กล่องยืนยันลบบัญชี: แสดงชื่อ ชื่อเล่น รหัสที่ใช้เข้าสู่ระบบ และสถานะบัญชีของคนที่จะลบ บอกว่าเข้าเว็บด้วยบัญชีเดิมไม่ได้ ทะเบียนยังอยู่ เปิดบัญชีใหม่ได้ภายหลัง และมีปุ่มยกเลิกกับยืนยัน',
      body.includes('กฤตเมธ ตัวอย่างเกม (เมธ)') && body.includes('6500004') && body.includes('เปิดใช้งาน') && body.includes('เข้าเว็บด้วยบัญชีเดิมไม่ได้อีก') &&
      body.includes('ข้อมูลในทะเบียนสมาชิก รูป และข้อมูลนักกีฬายังอยู่ครบ') && body.includes('เปิดบัญชีใหม่ให้ภายหลังได้') &&
      (await confirm.getByRole('button', { name: 'ยกเลิก', exact: true }).isVisible()) && (await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).isVisible()) &&
      (await p.locator('dialog[open]').count()) === 1)
    check('[จริง] กล่องยืนยันลบบัญชี: focus เริ่มที่ปุ่ม “ยกเลิก” (ไม่ใช่ปุ่มลบ) และกล่องอยู่ในจอ', (await focusedText(p)) === 'ยกเลิก' && (await dialogFits(p)))
    await shot(p, 'admin-delete-account-1440')
    await p.keyboard.press('Escape')
    await p.locator('dialog[open] .account-section').waitFor()
    check('[จริง] กด Esc ในกล่องยืนยัน: ไม่ลบอะไร กลับมาที่รายละเอียดสมาชิก และ focus กลับไปที่ปุ่ม “ลบบัญชีเข้าสู่ระบบ”',
      await focusIs(p, 'ลบบัญชีเข้าสู่ระบบ') && (await accountOf(p, actors.meth.id))?.state === 'active', await focusedText(p))
    // ปุ่มยกเลิกให้ผลเดียวกัน
    await deleteButton().click()
    await p.locator('dialog[open]').getByRole('button', { name: 'ยกเลิก', exact: true }).click()
    await p.locator('dialog[open] .account-section').waitFor()
    check('[จริง] กด “ยกเลิก”: บัญชียังอยู่ และ focus กลับไปที่ปุ่มเดิม', await focusIs(p, 'ลบบัญชีเข้าสู่ระบบ') && (await accountOf(p, actors.meth.id))?.state === 'active', await focusedText(p))

    // กล่องเก่ากับบัญชีที่เพิ่งถูกรีเซ็ตจากอีกแท็บ: ไม่ลบ แสดงสถานะล่าสุด แล้วต้องยืนยันใหม่
    await deleteButton().click()
    confirm = p.locator('dialog[open]')
    await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).waitFor()
    const other = await newPage(1280, 800, actors.admin, 1)
    await other.goto(`${BASE}/members`)
    const reset = await apiAs(other, `/api/members/${actors.meth.id}/account/password`, { method: 'POST', body: { studentId: '6500004', password: TEMP } })
    await other.context().close()
    await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).click()
    const conflict = confirm.locator('.form-alert')
    await conflict.waitFor()
    const afterConflict = await accountOf(p, actors.meth.id)
    check('[จริง] บัญชีถูกรีเซ็ตรหัสจากอีกแท็บหลังเปิดกล่อง: ไม่ลบ บอกเหตุผลในกล่อง (ไม่ถูกบัง) แสดงสถานะล่าสุด “ต้องเปลี่ยนรหัสผ่าน” และยังต้องกดยืนยันอีกครั้ง',
      reset.status === 200 && (await conflict.innerText()).includes('ยังไม่ได้ลบบัญชี') && (await conflict.innerText()).includes('ด้านล่างเป็นสถานะล่าสุด') &&
      (await confirm.locator('.account-identity .badge').innerText()) === 'ต้องเปลี่ยนรหัสผ่าน' && afterConflict?.state === 'must_change' &&
      (await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).isEnabled()) &&
      (await conflict.evaluate((el) => { const r = el.getBoundingClientRect(); const top = document.elementFromPoint(r.left + 10, r.top + 10); return el === top || el.contains(top) })), await conflict.innerText())
    await shot(p, 'admin-delete-account-conflict-1440')

    // สมาชิกที่เข้าสู่ระบบค้างไว้ (session ใหม่หลังรีเซ็ต) เปิดหน้าอยู่ระหว่างที่ผู้ดูแลลบบัญชี
    const live = await newPage(390, 844, null)
    const liveLogin = await loginWithPassword(live.request, BASE, '6500004', TEMP)
    await live.goto(`${BASE}/member/password`)
    await live.getByRole('heading', { level: 1 }).first().waitFor()

    await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).click()
    dialog = p.locator('dialog[open]')
    await dialog.locator('.account-section .notice-success').waitFor()
    const deleted = await accountOf(p, actors.meth.id)
    const registry = await memberOf(p, actors.meth.id)
    check('[จริง] ยืนยันอีกครั้งด้วยสถานะล่าสุด: ลบบัญชีสำเร็จ กลับมาที่รายละเอียดพร้อมข้อความยืนยัน สถานะเป็น “ยังไม่ได้เปิดบัญชี” ปุ่มลบหายไป และมีปุ่มเปิดบัญชีใหม่',
      (await dialog.locator('.account-section .notice-success').innerText()).includes('ลบบัญชีเข้าสู่ระบบของ “กฤตเมธ ตัวอย่างเกม” แล้ว') &&
      (await dialog.locator('.account-section .badge').first().innerText()) === 'ยังไม่ได้เปิดบัญชี' && (await deleteButton().count()) === 0 &&
      (await dialog.getByRole('button', { name: /^ตั้งรหัสผ่านและเปิดบัญชี/ }).isEnabled()) && deleted?.state === 'none' && deleted?.revision === null)
    check('[จริง] หลังลบบัญชี: ทะเบียนสมาชิกของคนนั้นยังอยู่ครบ (ชื่อ ชื่อเล่น รหัสนักศึกษา สถานะ) และจำนวนสมาชิกเท่าเดิม',
      registry?.name === 'กฤตเมธ ตัวอย่างเกม' && registry?.nickname === 'เมธ' && registry?.studentId === '6500004' && registry?.status === 'active' &&
      (await apiAs(p, '/api/members')).body.members.length === Object.keys(actors).length - 2)
    await shot(p, 'admin-account-deleted-1440')

    // session ของสมาชิกคนนั้นใช้ไม่ได้ทันที และเข้าสู่ระบบด้วยรหัสเดิมไม่ได้
    const liveSession = await apiAs(live, '/api/session')
    const relogin = await loginWithPassword(live.request, BASE, '6500004', TEMP)
    check('[จริง] หลังลบบัญชี: session ที่สมาชิกเข้าสู่ระบบค้างไว้ใช้ไม่ได้ทันที และเข้าสู่ระบบด้วยรหัสเดิมได้คำตอบเหมือนไม่มีบัญชี',
      liveLogin.status() === 200 && liveSession.body?.member === null && relogin.status() === 401 && (await relogin.json()).error === 'invalid_credentials')
    await live.context().close()

    // เปิดบัญชีใหม่ตามขั้นตอนเดิม: session เก่าจากก่อนลบ (ที่เตรียมไว้ในฐานทดสอบ) ยังใช้ไม่ได้
    await dialog.getByRole('button', { name: /^ตั้งรหัสผ่านและเปิดบัญชี/ }).click()
    const setDialog = p.locator('dialog[open]')
    await setDialog.locator('#account-password').fill('New-Temp-Pass-2026')
    await setDialog.locator('#account-password-confirm').fill('New-Temp-Pass-2026')
    await setDialog.getByRole('button', { name: 'เปิดบัญชี', exact: true }).click()
    await setDialog.getByRole('button', { name: 'เสร็จสิ้น' }).click()
    await p.locator('dialog[open] .account-section .notice-success').waitFor()
    const old = await newPage(1280, 800, actors.meth, 0)
    await old.goto(`${BASE}/member`)
    await old.waitForURL(`${BASE}/login?return=%2Fmember`)
    const fresh = await loginWithPassword(old.request, BASE, '6500004', 'New-Temp-Pass-2026')
    check('[จริง] เปิดบัญชีใหม่หลังลบ: ทำได้ตามขั้นตอนเดิม session เก่าก่อนลบไม่กลับมาใช้ได้ และเข้าสู่ระบบด้วยรหัสชั่วคราวใหม่ได้ (ต้องเปลี่ยนรหัสผ่าน)',
      (await accountOf(p, actors.meth.id))?.state === 'must_change' && old.url() === `${BASE}/login?return=%2Fmember` && fresh.status() === 200 && (await fresh.json()).mustChangePassword === true)
    await old.context().close()
    await p.keyboard.press('Escape')

    // ---------- คำสั่งลบไม่ได้คำตอบ ----------
    dialog = await openMember(p, 'ณิชา ตัวอย่างสุข')
    await deleteButton().click()
    confirm = p.locator('dialog[open]')
    const deleteUrl = `${BASE}/api/members/${actors.mind.id}/account/delete`
    const statusUrl = `${BASE}/api/members/${actors.mind.id}/account`
    // (1) คำสั่งลบไปไม่ถึง server และตรวจสถานะก็ไม่ได้: ไม่สรุปผล และให้เฉพาะปุ่มตรวจสถานะ
    await p.route(deleteUrl, (route) => route.abort())
    await p.route(statusUrl, (route) => route.abort())
    await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).click()
    await confirm.getByRole('button', { name: 'ตรวจสถานะอีกครั้ง' }).waitFor()
    const unknownText = await confirm.locator('.form-alert').innerText()
    check('[จริง+ตัดคำขอ] คำสั่งลบไม่ได้คำตอบและตรวจสถานะไม่ได้: ไม่บอกว่าสำเร็จหรือไม่สำเร็จ ไม่มีปุ่มลบให้กดซ้ำ มีเฉพาะ “ตรวจสถานะอีกครั้ง” ที่ไม่เปลี่ยนข้อมูล',
      unknownText.includes('ยังยืนยันไม่ได้ว่าบัญชีถูกลบหรือไม่') && (await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).count()) === 0 &&
      (await p.locator('.toast').count()) === 0, unknownText)
    await shot(p, 'admin-delete-account-unknown-1440')
    await p.unroute(statusUrl)
    await confirm.getByRole('button', { name: 'ตรวจสถานะอีกครั้ง' }).click()
    await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).waitFor()
    check('[จริง+ตัดคำขอ] ตรวจสถานะได้แล้ว: บอกตามจริงว่าบัญชียังอยู่ ยังไม่ได้ลบ และกดยืนยันลบได้อีกครั้ง',
      (await confirm.locator('.form-alert').innerText()).includes('บัญชียังอยู่ ยังไม่ได้ลบ') && (await accountOf(p, actors.mind.id))?.state === 'active')
    await p.unroute(deleteUrl)
    // (2) server ลบแล้วแต่คำตอบหาย: หน้าเว็บอ่านสถานะจริงก่อนสรุป แล้วจึงบอกว่าลบแล้ว
    await p.route(deleteUrl, async (route) => {
      await route.fetch()
      await route.abort()
    })
    await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).click()
    await p.locator('dialog[open] .account-section .notice-success').waitFor()
    await p.unroute(deleteUrl)
    check('[จริง+ตัดคำขอ] server ลบแล้วแต่คำตอบหาย: หน้าเว็บอ่านสถานะจริงก่อน แล้วจึงบอกว่าลบแล้ว (ยืนยันจากสถานะล่าสุด)',
      (await p.locator('dialog[open] .account-section .notice-success').innerText()).includes('ยืนยันจากสถานะล่าสุดของระบบ') && (await accountOf(p, actors.mind.id))?.state === 'none')
    // โปรไฟล์นักกีฬาของคนที่ถูกลบบัญชียังอยู่
    check('[จริง] ลบบัญชีเข้าสู่ระบบไม่ลบโปรไฟล์นักกีฬาของคนนั้น', (await memberOf(p, actors.mind.id))?.athlete?.game === 'Valorant')
    await p.keyboard.press('Escape')

    // สมาชิกที่ไม่มีบัญชี: ไม่มีปุ่มลบ
    dialog = await openMember(p, 'ชลธิชา ทดลองใจ')
    check('[จริง] สมาชิกที่ยังไม่ได้เปิดบัญชี: ไม่มีปุ่ม “ลบบัญชีเข้าสู่ระบบ”', (await deleteButton().count()) === 0 && (await dialog.locator('.account-delete').count()) === 0)
    await p.context().close()
  }
  {
    // ทีมงานทั่วไป: เห็นสถานะบัญชี แต่ไม่มีปุ่มลบ และ server ปฏิเสธคำสั่งลบ
    const p = await newPage(1440, 900, actors.staff)
    const dialog = await openMember(p, 'ภูมิ ทดสอบระบบ')
    const account = await accountOf(p, actors.phum.id)
    const tried = await apiAs(p, `/api/members/${actors.phum.id}/account/delete`, { method: 'POST', body: { expectedRevision: account.revision } })
    check('[จริง] ทีมงานทั่วไป (ไม่ใช่ผู้ดูแล): ไม่มีปุ่มลบบัญชี มีคำอธิบายว่าทำได้เฉพาะผู้ดูแล และเรียก API ลบตรง ๆ ได้ 403 โดยบัญชียังอยู่',
      (await dialog.getByRole('button', { name: /ลบบัญชี/ }).count()) === 0 && (await dialog.getByText('ลบบัญชีเข้าสู่ระบบ ทำได้เฉพาะผู้ดูแลระบบ').isVisible()) &&
      tried.status === 403 && tried.body?.error === 'forbidden' && (await accountOf(p, actors.phum.id))?.state === 'must_change')
    await p.context().close()
    // สมาชิกเรียก API ลบของตัวเอง: ไม่ได้
    const m = await newPage(390, 844, actors.mind, 0)
    await m.goto(`${BASE}/login`)
    const anonymous = await apiAs(m, `/api/members/${actors.phum.id}/account/delete`, { method: 'POST', body: { expectedRevision: 'x' } })
    check('[จริง] ผู้ที่ไม่มี session ที่ใช้ได้ (session ของบัญชีที่ถูกลบแล้ว) เรียก API ลบบัญชี: ได้ 401', anonymous.status === 401)
    await m.context().close()
  }
  // กล่องยืนยันลบบัญชีที่จอแคบและธีมมืด
  for (const [w, h, theme] of [[390, 844, 'light'], [360, 740, 'light'], [1440, 900, 'dark']]) {
    const p = await newPage(w, h, actors.admin, 0, { theme })
    const dialog = await openMember(p, 'ภูมิ ทดสอบระบบ')
    const sectionSmall = w < 1024 ? await smallTargets(p, 'dialog[open]') : []
    await dialog.getByRole('button', { name: 'ลบบัญชีเข้าสู่ระบบ', exact: true }).click()
    const confirm = p.locator('dialog[open]')
    await confirm.getByRole('button', { name: 'ยืนยันลบบัญชี', exact: true }).waitFor()
    const small = w < 1024 ? await smallTargets(p, 'dialog[open]') : []
    const dark = theme === 'dark' ? { danger: await contrast(p, 'dialog[open] .button-danger'), text: await contrast(p, 'dialog[open] .bulleted li'), label: await contrast(p, 'dialog[open] .account-identity dt') } : null
    check(`[จริง] กล่องยืนยันลบบัญชี ${w}px${theme === 'dark' ? ' ธีมมืด' : ''}: อยู่ในจอ ไม่ล้น${w < 1024 ? ' ปุ่มทั้งหมดสูง ≥44px' : ''}${dark ? ' และ contrast ของข้อความและปุ่มลบ ≥4.5:1' : ''}`,
      (await dialogFits(p)) && (await noOverflow(p)) && small.length === 0 && sectionSmall.length === 0 && (!dark || Object.values(dark).every((v) => v >= 4.5)), JSON.stringify({ small, sectionSmall, dark }))
    await shot(p, `admin-delete-account-${w}${theme === 'dark' ? '-dark' : ''}`)
    await p.context().close()
  }

  // ================= B. หมวด Google Docs / Sheets / Forms ของไฟล์ชมรม (คลังจำลอง) =================
  const CATEGORY_LABELS = ['ทั้งหมด', 'Google Docs', 'Google Sheets', 'Google Forms']
  const cards = (page) => page.locator('.file-card')
  const cardNames = (page) => page.locator('.file-card .file-name').allInnerTexts()
  const activeCategory = (page) => page.locator('.file-categories [aria-current="true"]').allInnerTexts()
  const waitCards = (page, count) => page.waitForFunction((count) => document.querySelectorAll('.file-card').length === count && !document.querySelector('.file-loading'), count)
  for (const [w, h, who] of [[1440, 900, 'member'], [390, 844, 'member'], [360, 740, 'member'], [1440, 900, 'staff'], [390, 844, 'staff']]) {
    const tag = `[จำลองคลัง] หมวดไฟล์ (${who === 'member' ? 'สมาชิก' : 'ทีมงาน'}) ${w}px`
    const base = who === 'member' ? '/member/files' : '/files'
    const p = await newPage(w, h, who === 'member' ? actors.viewer : actors.admin)
    await mockLibrary(p, { audience: who, deep: true })
    await p.goto(BASE + base)
    await waitCards(p, 30)
    check(`${tag}: มีหมวดครบและหน้าแรกยังไม่มีเอกสารเก่า`,
      JSON.stringify(await p.locator('.file-category').allInnerTexts()) === JSON.stringify(CATEGORY_LABELS) && !(await cardNames(p)).some(name => name.includes('ปี 2568')))
    for (const [type, label, oldName] of [['doc', 'Google Docs', 'บันทึกการประชุมปี 2568'], ['sheet', 'Google Sheets', 'ทะเบียนอุปกรณ์ปี 2568'], ['form', 'Google Forms', 'แบบประเมินกิจกรรมปี 2568']]) {
      const ready = p.waitForResponse(res => new URL(res.url()).pathname === '/api/library/files' && new URL(res.url()).searchParams.get('type') === type)
      await p.locator('.file-categories').getByRole('link', { name: label, exact: true }).click()
      await ready
      await p.waitForFunction(name => [...document.querySelectorAll('.file-name')].some(el => el.textContent.includes(name)), oldName)
      check(`${tag}: ${label} ขอชนิดจาก API และแสดงไฟล์เก่านอกหน้าแรก`, new URL(p.url()).searchParams.get('type') === type && (await activeCategory(p))[0] === label)
      if (type === 'doc') {
        await p.getByRole('button', { name: 'โหลดไฟล์เพิ่ม', exact: true }).click()
        await p.waitForFunction(() => document.querySelectorAll('.file-card').length > 30)
        check(`${tag}: โหลดเพิ่มภายในหมวด Docs รวมทางลัด`, (await cardNames(p)).includes('ทางลัดไปแผนงานชมรม'))
      }
    }
    await p.reload()
    await p.waitForFunction(() => document.querySelector('.file-categories [aria-current="true"]')?.textContent.includes('Google Forms'))
    await cards(p).first().waitFor()
    check(`${tag}: refresh คงหมวด ไม่ล้น และปุ่มมือถือสูง ≥44px`, await noOverflow(p) && (w >= 1024 || (await smallTargets(p, '.file-library')).length === 0))
    await shot(p, `roster-file-categories-${who}-${w}`)
    await p.context().close()
  }

  // ================= C. นักกีฬาและรูป: Worker/D1 local จริง =================
  const VIEWER_NAME = 'พิมพ์ชนก ตัวอย่างชมรม'
  const p = await newPage(1440, 900, actors.staff)
  await p.goto(BASE + '/athletes')
  await p.locator('.roster-card').first().waitFor()
  const countBefore = (await apiAs(p, '/api/members')).body.members.length
  check('[จริง] นักกีฬาเป็นเมนูแยกจากสมาชิก มี 3 โปรไฟล์เดิม', await p.locator('.roster-card').count() === 3 && await p.getByRole('link', { name: 'นักกีฬา', exact: true }).count() === 1)
  await p.getByRole('button', { name: 'เพิ่มนักกีฬา', exact: true }).click()
  let d = p.locator('dialog[open]').last()
  await d.locator('#athlete-member').selectOption(actors.viewer.id)
  await d.locator('#athlete-game').fill('Valorant')
  await d.locator('#athlete-team').fill('MU Beta')
  await d.locator('#athlete-ign').fill('sample#TH1')
  await d.getByRole('button', { name: 'เพิ่มนักกีฬา', exact: true }).click()
  await p.getByRole('button', { name: `ดูรายละเอียดนักกีฬา ${VIEWER_NAME}`, exact: true }).waitFor()
  check('[จริง] เพิ่มนักกีฬาจากสมาชิกเดิม: จำนวนบุคคลและบัญชีไม่เพิ่ม', (await apiAs(p, '/api/members')).body.members.length === countBefore && (await accountOf(p, actors.viewer.id)).state === 'active')

  await p.getByRole('button', { name: `ดูรายละเอียดนักกีฬา ${VIEWER_NAME}`, exact: true }).click()
  await p.locator('dialog[open] .detail-list').waitFor()
  await p.locator('dialog[open]').getByRole('button', { name: 'แก้ไข', exact: true }).click()
  await p.locator('#athlete-team').fill('MU Gamma')
  await p.locator('dialog[open]').getByRole('button', { name: 'บันทึกการแก้ไข', exact: true }).click()
  await p.waitForFunction(() => [...document.querySelectorAll('.roster-game')].some(el => el.textContent.includes('MU Gamma')))
  check('[จริง] แก้ข้อมูลนักกีฬาได้โดยไม่เปลี่ยนสิทธิ์', (await memberOf(p, actors.viewer.id)).role === 'member')

  await p.getByRole('button', { name: `ดูรายละเอียดนักกีฬา ${VIEWER_NAME}`, exact: true }).click()
  await p.locator('dialog[open]').getByRole('button', { name: 'เพิ่มรูป', exact: true }).click()
  await p.locator('#photo-file').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: WIDE })
  await p.getByText('ตัวอย่างรูปใหม่ ยังไม่ได้บันทึก', { exact: true }).waitFor()
  check('[จริง] รูปต้นฉบับใหญ่ย่อเป็น 512 และยังไม่ถูกบันทึก', await p.locator('.photo-preview img').evaluate(img => img.naturalWidth === 512) && !(await memberOf(p, actors.viewer.id)).photoVersion)
  await p.locator('dialog[open]').getByRole('button', { name: 'ยกเลิก', exact: true }).click()
  await p.getByRole('button', { name: 'ทิ้งรูปที่เลือก', exact: true }).click()
  await p.locator('dialog[open] .detail-list').waitFor()
  check('[จริง] ยกเลิกรูปไม่บันทึก และ focus คืนปุ่มเพิ่มรูป', !(await memberOf(p, actors.viewer.id)).photoVersion && await focusIs(p, 'เพิ่มรูป'))

  await p.getByRole('button', { name: 'เพิ่มรูป', exact: true }).click()
  await p.locator('#photo-file').setInputFiles({ name: 'wide.png', mimeType: 'image/png', buffer: WIDE })
  await p.getByText('ตัวอย่างรูปใหม่ ยังไม่ได้บันทึก', { exact: true }).waitFor()
  await p.route('**/api/members/*/photo', async route => route.request().method() === 'PUT' ? route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'test_failure', message: 'จำลองบันทึกไม่สำเร็จ' }) }) : route.continue())
  await p.getByRole('button', { name: 'บันทึกรูป', exact: true }).click()
  await p.locator('.photo-editor [role="alert"]').waitFor()
  check('[จริง+ตัดคำขอ] บันทึกล้มเหลว: รูปที่เลือกยังอยู่และรูป server ไม่เปลี่ยน', await p.locator('.photo-preview img').count() === 1 && !(await memberOf(p, actors.viewer.id)).photoVersion)
  await shot(p, 'roster-photo-save-failed-1440')
  await p.unroute('**/api/members/*/photo')
  await p.getByRole('button', { name: 'บันทึกรูป', exact: true }).click()
  await p.locator('dialog[open] .detail-list').waitFor()
  await p.waitForFunction(() => { const img = document.querySelector('dialog[open] .avatar img'); return img?.complete && img.naturalWidth === 512 })
  const stored = (await memberOf(p, actors.viewer.id)).photoVersion
  const own = await newPage(390, 844, actors.viewer)
  await own.goto(BASE + '/member/account')
  await own.locator('.avatar img').first().waitFor()
  const access = await apiAs(own, `/api/members/${actors.viewer.id}/photo`)
  const forbidden = await apiAs(own, `/api/members/${actors.mind.id}/photo`)
  check('[จริง] รูปใช้ร่วมกันในนักกีฬาและบัญชีตนเอง สมาชิกอ่านคนอื่นไม่ได้', access.status === 200 && forbidden.status === 404 && stored !== null)
  await shot(own, 'roster-own-photo-390')
  await own.context().close()
  await p.keyboard.press('Escape')

  for (const [w, h, theme] of [[1440, 900, 'light'], [390, 844, 'light'], [360, 740, 'light'], [1023, 800, 'light'], [1024, 800, 'light'], [1440, 900, 'dark']]) {
    const page = await newPage(w, h, actors.staff, 0, { theme })
    await page.goto(BASE + '/athletes')
    await page.locator('.roster-card').first().waitFor()
    check(`[จริง] นักกีฬา ${w}px ${theme}: ชื่อยาวไม่ล้นและปุ่มมือถือสูง ≥44px`, await noOverflow(page) && (w >= 1024 || (await smallTargets(page, '.roster-card')).length === 0))
    await shot(page, `roster-athletes-${w}-${theme}`)
    await page.context().close()
  }

  await p.goto(BASE + `/members?member=${encodeURIComponent(actors.viewer.id)}`)
  await p.locator('dialog[open] .person-head img').waitFor()
  check('[จริง] หน้าสมาชิกใช้รูปเดียวกับนักกีฬา', await p.locator('dialog[open] .person-head img').getAttribute('src') === `/api/members/${actors.viewer.id}/photo?v=${stored}`)
  await p.goto(BASE + '/athletes')
  await p.getByRole('button', { name: `ดูรายละเอียดนักกีฬา ${VIEWER_NAME}`, exact: true }).click()
  await p.getByRole('button', { name: 'เปลี่ยนหรือลบรูป', exact: true }).click()
  await p.locator('#photo-file').setInputFiles({ name: 'tiny.png', mimeType: 'image/png', buffer: TINY })
  await p.getByText('ตัวอย่างรูปใหม่ ยังไม่ได้บันทึก', { exact: true }).waitFor()
  await p.getByRole('button', { name: 'บันทึกรูป', exact: true }).click()
  await p.locator('dialog[open] .detail-list').waitFor()
  await p.waitForFunction(() => { const img = document.querySelector('dialog[open] .avatar img'); return img?.complete && img.naturalWidth === 40 })
  check('[จริง] เปลี่ยนรูปแล้วรุ่นใหม่ ไม่ขยายรูปเล็ก', (await memberOf(p, actors.viewer.id)).photoVersion !== stored)
  await p.getByRole('button', { name: 'เปลี่ยนหรือลบรูป', exact: true }).click()
  await p.getByRole('button', { name: 'ลบรูป', exact: true }).click()
  await p.locator('dialog[open]').last().getByRole('button', { name: 'ลบรูป', exact: true }).click()
  await p.locator('dialog[open] .detail-list').waitFor()
  check('[จริง] ลบรูปแล้วใช้ placeholder ข้อมูลบุคคลยังอยู่', (await memberOf(p, actors.viewer.id)).photoVersion === null && await p.locator('dialog[open] .avatar-initial').count() === 1)
  await p.getByRole('button', { name: 'ถอดจากนักกีฬา', exact: true }).click()
  await p.locator('dialog[open]').last().getByRole('button', { name: 'ถอดจากนักกีฬา', exact: true }).click()
  await p.getByRole('button', { name: `ดูรายละเอียดนักกีฬา ${VIEWER_NAME}`, exact: true }).waitFor({ state: 'detached' })
  check('[จริง] ถอดจากนักกีฬาไม่ลบทะเบียนหรือบัญชี', (await memberOf(p, actors.viewer.id)).id === actors.viewer.id && (await accountOf(p, actors.viewer.id)).state === 'active')
  await p.context().close()
  check('ไม่มี runtime error ที่ไม่คาดไว้', consoleErrors.length === 0, consoleErrors.join(' | '))
  console.log(`\nผลตรวจครบ: ผ่าน ${passed} ข้อ ไม่ผ่าน ${failed} ข้อ`)
  exitCode = failed ? 1 : 0
} catch (error) {
  console.error('ชุดตรวจหยุดก่อนจบ:', error)
  console.log(`\nผลตรวจ (ไม่ครบ): ผ่าน ${passed} ข้อ ไม่ผ่าน ${failed} ข้อ ก่อนหยุด`)
  exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  stopServer()
}
process.exit(exitCode)
