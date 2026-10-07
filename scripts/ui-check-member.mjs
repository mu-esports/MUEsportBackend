// ตรวจ UI ของหน้าเข้าสู่ระบบ หน้าสมาชิก และการจัดการบัญชีสมาชิก ในเบราว์เซอร์จริง: หน้าเว็บ + Worker + D1 local ผ่าน `vite dev`
// ใช้: `npm run check:ui:member` (สคริปต์เตรียมฐานข้อมูลทดสอบ เปิดและปิด dev server เอง ที่พอร์ต 5183)
// ตัวแปร: UI_LIVE_PORT (ค่าเริ่มต้น 5183), UI_STATE_DIR (ค่าเริ่มต้น .wrangler/ui-test-state), BROWSER_CHANNEL (msedge | chrome)
//         ชุดตรวจสองชุดที่ใช้พอร์ตและโฟลเดอร์เดียวกันรันพร้อมกันไม่ได้ ถ้าต้องรันซ้อนให้ตั้งทั้งสองค่าแยกกัน
//
// ขอบเขตของชุดนี้
// - [จริง]        = หน้าเว็บคุยกับ Worker และ D1 local จริง: เข้าสู่ระบบด้วยรหัสนักศึกษา (Argon2id จริง) บังคับเปลี่ยนรหัส ข้อมูลตนเอง กิจกรรม
//                   การตั้ง/รีเซ็ต/ปิดบัญชีโดยผู้ดูแล และสิทธิ์ของ session
// - [จำลองคลัง]   = ตอบ /api/library/* ด้วยข้อมูลสมมติในเบราว์เซอร์ทดสอบ (scripts/ui-library-mock.mjs) เพื่อดูหน้าจอของคลังไฟล์และตัวอย่างไฟล์
//                   ชุดตรวจนี้ไม่ใช้การเชื่อม Google จริง การคุยกับ Google ของ Worker ตรวจใน `npm test` (Google จำลองฝั่ง server)
// - [stub Picker] = สคริปต์ของ Google Picker/Identity ถูกแทนด้วยตัวจำลองในเบราว์เซอร์ทดสอบ เพื่อตรวจลำดับการทำงานของหน้าเว็บ
//                   ไม่ได้ทดสอบหน้าต่าง popup จริงของ Google และไม่ได้ทดสอบใน Brave
// ไม่มีข้อใดในไฟล์นี้เป็นการตรวจกับ Google จริง
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { prepareLocalDatabase } from './local-fixtures.mjs'
import { LONG_NAME, mockLibrary } from './ui-library-mock.mjs'

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
const OWN = 'My-Own-Secret-2026'
const READY = 'Ready-Member-4410'

// ---------- เตรียมฐานข้อมูลทดสอบและ dev server ----------
const actors = prepareLocalDatabase(
  STATE_DIR,
  [
    { key: 'admin', email: 'muesport2567@gmail.com', role: 'admin', name: 'MU Esport', sessions: 2 },
    { key: 'staff', email: 'staff.a@example.com', role: 'staff', name: 'ทีมงาน เอ' },
  ],
  [
    { key: 'first', name: 'ภูมิ ทดสอบระบบ', nickname: 'ภูมิ', studentId: '6512345', password: TEMP, mustChange: true, note: 'หมายเหตุภายในของทีมงาน' },
    // บทบาทในทะเบียนเป็น "ทีมงาน": ต้องไม่ได้สิทธิ์หลังบ้านจากค่านี้
    { key: 'ready', name: 'ณิชา ตัวอย่างสุข', nickname: 'มายด์', studentId: '0065002', role: 'staff', password: READY, sessions: 4, contact: 'Discord: mind_sample', note: 'หมายเหตุภายในของทีมงาน' },
    { key: 'noid', name: 'อริสา ลองดู', nickname: 'ฟ้า' },
    { key: 'plain', name: 'กฤตเมธ ตัวอย่างเกม', nickname: 'เมธ', studentId: '6500004' },
    { key: 'reset', name: 'ชลธิชา ทดลองใจ', nickname: 'น้ำ', studentId: '6500005', password: READY, sessions: 1 },
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

const consoleErrors = []
const EXPECTED_NOISE = /Failed to load resource|due to access control checks/
const noteError = (text) => {
  if (!EXPECTED_NOISE.test(text)) consoleErrors.push(text)
}
let browser
let exitCode = 1

const bangkokToday = () => new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10)

try {
  await waitForServer()
  console.log(`dev server พร้อมที่ ${BASE}`)
  browser = await chromium.launch({ channel: CHANNEL })

  /** คำขอไปโดเมนของ Google และหน้าต่างใหม่ที่หน้าเว็บเปิดเอง (ต้องไม่มีในหน้าของสมาชิก) */
  const googleRequests = []
  const popups = []

  async function newPage(width, height, actor, tokenIndex = 0, options = {}) {
    const context = await browser.newContext({ viewport: { width, height }, locale: 'th-TH', timezoneId: 'Asia/Bangkok', ...(options.touch ? { hasTouch: true, isMobile: true } : {}) })
    if (actor) await context.addCookies([{ name: 'mu_session', value: actor.tokens[tokenIndex], url: BASE, httpOnly: true, sameSite: 'Lax' }])
    if (options.theme) await context.addInitScript(([key, theme]) => localStorage.setItem(key, theme), [THEME_KEY, options.theme])
    const page = await context.newPage()
    page.setDefaultTimeout(8000)
    page.on('console', (m) => m.type() === 'error' && noteError(m.text()))
    page.on('pageerror', (e) => noteError(String(e)))
    page.on('request', (request) => /(^|\.)(google|googleapis|gstatic|googleusercontent)\.com$/.test(new URL(request.url()).hostname) && googleRequests.push(request.url()))
    context.on('page', (opened) => opened !== page && popups.push(opened.url()))
    return page
  }

  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  /** ตำแหน่งของปุ่ม “ค้นหา” เทียบกับช่องค้นหาในแถบเครื่องมือของคลังไฟล์ */
  const searchRowOf = (page) =>
    page.evaluate(() => {
      const input = document.querySelector('#file-search').getBoundingClientRect()
      const button = [...document.querySelectorAll('.file-toolbar button')].find((el) => el.textContent.trim() === 'ค้นหา').getBoundingClientRect()
      return { sameRow: Math.abs((input.top + input.bottom) / 2 - (button.top + button.bottom) / 2) <= 2, after: button.left >= input.right, input: Math.round(input.width), button: Math.round(button.width) }
    })
  const appears = (locator, timeout = 5000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
  const gone = (locator, timeout = 5000) => locator.waitFor({ state: 'detached', timeout }).then(() => true, () => false)
  const shot = async (page, name, fullPage = true) => {
    // Full-page capture after scrolling can place the sticky header in the middle of the image.
    if (fullPage) await page.evaluate(() => window.scrollTo(0, 0))
    return page.screenshot({ path: `${OUT}/${name}.png`, fullPage })
  }
  const apiAs = (page, path, options = {}) =>
    page.evaluate(
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

  /** ความสูงของส่วนที่กดได้ทุกตัวที่มองเห็นในหน้า (พื้นที่กดของการ์ดไฟล์คือทั้งการ์ด) */
  const tapHeights = (page, scope = 'body') =>
    page.evaluate((scope) => {
      const out = []
      const root = document.querySelector(scope) ?? document.body
      for (const el of root.querySelectorAll('button, select, input:not([type=hidden]), textarea, a.button, .m-tab, .m-nav-link, .m-activity, .text-link, .m-brand, .file-card')) {
        const r = el.getBoundingClientRect()
        const style = getComputedStyle(el)
        if (r.width === 0 || r.height === 0 || style.visibility === 'hidden' || el.closest('[hidden]') || el.closest('.visually-hidden')) continue
        out.push({ what: `${el.tagName.toLowerCase()}.${(el.className || '').toString().split(' ')[0]}:${(el.textContent || el.getAttribute('aria-label') || el.id || '').trim().slice(0, 24)}`, h: Math.round(r.height * 10) / 10 })
      }
      return out
    }, scope)
  const smallTargets = async (page, scope) => (await tapHeights(page, scope)).filter((t) => t.h < 43.5)

  /** contrast ของตัวอักษร (หรือของเส้นขอบ/เส้น focus) เทียบกับพื้นหลังที่มองเห็นจริง คำนวณจากสีที่เบราว์เซอร์ใช้จริง */
  const contrast = (page, selector, property = 'color') =>
    page.evaluate(
      ({ selector, property }) => {
        const el = document.querySelector(selector)
        if (!el) return null
        const parse = (value) => {
          const n = (value.match(/[\d.]+/g) ?? []).map(Number)
          return { r: n[0] ?? 0, g: n[1] ?? 0, b: n[2] ?? 0, a: n.length > 3 ? n[3] : 1 }
        }
        const over = (top, bottom) => ({ r: top.r * top.a + bottom.r * (1 - top.a), g: top.g * top.a + bottom.g * (1 - top.a), b: top.b * top.a + bottom.b * (1 - top.a), a: 1 })
        // พื้นหลังที่มองเห็น: ซ้อนสีพื้นของบรรพบุรุษจนถึงชั้นที่ทึบ (เส้นขอบและเส้น focus เทียบกับพื้นของชั้นนอก)
        const background = (start) => {
          const layers = []
          for (let node = start; node; node = node.parentElement) {
            const c = parse(getComputedStyle(node).backgroundColor)
            if (c.a > 0) layers.push(c)
            if (c.a === 1) break
          }
          return layers.reverse().reduce((bottom, top) => over(top, bottom), { r: 255, g: 255, b: 255, a: 1 })
        }
        const lum = ({ r, g, b }) => {
          const f = (v) => {
            const s = v / 255
            return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
          }
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
        }
        const style = getComputedStyle(el)
        const outer = property === 'color' ? el : el.parentElement
        const bg = background(outer)
        const fg = over(parse(style[property]), bg)
        const [a, b] = [lum(fg), lum(bg)].sort((x, y) => y - x)
        return Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100
      },
      { selector, property },
    )

  /** ส่วนท้ายของเนื้อหาไม่ถูกเมนูด้านล่างบัง: เลื่อนลงสุดแล้วตัวกดสุดท้ายของหน้าอยู่เหนือเมนูและกดถึงจริง */
  const lastControlClear = (page) =>
    page.evaluate(async () => {
      window.scrollTo(0, document.documentElement.scrollHeight)
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      const controls = [...document.querySelectorAll('#main button, #main a, #main input, #main select')].filter((el) => el.getBoundingClientRect().height > 0)
      const last = controls[controls.length - 1]
      const bar = document.querySelector('.m-tabbar')
      if (!last || !bar) return { ok: false, reason: 'no control or tabbar' }
      const r = last.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return { ok: r.bottom <= bar.getBoundingClientRect().top + 0.5 && (top === last || last.contains(top)), bottom: r.bottom, barTop: bar.getBoundingClientRect().top }
    })

  /** หน้าใหม่ที่เข้าสู่ระบบเป็นสมาชิกผ่านเส้นทางจริงของ Worker (ไม่ใช้ session ที่สร้างไว้ล่วงหน้า) */
  const memberPage = async (width, height, studentId, password, options = {}) => {
    const page = await newPage(width, height, null, 0, options)
    const res = await page.request.post(`${BASE}/auth/member/login`, { data: { studentId, password }, headers: { Origin: BASE } })
    if (res.status() !== 200) throw new Error(`เข้าสู่ระบบสมาชิก ${studentId} ไม่สำเร็จ: ${res.status()} ${await res.text()}`)
    return page
  }

  const memberLogin = async (page, studentId, password) => {
    await page.goto(`${BASE}/login`)
    await page.locator('#login-student-id').fill(studentId)
    await page.locator('#login-password').fill(password)
    await page.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
  }

  // กำหนดการทดสอบ: ผู้ดูแลเพิ่มผ่าน API จริง (6 รายการที่จะมาถึง 1 รายการที่ผ่านไปแล้ว)
  const today = bangkokToday()
  {
    const p = await newPage(1280, 800, actors.admin)
    await p.goto(`${BASE}/`)
    const events = [
      { title: 'ซ้อมทีม Valorant', day: 1, start: '18:00', end: '20:00', location: 'ห้องชมรม ชั้น 2', description: 'เตรียมแข่งรอบคัดเลือก\nนำอุปกรณ์มาเอง' },
      { title: 'ประชุมสมาชิกประจำเดือน', day: 2, start: '17:30', end: '18:30', location: 'https://example.com/meeting', description: '' },
      { title: 'เปิดรับสมัครสมาชิกใหม่', day: 3, endDay: 9, allDay: true, location: '', description: 'เปิดรับตลอดสัปดาห์' },
      { title: 'กิจกรรมพบปะสมาชิก', day: 5, start: '17:00', end: '20:00', location: 'ลานกิจกรรม', description: '' },
      { title: 'แข่งขันภายในชมรม', day: 12, start: '09:00', end: '17:00', location: 'ห้องชมรม ชั้น 2', description: '' },
      { title: 'สรุปผลการแข่งขัน', day: 40, start: '18:30', end: '19:30', location: '', description: '' },
      { title: 'ประชุมเตรียมงานที่ผ่านมา', day: -3, start: '18:00', end: '19:00', location: 'ห้องชมรม ชั้น 2', description: '' },
    ]
    let created = 0
    for (const [index, e] of events.entries()) {
      const start = `${addDays(today, e.day)}T${e.allDay ? '00:00' : e.start}`
      const end = `${addDays(today, e.endDay ?? e.day)}T${e.allDay ? '23:59' : e.end}`
      const res = await apiAs(p, '/api/events', { method: 'POST', key: `member-suite-event-${String(index).padStart(4, '0')}`, body: { title: e.title, allDay: e.allDay === true, start, end, location: e.location, description: e.description } })
      if (res.status === 201) created++
    }
    check('[จริง] เตรียมข้อมูล: ผู้ดูแลเพิ่มกำหนดการทดสอบผ่าน API ครบ', created === events.length, `${created}/${events.length}`)
    await p.context().close()
  }

  // ================= 1. หน้าเข้าสู่ระบบ =================
  {
    const p = await newPage(1440, 900, null, 0, { theme: 'dark' })
    await p.goto(`${BASE}/login`)
    await p.getByRole('heading', { name: 'เข้าสู่ระบบ', level: 1 }).waitFor()
    const headings = await p.locator('main h2').allInnerTexts()
    check('[จริง] หน้าเข้าสู่ระบบ: ส่วน “สำหรับสมาชิก” มาก่อนและเป็นฟอร์มหลัก ส่วน “สำหรับทีมงาน” เป็นส่วนรอง', headings[0] === 'สำหรับสมาชิก' && headings[1] === 'สำหรับทีมงาน', headings.join(' | '))
    check('[จริง] หน้าเข้าสู่ระบบ: มีช่องรหัสนักศึกษา รหัสผ่าน ปุ่มเข้าสู่ระบบ และข้อความลืมรหัสผ่านให้ติดต่อทีมงาน',
      (await p.locator('#login-student-id').isVisible()) && (await p.locator('#login-password').getAttribute('type')) === 'password' &&
      (await p.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).isVisible()) && (await p.getByText('ลืมรหัสผ่าน? ติดต่อทีมงาน').isVisible()))
    check('[จริง] หน้าเข้าสู่ระบบ: ไม่มีทางสมัครบัญชีเอง ไม่มีเมนูหรือข้อมูลหลังบ้าน และไม่มีแผงกราฟิกของหน้าเดิม',
      (await p.getByText(/สมัครสมาชิก|สร้างบัญชี|ลงทะเบียน/).count()) === 0 && (await p.locator('.sidebar, .nav-link, table, .auth-hero, .auth-shape, .theme-switch').count()) === 0)
    const surface = await p.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, scheme: getComputedStyle(document.documentElement).colorScheme }))
    check('[จริง] หน้าเข้าสู่ระบบสว่างเสมอ แม้เบราว์เซอร์นี้เคยเลือกธีมมืดของหลังบ้านไว้', surface.theme === 'light' && surface.bg === 'rgb(248, 250, 252)' && surface.scheme === 'light', JSON.stringify(surface))
    check('[จริง] หน้าเข้าสู่ระบบ: ธีมที่ทีมงานบันทึกไว้ไม่ถูกเขียนทับ', (await p.evaluate((key) => localStorage.getItem(key), THEME_KEY)) === 'dark')

    // contrast จากสีที่ใช้จริง
    const ratios = {
      body: await contrast(p, '.login-title'),
      muted: await contrast(p, '.login-welcome'),
      primary: await contrast(p, '.login-card .button-primary'),
      inputBorder: await contrast(p, '#login-student-id', 'borderTopColor'),
      note: await contrast(p, '.login-staff-note'),
    }
    await p.locator('.login-card .button-primary').hover()
    ratios.primaryHover = await contrast(p, '.login-card .button-primary')
    await p.locator('#login-student-id').focus()
    ratios.focusRing = await contrast(p, '#login-student-id', 'outlineColor')
    check('[จริง] contrast หน้าเข้าสู่ระบบ: ข้อความ ≥4.5:1 ปุ่มหลักทั้งปกติและ hover ≥4.5:1 ขอบช่องกรอกและเส้น focus ≥3:1',
      ratios.body >= 4.5 && ratios.muted >= 4.5 && ratios.note >= 4.5 && ratios.primary >= 4.5 && ratios.primaryHover >= 4.5 && ratios.inputBorder >= 3 && ratios.focusRing >= 3, JSON.stringify(ratios))

    // คีย์บอร์ด: ลำดับ Tab และเส้น focus
    await p.locator('#login-student-id').focus()
    const order = []
    for (let i = 0; i < 4; i++) {
      order.push(await p.evaluate(() => {
        const el = document.activeElement
        const style = getComputedStyle(el)
        return { id: el.id || el.getAttribute('aria-label') || el.textContent.trim(), outline: style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) >= 2 }
      }))
      await p.keyboard.press('Tab')
    }
    check('[จริง] คีย์บอร์ด: Tab ไล่จากรหัสนักศึกษา → รหัสผ่าน → ปุ่มแสดงรหัส → ปุ่มเข้าสู่ระบบ และทุกจุดมีเส้น focus',
      order.map((o) => o.id).join(' > ') === 'login-student-id > login-password > แสดงรหัสผ่าน > เข้าสู่ระบบ' && order.every((o) => o.outline), JSON.stringify(order))

    // ตรวจที่หน้าเว็บ: ช่องว่าง
    await p.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
    check('[จริง] ไม่กรอกอะไร: บอกที่ช่องนั้นทั้งสองช่อง focus ไปช่องแรกที่ผิด และยังไม่ส่งคำขอ',
      (await p.locator('#login-student-id-error').innerText()) === 'กรอกรหัสนักศึกษา' && (await p.locator('#login-password-error').innerText()) === 'กรอกรหัสผ่าน' &&
      (await p.locator('#login-student-id').getAttribute('aria-invalid')) === 'true' && (await p.evaluate(() => document.activeElement?.id)) === 'login-student-id')
    const errorContrast = await contrast(p, '#login-student-id-error')
    check('[จริง] contrast ข้อความผิดพลาดของช่องกรอก ≥4.5:1', errorContrast >= 4.5, String(errorContrast))

    // แสดง/ซ่อนรหัสผ่าน
    await p.locator('#login-password').fill('Wrong-Password-1')
    const toggle = p.getByRole('button', { name: 'แสดงรหัสผ่าน' })
    await toggle.click()
    const shown = (await p.locator('#login-password').getAttribute('type')) === 'text' && (await p.getByRole('button', { name: 'ซ่อนรหัสผ่าน' }).getAttribute('aria-pressed')) === 'true'
    await p.getByRole('button', { name: 'ซ่อนรหัสผ่าน' }).click()
    check('[จริง] ปุ่มแสดง/ซ่อนรหัสผ่านสลับได้ บอกสถานะด้วย aria-pressed และค่าที่พิมพ์ไม่หาย',
      shown && (await p.locator('#login-password').getAttribute('type')) === 'password' && (await p.locator('#login-password').inputValue()) === 'Wrong-Password-1')

    // รหัสผิด (Worker + Argon2id จริง)
    await p.locator('#login-student-id').fill('6512345')
    await p.keyboard.press('Enter')
    const alert = p.locator('.login-card .form-alert')
    check('[จริง] รหัสผ่านผิด: ข้อความไม่บอกว่ารหัสนักศึกษานี้มีบัญชีหรือไม่ บอกทางติดต่อทีมงาน และค่าที่กรอกยังอยู่',
      (await appears(alert)) && (await alert.innerText()) === 'รหัสนักศึกษาหรือรหัสผ่านไม่ถูกต้อง ถ้าลืมรหัสผ่านให้ติดต่อทีมงานเพื่อตั้งรหัสใหม่' &&
      (await p.locator('#login-student-id').inputValue()) === '6512345' && (await p.locator('#login-password').inputValue()) === 'Wrong-Password-1' && p.url().endsWith('/login'))
    await p.locator('#login-student-id').fill('9999999')
    await p.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
    await p.waitForResponse((r) => r.url().endsWith('/auth/member/login'))
    check('[จริง] รหัสนักศึกษาที่ไม่มีในระบบ: ได้ข้อความเดียวกับรหัสผ่านผิดทุกตัวอักษร',
      (await alert.innerText()) === 'รหัสนักศึกษาหรือรหัสผ่านไม่ถูกต้อง ถ้าลืมรหัสผ่านให้ติดต่อทีมงานเพื่อตั้งรหัสใหม่')
    const alertContrast = await contrast(p, '.login-card .form-alert')
    check('[จริง] contrast ข้อความแจ้งเข้าสู่ระบบไม่สำเร็จ ≥4.5:1', alertContrast >= 4.5, String(alertContrast))
    await shot(p, 'member-login-error-1440')
    await p.context().close()
  }

  // หน้าเข้าสู่ระบบทุกความกว้าง
  for (const [w, h] of [[1440, 900], [1024, 768], [768, 1024], [390, 844], [360, 740], [320, 568], [844, 390]]) {
    const p = await newPage(w, h)
    await p.goto(`${BASE}/login?return=%2Fmember%2Ffiles`)
    await p.locator('#login-student-id').waitFor()
    // ส่วนทีมงานรู้ผลจาก server ทีหลังฟอร์มสมาชิก: วัดหน้าเมื่อส่วนนั้นแสดงผลสุดท้ายแล้ว (ปุ่ม Google หรือข้อความว่ายังไม่ได้ตั้งค่า)
    await p.locator('.login-staff .auth-inline').waitFor({ state: 'detached' })
    const small = await smallTargets(p)
    check(`[จริง] หน้าเข้าสู่ระบบ ${w}×${h}: ไม่ล้นจอ และทุกส่วนที่กดได้สูง ≥44px`, (await noOverflow(p)) && small.length === 0, JSON.stringify(small))
    const google = p.getByRole('link', { name: 'เข้าสู่ระบบด้วย Google' })
    // ตรวจทุกครั้ง ไม่ข้ามเงียบ ๆ: เครื่องที่ตั้งค่า Google login แล้วต้องมีปุ่ม เครื่องที่ยังไม่ตั้งค่าต้องบอกเหตุผลแทนปุ่ม
    const configured = (await apiAs(p, '/api/session')).body?.authConfigured === true
    check(`[จริง] หน้าเข้าสู่ระบบ ${w}×${h}: ${configured ? 'ปุ่ม Google ของทีมงานไม่พาไปหน้าของสมาชิกตามค่า return' : 'ยังไม่ได้ตั้งค่า Google login: บอกว่าทีมงานยังเข้าสู่ระบบไม่ได้ และไม่แสดงปุ่ม Google'}`,
      configured
        ? (await google.count()) === 1 && (await google.getAttribute('href')) === '/auth/login?return=%2F'
        : (await google.count()) === 0 && (await p.getByText('ทีมงานยังเข้าสู่ระบบไม่ได้').isVisible()))
    if (w === 1440 || w === 390) await shot(p, `member-login-${w}`)
    await p.context().close()
  }

  // ================= 2. เข้าสู่ระบบครั้งแรก: บังคับเปลี่ยนรหัสผ่านชั่วคราว =================
  {
    const p = await newPage(1440, 900)
    await memberLogin(p, '6512345', TEMP)
    await p.waitForURL(`${BASE}/member/password`)
    await p.getByRole('heading', { name: 'ตั้งรหัสผ่านใหม่', level: 1 }).waitFor()
    check('[จริง] เข้าสู่ระบบด้วยรหัสชั่วคราว (Argon2id จริง): ถูกพาไปหน้าตั้งรหัสผ่านใหม่ พร้อมชื่อเล่นและรหัสนักศึกษาให้ตรวจ',
      (await p.locator('.login-welcome').innerText()).includes('ภูมิ') && (await p.locator('.login-welcome').innerText()).includes('6512345'))
    check('[จริง] หน้าตั้งรหัสผ่านใหม่ไม่มีเมนูไปหน้าอื่น มีเพียงฟอร์มและปุ่มออกจากระบบ',
      (await p.locator('.m-nav, .m-tabbar, .sidebar, .nav-link').count()) === 0 && (await p.getByRole('button', { name: 'ออกจากระบบ' }).isVisible()))
    for (const path of ['/member', '/member/activities', '/member/files', '/member/files/file-doc-0001', '/member/account', '/members', '/files', '/']) {
      await p.goto(BASE + path)
      await p.waitForURL(`${BASE}/member/password`)
    }
    check('[จริง] ยังไม่เปลี่ยนรหัส: เปลี่ยน URL ไปหน้าของสมาชิกหรือหน้าหลังบ้านไม่ได้ ถูกพากลับมาหน้าตั้งรหัสผ่านทุกครั้ง', p.url() === `${BASE}/member/password`)
    const blocked = []
    for (const path of ['/api/member/me', '/api/member/events', '/api/library/files', '/api/library/files/file-doc-0001', '/api/library/files/file-doc-0001/content', '/api/library/status']) {
      const res = await apiAs(p, path)
      blocked.push(`${res.status}:${res.body?.error}`)
    }
    check('[จริง] ยังไม่เปลี่ยนรหัส: เรียก API ข้อมูลตนเอง กิจกรรม และคลังไฟล์ตรง ๆ ได้ 403 ทุกเส้นทาง', blocked.every((b) => b === '403:password_change_required'), blocked.join(' '))
    const staffApi = await apiAs(p, '/api/members')
    check('[จริง] session ของสมาชิกเรียก API หลังบ้านไม่ได้ (403 staff_only)', staffApi.status === 403 && staffApi.body?.error === 'staff_only')

    // ตรวจที่หน้าเว็บ
    await p.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click()
    check('[จริง] ฟอร์มตั้งรหัส: ช่องว่างถูกแจ้งที่แต่ละช่อง และ focus ไปช่องแรก',
      (await p.locator('#password-current-error').innerText()) === 'กรอกรหัสผ่านชั่วคราว' && (await p.locator('#password-new-error').innerText()) === 'กรอกรหัสผ่านใหม่' &&
      (await p.evaluate(() => document.activeElement?.id)) === 'password-current')
    await p.locator('#password-current').fill(TEMP)
    await p.locator('#password-new').fill('short-1')
    await p.locator('#password-confirm').fill('short-1')
    await p.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click()
    const tooShort = await p.locator('#password-new-error').innerText()
    await p.locator('#password-new').fill('6512345')
    await p.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click()
    const shortId = await p.locator('#password-new-error').innerText()
    await p.locator('#password-new').fill(OWN)
    await p.locator('#password-confirm').fill(`${OWN}x`)
    await p.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click()
    const mismatch = await p.locator('#password-confirm-error').innerText()
    check('[จริง] ฟอร์มตั้งรหัส: รหัสสั้นเกิน และรหัสสองช่องไม่ตรงกัน ถูกแจ้งที่ช่องนั้นก่อนส่ง',
      tooShort.includes('อย่างน้อย 10 ตัวอักษร') && shortId.includes('อย่างน้อย 10 ตัวอักษร') && mismatch === 'รหัสผ่านใหม่สองช่องไม่ตรงกัน', [tooShort, shortId, mismatch].join(' | '))
    // รหัสชั่วคราวผิด: server ตอบและบอกที่ช่องนั้น ค่าที่กรอกยังอยู่
    await p.locator('#password-current').fill('Wrong-Temp-0000')
    await p.locator('#password-confirm').fill(OWN)
    await p.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click()
    await p.locator('#password-current-error').waitFor()
    check('[จริง] รหัสชั่วคราวผิด: server แจ้งที่ช่องรหัสชั่วคราว ค่าที่กรอกในช่องอื่นยังอยู่ และยังอยู่หน้าเดิม',
      (await p.locator('#password-current-error').innerText()).includes('รหัสผ่านปัจจุบันไม่ถูกต้อง') && (await p.locator('#password-new').inputValue()) === OWN &&
      (await p.locator('#password-confirm').inputValue()) === OWN && p.url() === `${BASE}/member/password`)
    await shot(p, 'member-first-password-1440')

    await p.locator('#password-current').fill(TEMP)
    await p.getByRole('button', { name: 'บันทึกรหัสผ่านใหม่' }).click()
    await p.waitForURL(`${BASE}/member`)
    check('[จริง] ตั้งรหัสผ่านใหม่สำเร็จ: ไปหน้าแรกของสมาชิกพร้อมข้อความแจ้งผล และ API ของสมาชิกใช้ได้',
      (await appears(p.getByText('ตั้งรหัสผ่านใหม่แล้ว'))) && (await appears(p.getByRole('heading', { name: 'สวัสดี ภูมิ', level: 1 }))) && (await apiAs(p, '/api/member/me')).status === 200)
    await p.goto(`${BASE}/member/password`)
    await p.waitForURL(`${BASE}/member`)
    check('[จริง] เปลี่ยนรหัสแล้ว: หน้าตั้งรหัสชั่วคราวไม่เปิดซ้ำ', p.url() === `${BASE}/member`)
    await p.context().close()

    // รหัสชั่วคราวเดิมใช้ไม่ได้แล้ว รหัสใหม่ใช้ได้
    const again = await newPage(390, 844)
    await memberLogin(again, '6512345', TEMP)
    const rejected = await appears(again.locator('.login-card .form-alert'))
    await again.locator('#login-password').fill(OWN)
    await again.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
    await again.waitForURL(`${BASE}/member`)
    check('[จริง] หลังเปลี่ยนรหัส: รหัสชั่วคราวเดิมเข้าไม่ได้ รหัสใหม่เข้าได้และไปหน้าแรกของสมาชิกทันที', rejected && again.url() === `${BASE}/member`)
    await again.context().close()
  }
  {
    // หน้าตั้งรหัสผ่านใหม่บนจอแคบ (ใช้บัญชีที่เพิ่งรีเซ็ตโดยผู้ดูแล)
    const admin = await newPage(1280, 800, actors.admin)
    await admin.goto(`${BASE}/`)
    const reset = await apiAs(admin, `/api/members/${actors.first.id}/account/password`, { method: 'POST', body: { studentId: '6512345', password: TEMP } })
    check('[จริง] ผู้ดูแลรีเซ็ตรหัสผ่านผ่าน API: สำเร็จและบัญชีกลับเป็นต้องเปลี่ยนรหัสผ่าน', reset.status === 200 && reset.body?.account?.state === 'must_change' && !JSON.stringify(reset.body).includes(TEMP))
    await admin.context().close()
    for (const [w, h] of [[390, 844], [320, 568], [844, 390]]) {
      const p = await newPage(w, h)
      await memberLogin(p, '6512345', TEMP)
      await p.waitForURL(`${BASE}/member/password`)
      const small = await smallTargets(p)
      check(`[จริง] หน้าตั้งรหัสผ่านใหม่ ${w}×${h}: ไม่ล้นจอ และทุกส่วนที่กดได้สูง ≥44px`, (await noOverflow(p)) && small.length === 0, JSON.stringify(small))
      if (w === 390) await shot(p, 'member-first-password-390')
      await p.context().close()
    }
  }

  // ================= 3. หน้าของสมาชิก =================
  const member = actors.ready
  googleRequests.length = 0
  popups.length = 0

  // ---------- หน้าแรก ----------
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const tag = `หน้าแรกสมาชิก ${w}px`
    // คลังจริงของ Worker: เครื่องนี้ไม่ได้เชื่อม Google จึงต้องบอกว่ายังไม่พร้อม ไม่ใช่บอกว่าไม่มีไฟล์
    const real = await newPage(w, h, member, 0, { theme: 'dark' })
    await real.goto(`${BASE}/member`)
    await real.getByRole('heading', { name: 'สวัสดี มายด์', level: 1 }).waitFor()
    await real.locator('.m-event').first().waitFor()
    const filesCard = real.locator('section[aria-labelledby="home-files"]')
    check(`[จริง] ${tag}: คลังไฟล์ยังไม่ได้เชื่อม Google จึงบอกว่ายังไม่พร้อมใช้งาน ไม่แสดงว่า “ไม่มีไฟล์”`,
      (await appears(filesCard.getByText('คลังไฟล์ของชมรมยังไม่พร้อมใช้งานในตอนนี้ ติดต่อทีมงาน'))) && (await filesCard.getByText(/ยังไม่มีไฟล์/).count()) === 0)
    const surface = await real.evaluate(() => ({ theme: document.documentElement.dataset.theme, bg: getComputedStyle(document.body).backgroundColor, header: getComputedStyle(document.querySelector('.m-header')).backgroundColor }))
    check(`[จริง] ${tag}: หน้าสมาชิกสว่างเสมอ ไม่รับธีมมืดของหลังบ้านที่เคยเลือกในเบราว์เซอร์เดียวกัน`,
      surface.theme === 'light' && surface.bg === 'rgb(248, 250, 252)' && surface.header === 'rgb(255, 255, 255)', JSON.stringify(surface))
    await real.context().close()

    const p = await newPage(w, h, member)
    await mockLibrary(p)
    await p.goto(`${BASE}/member`)
    await p.getByRole('heading', { name: 'สวัสดี มายด์', level: 1 }).waitFor()
    await p.locator('.m-event').first().waitFor()
    await p.locator('.file-card').first().waitFor()
    const eventTitles = await p.locator('.m-event-title').allInnerTexts()
    check(`[จริง] ${tag}: ทักด้วยชื่อเล่น และแสดงกิจกรรมที่จะมาถึง 5 รายการแรกจากข้อมูลจริง เรียงจากใกล้ที่สุด ไม่มีรายการที่ผ่านไปแล้ว`,
      eventTitles.length === 5 && eventTitles[0] === 'ซ้อมทีม Valorant' && !eventTitles.includes('ประชุมเตรียมงานที่ผ่านมา') && !eventTitles.includes('สรุปผลการแข่งขัน'), eventTitles.join(' | '))
    const firstEvent = await p.locator('.m-event').first().innerText()
    check(`[จริง] ${tag}: กิจกรรมแสดงวันที่ไทยปี พ.ศ. เวลา 24 ชั่วโมง และสถานที่`,
      new RegExp(`${Number(today.slice(0, 4)) + 543}`).test(firstEvent) && /18:00–20:00 น\./.test(firstEvent) && firstEvent.includes('ห้องชมรม ชั้น 2'), firstEvent.replace(/\n/g, ' / '))
    check(`[จำลองคลัง] ${tag}: แสดงไฟล์ที่แก้ไขล่าสุด 5 รายการ พร้อมทางไปดูทั้งหมด และทางไปบัญชีของฉัน`,
      (await p.locator('.file-card').count()) === 5 && (await p.locator('section[aria-labelledby="home-files"] a', { hasText: 'ดูทั้งหมด' }).getAttribute('href')) === '/member/files' &&
      (await p.locator('a.m-card-link').getAttribute('href')) === '/member/account')
    const text = await p.locator('body').innerText()
    check(`[จริง] ${tag}: ไม่มีตัวเลขทะเบียนสมาชิก ข้อมูลการเชื่อมต่อ ปุ่มซิงค์ สถานะ token หรือเมนูหลังบ้าน`,
      !/อัปเดตจาก Google|ซิงค์|token|แหล่งข้อมูล|ทีมงาน\b|สมาชิกทั้งหมด|ทั้งหมด \d+ คน/i.test(text.replace('ติดต่อทีมงาน', '')) && (await p.locator('.sidebar, .nav-link, .sync-row, .topbar').count()) === 0, '')
    const navLabels = await p.locator(w >= 900 ? '.m-nav a' : '.m-tabbar a').allInnerTexts()
    check(`[จริง] ${tag}: เมนูมีสี่หน้า หน้าแรก / กิจกรรม / ไฟล์ชมรม / บัญชีของฉัน และบอกหน้าปัจจุบัน`,
      navLabels.map((s) => s.trim()).join(' / ') === 'หน้าแรก / กิจกรรม / ไฟล์ชมรม / บัญชีของฉัน' &&
      (await p.locator(w >= 900 ? '.m-nav a[aria-current="page"]' : '.m-tabbar a[aria-current="page"]').innerText()).trim() === 'หน้าแรก')
    if (w >= 900) {
      const box = await p.locator('.m-header').boundingBox()
      const main = await p.locator('.m-main').boundingBox()
      check(`[จริง] ${tag}: หัวเว็บเตี้ย ไม่มี sidebar ของหลังบ้าน และเนื้อหากว้างไม่เกินประมาณ 1200px`,
        box.height <= 64 && (await p.locator('.m-tabbar').isHidden()) && main.width >= 1100 && main.width <= 1200, `${box.height} / ${main.width}`)
      const nav = { active: await contrast(p, '.m-nav a[aria-current="page"]'), idle: await contrast(p, '.m-nav a:not([aria-current])'), link: await contrast(p, '.m-card-head .text-link'), meta: await contrast(p, '.m-event-meta') }
      await p.locator('.m-nav a:not([aria-current])').first().hover()
      nav.hover = await contrast(p, '.m-nav a:not([aria-current])')
      check(`[จริง] ${tag}: contrast ของเมนู (ปกติ hover และหน้าปัจจุบัน) ลิงก์ และข้อความรอง ≥4.5:1`, Object.values(nav).every((v) => v >= 4.5), JSON.stringify(nav))
    } else {
      const bar = await p.locator('.m-tabbar').boundingBox()
      check(`[จริง] ${tag}: หัวเว็บสั้น เมนูสี่หน้าอยู่ด้านล่างของจอ และเมนูบนหัวเว็บไม่แสดงซ้ำ`,
        (await p.locator('.m-header').boundingBox()).height <= 60 && (await p.locator('.m-nav').isHidden()) && Math.round(bar.y + bar.height) === h && bar.width === w)
      const clear = await lastControlClear(p)
      check(`[จริง] ${tag}: เลื่อนลงสุดแล้วส่วนท้ายของเนื้อหาไม่ถูกเมนูด้านล่างบัง และยังกดถึง`, clear.ok, JSON.stringify(clear))
      const tab = { active: await contrast(p, '.m-tabbar a[aria-current="page"]'), idle: await contrast(p, '.m-tabbar a:not([aria-current])') }
      check(`[จริง] ${tag}: contrast ของเมนูด้านล่าง ≥4.5:1`, tab.active >= 4.5 && tab.idle >= 4.5, JSON.stringify(tab))
    }
    const small = await smallTargets(p)
    check(`[จริง] ${tag}: ไม่ล้นจอ และทุกส่วนที่กดได้สูง ≥44px`, (await noOverflow(p)) && small.length === 0, JSON.stringify(small))
    await p.evaluate(() => window.scrollTo(0, 0))
    await shot(p, `member-home-${w}`, w >= 900)
    await p.context().close()
  }

  // ---------- กิจกรรม ----------
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const tag = `กิจกรรม ${w}px`
    const p = await newPage(w, h, member)
    await p.goto(`${BASE}/member/activities`)
    await p.locator('.m-activity').first().waitFor()
    const titles = await p.locator('.m-event-title').allInnerTexts()
    check(`[จริง] ${tag}: แสดงเป็นรายการ เรียงจากใกล้ที่สุด มีครบ 6 รายการที่จะมาถึง แยกตามเดือน`,
      titles.length === 6 && titles[0] === 'ซ้อมทีม Valorant' && titles[5] === 'สรุปผลการแข่งขัน' && (await p.locator('.m-month-title').count()) >= 1 && (await p.locator('table, .calendar-grid, .month-grid').count()) === 0, titles.join(' | '))
    check(`[จริง] ${tag}: ไม่มีปุ่มเพิ่ม แก้ไข หรือลบกำหนดการ`, (await p.getByRole('button', { name: /เพิ่ม|แก้ไข|ลบ|บันทึก/ }).count()) === 0 && (await p.getByRole('link', { name: /เพิ่ม|แก้ไข|ลบ/ }).count()) === 0)
    const allDay = await p.locator('.m-activity', { hasText: 'เปิดรับสมัครสมาชิกใหม่' }).innerText()
    check(`[จริง] ${tag}: กำหนดการทั้งวันหลายวันบอกช่วงวันและคำว่า “ทั้งวัน”`, /–/.test(allDay) && allDay.includes('ทั้งวัน'), allDay.replace(/\n/g, ' / '))

    // รายละเอียด: เปิดด้วยคีย์บอร์ด focus เข้า dialog ปิดด้วย Esc แล้ว focus กลับที่รายการเดิม
    const item = p.locator('.m-activity', { hasText: 'ซ้อมทีม Valorant' })
    await item.focus()
    await p.keyboard.press('Enter')
    const dialog = p.locator('dialog[open]')
    await dialog.waitFor()
    const detail = await dialog.innerText()
    check(`[จริง] ${tag}: รายละเอียดแสดงชื่อ วันเวลา สถานที่ และรายละเอียดหลายบรรทัด โดย focus อยู่ในกล่อง`,
      detail.includes('ซ้อมทีม Valorant') && /18:00–20:00 น\./.test(detail) && detail.includes('ห้องชมรม ชั้น 2') && detail.includes('นำอุปกรณ์มาเอง') &&
      (await p.evaluate(() => document.querySelector('dialog[open]').contains(document.activeElement))))
    if (w === 390) await shot(p, 'member-activity-detail-390', false)
    await p.keyboard.press('Escape')
    await gone(dialog)
    check(`[จริง] ${tag}: ปิดรายละเอียดด้วย Esc แล้ว focus กลับไปที่รายการที่เปิด`, await p.evaluate(() => document.activeElement?.classList.contains('m-activity') && document.activeElement.textContent.includes('ซ้อมทีม Valorant')))
    // สถานที่ที่เป็นลิงก์
    await p.locator('.m-activity', { hasText: 'ประชุมสมาชิกประจำเดือน' }).click()
    const link = p.locator('dialog[open] a[href="https://example.com/meeting"]')
    check(`[จริง] ${tag}: สถานที่ที่เป็น URL แสดงเป็นลิงก์เปิดแท็บใหม่แบบปลอดภัย`, (await appears(link)) && (await link.getAttribute('rel')) === 'noopener noreferrer' && (await link.getAttribute('target')) === '_blank')
    await p.getByRole('button', { name: 'ปิด', exact: true }).last().click()
    await gone(dialog)

    await p.getByRole('button', { name: /ที่ผ่านมา 30 วัน/ }).click()
    check(`[จริง] ${tag}: สลับไปดูกิจกรรมที่ผ่านมาได้ และปุ่มบอกสถานะที่เลือก`,
      (await appears(p.locator('.m-activity', { hasText: 'ประชุมเตรียมงานที่ผ่านมา' }))) && (await p.locator('.m-activity').count()) === 1 &&
      (await p.getByRole('button', { name: /ที่ผ่านมา 30 วัน/ }).getAttribute('aria-pressed')) === 'true')
    await p.getByRole('button', { name: /กำลังจะมาถึง/ }).click()
    await p.locator('.m-activity').nth(5).waitFor()
    const small = await smallTargets(p)
    check(`[จริง] ${tag}: ไม่ล้นจอ และทุกส่วนที่กดได้สูง ≥44px`, (await noOverflow(p)) && small.length === 0, JSON.stringify(small))
    if (w < 900) {
      const clear = await lastControlClear(p)
      check(`[จริง] ${tag}: รายการสุดท้ายไม่ถูกเมนูด้านล่างบัง`, clear.ok, JSON.stringify(clear))
      await p.evaluate(() => window.scrollTo(0, 0))
    }
    await shot(p, `member-activities-${w}`, w >= 900)
    await p.context().close()
  }

  // ---------- ไฟล์ชมรมและตัวอย่างไฟล์ (คลังจำลอง) ----------
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const tag = `[จำลองคลัง] ไฟล์ชมรมของสมาชิก ${w}px`
    const p = await newPage(w, h, member)
    const calls = await mockLibrary(p)
    await p.goto(`${BASE}/member/files`)
    await p.locator('.file-card').first().waitFor()
    check(`${tag}: แสดงหน้าแรกของรายการ 30 ไฟล์ บอกว่ายังมีอีก พร้อมเวลาที่ได้ข้อมูลจาก Google และปุ่มรีเฟรช`,
      (await p.locator('.file-card').count()) === 30 && (await p.locator('.file-status .result-count').innerText()).includes('แสดง 30 ไฟล์แรก ยังมีไฟล์อีก') &&
      /ข้อมูลจาก Google เมื่อ .+ น\./.test(await p.locator('.file-status .result-count').innerText()) && (await p.getByRole('button', { name: 'รีเฟรช' }).isVisible()))
    check(`${tag}: ไม่มีปุ่มจัดการ (สร้าง แก้ไข ลบ เชื่อม) และไม่มีปุ่มแก้ไขใน Google`,
      (await p.getByRole('button', { name: /สร้าง|แก้ไข|ลบ|เชื่อม|อัปโหลด/ }).count()) === 0 && (await p.getByRole('link', { name: /สร้าง|แก้ไข|เชื่อม/ }).count()) === 0)
    const long = p.locator('.file-card', { hasText: 'รายงานสรุปผลการแข่งขัน' })
    const clamp = await long.locator('.file-name').evaluate((el) => ({ clipped: el.scrollHeight > el.clientHeight + 1, lines: Math.round(el.clientHeight / parseFloat(getComputedStyle(el).lineHeight)), title: el.getAttribute('title') }))
    check(`${tag}: ชื่อไฟล์ยาวถูกตัดไม่เกินสองบรรทัด และชื่อเต็มเข้าถึงได้จาก title และข้อความของลิงก์`,
      clamp.clipped && clamp.lines <= 2 && clamp.title === LONG_NAME && (await long.locator('.file-name').textContent()) === LONG_NAME, JSON.stringify(clamp))
    check(`${tag}: ไฟล์ที่ไม่มีตัวอย่างในเว็บยังอยู่ในรายการพร้อมป้ายบอก`, (await p.locator('.file-card', { hasText: 'ระเบียบการใช้ห้อง.docx' }).getByText('ไม่มีตัวอย่างในเว็บ').count()) === 1)

    await p.getByRole('button', { name: 'โหลดไฟล์เพิ่ม' }).click()
    await p.locator('.file-card').nth(44).waitFor()
    check(`${tag}: โหลดเพิ่มทีละหน้าด้วยตำแหน่งหน้าถัดไป จนครบแล้วบอกว่าแสดงครบ และปุ่มโหลดเพิ่มหายไป`,
      (await p.locator('.file-card').count()) === 45 && (await p.locator('.file-status .result-count').innerText()).includes('แสดงครบ 45 ไฟล์') && (await p.getByRole('button', { name: 'โหลดไฟล์เพิ่ม' }).count()) === 0 &&
      calls.some((c) => c.includes('pageToken=30')))

    // ค้นหา กรองประเภท และเรียง
    await p.locator('#file-search').fill('แผนงาน')
    await p.keyboard.press('Enter')
    await p.waitForFunction(() => document.querySelectorAll('.file-card').length === 1 && document.querySelector('.file-card .file-name').textContent === 'แผนงานชมรม ภาคเรียนที่ 1')
    const searched = p.url().includes('q=') && (await p.locator('.file-card .file-name').innerText()) === 'แผนงานชมรม ภาคเรียนที่ 1'
    await p.locator('#file-search').fill('')
    await p.keyboard.press('Enter')
    await p.locator('#file-type').selectOption('sheet')
    await p.waitForFunction(() => document.querySelectorAll('.file-card').length === 1 && document.querySelector('.file-card .file-name').textContent === 'ตารางซ้อมและห้องที่ใช้')
    const filtered = (await p.locator('.file-card .file-name').innerText()) === 'ตารางซ้อมและห้องที่ใช้' && p.url().includes('type=sheet')
    await p.locator('#file-type').selectOption('all')
    let releaseSort
    const sortGate = new Promise((resolve) => { releaseSort = resolve })
    const holdSort = async (route) => {
      if (new URL(route.request().url()).searchParams.get('sort') === 'name') await sortGate
      return route.fallback()
    }
    await p.route('**/api/library/files?**', holdSort)
    const sortRequest = p.waitForRequest((request) => new URL(request.url()).pathname === '/api/library/files' && new URL(request.url()).searchParams.get('sort') === 'name')
    const sortResponse = p.waitForResponse((response) => new URL(response.url()).pathname === '/api/library/files' && new URL(response.url()).searchParams.get('sort') === 'name')
    await p.locator('#file-sort').selectOption('name')
    await sortRequest
    check(`${tag}: เปลี่ยนตัวกรองแล้วรอคำตอบชุดใหม่ ไม่แสดงรายการชุดเก่าภายใต้เงื่อนไขใหม่`,
      (await appears(p.getByText('กำลังโหลดรายการไฟล์…'))) && (await p.locator('.file-card').count()) === 0)
    releaseSort()
    await sortResponse
    await p.waitForFunction(() => new URL(location.href).searchParams.get('sort') === 'name' && document.querySelectorAll('.file-card').length === 30)
    const sortedNames = await p.locator('.file-card .file-name').allTextContents()
    check(`${tag}: ค้นชื่อ กรองประเภท และเรียงตามชื่อได้ โดยเก็บตัวเลือกไว้ใน URL`, searched && filtered && calls.some((c) => c.includes('sort=name')) &&
      sortedNames.every((name, index) => index === 0 || sortedNames[index - 1].localeCompare(name, 'th') <= 0))
    await p.unroute('**/api/library/files?**', holdSort)
    await p.locator('#file-search').fill('ไม่มีไฟล์ชื่อนี้แน่นอน')
    await p.keyboard.press('Enter')
    check(`${tag}: ค้นแล้วไม่พบ: บอกว่าไม่พบไฟล์ที่ตรงเงื่อนไข พร้อมปุ่มล้างตัวกรอง`, (await appears(p.getByText('ไม่พบไฟล์ที่ตรงกับเงื่อนไข'))) && (await p.getByRole('button', { name: 'ล้างตัวกรอง' }).isVisible()))
    await p.getByRole('button', { name: 'ล้างตัวกรอง' }).click()
    await p.locator('.file-card').first().waitFor()
    await p.locator('#file-sort').selectOption('modified')
    await p.waitForFunction(() => !location.search.includes('sort') && document.querySelectorAll('.file-card').length === 30)

    const small = await smallTargets(p)
    check(`${tag}: ไม่ล้นจอ และทุกส่วนที่กดได้สูง ≥44px (พื้นที่กดของไฟล์คือทั้งการ์ด)`, (await noOverflow(p)) && small.length === 0, JSON.stringify(small))
    await p.evaluate(() => window.scrollTo(0, 0))
    await shot(p, `member-files-${w}`, false)

    // ตัวอย่าง: เอกสาร (PDF)
    await p.locator('#file-type').selectOption('doc')
    await p.waitForFunction(() => document.querySelectorAll('.file-card').length === 1 && document.querySelector('.file-card .file-name').textContent === 'แผนงานชมรม ภาคเรียนที่ 1')
    await p.locator('.file-card .file-name').click()
    await p.waitForURL(`${BASE}/member/files/file-doc-0001`)
    await p.locator('.pdf-page canvas').first().waitFor({ timeout: 20000 })
    await p.waitForFunction(() => {
      const canvas = document.querySelector('.pdf-page canvas')
      if (!canvas || canvas.width === 0) return false
      const data = canvas.getContext('2d').getImageData(0, 0, canvas.width, Math.min(canvas.height, 400)).data
      for (let i = 0; i < data.length; i += 4) if (data[i + 3] !== 0 && (data[i] < 200 || data[i + 1] < 200 || data[i + 2] < 200)) return true
      return false
    }, null, { timeout: 20000 })
    const viewer = await p.evaluate(() => ({ boxes: document.querySelectorAll('.viewer-box').length, pages: document.querySelectorAll('.pdf-page').length, iframes: document.querySelectorAll('iframe, embed, object').length, bar: document.querySelector('.viewer-bar p')?.textContent }))
    check(`${tag}: ตัวอย่างเอกสารแสดงเป็น PDF ในเว็บ (วาดหน้าเอกสารจริงบน canvas) ในกล่องแสดงเนื้อหากล่องเดียว ไม่มี iframe ของ Google`,
      viewer.boxes === 1 && viewer.pages === 3 && viewer.iframes === 0 && viewer.bar === '3 หน้า', JSON.stringify(viewer))
    const pageWidth = await p.locator('.pdf-page').first().evaluate((el) => ({ page: el.getBoundingClientRect().width, frame: el.closest('.pdf-frame').clientWidth }))
    // จอแคบ: หน้าพอดีความกว้างของกล่อง; จอกว้าง: หน้ากว้างไม่เกิน 880px และอยู่ในกล่อง
    check(`${tag}: หน้า PDF ที่ขนาด 100% พอดีความกว้างของกล่อง (จอกว้างไม่เกิน 880px) ไม่ล้นกล่อง และหน้าเว็บไม่ล้นจอ`,
      pageWidth.page <= pageWidth.frame + 1 && Math.abs(pageWidth.page - Math.min(pageWidth.frame, 880)) <= 6 && (await noOverflow(p)), JSON.stringify(pageWidth))
    check(`${tag}: หน้าตัวอย่างมีชื่อไฟล์ ปุ่มรีเฟรช ทางกลับไปรายการ และปุ่มเปิดต้นฉบับ (ไม่มีปุ่มแก้ไข) พร้อมบอกว่าขึ้นกับสิทธิ์ของบัญชี Google ของคนนั้น`,
      (await p.getByRole('heading', { name: 'แผนงานชมรม ภาคเรียนที่ 1', level: 1 }).isVisible()) && (await p.getByRole('button', { name: 'รีเฟรช' }).isVisible()) &&
      (await p.getByRole('link', { name: 'กลับไปรายการไฟล์' }).getAttribute('href')) === '/member/files?type=doc' &&
      (await p.getByRole('link', { name: /เปิดต้นฉบับ/ }).getAttribute('href')) === 'https://drive.google.com/file/d/file-doc-0001/view?usp=drivesdk' &&
      (await p.getByRole('link', { name: /เปิดต้นฉบับ/ }).getAttribute('target')) === '_blank' && (await p.getByRole('link', { name: /แก้ไขใน/ }).count()) === 0 &&
      (await p.getByText('จะเปิดได้หรือไม่ขึ้นกับสิทธิ์ของบัญชี Google ที่ล็อกอินในเบราว์เซอร์นี้').count()) >= 1)
    await p.getByRole('button', { name: 'ขยาย' }).click()
    const zoomed = (await p.locator('.pdf-page').first().evaluate((el) => el.getBoundingClientRect().width)) / pageWidth.page
    check(`${tag}: ขยายตัวอย่างได้ (125%) และส่วนที่เกินเลื่อนอยู่ในกล่อง ไม่ทำให้หน้าเว็บล้น`, Math.abs(zoomed - 1.25) < 0.02 && (await noOverflow(p)), String(zoomed))
    await p.getByRole('button', { name: 'ย่อ' }).click()
    const previewSmall = await smallTargets(p)
    check(`${tag}: หน้าตัวอย่างทุกส่วนที่กดได้สูง ≥44px`, previewSmall.length === 0, JSON.stringify(previewSmall))
    await p.evaluate(() => window.scrollTo(0, 0))
    await shot(p, `member-preview-${w}`, false)

    // กลับไปรายการ: ตัวกรองเดิมยังอยู่
    await p.getByRole('link', { name: 'กลับไปรายการไฟล์' }).click()
    await p.waitForURL(`${BASE}/member/files?type=doc`)
    await p.locator('.file-card').first().waitFor()
    check(`${tag}: กลับจากตัวอย่างมาที่รายการเดิมพร้อมตัวกรองเดิม`, (await p.locator('#file-type').inputValue()) === 'doc' && (await p.locator('.file-card').count()) === 1)

    // ชีต
    await p.goto(`${BASE}/member/files/file-sheet-0002`)
    await p.locator('.sheet-table tbody tr').first().waitFor()
    const range = await p.locator('.sheet-range').innerText()
    check(`${tag}: Google Sheets แสดงเป็นตาราง บอกขอบเขตที่แสดง (แถว 1–200 จาก 1,000 แถว) และมีตัวเลือกแท็บ`,
      range.includes('แสดงแถว 1–200 จากตาราง 1,000 แถว') && (await p.locator('.sheet-table tbody tr').count()) === 200 && (await p.locator('#sheet-tab option').count()) === 2 &&
      (await p.locator('.sheet-table thead th').allInnerTexts()).slice(1).join('') === 'ABCD', range)
    await p.getByRole('button', { name: /โหลดแถวถัดไป/ }).click()
    await p.locator('.sheet-table tbody tr').nth(259).waitFor()
    check(`${tag}: โหลดแถวถัดไปแล้วขอบเขตที่บอกขยายตาม และยังบอกว่ายังไม่ครบทุกแถว`,
      (await p.locator('.sheet-range').innerText()).includes('แสดงแถว 1–400') && (await p.getByText('ยังแสดงไม่ครบทุกแถวของแท็บนี้').isVisible()))
    await p.locator('#sheet-tab').selectOption('7')
    await p.waitForFunction(() => document.querySelectorAll('.sheet-table tbody tr').length === 1)
    check(`${tag}: เปลี่ยนแท็บแล้วตารางและขอบเขตเปลี่ยนตาม และตารางกว้างเลื่อนอยู่ในกล่อง ไม่ทำให้หน้าล้น`,
      (await p.locator('.sheet-table tbody').innerText()).includes('จำนวนวันซ้อม') && (await p.locator('.sheet-range').innerText()).includes('จากตาราง 20 แถว') && (await noOverflow(p)))

    // ฟอร์ม
    await p.goto(`${BASE}/member/files/file-form-0003`)
    await p.locator('.form-item').first().waitFor()
    const form = await p.locator('.form-viewer').innerText()
    check(`${tag}: Google Forms แสดงชื่อ คำอธิบาย และคำถาม พร้อมปุ่ม “เปิดฟอร์ม” ไปหน้าตอบของ Google และไม่มีปุ่มแก้ไขหรือคำตอบของผู้ตอบ`,
      form.includes('ใบสมัครสมาชิกใหม่') && form.includes('กรอกเพื่อสมัครเข้าชมรม') && form.includes('ชื่อ-นามสกุล') && form.includes('ต้องตอบ') && form.includes('Valorant') &&
      (await p.getByRole('link', { name: /เปิดฟอร์ม/ }).getAttribute('href')) === 'https://docs.google.com/forms/d/e/file-form-0003/viewform' &&
      (await p.getByRole('link', { name: /แก้ไขใน|เปิดต้นฉบับ/ }).count()) === 0 && form.includes('ไม่มีคำตอบของผู้ตอบในหน้านี้'))

    // รูปภาพ ข้อความ และชนิดที่ไม่มีตัวอย่าง
    await p.goto(`${BASE}/member/files/file-image-0006`)
    await p.locator('.image-viewer img:not([hidden])').waitFor()
    check(`${tag}: รูปภาพแสดงผ่าน endpoint ของเว็บ ไม่ใช่ลิงก์ของ Google`, (await p.locator('.image-viewer img').getAttribute('src')) === '/api/library/files/file-image-0006/content')
    await p.goto(`${BASE}/member/files/file-text-0008`)
    await p.locator('.text-preview').waitFor()
    check(`${tag}: ไฟล์ข้อความแสดงเป็นตัวอักษร ไม่ถูกตีความเป็น HTML`, (await p.locator('.text-preview').innerText()).includes('<b>ข้อความนี้ต้องแสดงเป็นตัวอักษร ไม่ใช่ตัวหนา</b>') && (await p.locator('.text-preview b').count()) === 0)
    await p.goto(`${BASE}/member/files/file-office-0007`)
    await p.getByText('ไม่มีตัวอย่างในเว็บ').first().waitFor()
    check(`${tag}: ไฟล์ที่ยังไม่มีตัวอย่าง (Office) บอกเหตุผล และยังมีปุ่มเปิดต้นฉบับ`,
      (await p.getByText('ไฟล์ชนิดนี้ (ไฟล์ Office) ยังไม่มีตัวอย่างในเว็บ').isVisible()) && (await p.getByRole('link', { name: /เปิดต้นฉบับ/ }).isVisible()))
    await p.goto(`${BASE}/member/files/file-that-was-deleted`)
    await p.getByRole('heading', { name: 'เปิดไฟล์นี้ไม่ได้แล้ว' }).waitFor()
    check(`${tag}: ไฟล์ที่ถูกลบหรือบัญชีชมรมเปิดไม่ได้แล้ว: บอกสถานะ ไม่มีปุ่มลองใหม่ที่ไม่มีประโยชน์ และมีทางกลับไปรายการ`,
      (await p.getByRole('button', { name: 'ลองอีกครั้ง' }).count()) === 0 && (await p.getByRole('link', { name: 'กลับไปรายการไฟล์' }).count()) >= 1)
    await p.context().close()
  }
  check('[จำลองคลัง] ระหว่างใช้หน้าของสมาชิกทั้งหมด: หน้าเว็บไม่เรียกโดเมนของ Google เลย และไม่เปิดหน้าต่างหรือแท็บใหม่เอง',
    googleRequests.length === 0 && popups.length === 0, JSON.stringify({ googleRequests: googleRequests.slice(0, 3), popups }))

  // สถานะของรายการ: ยังไม่พร้อม ล้มเหลว ข้อมูลค้าง และว่างจริง
  {
    const cases = [
      ['unavailable', 'คลังไฟล์ยังไม่พร้อมใช้งาน', 'คลังไฟล์ของชมรมยังไม่พร้อมใช้งานในตอนนี้ ติดต่อทีมงาน'],
      ['error', 'โหลดรายการไฟล์ไม่สำเร็จ', 'โหลดรายการไฟล์จาก Google ไม่สำเร็จ กดรีเฟรชเพื่อลองอีกครั้ง'],
    ]
    for (const [mode, title, message] of cases) {
      const p = await newPage(390, 844, member)
      await mockLibrary(p, { mode: { list: mode } })
      await p.goto(`${BASE}/member/files`)
      check(`[จำลองคลัง] รายการไฟล์สถานะ ${mode}: บอกสาเหตุ ไม่แสดงเป็น “ไม่มีไฟล์” และมีปุ่มลองอีกครั้ง`,
        (await appears(p.getByText(title))) && (await p.getByText(message).isVisible()) && (await p.getByText(/ยังไม่มีไฟล์ในคลัง|ไม่พบไฟล์/).count()) === 0 &&
        (await p.getByRole('button', { name: /ลอง(โหลด)?อีกครั้ง/ }).isVisible()) && (await p.getByText(/เปิดใช้คลังไฟล์ Google|แหล่งข้อมูล/).count()) === 0)
      await shot(p, `member-files-${mode}-390`, false)
      await p.context().close()
    }
    const stale = await newPage(390, 844, member)
    await mockLibrary(stale, { mode: { list: 'stale' } })
    await stale.goto(`${BASE}/member/files`)
    await stale.locator('.file-card').first().waitFor()
    check('[จำลองคลัง] Google ล้มเหลวแต่มีรายการที่เก็บไว้: แสดงรายการเดิมพร้อมบอกว่าอาจไม่ใช่ข้อมูลล่าสุด เหตุผล และเวลาที่ได้ข้อมูลจริง',
      (await stale.locator('.notice-warning').innerText()).includes('รายการนี้อาจไม่ใช่ข้อมูลล่าสุด: Google จำกัดจำนวนคำขอชั่วคราว') && /เมื่อ .+ น\./.test(await stale.locator('.notice-warning').innerText()))
    await stale.context().close()
    const empty = await newPage(390, 844, member)
    await mockLibrary(empty, { mode: { list: 'empty' } })
    await empty.goto(`${BASE}/member/files`)
    check('[จำลองคลัง] คลังว่างจริง: บอกว่ายังไม่มีไฟล์ในคลัง (ต่างจากสถานะโหลดไม่สำเร็จ)', (await appears(empty.getByText('ยังไม่มีไฟล์ในคลัง'))) && (await empty.getByRole('button', { name: 'ล้างตัวกรอง' }).count()) === 0)
    await empty.context().close()
  }

  // ---------- บัญชีของฉัน ----------
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const tag = `บัญชีของฉัน ${w}px`
    const p = w === 1440 ? await newPage(w, h, member, 1) : await memberPage(w, h, '0065002', OWN)
    await p.goto(`${BASE}/member/account`)
    await p.locator('.m-profile').waitFor()
    const profile = await p.locator('.m-profile').innerText()
    check(`[จริง] ${tag}: แสดงชื่อ ชื่อเล่น รหัสนักศึกษา (คงเลขศูนย์นำหน้า) สถานะ และช่องทางติดต่อของตัวเอง`,
      profile.includes('ณิชา ตัวอย่างสุข') && profile.includes('มายด์') && profile.includes('0065002') && profile.includes('ใช้งาน') && profile.includes(w === 1440 ? 'Discord: mind_sample' : 'แก้จากอุปกรณ์อื่น'), profile.replace(/\n/g, ' / '))
    const whole = await p.locator('#main').innerText()
    check(`[จริง] ${tag}: ไม่มีหมายเหตุของทีมงาน บทบาท หรือช่องให้แก้ชื่อ รหัสนักศึกษา บทบาท และสถานะ`,
      !whole.includes('หมายเหตุภายใน') && !/บทบาท|สิทธิ์/.test(whole) && (await p.locator('#main select, #main input[type="text"]').count()) === 0)
    if (w === 1440) {
      // แก้ช่องทางติดต่อ (Worker จริง)
      const edit = p.getByRole('button', { name: 'แก้ไขช่องทางติดต่อ' })
      await edit.click()
      check(`[จริง] ${tag}: กดแก้ไขช่องทางติดต่อแล้ว focus ไปที่ช่องกรอก พร้อมค่าเดิม`, (await p.evaluate(() => document.activeElement?.id)) === 'self-contact' && (await p.locator('#self-contact').inputValue()) === 'Discord: mind_sample')
      await p.locator('#self-contact').fill('LINE: mind_new')
      await p.getByRole('button', { name: 'บันทึก', exact: true }).click()
      await p.getByText('บันทึกช่องทางติดต่อแล้ว').waitFor()
      check(`[จริง] ${tag}: บันทึกช่องทางติดต่อสำเร็จ ค่าใหม่แสดงทันที และ focus กลับไปที่ปุ่มแก้ไข`,
        (await p.locator('.m-contact').innerText()).includes('LINE: mind_new') && (await p.evaluate(() => document.activeElement?.textContent?.includes('แก้ไขช่องทางติดต่อ'))))
      // รุ่นเก่า: แก้จากอีก session แล้วบันทึกจากหน้านี้
      const other = await newPage(1280, 800, member, 3)
      await other.goto(`${BASE}/member/account`)
      const me = await apiAs(other, '/api/member/me')
      await apiAs(other, '/api/member/me', { method: 'PATCH', body: { contact: 'แก้จากอุปกรณ์อื่น', expectedVersion: me.body.member.version } })
      await other.context().close()
      await p.getByRole('button', { name: 'แก้ไขช่องทางติดต่อ' }).click()
      await p.locator('#self-contact').fill('ค่าที่พิมพ์ค้างไว้')
      await p.getByRole('button', { name: 'บันทึก', exact: true }).click()
      await p.locator('#self-contact-error').waitFor()
      check(`[จริง] ${tag}: ข้อมูลถูกแก้จากที่อื่น: ไม่บันทึกทับ บอกค่าล่าสุด และสิ่งที่พิมพ์ไว้ยังอยู่ในช่อง`,
        (await p.locator('#self-contact-error').innerText()).includes('ถูกแก้ไขจากที่อื่น') && (await p.locator('#self-contact-error').innerText()).includes('แก้จากอุปกรณ์อื่น') &&
        (await p.locator('#self-contact').inputValue()) === 'ค่าที่พิมพ์ค้างไว้')
      await p.getByRole('button', { name: 'ยกเลิก' }).click()

      // เปลี่ยนรหัสผ่านเอง
      await p.locator('#password-current').fill(READY)
      await p.locator('#password-new').fill(READY)
      await p.locator('#password-confirm').fill(READY)
      await p.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน', exact: true }).click()
      const same = await p.locator('#password-new-error').innerText()
      await p.locator('#password-new').fill(OWN)
      await p.locator('#password-confirm').fill(OWN)
      await p.getByRole('button', { name: 'เปลี่ยนรหัสผ่าน', exact: true }).click()
      await p.getByText('เปลี่ยนรหัสผ่านแล้ว', { exact: true }).waitFor()
      check(`[จริง] ${tag}: เปลี่ยนรหัสผ่านเองได้ รหัสใหม่ที่ซ้ำกับรหัสเดิมถูกแจ้งก่อนส่ง หลังสำเร็จช่องถูกล้างและยังใช้งานต่อได้`,
        same === 'รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน' && (await p.locator('#password-current').inputValue()) === '' && (await apiAs(p, '/api/member/me')).status === 200)
      // session อื่นของบัญชีนี้ (อุปกรณ์อื่น) ถูกยกเลิกเมื่อเปลี่ยนรหัสผ่าน
      const elsewhere = await newPage(390, 844, member, 0)
      await elsewhere.goto(`${BASE}/member`)
      await elsewhere.waitForURL(`${BASE}/login?return=%2Fmember`)
      check(`[จริง] ${tag}: หลังเปลี่ยนรหัสผ่าน อุปกรณ์อื่นที่เข้าสู่ระบบค้างไว้ถูกออกจากระบบ`, elsewhere.url() === `${BASE}/login?return=%2Fmember`)
      await elsewhere.context().close()
    }
    const small = await smallTargets(p)
    check(`[จริง] ${tag}: ไม่ล้นจอ และทุกส่วนที่กดได้สูง ≥44px`, (await noOverflow(p)) && small.length === 0, JSON.stringify(small))
    if (w < 900) {
      const clear = await lastControlClear(p)
      check(`[จริง] ${tag}: ปุ่มท้ายฟอร์มและปุ่มออกจากระบบไม่ถูกเมนูด้านล่างบัง`, clear.ok, JSON.stringify(clear))
      // ช่องกรอกที่ได้ focus ไม่ถูกหัวเว็บหรือเมนูบัง
      await p.locator('#password-confirm').focus()
      const visible = await p.locator('#password-confirm').evaluate((el) => {
        const r = el.getBoundingClientRect()
        const header = document.querySelector('.m-header').getBoundingClientRect().bottom
        const bar = document.querySelector('.m-tabbar').getBoundingClientRect().top
        return r.top >= header && r.bottom <= bar
      })
      check(`[จริง] ${tag}: ช่องกรอกที่ได้ focus อยู่ระหว่างหัวเว็บกับเมนูด้านล่าง ไม่ถูกบัง`, visible)
      await p.evaluate(() => window.scrollTo(0, 0))
    }
    await shot(p, `member-account-${w}`, w >= 900)
    await p.context().close()
  }

  // ทุกหน้าของสมาชิก ทุกความกว้าง + แนวนอน
  for (const [w, h] of [[320, 568], [360, 740], [390, 844], [768, 1024], [1024, 768], [1440, 900], [844, 390]]) {
    const p = await memberPage(w, h, '0065002', OWN)
    await mockLibrary(p)
    const problems = []
    for (const [path, ready] of [['/member', '.file-card'], ['/member/activities', '.m-activity'], ['/member/files', '.file-card'], ['/member/files/file-sheet-0002', '.sheet-table'], ['/member/account', '.m-profile']]) {
      await p.goto(BASE + path)
      await p.locator(ready).first().waitFor()
      if (!(await noOverflow(p))) problems.push(`${path}: ล้นจอ`)
      const small = await smallTargets(p)
      if (small.length > 0) problems.push(`${path}: ${JSON.stringify(small)}`)
      if (path === '/member/files') {
        const searchRow = await searchRowOf(p)
        if (!searchRow.sameRow || !searchRow.after) problems.push(`${path}: ปุ่มค้นหาไม่อยู่บรรทัดเดียวกับช่องค้นหา ${JSON.stringify(searchRow)}`)
      }
      if (w < 900) {
        const clear = await lastControlClear(p)
        if (!clear.ok) problems.push(`${path}: ส่วนท้ายถูกบัง ${JSON.stringify(clear)}`)
      }
    }
    check(`[จริง+จำลองคลัง] หน้าของสมาชิกทั้งห้าหน้าที่ ${w}×${h}: ไม่ล้นจอ ส่วนที่กดได้สูง ≥44px และส่วนท้ายไม่ถูกเมนูบัง`, problems.length === 0, problems.join(' ; '))
    const navShown = { top: await p.locator('.m-nav').isVisible(), bottom: await p.locator('.m-tabbar').isVisible() }
    check(`[จริง] เมนูของสมาชิกที่ ${w}×${h}: แสดงชุดเดียว (${w >= 900 ? 'บนหัวเว็บ' : 'ด้านล่างของจอ'})`, navShown.top === (w >= 900) && navShown.bottom === (w < 900), JSON.stringify(navShown))
    if (h <= 480) {
      const bar = await p.locator('.m-tabbar').boundingBox()
      check(`[จริง] มือถือแนวนอน ${w}×${h}: เมนูด้านล่างเตี้ยลง (≤52px) แต่ยังแตะได้ ≥44px เหลือพื้นที่เนื้อหามากกว่าครึ่งจอ`, bar.height <= 52 && bar.height >= 44 && h - bar.height - (await p.locator('.m-header').boundingBox()).height > h / 2, String(bar.height))
    }
    if (h <= 480) {
      const tabs = await p.locator('.m-tab').evaluateAll((list) => list.map((tab) => {
        const icon = tab.querySelector('svg').getBoundingClientRect()
        const label = tab.querySelector('span').getBoundingClientRect()
        const box = tab.getBoundingClientRect()
        return {
          gap: Math.round(label.left - icon.right),
          offCentre: Math.round(Math.abs((icon.left + label.right) / 2 - (box.left + box.right) / 2)),
          level: Math.round(Math.abs((icon.top + icon.bottom) / 2 - (label.top + label.bottom) / 2)),
        }
      }))
      check(`[จริง] มือถือแนวนอน ${w}×${h}: ไอคอนกับชื่อเมนูอยู่ติดกันกลางปุ่ม ไม่ถูกแยกไปคนละฝั่งของปุ่ม`,
        tabs.length === 4 && tabs.every((t) => t.gap >= 0 && t.gap <= 12 && t.offCentre <= 2 && t.level <= 3), JSON.stringify(tabs))
    }
    if (w === 844) await shot(p, 'member-account-landscape-844', false)
    await p.context().close()
  }

  // ---------- ขอบเขตสิทธิ์ที่หน้าเว็บ ----------
  {
    const p = await memberPage(1280, 800, '0065002', OWN)
    for (const path of ['/', '/members', '/calendar', '/files', '/files/file-doc-0001', '/documents/new', '/forms', '/sources', '/team']) {
      await p.goto(BASE + path)
      await p.waitForURL(`${BASE}/member`)
    }
    check('[จริง] สมาชิกเปิด URL ของหลังบ้านตรง ๆ: ถูกพากลับไปหน้าแรกของสมาชิกทุกหน้า และไม่มีเมนูหลังบ้าน', p.url() === `${BASE}/member` && (await p.locator('.sidebar, .nav-link').count()) === 0)
    const denied = []
    for (const [method, path] of [['GET', '/api/members'], ['GET', '/api/users'], ['GET', '/api/sources'], ['GET', '/api/forms'], ['GET', '/api/sync'], ['GET', '/api/setup'], ['GET', '/api/documents'], ['POST', '/api/sync/sheets'], ['POST', '/api/google/connect'], ['POST', `/api/members/${actors.plain.id}/account/password`], ['PATCH', `/api/members/${actors.plain.id}`]]) {
      const res = await apiAs(p, path, { method, body: method === 'GET' ? undefined : { studentId: '6500004', password: 'Sneaky-Pass-0001' } })
      denied.push(`${method} ${path}=${res.status}:${res.body?.error}`)
    }
    check('[จริง] สมาชิก (บทบาทในทะเบียนเป็น “ทีมงาน”) เรียก API หลังบ้านตรง ๆ: 403 staff_only ทุกเส้นทาง รวมคำสั่งเปลี่ยนข้อมูล',
      denied.every((d) => d.endsWith('=403:staff_only')), denied.filter((d) => !d.endsWith('=403:staff_only')).join(' '))
    const meOther = await apiAs(p, `/api/member/me?id=${actors.plain.id}`)
    check('[จริง] ระบุรหัสสมาชิกคนอื่นใน URL ของ API ข้อมูลตนเอง: ยังได้เฉพาะข้อมูลของตัวเอง ไม่มีหมายเหตุของทีมงาน',
      meOther.body?.member?.name === 'ณิชา ตัวอย่างสุข' && !meOther.text.includes('หมายเหตุภายใน') && !meOther.text.includes('กฤตเมธ'))
    await p.context().close()

    const staff = await newPage(1280, 800, actors.staff)
    for (const path of ['/member', '/member/files', '/member/account', '/member/password']) {
      await staff.goto(BASE + path)
      await staff.waitForURL(`${BASE}/`)
    }
    check('[จริง] ทีมงานเปิดหน้าของสมาชิก: ถูกพากลับไปหลังบ้าน และ API ข้อมูลตนเองของสมาชิกตอบ 403 member_only',
      staff.url() === `${BASE}/` && (await apiAs(staff, '/api/member/me')).body?.error === 'member_only')
    // ค่า return ที่พยายามชี้ออกนอกเว็บ: ผู้ที่เข้าสู่ระบบอยู่แล้วถูกพาไปหน้าแรกของฝั่งตัวเองในเว็บนี้ และหน้าไม่ค้าง
    const outside = []
    for (const value of ['//evil.example/x', '/%5Cevil.example/x', 'https://evil.example/x']) {
      await staff.goto(`${BASE}/login?return=${value}`)
      const landed = await staff.waitForURL(`${BASE}/`, { timeout: 5000 }).then(() => true, () => false)
      outside.push({ value, landed, url: staff.url() })
    }
    check('[จริง] ค่า return ที่ชี้ออกนอกเว็บในลิงก์หน้าเข้าสู่ระบบ (// \\ และ URL เต็ม): ทีมงานที่เข้าสู่ระบบอยู่ถูกพาไปหลังบ้านของเว็บนี้ ไม่ออกนอกเว็บและหน้าไม่ค้าง',
      outside.every((o) => o.landed && o.url === `${BASE}/`), JSON.stringify(outside))
    await staff.context().close()
  }

  // ---------- ออกจากระบบ และ session ที่ถูกยกเลิก ----------
  {
    const p = await newPage(390, 844, actors.reset)
    await p.goto(`${BASE}/member/account`)
    await p.locator('.m-profile').waitFor()
    // ผู้ดูแลรีเซ็ตรหัสผ่านระหว่างที่สมาชิกเปิดหน้าอยู่
    const admin = await newPage(1280, 800, actors.admin)
    await admin.goto(`${BASE}/`)
    const reset = await apiAs(admin, `/api/members/${actors.reset.id}/account/password`, { method: 'POST', body: { studentId: '6500005', password: TEMP } })
    await admin.context().close()
    await p.getByRole('link', { name: 'กิจกรรม' }).click()
    const expired = p.locator('dialog[open]', { hasText: 'เซสชันหมดอายุ' })
    check('[จริง] ผู้ดูแลรีเซ็ตรหัสผ่าน: session เดิมของสมาชิกใช้ไม่ได้ทันที หน้าเว็บแจ้งให้เข้าสู่ระบบอีกครั้ง พร้อมจำหน้าที่จะกลับ',
      reset.status === 200 && (await appears(expired)) && (await expired.getByRole('link', { name: 'เข้าสู่ระบบอีกครั้ง' }).getAttribute('href')) === '/login?return=%2Fmember%2Factivities' &&
      (await apiAs(p, '/api/member/me')).status === 401)
    // กล่องนี้ปิดเองไม่ได้: ต้องไม่มีปุ่มปิดที่กดแล้วไม่เกิดอะไร และ Esc (ทั้งครั้งแรกและกดซ้ำ) ไม่ทำให้กล่องถูกปิดแม้ชั่วขณะ
    const closeButtons = await expired.getByRole('button', { name: 'ปิด' }).count()
    await p.evaluate(() => {
      window.__expiredClosed = 0
      document.querySelector('dialog[open]').addEventListener('close', () => window.__expiredClosed++)
    })
    await p.keyboard.press('Escape')
    await p.keyboard.press('Escape')
    // อ่านสถานะเมื่อกล่องเปิดอยู่และ focus อยู่ในกล่อง: ถ้าเบราว์เซอร์ปิดกล่องแล้วหน้าเว็บเปิดกลับ จะเห็นจากจำนวนครั้งที่ถูกปิด
    const settled = await p.waitForFunction(() => {
      const dialog = document.querySelector('dialog[open]')
      return !!dialog && dialog.contains(document.activeElement) && document.activeElement.textContent.trim() === 'เข้าสู่ระบบอีกครั้ง'
    }, null, { timeout: 3000 }).then(() => true, () => false)
    const closedTimes = await p.evaluate(() => window.__expiredClosed)
    check('[จริง] กล่อง “เซสชันหมดอายุ” ของสมาชิก: ไม่มีปุ่มปิดที่กดแล้วไม่เกิดอะไร กด Esc ซ้ำแล้วกล่องไม่ถูกปิดแม้ชั่วขณะ และ focus อยู่ที่ทางไปต่อทางเดียว (เข้าสู่ระบบอีกครั้ง)',
      closeButtons === 0 && settled && closedTimes === 0, JSON.stringify({ closeButtons, settled, closedTimes }))
    await shot(p, 'member-session-expired-390', false)
    await expired.getByRole('link', { name: 'เข้าสู่ระบบอีกครั้ง' }).click()
    await p.locator('#login-student-id').fill('6500005')
    await p.locator('#login-password').fill(TEMP)
    await p.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
    await p.waitForURL(`${BASE}/member/password`)
    check('[จริง] เข้าสู่ระบบด้วยรหัสที่ผู้ดูแลตั้งใหม่: ต้องเปลี่ยนรหัสผ่านก่อนเสมอ แม้มีหน้าที่จะกลับไป', p.url() === `${BASE}/member/password`)
    await p.getByRole('button', { name: 'ออกจากระบบ' }).click()
    await p.waitForURL(`${BASE}/login?loggedOut=1`)
    check('[จริง] ออกจากระบบจากหน้าตั้งรหัสผ่าน: ไปหน้าเข้าสู่ระบบพร้อมข้อความ “ออกจากระบบแล้ว” และ session ถูกยกเลิกที่ server',
      (await p.locator('p.notice').innerText()) === 'ออกจากระบบแล้ว' && (await apiAs(p, '/api/session')).body?.member === null)
    await p.context().close()

    const out = await memberPage(1440, 900, '0065002', OWN)
    await out.goto(`${BASE}/member`)
    await out.getByRole('heading', { name: /สวัสดี/ }).waitFor()
    // ออกจากระบบไม่สำเร็จ (เครือข่ายขาด): ต้องบอกและยังอยู่ในระบบ
    await out.route('**/auth/logout', (route) => route.abort())
    await out.route('**/api/session', (route) => route.abort())
    await out.getByRole('button', { name: 'ออกจากระบบ' }).click()
    const alert = out.locator('.m-alert')
    check('[จริง] ออกจากระบบไม่สำเร็จเพราะเชื่อมต่อไม่ได้: บอกว่ายืนยันไม่ได้ ไม่พาไปหน้าเข้าสู่ระบบ และปุ่มเปลี่ยนเป็นให้กดอีกครั้ง',
      (await appears(alert)) && (await alert.innerText()).includes('ยืนยันไม่ได้ว่าออกจากระบบแล้วหรือยัง') && out.url() === `${BASE}/member` && (await out.getByRole('button', { name: 'ออกจากระบบอีกครั้ง' }).isVisible()))
    await out.unroute('**/auth/logout')
    await out.unroute('**/api/session')
    await out.getByRole('button', { name: 'ออกจากระบบอีกครั้ง' }).click()
    await out.waitForURL(`${BASE}/login?loggedOut=1`)
    await out.goto(`${BASE}/member/files`)
    await out.waitForURL(`${BASE}/login?return=%2Fmember%2Ffiles`)
    check('[จริง] ออกจากระบบสำเร็จ: เปิดหน้าของสมาชิกอีกไม่ได้ ถูกพาไปหน้าเข้าสู่ระบบพร้อมจำหน้าที่จะกลับ', out.url() === `${BASE}/login?return=%2Fmember%2Ffiles`)
    await out.locator('#login-student-id').fill('0065002')
    await out.locator('#login-password').fill(OWN)
    await out.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
    await out.waitForURL(`${BASE}/member/files`)
    check('[จริง] เข้าสู่ระบบอีกครั้ง: กลับไปหน้าของสมาชิกที่ตั้งใจเปิด', out.url() === `${BASE}/member/files`)
    await out.context().close()
  }

  // ================= 4. ผู้ดูแล: รหัสนักศึกษาและบัญชีสมาชิก =================
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const tag = `บัญชีสมาชิก (ผู้ดูแล) ${w}px`
    const p = await newPage(w, h, actors.admin, w === 1440 ? 0 : 1)
    await p.goto(`${BASE}/members`)
    await p.locator('tbody tr').first().waitFor()
    check(`[จริง] ${tag}: รายชื่อแสดงรหัสนักศึกษาใต้ชื่อ (คงเลขศูนย์นำหน้า) และค้นด้วยรหัสนักศึกษาได้`,
      (await p.locator('tbody tr', { hasText: 'ณิชา ตัวอย่างสุข' }).locator('.member-student-id').innerText()) === 'รหัสนักศึกษา 0065002' &&
      (await p.locator('tbody tr', { hasText: 'อริสา ลองดู' }).locator('.member-student-id').count()) === (w === 1440 ? 0 : 1))
    await p.locator('#member-search').fill('65000')
    await p.waitForFunction(() => document.querySelectorAll('tbody tr').length === 2)
    await p.locator('#member-search').fill('')

    let dialog
    if (w === 1440) {
      // สมาชิกที่ยังไม่มีรหัสนักศึกษา
      await p.getByRole('button', { name: 'ดูรายละเอียด อริสา ลองดู' }).click()
      dialog = p.locator('dialog[open]')
      await dialog.locator('.account-section').waitFor()
      check(`[จริง] ${tag}: สมาชิกที่ยังไม่มีรหัสนักศึกษา: ข้อมูลอยู่ครบ สถานะ “ยังไม่ได้เปิดบัญชี” ปุ่มตั้งรหัสกดไม่ได้ พร้อมเหตุผลและทางแก้`,
        (await dialog.locator('.account-section .badge').innerText()) === 'ยังไม่ได้เปิดบัญชี' && (await dialog.getByRole('button', { name: 'ตั้งรหัสผ่านและเปิดบัญชี' }).isDisabled()) &&
        (await dialog.getByText('สมาชิกนี้ยังไม่มีรหัสนักศึกษา จึงเปิดบัญชีไม่ได้ กด “แก้ไข” แล้วกรอกรหัสนักศึกษาก่อน').isVisible()))
      // กรอกรหัสนักศึกษาจากฟอร์มแก้ไข
      await dialog.getByRole('button', { name: 'แก้ไข', exact: true }).click()
      await p.locator('#member-student-id').fill('65 00009')
      await p.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
      const invalid = await p.locator('#member-student-id-error').innerText()
      await p.locator('#member-student-id').fill(w === 1440 ? '0065002' : '6500004')
      await p.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
      await p.locator('#member-student-id-error', { hasText: 'มีสมาชิกคนอื่นใช้อยู่แล้ว' }).waitFor()
      const duplicate = await p.locator('#member-student-id-error').innerText()
      check(`[จริง] ${tag}: ฟอร์มแก้สมาชิก: รหัสผิดรูปแบบถูกแจ้งที่ช่องก่อนส่ง รหัสซ้ำกับคนอื่นถูก server ปฏิเสธและแจ้งที่ช่องเดียวกัน ค่าที่กรอกยังอยู่`,
        invalid.includes('ไม่มีช่องว่าง') && duplicate.includes('รหัสนักศึกษานี้มีสมาชิกคนอื่นใช้อยู่แล้ว') && (await p.locator('#member-name').inputValue()) === 'อริสา ลองดู' &&
        (await p.evaluate(() => document.activeElement?.id)) === 'member-student-id', `${invalid} | ${duplicate}`)
      const newId = w === 1440 ? '0012399' : '0012400'
      await p.locator('#member-student-id').fill(newId)
      await p.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
      await p.getByText('บันทึกการแก้ไข “อริสา ลองดู” แล้ว').waitFor()
      check(`[จริง] ${tag}: บันทึกรหัสนักศึกษาแล้วแสดงในรายชื่อตามที่พิมพ์ (คงเลขศูนย์นำหน้า)`,
        (await p.locator('tbody tr', { hasText: 'อริสา ลองดู' }).locator('.member-student-id').innerText()) === `รหัสนักศึกษา ${newId}`)

    } else {
      // จอแคบ: ฟอร์มแก้สมาชิกที่มีช่องรหัสนักศึกษา ไม่ล้นจอ และข้อความผิดพลาดของช่องอยู่ใต้ช่องนั้น
      await p.getByRole('button', { name: 'ดูรายละเอียด อริสา ลองดู' }).click()
      await p.locator('dialog[open]').getByRole('button', { name: 'แก้ไข', exact: true }).click()
      await p.locator('#member-student-id').fill('65 00009')
      await p.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
      const error = p.locator('#member-student-id-error')
      const below = (await error.boundingBox()).y >= (await p.locator('#member-student-id').boundingBox()).y + 40
      const formSmall = await smallTargets(p, 'dialog[open]')
      check(`[จริง] ${tag}: ฟอร์มแก้สมาชิกบนจอแคบ: ข้อความผิดพลาดของรหัสนักศึกษาอยู่ใต้ช่อง ไม่ล้นจอ และทุกส่วนที่กดได้สูง ≥44px`, below && (await noOverflow(p)) && formSmall.length === 0, JSON.stringify(formSmall))
      await p.getByRole('button', { name: 'ยกเลิก' }).click()
      await p.getByRole('button', { name: 'ทิ้งการแก้ไข' }).click()
      await p.locator('dialog[open] .account-section').waitFor()
      await p.keyboard.press('Escape')
      await gone(p.locator('dialog[open]'))
    }

    // เปิดบัญชี
    await p.getByRole('button', { name: 'ดูรายละเอียด กฤตเมธ ตัวอย่างเกม' }).click()
    dialog = p.locator('dialog[open]')
    await dialog.locator('.account-section').waitFor()
    const openButton = dialog.getByRole('button', { name: /^ตั้งรหัสผ่านและเปิดบัญชี/ })
    const stateBefore = await dialog.locator('.account-section .badge').innerText()
    if (w === 1440) {
      check(`[จริง] ${tag}: สมาชิกที่มีรหัสนักศึกษา: มีปุ่ม “ตั้งรหัสผ่านและเปิดบัญชี” และยังไม่มีรหัสที่ใช้เข้าสู่ระบบ`, stateBefore === 'ยังไม่ได้เปิดบัญชี' && (await openButton.isEnabled()))
      await shot(p, 'admin-member-account-1440', false)
      await openButton.click()
      dialog = p.locator('dialog[open]')
      await dialog.getByRole('heading', { name: 'ตั้งรหัสผ่านและเปิดบัญชี' }).waitFor()
      check(`[จริง] ${tag}: กล่องตั้งรหัสแสดงชื่อและรหัสนักศึกษาให้ตรวจ ช่องรหัสผ่านว่าง (ไม่ใช้รหัสนักศึกษาเป็นค่าเริ่มต้น) และ focus อยู่ที่ปุ่มสร้างรหัสสุ่ม`,
        (await dialog.locator('.account-identity').innerText()).includes('กฤตเมธ ตัวอย่างเกม') && (await dialog.locator('.account-login-id').innerText()) === '6500004' &&
        (await p.locator('#account-password').inputValue()) === '' && (await p.evaluate(() => document.activeElement?.textContent?.includes('สร้างรหัสสุ่ม'))))
      await dialog.getByRole('button', { name: 'เปิดบัญชี', exact: true }).click()
      const blank = await p.locator('#account-password-error').innerText()
      await p.locator('#account-password').fill('6500004')
      await p.locator('#account-password-confirm').fill('6500004')
      await dialog.getByRole('button', { name: 'เปิดบัญชี', exact: true }).click()
      const short = await p.locator('#account-password-error').innerText()
      await p.locator('#account-password').fill('Good-Temp-Pass-1')
      await p.locator('#account-password-confirm').fill('Good-Temp-Pass-2')
      await dialog.getByRole('button', { name: 'เปิดบัญชี', exact: true }).click()
      const mismatch = await p.locator('#account-password-confirm-error').innerText()
      check(`[จริง] ${tag}: ตรวจที่ช่อง: ว่าง สั้นเกิน และยืนยันไม่ตรง ถูกแจ้งก่อนส่ง ค่าที่กรอกยังอยู่`,
        blank === 'กรอกรหัสผ่านชั่วคราว' && short.includes('อย่างน้อย 10 ตัวอักษร') && mismatch === 'รหัสผ่านสองช่องไม่ตรงกัน' && (await p.locator('#account-password').inputValue()) === 'Good-Temp-Pass-1')
      // สร้างรหัสสุ่มสองครั้ง: ไม่ซ้ำกัน แสดงให้อ่านได้ และกรอกทั้งสองช่อง
      await dialog.getByRole('button', { name: 'สร้างรหัสสุ่ม' }).click()
      const first = await p.locator('#account-password').inputValue()
      await dialog.getByRole('button', { name: 'สร้างรหัสสุ่ม' }).click()
      const second = await p.locator('#account-password').inputValue()
      check(`[จริง] ${tag}: “สร้างรหัสสุ่ม” ได้รหัส 16 ตัวที่ไม่ซ้ำกันแต่ละครั้ง กรอกทั้งสองช่อง และแสดงให้ผู้ดูแลอ่านได้`,
        /^[A-HJ-NP-Za-km-z2-9]{4}(-[A-HJ-NP-Za-km-z2-9]{4}){3}$/.test(first) && first !== second && (await p.locator('#account-password-confirm').inputValue()) === second &&
        (await p.locator('#account-password').getAttribute('type')) === 'text', `${first} ${second}`)
      await shot(p, 'admin-set-password-1440', false)
      await dialog.getByRole('button', { name: 'เปิดบัญชี', exact: true }).click()
      await p.locator('dialog[open]').getByRole('heading', { name: 'ตั้งรหัสผ่านแล้ว' }).waitFor()
      dialog = p.locator('dialog[open]')
      check(`[จริง] ${tag}: เปิดบัญชีสำเร็จ (Argon2id จริง): แสดงรหัสชั่วคราวให้ส่งต่อพร้อมปุ่มคัดลอก และบอกว่าปิดแล้วดูอีกไม่ได้ และระบบไม่ส่งข้อความให้สมาชิก`,
        (await dialog.locator('.account-temp-value').innerText()) === second && (await dialog.getByRole('button', { name: 'คัดลอกรหัสผ่าน' }).isVisible()) &&
        (await dialog.getByText('หลังปิดกล่องนี้จะดูรหัสนี้อีกไม่ได้').isVisible()) && (await dialog.getByText('ระบบไม่ส่งข้อความหรืออีเมลให้สมาชิก').isVisible()))
      await shot(p, 'admin-set-password-done-1440', false)
      await dialog.getByRole('button', { name: 'เสร็จสิ้น' }).click()
      dialog = p.locator('dialog[open]')
      await dialog.locator('.account-section .badge', { hasText: 'ต้องเปลี่ยนรหัสผ่าน' }).waitFor()
      check(`[จริง] ${tag}: กลับมาที่รายละเอียดสมาชิกคนเดิม สถานะเป็น “ต้องเปลี่ยนรหัสผ่าน” มีปุ่มรีเซ็ตรหัสผ่านและปิดบัญชี และไม่มีรหัสผ่านค้างอยู่ในหน้า`,
        (await dialog.getByRole('button', { name: 'รีเซ็ตรหัสผ่าน' }).isVisible()) && (await dialog.getByRole('button', { name: 'ปิดบัญชี' }).isVisible()) &&
        !(await p.locator('body').innerText()).includes(second) && (await dialog.locator('.account-section .notice-success').innerText()) === 'เปิดบัญชีของ “กฤตเมธ ตัวอย่างเกม” แล้ว')
      const list = await apiAs(p, '/api/members')
      check(`[จริง] ${tag}: รายชื่อสมาชิกจาก API ไม่มีรหัสผ่าน hash หรือ salt`, list.status === 200 && !list.text.includes(second) && !/argon2|password_hash|"hash"|salt/i.test(list.text))

      // สมาชิกเข้าสู่ระบบด้วยรหัสที่เพิ่งตั้ง
      const m = await newPage(390, 844)
      await memberLogin(m, '6500004', second)
      await m.waitForURL(`${BASE}/member/password`)
      check(`[จริง] ${tag}: สมาชิกเข้าสู่ระบบด้วยรหัสสุ่มที่ผู้ดูแลตั้งได้ และถูกบังคับเปลี่ยนรหัสทันที`, m.url() === `${BASE}/member/password`)
      const session = await apiAs(m, '/api/session')

      // ปิดบัญชี
      await dialog.getByRole('button', { name: 'ปิดบัญชี' }).click()
      const confirm = p.locator('dialog[open]')
      await confirm.getByRole('heading', { name: 'ปิดบัญชีของ “กฤตเมธ ตัวอย่างเกม”?' }).waitFor()
      check(`[จริง] ${tag}: ปิดบัญชีต้องยืนยันก่อน บอกผลที่จะเกิด และ focus เริ่มที่ปุ่มยกเลิก`,
        (await confirm.getByText('ข้อมูลในทะเบียนสมาชิกไม่ถูกลบหรือแก้ไข').isVisible()) && (await p.evaluate(() => document.activeElement?.textContent?.trim())) === 'ยกเลิก')
      await confirm.getByRole('button', { name: 'ปิดบัญชี', exact: true }).click()
      dialog = p.locator('dialog[open]')
      await dialog.locator('.account-section .badge', { hasText: 'ปิดบัญชี' }).waitFor()
      const after = await apiAs(m, '/api/session')
      check(`[จริง] ${tag}: ปิดบัญชีแล้ว session ของสมาชิกใช้ไม่ได้ทันที ผลแสดงในกล่องรายละเอียด และปุ่มเปลี่ยนเป็นตั้งรหัสผ่านและเปิดบัญชีอีกครั้ง`,
        session.body?.member?.studentId === '6500004' && after.body?.member === null && (await dialog.getByRole('button', { name: 'ตั้งรหัสผ่านและเปิดบัญชีอีกครั้ง' }).isVisible()) &&
        (await dialog.locator('.account-section .notice-success').innerText()) === 'ปิดบัญชีของ “กฤตเมธ ตัวอย่างเกม” แล้ว')
      await m.context().close()
      await p.keyboard.press('Escape')
      await gone(p.locator('dialog[open]'))
      check(`[จริง] ${tag}: ปิดกล่องรายละเอียดด้วย Esc แล้ว focus กลับไปที่ปุ่มของแถวเดิม`, await p.evaluate(() => document.activeElement?.getAttribute('aria-label') === 'ดูรายละเอียด กฤตเมธ ตัวอย่างเกม'))
    } else {
      // จอแคบ: กล่องรายละเอียดและกล่องตั้งรหัส (บัญชีถูกปิดไปแล้วจากรอบจอกว้าง)
      check(`[จริง] ${tag}: บัญชีที่ปิดแล้วแสดงสถานะ “ปิดบัญชี” และมีปุ่มเปิดอีกครั้ง`, stateBefore === 'ปิดบัญชี' && (await openButton.isVisible()))
      const small = await smallTargets(p, 'dialog[open]')
      check(`[จริง] ${tag}: กล่องรายละเอียดไม่ล้นจอ และทุกส่วนที่กดได้สูง ≥44px`, (await noOverflow(p)) && small.length === 0, JSON.stringify(small))
      await shot(p, 'admin-member-account-390', false)
      await openButton.click()
      dialog = p.locator('dialog[open]')
      await dialog.getByRole('button', { name: 'สร้างรหัสสุ่ม' }).click()
      const dialogSmall = await smallTargets(p, 'dialog[open]')
      const fits = await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= window.innerWidth)
      check(`[จริง] ${tag}: กล่องตั้งรหัสผ่านไม่ล้นจอ รหัสสุ่มอ่านได้ครบ และทุกส่วนที่กดได้สูง ≥44px`, fits && (await noOverflow(p)) && dialogSmall.length === 0, JSON.stringify(dialogSmall))
      await shot(p, 'admin-set-password-390', false)
      await dialog.getByRole('button', { name: 'ยกเลิก' }).click()
      await p.locator('dialog[open] .account-section').waitFor()
      check(`[จริง] ${tag}: ยกเลิกกล่องตั้งรหัสแล้วกลับมาที่รายละเอียดของสมาชิกคนเดิม บัญชีไม่เปลี่ยน`, (await p.locator('dialog[open] .account-section .badge').innerText()) === 'ปิดบัญชี')
      await p.keyboard.press('Escape')
    }
    await p.context().close()
  }

  // รหัสนักศึกษาเปลี่ยนหลังเปิดบัญชี: รอผู้ดูแลยืนยัน
  {
    const p = await newPage(1440, 900, actors.admin)
    await p.goto(`${BASE}/members`)
    await p.locator('tbody tr').first().waitFor()
    await p.getByRole('button', { name: 'ดูรายละเอียด ณิชา ตัวอย่างสุข' }).click()
    await p.locator('dialog[open]').getByRole('button', { name: 'แก้ไข', exact: true }).click()
    check('[จริง] ฟอร์มแก้สมาชิกที่มีบัญชีแล้ว: บอกว่าแก้รหัสที่นี่ยังไม่เปลี่ยนรหัสที่ใช้เข้าสู่ระบบ', (await p.locator('#member-student-id-hint').innerText()).includes('ยังไม่เปลี่ยนรหัสที่ใช้เข้าสู่ระบบ'))
    await p.locator('#member-student-id').fill('0065999')
    await p.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
    await p.getByText('บันทึกการแก้ไข “ณิชา ตัวอย่างสุข” แล้ว').waitFor()
    await p.getByRole('button', { name: 'ดูรายละเอียด ณิชา ตัวอย่างสุข' }).click()
    let dialog = p.locator('dialog[open]')
    await dialog.locator('.account-section').waitFor()
    check('[จริง] แก้รหัสนักศึกษาของสมาชิกที่มีบัญชี: ทะเบียนเปลี่ยน แต่รหัสที่ใช้เข้าสู่ระบบยังเป็นค่าเดิม พร้อมคำอธิบายและปุ่มให้ผู้ดูแลยืนยัน',
      (await dialog.locator('.account-section').innerText()).includes('รหัสนักศึกษาในทะเบียน (0065999) ไม่ตรงกับรหัสที่บัญชีนี้ใช้เข้าสู่ระบบ (0065002)') &&
      (await dialog.getByRole('button', { name: 'ยืนยันใช้รหัส 0065999 เข้าสู่ระบบ' }).isVisible()))
    const old = await newPage(390, 844)
    await memberLogin(old, '0065002', OWN)
    await old.waitForURL(`${BASE}/member`)
    await old.goto(`${BASE}/member/account`)
    await old.locator('.m-profile').waitFor()
    check('[จริง] ก่อนผู้ดูแลยืนยัน: สมาชิกยังเข้าด้วยรหัสเดิมได้ และหน้าบัญชีบอกว่ายังใช้รหัสเดิมเข้าสู่ระบบ',
      (await old.locator('.m-profile').innerText()).includes('ตอนนี้ยังเข้าสู่ระบบด้วยรหัส 0065002'))
    await dialog.getByRole('button', { name: 'ยืนยันใช้รหัส 0065999 เข้าสู่ระบบ' }).click()
    const confirm = p.locator('dialog[open]')
    await confirm.getByRole('heading', { name: 'ยืนยันเปลี่ยนรหัสที่ใช้เข้าสู่ระบบ?' }).waitFor()
    await confirm.getByRole('button', { name: 'ใช้รหัส 0065999' }).click()
    dialog = p.locator('dialog[open]')
    await dialog.locator('.account-section').waitFor()
    await p.waitForFunction(() => !document.querySelector('dialog[open] .account-section')?.textContent.includes('ไม่ตรงกับรหัสที่บัญชีนี้ใช้'))
    const after = await apiAs(old, '/api/session')
    await old.context().close()
    const fresh = await newPage(390, 844)
    await memberLogin(fresh, '0065002', OWN)
    const oldRejected = await appears(fresh.locator('.login-card .form-alert'))
    await fresh.locator('#login-student-id').fill('0065999')
    await fresh.getByRole('button', { name: 'เข้าสู่ระบบ', exact: true }).click()
    await fresh.waitForURL(`${BASE}/member`)
    check('[จริง] หลังผู้ดูแลยืนยัน: session เดิมถูกยกเลิก รหัสเดิมเข้าไม่ได้ รหัสใหม่เข้าได้ด้วยรหัสผ่านเดิม และยังเป็นบัญชีของสมาชิกคนเดิม',
      after.body?.member === null && oldRejected && (await apiAs(fresh, '/api/session')).body?.member?.id === actors.ready.id)
    await fresh.context().close()
    await p.context().close()
  }

  // ทีมงานทั่วไป: เห็นสถานะบัญชี แต่จัดการไม่ได้
  {
    const p = await newPage(1440, 900, actors.staff)
    await p.goto(`${BASE}/members`)
    await p.locator('tbody tr').first().waitFor()
    await p.getByRole('button', { name: 'ดูรายละเอียด ภูมิ ทดสอบระบบ' }).click()
    const dialog = p.locator('dialog[open]')
    await dialog.locator('.account-section').waitFor()
    const res = await apiAs(p, `/api/members/${actors.first.id}/account/password`, { method: 'POST', body: { studentId: '6512345', password: 'Staff-Try-Pass-01' } })
    check('[จริง] ทีมงานทั่วไป: เห็นสถานะบัญชี แต่ไม่มีปุ่มตั้งรหัส/ปิดบัญชี มีคำอธิบายว่าเฉพาะผู้ดูแล และเรียก API ตรง ๆ ได้ 403',
      (await dialog.locator('.account-section .badge').count()) === 1 && (await dialog.locator('.account-section button').count()) === 0 &&
      (await dialog.getByText('ทำได้เฉพาะผู้ดูแลระบบ').isVisible()) && res.status === 403)
    await p.context().close()
  }

  // ================= 5. หลังบ้าน: ไฟล์ชมรม =================
  for (const [w, h, theme] of [[1440, 900, 'light'], [390, 844, 'light'], [1440, 900, 'dark']]) {
    const tag = `[จำลองคลัง] ไฟล์ชมรมของทีมงาน ${w}px${theme === 'dark' ? ' ธีมมืด' : ''}`
    const p = await newPage(w, h, actors.admin, 0, { theme })
    await mockLibrary(p, { audience: 'staff' })
    await p.goto(`${BASE}/files`)
    await p.locator('.file-card').first().waitFor()
    check(`${tag}: เมนู “ไฟล์ชมรม” อยู่ในเมนูใช้งานประจำ ส่วน “แหล่งข้อมูล” และ “ทีมงาน” แยกอยู่ในกลุ่มตั้งค่า`,
      w < 1024 || ((await p.locator('.sidebar .nav-link.active .nav-label').innerText()) === 'ไฟล์ชมรม' && (await p.locator('.sidebar .nav-group').innerText()) === 'ตั้งค่า' &&
        (await p.locator('.sidebar .nav-group + .nav-list .nav-label').allInnerTexts()).join(',') === 'แหล่งข้อมูล,ทีมงาน' && (await p.locator('.sidebar .nav-label', { hasText: /^เอกสาร$/ }).count()) === 0))
    check(`${tag}: บอกทีมงานตรง ๆ ว่าสมาชิกเปิดดูไฟล์ทุกไฟล์ในหน้านี้ได้ รวมชีตทะเบียนและคำตอบฟอร์ม และมีปุ่มสร้างเอกสาร`,
      (await p.locator('.library-visibility').innerText()).includes('สมาชิกที่เข้าสู่ระบบด้วยรหัสนักศึกษาเปิดดูไฟล์ทุกไฟล์ในหน้านี้ได้') && (await p.getByRole('link', { name: 'สร้างเอกสาร' }).getAttribute('href')) === '/documents/new')
    const small = await smallTargets(p, '#main')
    check(`${tag}: ไม่ล้นจอ${w < 1024 ? ' และทุกส่วนที่กดได้สูง ≥44px' : ''}`, (await noOverflow(p)) && (w >= 1024 || small.length === 0), JSON.stringify(small))
    const searchRow = await searchRowOf(p)
    check(`${tag}: ปุ่ม “ค้นหา” อยู่บรรทัดเดียวกับช่องค้นหา แม้แถบเครื่องมือถูกห่อบรรทัด`, searchRow.sameRow && searchRow.after, JSON.stringify(searchRow))
    if (theme === 'dark') {
      const dark = { name: await contrast(p, '.file-name'), meta: await contrast(p, '.file-meta'), tag: await contrast(p, '.file-tag') }
      check(`${tag}: contrast ของชื่อไฟล์ ข้อมูลประกอบ และป้าย ≥4.5:1`, Object.values(dark).every((v) => v >= 4.5), JSON.stringify(dark))
    }
    await shot(p, `staff-files-${w}${theme === 'dark' ? '-dark' : ''}`, false)
    await p.locator('.file-card', { hasText: 'แผนงานชมรม ภาคเรียนที่ 1' }).locator('.file-name').click()
    await p.waitForURL(`${BASE}/files/file-doc-0001`)
    await p.locator('.pdf-page canvas').first().waitFor({ timeout: 20000 })
    const edit = p.getByRole('link', { name: /แก้ไขใน Google Docs/ })
    check(`${tag}: ตัวอย่างไฟล์ของทีมงานมีปุ่ม “แก้ไขใน Google Docs” เปิดแท็บใหม่ด้วยลิงก์ของ Google และบอกว่าสิทธิ์แก้ขึ้นกับบัญชี Google ของคนนั้น`,
      (await edit.getAttribute('href')) === 'https://drive.google.com/file/d/file-doc-0001/view?usp=drivesdk' && (await edit.getAttribute('target')) === '_blank' && (await edit.getAttribute('rel')) === 'noopener noreferrer' &&
      (await p.getByText('ใช้สิทธิ์ของบัญชี Google ที่คุณล็อกอินในเบราว์เซอร์').isVisible()) && (await noOverflow(p)))
    if (theme === 'light') await shot(p, `staff-preview-${w}`, false)
    await p.context().close()
  }
  {
    // ยังไม่ได้เปิดใช้คลัง: ผู้ดูแลมีปุ่มขอสิทธิ์ ทีมงานทั่วไปไม่มี
    const admin = await newPage(1440, 900, actors.admin)
    await mockLibrary(admin, { audience: 'staff', mode: { list: 'missing_scope' } })
    let connectBody = null
    await admin.route('**/api/google/connect', (route) => {
      connectBody = route.request().postDataJSON()
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'google_not_configured', message: 'เว็บไซต์ยังไม่ได้ตั้งค่าการเชื่อม Google' }) })
    })
    await admin.goto(`${BASE}/files`)
    await admin.getByText('ยังไม่ได้เปิดใช้คลังไฟล์ Google').first().waitFor()
    await admin.getByRole('button', { name: 'เปิดใช้คลังไฟล์ Google' }).click()
    await admin.locator('.library-setup .form-alert').waitFor()
    check('[จำลองคลัง] ยังไม่ได้เปิดใช้คลัง (ผู้ดูแล): บอกว่าต้องอนุญาตอ่านไฟล์ของชมรม ไม่แสดงเป็นไม่มีไฟล์ ปุ่มขอสิทธิ์ส่งคำขอบริการ library และข้อผิดพลาดแสดงในหน้า',
      (await admin.getByText(/ยังไม่มีไฟล์ในคลัง/).count()) === 0 && connectBody?.service === 'library' && connectBody?.returnTo === '/files' &&
      (await admin.locator('.library-setup .form-alert').innerText()).includes('ยังไม่ได้ตั้งค่าการเชื่อม Google'))
    await shot(admin, 'staff-files-not-enabled-1440', false)
    await admin.context().close()
    const staff = await newPage(1440, 900, actors.staff)
    await mockLibrary(staff, { audience: 'staff', mode: { list: 'missing_scope' } })
    await staff.goto(`${BASE}/files`)
    await staff.getByText('ยังไม่ได้เปิดใช้คลังไฟล์ Google').first().waitFor()
    check('[จำลองคลัง] ยังไม่ได้เปิดใช้คลัง (ทีมงานทั่วไป): ไม่มีปุ่มขอสิทธิ์ บอกให้ผู้ดูแลเป็นคนเปิดใช้',
      (await staff.getByRole('button', { name: 'เปิดใช้คลังไฟล์ Google' }).count()) === 0 && (await staff.getByText('ให้ผู้ดูแลระบบเปิดหน้านี้แล้วกด “เปิดใช้คลังไฟล์ Google”').isVisible()))
    await staff.context().close()

    // คลังจริงของ Worker ในเครื่องนี้ (ไม่ได้เชื่อม Google)
    const real = await newPage(1440, 900, actors.admin)
    await real.goto(`${BASE}/files`)
    check('[จริง] ไฟล์ชมรมกับ Worker จริงที่ยังไม่ได้เชื่อม Google: บอกว่าคลังยังไม่พร้อมและพาไปดูสถานะการเชื่อม ไม่แสดงเป็นรายการว่าง',
      (await appears(real.getByText('คลังไฟล์ยังไม่พร้อมใช้งาน'))) && (await real.getByRole('link', { name: 'ดูสถานะการเชื่อม Google' }).isVisible()) && (await real.getByText(/ยังไม่มีไฟล์ในคลัง/).count()) === 0)
    await real.goto(`${BASE}/documents`)
    await real.waitForURL(`${BASE}/files`)
    check('[จริง] ลิงก์หน้าเอกสารเดิม (/documents) พามาที่หน้าไฟล์ชมรม', real.url() === `${BASE}/files`)
    await real.goto(`${BASE}/sources`)
    await real.locator('.library-card').waitFor()
    check('[จริง] หน้าแหล่งข้อมูลมีการ์ด “คลังไฟล์ชมรม” แยกจากแหล่งข้อมูลที่ซิงค์ และบอกสถานะตามจริง',
      (await real.locator('.library-card .badge').innerText()) === 'ยังไม่ได้เปิดใช้' && (await real.locator('.library-card').innerText()).includes('แยกจากชีต ปฏิทิน และฟอร์มที่ซิงค์ด้านล่าง'))
    await real.context().close()
  }

  // ================= 6. Google Picker: ลำดับการทำงานของหน้าเว็บ (ตัวจำลองในเบราว์เซอร์) =================
  // ทุกข้อในส่วนนี้ใช้สคริปต์จำลองแทนสคริปต์ของ Google: ตรวจได้เฉพาะสิ่งที่หน้าเว็บทำ ไม่ได้พิสูจน์พฤติกรรมของหน้าต่าง Google จริง
  {
    const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
    const unlinked = (kind) => ({ kind, linked: kind === 'docs', resource: null, syncing: false, lastSuccessAt: null, lastAttemptAt: null, error: null, retryAt: null, issues: [], dataVersion: 1 })
    const pickerPage = async (options = {}) => {
      const p = await newPage(1440, 900, actors.admin)
      await p.addInitScript(() => {
        window.__picker = { scripts: [], loads: [], tokenRequests: [], instances: [], open: 0, disposed: 0, tokenMode: 'ok' }
      })
      const state = { blockScripts: options.blockScripts === true }
      const stub = (body) => (route) => (state.blockScripts ? route.abort() : route.fulfill({ status: 200, contentType: 'text/javascript', body }))
      await p.route('https://apis.google.com/js/api.js', stub(`
        window.__picker.scripts.push('api')
        window.gapi = { load(name, options) {
          window.__picker.loads.push(name)
          window.google = window.google || {}
          const state = window.__picker
          window.google.picker = {
            Action: { PICKED: 'picked', CANCEL: 'cancel' }, DocsViewMode: { LIST: 'list' },
            DocsView: class { setMimeTypes() { return this } setIncludeFolders() { return this } setSelectFolderEnabled() { return this } setMode() { return this } },
            PickerBuilder: class {
              addView() { return this } setOAuthToken(token) { this.token = token; return this } setDeveloperKey() { return this } setAppId() { return this } setLocale() { return this }
              setCallback(callback) { this.callback = callback; return this }
              build() {
                const builder = this
                const element = document.createElement('div')
                element.className = 'stub-picker'
                element.setAttribute('role', 'dialog')
                element.textContent = 'ตัวจำลองหน้าต่างเลือกไฟล์'
                const instance = {
                  token: builder.token,
                  setVisible(visible) { if (visible) { document.body.appendChild(element); state.open++ } else if (element.isConnected) { element.remove(); state.open-- } },
                  dispose() { if (element.isConnected) { element.remove(); state.open-- } state.disposed++ },
                  pick() { builder.callback({ action: 'picked', docs: [{ id: 'picked-file-0001', name: 'ชีตที่เลือก' }] }) },
                  cancel() { builder.callback({ action: 'cancel' }) },
                }
                state.instances.push(instance)
                return instance
              }
            },
          }
          setTimeout(() => options.callback(), 0)
        } }
      `))
      await p.route('https://accounts.google.com/gsi/client', stub(`
        window.__picker.scripts.push('gsi')
        window.google = window.google || {}
        window.google.accounts = { oauth2: { initTokenClient(config) {
          return { requestAccessToken() {
            // บันทึกว่าคำขอสิทธิ์เกิดขณะเบราว์เซอร์ยังถือว่าเป็นการกดของผู้ใช้หรือไม่
            window.__picker.tokenRequests.push({ active: navigator.userActivation ? navigator.userActivation.isActive : null, hint: config.hint, scope: config.scope })
            const mode = window.__picker.tokenMode
            setTimeout(() => (mode === 'ok' ? config.callback({ access_token: 'stub-access-token', expires_in: 3600 }) : config.error_callback({ type: mode })), 30)
          } }
        } } }
      `))
      await p.route('**/api/sources', (route) => route.fulfill({ json: { google: { status: 'connected', expectedEmail: 'muesport2567@gmail.com', email: 'muesport2567@gmail.com', connectedAt: iso(600), lastCheckedAt: iso(5), lastError: null, missingConfig: [] }, resources: [{ id: 'docs', status: 'ready' }, { id: 'sheets', status: 'not_selected', resourceName: null }, { id: 'calendar', status: 'not_selected', resourceName: null }, { id: 'forms', status: 'not_selected', resourceName: null }, { id: 'excel', status: 'disabled' }] } }))
      await p.route('**/api/sync', (route) => route.fulfill({ json: { sync: ['sheets', 'calendar', 'forms', 'docs'].map(unlinked) } }))
      await p.route('**/api/setup', (route) => route.fulfill({ json: { scopes: { driveFile: true, calendarCreated: false, calendarExisting: false, library: false }, studentIdColumn: null, picker: { configured: true, missing: [], apiKey: 'stub-key', appId: '1', clientId: 'stub-client' }, local: { members: 0, events: 0 }, operations: [], sync: ['sheets', 'calendar', 'forms', 'docs'].map(unlinked) } }))
      await p.route('**/api/setup/preview', (route) => route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ error: 'file_not_granted', message: 'ตัวจำลอง: ยังไม่ได้เชื่อม' }) }))
      await p.goto(`${BASE}/sources`)
      await p.locator('.resource-row[data-resource="sheets"] .button').first().waitFor()
      return { p, state }
    }
    const button = (p) => p.locator('.resource-row[data-resource="sheets"]').getByRole('button', { name: /เลือกชีตที่มีอยู่|หน้าต่างเลือกไฟล์ของ Google เปิดอยู่/ })
    const stateOf = (p) => p.evaluate(() => ({ ...window.__picker, instances: window.__picker.instances.length }))

    {
      const { p } = await pickerPage()
      await p.waitForFunction(() => window.__picker.loads.includes('picker'))
      const before = await stateOf(p)
      check('[stub Picker] เปิดหน้าตั้งค่า: โหลดสคริปต์ของ Google ไว้ล่วงหน้าก่อนผู้ใช้กดปุ่ม โดยยังไม่ขอสิทธิ์และยังไม่เปิดหน้าต่างใด',
        before.scripts.includes('api') && before.scripts.includes('gsi') && before.tokenRequests.length === 0 && before.instances === 0, JSON.stringify(before))
      check('[stub Picker] หน้าตั้งค่าอธิบายทางเลือกเมื่อหน้าต่างเลือกไฟล์ใช้ไม่ได้ และบอกว่าการดูไฟล์ชมรมไม่ใช้หน้าต่างนี้',
        (await p.locator('.picker-note').innerText()).includes('การดูไฟล์ในหน้า “ไฟล์ชมรม” ไม่ใช้หน้าต่างนี้') && (await p.locator('.picker-note').innerText()).includes('ใช้ “สร้างชุดข้อมูลชมรม” แทน'))

      // กดซ้ำเร็ว ๆ: เปิดหน้าต่างเดียว ขอสิทธิ์ครั้งเดียว และคำขอสิทธิ์เกิดในจังหวะเดียวกับการกด
      await button(p).dblclick()
      await p.locator('.stub-picker').waitFor()
      const opened = await stateOf(p)
      check('[stub Picker] กดปุ่มซ้ำสองครั้งติดกัน: ขอสิทธิ์ครั้งเดียว เปิดหน้าต่างเลือกไฟล์หน้าต่างเดียว และคำขอสิทธิ์เกิดขณะยังเป็นการกดของผู้ใช้ (ไม่ถูกเลื่อนไปหลังการรอ)',
        opened.tokenRequests.length === 1 && opened.tokenRequests[0].active === true && opened.instances === 1 && opened.open === 1 && (await p.locator('.stub-picker').count()) === 1, JSON.stringify(opened))
      check('[stub Picker] ระหว่างหน้าต่างเปิดอยู่: ปุ่มบอกสถานะและกดซ้ำไม่ได้ มีปุ่มปิดหน้าต่างเลือกไฟล์จากหน้าเว็บ และขอสิทธิ์เฉพาะ drive.file ด้วยบัญชีชมรม',
        (await button(p).isDisabled()) && (await button(p).innerText()).includes('หน้าต่างเลือกไฟล์ของ Google เปิดอยู่') && (await p.getByRole('button', { name: 'ปิดหน้าต่างเลือกไฟล์' }).isVisible()) &&
        opened.tokenRequests[0].scope === 'https://www.googleapis.com/auth/drive.file' && opened.tokenRequests[0].hint === 'muesport2567@gmail.com')

      // ยกเลิกจากหน้าต่างของ Google
      await p.evaluate(() => window.__picker.instances[0].cancel())
      await gone(p.locator('.stub-picker'))
      await p.waitForFunction(() => !document.querySelector('.resource-row[data-resource="sheets"] .button').disabled)
      const cancelled = await stateOf(p)
      check('[stub Picker] ยกเลิกในหน้าต่างเลือกไฟล์: หน้าต่างถูกรื้อออก ปุ่มกลับมากดได้ ไม่มีข้อความผิดพลาด และ focus กลับไปที่ปุ่มที่เปิด',
        cancelled.open === 0 && cancelled.disposed === 1 && (await p.locator('.data-space > .form-alert').count()) === 0 &&
        (await p.evaluate(() => document.activeElement === document.querySelector('.resource-row[data-resource="sheets"] .button'))), JSON.stringify(cancelled))

      // เปิดอีกครั้ง: ใช้สิทธิ์เดิม ไม่เปิดหน้าต่างขออนุญาตซ้ำ แล้วปิดจากปุ่มของหน้าเว็บ
      await button(p).click()
      await p.locator('.stub-picker').waitFor()
      const reopened = await stateOf(p)
      await p.getByRole('button', { name: 'ปิดหน้าต่างเลือกไฟล์' }).click()
      await gone(p.locator('.stub-picker'))
      const closed = await stateOf(p)
      check('[stub Picker] เปิดครั้งถัดไป: ใช้สิทธิ์ที่ได้แล้ว ไม่ขอสิทธิ์ซ้ำ และปิดจากปุ่มของหน้าเว็บได้โดยไม่เหลือหน้าต่างค้าง',
        reopened.tokenRequests.length === 1 && reopened.instances === 2 && closed.open === 0 && (await p.locator('.stub-picker').count()) === 0, JSON.stringify(closed))

      // เลือกไฟล์: หน้าต่างปิด แล้วหน้าเว็บทำขั้นถัดไป (กล่องตั้งค่าชีต) หนึ่งกล่อง
      await p.waitForFunction(() => !document.querySelector('.resource-row[data-resource="sheets"] .button').disabled)
      await button(p).click()
      await p.locator('.stub-picker').waitFor()
      await p.evaluate(() => window.__picker.instances[2].pick())
      await gone(p.locator('.stub-picker'))
      check('[stub Picker] เลือกไฟล์แล้ว: หน้าต่างเลือกไฟล์ปิด เปิดกล่องขั้นถัดไปของเว็บหนึ่งกล่อง ไม่มีกล่องซ้อนกัน',
        (await appears(p.locator('dialog[open]'))) && (await p.locator('dialog[open]').count()) === 1 && (await p.locator('.stub-picker').count()) === 0)
      await p.context().close()
    }
    for (const [mode, expected] of [['popup_failed_to_open', 'เบราว์เซอร์บล็อกหน้าต่างขออนุญาตของ Google'], ['popup_closed', 'หน้าต่างขออนุญาตของ Google ถูกปิดก่อนเสร็จ']]) {
      const { p } = await pickerPage()
      await p.waitForFunction(() => window.__picker.loads.includes('picker'))
      await p.evaluate((mode) => (window.__picker.tokenMode = mode), mode)
      await button(p).click()
      const alert = p.locator('.data-space > .form-alert')
      await alert.waitFor()
      const failedState = await stateOf(p)
      check(`[stub Picker] หน้าต่างขออนุญาต ${mode}: บอกเหตุผลและบอกว่ายังไม่ได้เลือกไฟล์ ไม่เปิดหน้าต่างเลือกไฟล์ ปุ่มกลับมากดได้ และ focus กลับไปที่ปุ่ม`,
        (await alert.innerText()).includes(expected) && (await alert.innerText()).includes('ยังไม่ได้เลือกไฟล์') && failedState.instances === 0 && (await button(p).isEnabled()) &&
        (await p.evaluate(() => document.activeElement === document.querySelector('.resource-row[data-resource="sheets"] .button'))), await alert.innerText())
      // ลองใหม่หลังอนุญาต: ทำงานได้ และข้อความผิดพลาดเดิมหายไป
      await p.evaluate(() => (window.__picker.tokenMode = 'ok'))
      await button(p).click()
      await p.locator('.stub-picker').waitFor()
      check(`[stub Picker] หลัง ${mode}: กดอีกครั้งแล้วใช้งานได้ และข้อความผิดพลาดเดิมถูกล้าง`, (await p.locator('.data-space > .form-alert').count()) === 0 && (await stateOf(p)).tokenRequests.length === 2)
      await p.context().close()
    }
    {
      const { p, state } = await pickerPage({ blockScripts: true })
      await button(p).click()
      const alert = p.locator('.data-space > .form-alert')
      await alert.waitFor({ timeout: 20000 })
      // สคริปต์สองตัวล้มเหลวไม่พร้อมกัน: รอจนตัวที่สองจบ แล้วจึงนับแท็กที่เหลือ
      await p.waitForFunction(() => document.querySelectorAll('script[src*="apis.google.com"], script[src*="accounts.google.com"]').length === 0, null, { timeout: 20000 }).catch(() => undefined)
      const tags = await p.evaluate(() => document.querySelectorAll('script[src*="apis.google.com"], script[src*="accounts.google.com"]').length)
      check('[stub Picker] โหลดสคริปต์ของ Google ไม่ได้: บอกเหตุผล ไม่ค้างในสถานะกำลังเปิด และไม่ทิ้งแท็กสคริปต์ที่ล้มเหลวไว้ในหน้า',
        (await alert.innerText()).includes('โหลดหน้าต่างเลือกไฟล์ของ Google ไม่ได้') && (await button(p).isEnabled()) && tags === 0, `${await alert.innerText()} tags=${tags}`)
      state.blockScripts = false
      await button(p).click()
      await p.locator('.stub-picker').waitFor()
      check('[stub Picker] เครือข่ายกลับมา: กดอีกครั้งแล้วโหลดใหม่และเปิดหน้าต่างเลือกไฟล์ได้ หน้าต่างเดียว', (await stateOf(p)).open === 1 && (await p.locator('.data-space > .form-alert').count()) === 0)
      // ออกจากหน้าตั้งค่าขณะหน้าต่างเปิดอยู่: หน้าต่างถูกปิดด้วย
      await p.locator('.sidebar .nav-link', { hasText: 'สมาชิก' }).evaluate((el) => el.click())
      await p.waitForURL(`${BASE}/members`)
      await p.getByRole('heading', { name: 'สมาชิก', level: 1 }).waitFor()
      const closedOnLeave = await gone(p.locator('.stub-picker'), 3000)
      check('[stub Picker] ออกจากหน้าตั้งค่าขณะหน้าต่างเลือกไฟล์เปิดอยู่: หน้าต่างถูกปิด ไม่ค้างทับหน้าอื่น', closedOnLeave && (await p.locator('.stub-picker').count()) === 0 && (await stateOf(p)).open === 0)
      await p.context().close()
    }
  }

  check('ไม่มีข้อผิดพลาดใน console ของเบราว์เซอร์ที่ไม่ได้คาดไว้', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '))

  console.log(`\nผลตรวจ UI หน้าสมาชิกและบัญชีสมาชิก: ผ่าน ${passed} ข้อ ไม่ผ่าน ${failed} ข้อ`)
  exitCode = failed === 0 ? 0 : 1
} catch (error) {
  console.error('ชุดตรวจหยุดก่อนจบ:', error)
  console.log(`\nผลตรวจ (ไม่ครบ): ผ่าน ${passed} ข้อ ไม่ผ่าน ${failed} ข้อ ก่อนหยุด`)
  exitCode = 1
} finally {
  await browser?.close().catch(() => undefined)
  stopServer()
}
process.exit(exitCode)
