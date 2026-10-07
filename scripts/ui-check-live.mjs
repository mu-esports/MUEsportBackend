// ตรวจ UI โหมดใช้งานจริงในเบราว์เซอร์จริง: หน้าเว็บ + Worker + D1 local ผ่าน `vite dev`
// ใช้: `npm run check:ui:live` (สคริปต์เตรียมฐานข้อมูลทดสอบ เปิดและปิด dev server เอง ที่พอร์ต 5183)
//
// ขอบเขตของชุดนี้
// - [จริง]   = หน้าเว็บคุยกับ Worker และ D1 local จริง (สมาชิก กำหนดการ ทีมงาน สิทธิ์ session แหล่งข้อมูล)
// - [จำลอง]  = ตอบ /api/documents* และบางสถานะด้วยข้อมูลจำลองในเบราว์เซอร์ทดสอบ เพื่อดูสถานะของหน้าจอ
//              เพราะเครื่องนี้ยังไม่มี Google credentials การคุยกับ Google ของ Worker ตรวจใน `npm test` (Google จำลอง)
// ไม่มีข้อใดในไฟล์นี้เป็นการตรวจกับ Google จริง
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { chromium, webkit } from 'playwright-core'
import { prepareLocalDatabase } from './local-fixtures.mjs'
import { checkMonthChip, probeLoadSignal, saveMonthChipDiagnostics, traceApi } from './ui-data-ready.mjs'

const PORT = Number(process.env.UI_LIVE_PORT ?? 5183)
const BASE = `http://localhost:${PORT}`
const CHANNEL = process.env.BROWSER_CHANNEL ?? 'msedge'
const STATE_DIR = '.wrangler/ui-test-state'
const OUT = 'screenshots'
mkdirSync(OUT, { recursive: true })

let failed = 0
let passed = 0
const check = (name, ok, extra = '') => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`)
}

// ---------- เตรียมฐานข้อมูลทดสอบและ dev server ----------
const actors = prepareLocalDatabase(STATE_DIR, [
  { key: 'admin', email: 'muesport2567@gmail.com', role: 'admin', name: 'MU Esport' },
  { key: 'a', email: 'staff.a@example.com', role: 'staff', name: 'ทีมงาน เอ', sessions: 2 },
  { key: 'b', email: 'staff.b@example.com', role: 'staff', name: 'ทีมงาน บี' },
  { key: 'c', email: 'staff.c@example.com', role: 'staff', name: 'ทีมงาน ซี' },
  { key: 'out', email: 'logout-review@example.com', role: 'staff', name: 'ทดสอบออกจากระบบ', sessions: 6 },
])

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

try {
  const publicSession = await waitForServer()
  const authConfigured = publicSession.authConfigured
  console.log(`dev server พร้อมที่ ${BASE} · Google client ${authConfigured ? 'ตั้งค่าแล้ว' : 'ยังไม่ได้ตั้งค่า'} (จาก .dev.vars)`)

  browser = await chromium.launch({ channel: CHANNEL })

  async function newPage(width, height, actor, tokenIndex = 0, engine = browser) {
    const context = await engine.newContext({ viewport: { width, height }, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
    if (actor) await context.addCookies([{ name: 'mu_session', value: actor.tokens[tokenIndex], url: BASE, httpOnly: true, sameSite: 'Lax' }])
    const page = await context.newPage()
    page.setDefaultTimeout(6000)
    // สถานะ HTTP ที่จงใจทำให้เกิด (401/403/404/409/502 และคำขอที่ถูกตัด) เบราว์เซอร์จะ log เอง ไม่นับเป็นข้อผิดพลาดของหน้าเว็บ
    // WebKit log "due to access control checks" เมื่อ fetch ที่ค้างอยู่ถูกยกเลิกเพราะเปลี่ยนหน้า
    page.on('console', (m) => m.type() === 'error' && noteError(m.text()))
    page.on('pageerror', (e) => noteError(String(e)))
    return page
  }

  const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
  const appears = (locator, timeout = 4000) => locator.first().waitFor({ timeout }).then(() => true, () => false)
  const gone = (locator, timeout = 4000) => locator.waitFor({ state: 'detached', timeout }).then(() => true, () => false)
  const shot = (page, name, fullPage = true) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage })
  const inViewport = (locator) =>
    locator.evaluate((el) => {
      const r = el.getBoundingClientRect()
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
      return r.top >= 0 && r.bottom <= window.innerHeight && (top === el || el.contains(top))
    })
  const apiAs = (page, path, options = {}) =>
    page.evaluate(
      async ({ path, options }) => {
        const session = await (await fetch('/api/session')).json()
        const res = await fetch(path, {
          method: options.method ?? 'GET',
          headers: {
            'Content-Type': 'application/json',
            'X-CSRF-Token': session.csrfToken ?? '',
            ...(options.key ? { 'Idempotency-Key': options.key } : {}),
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
        })
        return { status: res.status, type: res.headers.get('Content-Type') ?? '', cache: res.headers.get('Cache-Control'), body: await res.text() }
      },
      { path, options },
    )
  const ignoreErrorsSince = (count) => consoleErrors.splice(count)

  // ================= 1. ยังไม่เข้าสู่ระบบ =================
  const anon = await newPage(1440, 900)
  await anon.goto(`${BASE}/members`)
  check('[จริง] ยังไม่เข้าสู่ระบบ: เปิด /members แล้วถูกพาไปหน้าเข้าสู่ระบบ พร้อมจำ path ที่จะกลับ',
    (await appears(anon.getByRole('heading', { name: 'เข้าสู่ระบบ' }))) && anon.url().includes('/login?return=%2Fmembers'), anon.url())
  check('[จริง] หน้าเข้าสู่ระบบไม่แสดงข้อมูลหลังบ้านหรือเมนู',
    (await anon.locator('.sidebar, .nav-link, table').count()) === 0)
  if (authConfigured) {
    check('[จริง] หน้าเข้าสู่ระบบ: มีปุ่มเข้าสู่ระบบด้วย Google ชี้ไป /auth/login พร้อม return',
      ((await anon.getByRole('link', { name: 'เข้าสู่ระบบด้วย Google' }).getAttribute('href')) ?? '').startsWith('/auth/login?return=%2Fmembers'))
  } else {
    check('[จริง] ยังไม่ได้ตั้งค่า Google client: บอกตรง ๆ ว่ายังเข้าสู่ระบบไม่ได้ ไม่มีปุ่มหลอก',
      (await anon.getByText('ยังเข้าสู่ระบบไม่ได้').isVisible()) && (await anon.getByRole('link', { name: 'เข้าสู่ระบบด้วย Google' }).count()) === 0)
    await shot(anon, 'live-login-not-configured-1440')
    await anon.goto(`${BASE}/auth/login`)
    check('[จริง] /auth/login วิ่งเข้า Worker แม้เปิด URL ตรง และไม่ส่งไป Google เมื่อยังไม่ได้ตั้งค่า',
      (await appears(anon.getByText('ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google'))) && anon.url().includes('/login?error=not_configured'), anon.url())
  }
  await anon.goto(`${BASE}/auth/google/callback?state=forged&code=x`)
  check('[จริง] OAuth callback เปิดตรงจากเบราว์เซอร์วิ่งเข้า Worker และ state ปลอมถูกปฏิเสธ',
    (await appears(anon.getByText('ขั้นตอนเข้าสู่ระบบไม่ถูกต้อง'))) && anon.url().includes('/login?error=state_invalid'), anon.url())
  await shot(anon, 'live-login-error-1440')

  const anonApi = await apiAs(anon, '/api/does-not-exist')
  check('[จริง] API ที่ไม่มีตอบ 404 เป็น JSON ไม่ใช่ index.html',
    anonApi.status === 404 && anonApi.type.includes('application/json') && anonApi.body.includes('not_found') && !anonApi.body.includes('<html'))
  const anonMembers = await apiAs(anon, '/api/members')
  check('[จริง] API ข้อมูลตอบ 401 เมื่อไม่มี session และห้าม cache', anonMembers.status === 401 && anonMembers.cache === 'no-store')
  for (const path of ['/members', '/calendar?event=abc', '/documents/some-id', '/team']) {
    const res = await anon.request.get(BASE + path)
    check(`[จริง] refresh ที่ ${path} ได้หน้าเว็บ (SPA fallback)`, res.status() === 200 && (await res.text()).includes('<div id="root">'))
  }

  // หน้าเข้าสู่ระบบเมื่อระบบตั้งค่าแล้ว (จำลองเฉพาะคำตอบ /api/session เพื่อดูหน้าจอ)
  for (const [w, h] of [[1440, 900], [390, 844], [320, 568]]) {
    const p = await newPage(w, h)
    await p.route('**/api/session', (route) => route.fulfill({ json: { authConfigured: true, user: null, csrfToken: null } }))
    await p.goto(`${BASE}/login?return=%2Fdocuments`)
    const button = p.getByRole('link', { name: 'เข้าสู่ระบบด้วย Google' })
    check(`[จำลอง session] หน้าเข้าสู่ระบบ ${w}px: ปุ่มเข้าสู่ระบบแตะได้ ≥44px และไม่ล้นจอ`,
      (await appears(button)) && (await button.boundingBox()).height >= 44 && (await noOverflow(p)) &&
      (await button.getAttribute('href')) === '/auth/login?return=%2Fdocuments')
    await shot(p, `live-login-${w}`)
    if (w === 390) {
      await p.goto(`${BASE}/access-denied`)
      check('[จริง] หน้าปฏิเสธการเข้าถึง: บอกว่าล็อกอิน Google สำเร็จแต่ไม่มีสิทธิ์ และมีทางเข้าด้วยบัญชีอื่น',
        (await appears(p.getByRole('heading', { name: 'ไม่มีสิทธิ์เข้าใช้งาน' }))) && (await p.getByRole('link', { name: 'เข้าสู่ระบบด้วยบัญชีอื่น' }).isVisible()) && (await noOverflow(p)))
      await shot(p, 'live-access-denied-390')
    }
    await p.context().close()
  }
  await anon.context().close()

  // ================= 2. ข้อมูลร่วมกัน: สอง session คนละเบราว์เซอร์ =================
  const a = await newPage(1440, 900, actors.a)
  const b = await newPage(1440, 900, actors.b)
  await a.goto(`${BASE}/`)
  check('[จริง] เข้าสู่ระบบแล้ว: ข้อมูลจริงเริ่มว่าง ไม่มีข้อมูลตัวอย่าง ไม่มีแถบข้อมูลตัวอย่างหรือปุ่มรีเซ็ต',
    (await appears(a.getByText('ยังไม่มีสมาชิก'))) && (await a.locator('.sample-banner').count()) === 0 &&
    (await a.getByRole('button', { name: /รีเซ็ต/ }).count()) === 0 && (await a.getByText('ข้อมูลตัวอย่าง').count()) === 0)
  check('[จริง] แสดงบัญชีที่เข้าสู่ระบบและสิทธิ์ และ staff ไม่เห็นเมนูทีมงาน',
    (await a.locator('.topbar .account').innerText()).includes('staff.a@example.com') &&
    (await a.locator('.topbar .account').innerText()).includes('ทีมงาน') &&
    (await a.locator('.sidebar').getByRole('link', { name: 'ทีมงาน' }).count()) === 0 &&
    (await a.locator('.sidebar').getByRole('link', { name: 'เอกสาร' }).count()) === 1)
  await shot(a, 'live-overview-empty-1440')

  await a.locator('.sidebar').getByRole('link', { name: 'สมาชิก', exact: true }).click()
  await a.getByRole('button', { name: 'เพิ่มสมาชิกคนแรก' }).click()
  await a.locator('#member-name').fill('สมหญิง ทดสอบร่วม')
  await a.locator('#member-nickname').fill('หญิง')
  await a.getByRole('button', { name: 'เพิ่มสมาชิก' }).last().click()
  check('[จริง] A เพิ่มสมาชิก: แจ้งสำเร็จหลัง server ยืนยัน', await appears(a.locator('.toast', { hasText: 'เพิ่มสมาชิก “สมหญิง ทดสอบร่วม”' })))

  await b.goto(`${BASE}/members`)
  const rowB = b.locator('tbody tr', { hasText: 'สมหญิง ทดสอบร่วม' })
  check('[จริง] B (อีก session/อุปกรณ์) โหลดหน้าแล้วเห็นสมาชิกที่ A เพิ่ม', await appears(rowB))

  // B เปิดฟอร์มแก้ไขค้างไว้ แล้ว A แก้และบันทึกก่อน
  await rowB.getByRole('button', { name: /ดูรายละเอียด/ }).click()
  await b.getByRole('button', { name: 'แก้ไข' }).click()
  await b.locator('#member-note').fill('B กำลังพิมพ์')
  const rowA = a.locator('tbody tr', { hasText: 'สมหญิง ทดสอบร่วม' })
  await rowA.getByRole('button', { name: /ดูรายละเอียด/ }).click()
  await a.getByRole('button', { name: 'แก้ไข' }).click()
  await a.locator('#member-nickname').fill('หญิง-แก้โดยA')
  await a.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
  await a.locator('.toast', { hasText: 'บันทึกการแก้ไข' }).waitFor()

  // B กลับมาที่แท็บ: รายการด้านหลังอัปเดต แต่ค่าที่กำลังพิมพ์ในฟอร์มไม่หาย
  await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
  check('[จริง] B กลับเข้าแท็บ: ดึงค่าล่าสุดโดยไม่ลบค่าฟอร์มที่กำลังแก้',
    (await appears(b.locator('tbody tr', { hasText: 'หญิง-แก้โดยA' }))) && (await b.locator('#member-note').inputValue()) === 'B กำลังพิมพ์')

  await b.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
  const conflictAlert = b.locator('dialog[open] .form-alert')
  check('[จริง] B บันทึกจากข้อมูลเก่า: ได้ข้อความ conflict ภาษาไทย ไม่เขียนทับ และค่าที่กรอกยังอยู่',
    (await appears(conflictAlert)) && (await conflictAlert.innerText()).includes('ถูกแก้ไขจากที่อื่น') &&
    (await b.locator('#member-note').inputValue()) === 'B กำลังพิมพ์' && (await b.locator('#member-nickname').inputValue()) === 'หญิง')
  await b.screenshot({ path: `${OUT}/live-member-conflict-1440.png` })
  const afterConflict = JSON.parse((await apiAs(b, '/api/members')).body).members[0]
  check('[จริง] conflict: ข้อมูลใน D1 ยังเป็นของ A', afterConflict.nickname === 'หญิง-แก้โดยA' && afterConflict.note === '' && afterConflict.version === 2)
  await conflictAlert.getByRole('button', { name: /โหลดค่าล่าสุด/ }).click()
  check('[จริง] โหลดค่าล่าสุด: ฟอร์มแสดงค่าที่ A บันทึก แล้วแก้ต่อและบันทึกได้',
    (await b.locator('#member-nickname').inputValue()) === 'หญิง-แก้โดยA' && (await b.locator('dialog[open] .form-alert').count()) === 0)
  await b.locator('#member-note').fill('B แก้หลังโหลดค่าล่าสุด')
  await b.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
  check('[จริง] B บันทึกหลังโหลดค่าล่าสุดสำเร็จ', await appears(b.locator('.toast', { hasText: 'บันทึกการแก้ไข' })))
  await a.reload()
  await rowA.getByRole('button', { name: /ดูรายละเอียด/ }).click()
  check('[จริง] A reload แล้วเห็นการแก้ของ B', await appears(a.getByText('B แก้หลังโหลดค่าล่าสุด')))
  await a.keyboard.press('Escape')

  // พักการใช้งานจากข้อมูลเก่า
  await rowB.getByRole('button', { name: /ดูรายละเอียด/ }).click()
  await apiAs(a, `/api/members/${afterConflict.id}`, { method: 'PATCH', body: { name: 'สมหญิง ทดสอบร่วม', nickname: 'หญิง-แก้โดยA', role: 'staff', status: 'active', contact: '', note: 'A แก้อีกรอบ', expectedVersion: 3 } })
  await b.getByRole('button', { name: 'พักการใช้งาน' }).click()
  await b.locator('dialog.dialog-sm').getByRole('button', { name: 'พักการใช้งาน' }).click()
  check('[จริง] เปลี่ยนสถานะจากข้อมูลเก่า: แจ้งในหน้ารายละเอียด แสดงค่าล่าสุด และสถานะไม่ถูกเปลี่ยน',
    (await appears(b.locator('dialog[open] .detail-alert', { hasText: 'ถูกแก้ไขจากที่อื่น' }))) &&
    (await appears(b.locator('dialog[open]').getByText('A แก้อีกรอบ'))) && (await b.locator('dialog[open] .badge-active').count()) === 1)
  await b.keyboard.press('Escape')

  // response หาย แล้ว retry: ไม่สร้างซ้ำ
  let dropped = false
  await a.route('**/api/members', async (route) => {
    if (route.request().method() === 'POST' && !dropped) {
      dropped = true
      await route.fetch() // server ทำงานสำเร็จ แต่คำตอบไม่ถึงเบราว์เซอร์
      return route.abort('failed')
    }
    return route.fallback()
  })
  const errorsBeforeDrop = consoleErrors.length
  await a.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
  await a.locator('#member-name').fill('คนที่ลองซ้ำ')
  await a.locator('#member-nickname').fill('ซ้ำ')
  await a.getByRole('button', { name: 'เพิ่มสมาชิก' }).last().click()
  const dropAlert = a.locator('dialog[open] .form-alert')
  check('[จริง] คำตอบหายระหว่างทาง: แจ้งว่าเชื่อมต่อระบบกลางไม่ได้ (ไม่พูดถึงที่เก็บในเบราว์เซอร์) และค่าที่กรอกยังอยู่',
    (await appears(dropAlert)) && (await dropAlert.innerText()).includes('เชื่อมต่อระบบกลางไม่ได้') && !/เบราว์เซอร์อนุญาต|local storage/i.test(await dropAlert.innerText()) &&
    (await a.locator('#member-name').inputValue()) === 'คนที่ลองซ้ำ')
  await a.screenshot({ path: `${OUT}/live-member-save-failed-1440.png` })
  await a.getByRole('button', { name: 'เพิ่มสมาชิก' }).last().click()
  await a.locator('.toast', { hasText: 'คนที่ลองซ้ำ' }).waitFor()
  await a.unroute('**/api/members')
  ignoreErrorsSince(errorsBeforeDrop)
  const afterRetry = JSON.parse((await apiAs(a, '/api/members')).body).members
  check('[จริง] ลองใหม่หลังคำตอบหาย: มีรายการเดียว ไม่สร้างซ้ำ', afterRetry.filter((m) => m.name === 'คนที่ลองซ้ำ').length === 1, `ทั้งหมด ${afterRetry.length} รายการ`)
  check('[จริง] หลังบันทึก รายการในหน้าจอตรงกับ server', (await a.locator('tbody tr').count()) === afterRetry.length)

  // คำตอบเก่าที่มาช้าต้องไม่ทับข้อมูลใหม่
  const stale = JSON.stringify({ members: afterRetry.filter((m) => m.name !== 'คนที่ลองซ้ำ') })
  let delayedOnce = false
  await b.route('**/api/members', async (route) => {
    if (route.request().method() === 'GET' && !delayedOnce) {
      delayedOnce = true
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return route.fulfill({ status: 200, contentType: 'application/json', body: stale })
    }
    return route.fallback()
  })
  await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))) // คำขอที่ 1 (ตอบช้า ข้อมูลเก่า)
  await b.waitForTimeout(100)
  await b.evaluate(() => document.dispatchEvent(new Event('visibilitychange'))) // คำขอที่ 2 (ตอบก่อน ข้อมูลใหม่)
  await b.locator('tbody tr', { hasText: 'คนที่ลองซ้ำ' }).waitFor()
  await b.waitForTimeout(2000)
  check('[จริง] คำตอบของคำขอเก่าที่มาช้าไม่ทับข้อมูลใหม่', (await b.locator('tbody tr', { hasText: 'คนที่ลองซ้ำ' }).count()) === 1)
  await b.unroute('**/api/members')

  // ระบบกลางล่ม: ไม่ fallback เป็นข้อมูลตัวอย่าง
  const errorsBeforeDown = consoleErrors.length
  await b.route('**/api/members', (route) => route.abort('failed'))
  await b.reload()
  check('[จริง] โหลดข้อมูลไม่ได้: แสดงข้อผิดพลาดของระบบกลาง มีปุ่มลองใหม่ ไม่แสดงข้อมูลตัวอย่างแทน และไม่บอกให้รีเซ็ต',
    (await appears(b.getByText('โหลดข้อมูลไม่สำเร็จ'))) && (await b.getByText('เชื่อมต่อระบบกลางไม่ได้').first().isVisible()) &&
    (await b.locator('tbody tr').count()) === 0 && (await b.getByText(/รีเซ็ตข้อมูลตัวอย่าง|ธนกร สมมติวงศ์/).count()) === 0)
  await shot(b, 'live-members-load-failed-1440')
  await b.unroute('**/api/members')
  await b.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }).click()
  check('[จริง] ลองโหลดอีกครั้งแล้วกลับมาใช้งานได้', await appears(b.locator('tbody tr').first()))
  ignoreErrorsSince(errorsBeforeDown)

  // ================= 3. กำหนดการในระบบ + deep link =================
  await a.locator('.sidebar').getByRole('link', { name: 'ปฏิทิน', exact: true }).click()
  const calendarSource = a.locator('main .sync-row[data-sync-kind="calendar"]')
  check('[จริง] ปฏิทิน: ระบุว่าเป็นกำหนดการในระบบ และแถบแหล่งข้อมูลบอกว่ายังไม่ได้เชื่อม Google Calendar ไม่มีป้ายว่าเป็นข้อมูลจาก Google หรือเวลาอัปเดตจาก Google',
    (await appears(a.getByText('กำหนดการในระบบของชมรม'))) && (await appears(calendarSource)) && (await calendarSource.getAttribute('data-sync-state')) === 'local' &&
    (await calendarSource.innerText()).trim() === 'ข้อมูลในเว็บ (ยังไม่ได้เชื่อม Google Calendar)' && (await a.locator('main .badge-source, main .sync-state').count()) === 0 &&
    (await a.locator('main').getByRole('button', { name: /อัปเดตจาก Google/ }).count()) === 0)
  await a.getByRole('button', { name: 'เพิ่มกำหนดการ' }).first().click()
  await a.locator('#event-title').fill('ประชุมทีมงานประจำสัปดาห์ เตรียมงานแข่งขันรอบคัดเลือก')
  await a.getByRole('button', { name: 'เพิ่มกำหนดการ' }).last().click()
  await a.locator('.toast', { hasText: 'เพิ่มกำหนดการ' }).waitFor()
  const eventsNow = JSON.parse((await apiAs(a, '/api/events')).body).events
  const eventId = eventsNow[0].id
  check('[จริง] เพิ่มกำหนดการ: บันทึกใน D1 พร้อม id และ version จาก server', eventsNow.length === 1 && /^[0-9a-f-]{36}$/.test(eventId) && eventsNow[0].version === 1)

  await b.goto(`${BASE}/calendar?event=${eventId}&keep=1`)
  const detail = b.locator('dialog.dialog[open]')
  check('[จริง] B เปิด deep link ของกำหนดการที่ A สร้าง: เปิดรายละเอียด', await appears(detail.locator('h2', { hasText: 'ประชุมทีมงานประจำสัปดาห์' })))
  await b.reload()
  check('[จริง] deep link + refresh: รายละเอียดเดิมยังเปิด และ URL ยังมี event',
    (await appears(detail.locator('h2', { hasText: 'ประชุมทีมงานประจำสัปดาห์' }))) && new URL(b.url()).searchParams.get('event') === eventId)
  await b.keyboard.press('Escape')
  check('[จริง] ปิดรายละเอียด: ลบเฉพาะ event รักษา parameter อื่น และ focus ไปที่รายการนั้น',
    (await gone(detail)) && new URL(b.url()).search === '?keep=1' &&
    (await b.evaluate((id) => document.activeElement?.getAttribute('data-event-id') === id, eventId)))
  await b.goto(`${BASE}/calendar?event=no-such-id`)
  await b.getByRole('button', { name: 'กลับไปดูปฏิทินเดือนนี้' }).click()
  check('[จริง] ID ไม่พบ: กดกลับแล้ว focus ไปที่หัวข้อเดือนของปฏิทิน (ไม่หายไปกับปุ่ม)',
    (await gone(b.getByText('ไม่พบกำหนดการที่ต้องการเปิด'))) &&
    (await b.waitForFunction(() => document.activeElement?.classList.contains('calendar-title'), null, { timeout: 2000 }).then(() => true, () => false)))

  // แก้กำหนดการจากข้อมูลเก่า
  await b.goto(`${BASE}/calendar?event=${eventId}`)
  await detail.getByRole('button', { name: 'แก้ไข' }).click()
  await b.locator('#event-location').fill('ห้องของ B')
  await apiAs(a, `/api/events/${eventId}`, { method: 'PATCH', body: { ...eventsNow[0], location: 'ห้องของ A', expectedVersion: 1 } })
  await b.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
  check('[จริง] กำหนดการ: บันทึกจากข้อมูลเก่าได้ conflict และค่าที่กรอกยังอยู่',
    (await appears(b.locator('dialog[open] .form-alert', { hasText: 'ถูกแก้ไขจากที่อื่น' }))) && (await b.locator('#event-location').inputValue()) === 'ห้องของ B')
  await b.getByRole('button', { name: /โหลดค่าล่าสุด/ }).click()
  check('[จริง] กำหนดการ: โหลดค่าล่าสุดแล้วเห็นค่าของ A', (await b.locator('#event-location').inputValue()) === 'ห้องของ A')
  await b.keyboard.press('Escape')
  await b.keyboard.press('Escape')

  // ================= 4. ทีมงานและสิทธิ์ (admin) =================
  const admin = await newPage(1440, 900, actors.admin)
  await admin.goto(`${BASE}/team`)
  check('[จริง] admin เห็นเมนูและหน้าทีมงาน พร้อมรายชื่อบัญชีจริงจาก D1',
    (await appears(admin.locator('.team-row', { hasText: 'staff.c@example.com' }))) && (await admin.locator('.team-row').count()) === 5 &&
    (await admin.locator('.sidebar').getByRole('link', { name: 'ทีมงาน' }).count()) === 1)
  const clubRow = admin.locator('.team-row', { hasText: 'muesport2567@gmail.com' })
  check('[จริง] บัญชีชมรม: ไม่มีปุ่มเปลี่ยนหรือถอนสิทธิ์', (await clubRow.getByRole('button').count()) === 0 && (await clubRow.innerText()).includes('ผู้ดูแลหลัก'))

  await admin.getByRole('button', { name: 'เพิ่มทีมงาน' }).first().click()
  await admin.getByRole('button', { name: 'เพิ่มทีมงาน' }).last().click()
  check('[จริง] เพิ่มทีมงาน: validation อีเมลก่อนส่ง', await appears(admin.locator('#team-email-error', { hasText: 'กรอกอีเมล' })))
  await admin.locator('#team-email').fill('staff.b@example.com')
  await admin.getByRole('button', { name: 'เพิ่มทีมงาน' }).last().click()
  check('[จริง] เพิ่มทีมงาน: อีเมลซ้ำ server ปฏิเสธ แสดงที่ช่องอีเมล และค่าที่กรอกยังอยู่',
    (await appears(admin.locator('#team-email-error', { hasText: 'อยู่ในรายชื่อทีมงานแล้ว' }))) && (await admin.locator('#team-email').inputValue()) === 'staff.b@example.com')
  await admin.locator('#team-email').fill('new.staff@example.com')
  await admin.screenshot({ path: `${OUT}/live-team-add-1440.png` })
  await admin.getByRole('button', { name: 'เพิ่มทีมงาน' }).last().click()
  check('[จริง] เพิ่มทีมงานสำเร็จ: อยู่ในรายการ สถานะยังไม่เคยเข้าสู่ระบบ',
    (await appears(admin.locator('.toast', { hasText: 'new.staff@example.com' }))) &&
    (await admin.locator('.team-row', { hasText: 'new.staff@example.com' }).innerText()).includes('ยังไม่เคยเข้าสู่ระบบ'))
  await shot(admin, 'live-team-1440')

  // ถอนสิทธิ์ C ขณะที่ C เปิดเว็บอยู่
  const c = await newPage(1440, 900, actors.c)
  await c.goto(`${BASE}/members`)
  await c.locator('tbody tr').first().waitFor()
  await admin.getByRole('button', { name: 'ถอนสิทธิ์ staff.c@example.com' }).click()
  check('[จริง] ถอนสิทธิ์: อธิบายผลก่อนยืนยัน', await appears(admin.locator('dialog[open]').getByText('จะถูกออกจากระบบทันที')))
  await admin.locator('dialog[open]').getByRole('button', { name: 'ถอนสิทธิ์' }).click()
  check('[จริง] ถอนสิทธิ์สำเร็จ: รายการแสดงถอนสิทธิ์แล้ว',
    (await appears(admin.locator('.toast', { hasText: 'ถอนสิทธิ์ staff.c@example.com' }))) &&
    (await admin.locator('.team-row', { hasText: 'staff.c@example.com' }).innerText()).includes('ถอนสิทธิ์แล้ว'))
  const errorsBeforeRevoke = consoleErrors.length
  await c.reload()
  check('[จริง] บัญชีที่ถูกถอนสิทธิ์: session เดิมใช้ไม่ได้ทันที ถูกพาไปหน้าเข้าสู่ระบบ ไม่เห็นข้อมูล',
    (await appears(c.getByRole('heading', { name: 'เข้าสู่ระบบ' }))) && (await c.locator('tbody tr').count()) === 0)
  ignoreErrorsSince(errorsBeforeRevoke)
  await c.context().close()

  await a.goto(`${BASE}/team`)
  await a.locator('h1').waitFor()
  const staffUsers = await apiAs(a, '/api/users')
  const staffConnect = await apiAs(a, '/api/google/connect', { method: 'POST' })
  check('[จริง] staff เปิด /team: ถูกพากลับหน้าแรก และ API ทีมงาน/เชื่อม Google ตอบ 403',
    new URL(a.url()).pathname === '/' && staffUsers.status === 403 && staffConnect.status === 403)

  // ================= 5. แหล่งข้อมูล (สถานะจริงจาก server) =================
  await admin.locator('.sidebar').getByRole('link', { name: 'แหล่งข้อมูล', exact: true }).click()
  await admin.locator('.connection-card').waitFor()
  const connectionText = await admin.locator('.connection-card').innerText()
  const sourceText = await admin.locator('.source-grid').innerText()
  if (!authConfigured) {
    check('[จริง] แหล่งข้อมูล: ยังไม่ได้ตั้งค่า ไม่มีป้ายเชื่อมแล้ว และบอกชื่อค่าที่ต้องตั้งให้ผู้ดูแล',
      connectionText.includes('ยังไม่ได้ตั้งค่า') && !connectionText.includes('เชื่อมแล้ว') &&
      ['GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'TOKEN_ENCRYPTION_KEY'].every((name) => connectionText.includes(name)) &&
      connectionText.includes(`${BASE}/auth/google/callback`) && (await admin.getByRole('button', { name: /เชื่อมบัญชี Google/ }).count()) === 0)
  } else {
    check('[จริง] แหล่งข้อมูล: ยังไม่ได้เชื่อม ไม่มีป้ายเชื่อมแล้ว', connectionText.includes('ยังไม่ได้เชื่อม') && !connectionText.includes('เชื่อมแล้ว'))
  }
  check('[จริง] แหล่งข้อมูล: บัญชีที่ต้องใช้คือบัญชีชมรม และยังไม่มีบัญชีที่เชื่อมอยู่', connectionText.includes('muesport2567@gmail.com') && connectionText.includes('ยังไม่มี'))
  await admin.locator('.data-space .resource-state').nth(2).waitFor()
  const spaceText = await admin.locator('.data-space').innerText()
  check('[จริง] แหล่งข้อมูล: Google Docs รอเชื่อมบัญชี, Sheets/Calendar/Forms ยังไม่ได้เชื่อม (สถานะจริงจาก server), Excel ยังไม่เปิดใช้',
    (await admin.locator('.source-card').count()) === 2 && sourceText.includes('Google Docs') && sourceText.includes('รอเชื่อมบัญชี Google') &&
    (sourceText.match(/ยังไม่เปิดใช้/g) ?? []).length === 1 && sourceText.includes('Excel') &&
    (await admin.locator('.data-space .resource-row').count()) === 3 && (spaceText.match(/ยังไม่ได้เชื่อม/g) ?? []).length === 3 &&
    ['Google Sheets', 'Google Calendar', 'Google Forms'].every((name) => spaceText.includes(name)))
  check('[จริง] แหล่งข้อมูล: ไม่มีคำว่าเชื่อมสำเร็จ ไม่มีป้ายเชื่อมแล้ว และไม่มีสถานะซิงค์ของแหล่งที่ยังไม่ได้เชื่อม',
    !/เชื่อมสำเร็จ|เชื่อมต่อแล้ว|อัปเดตจาก Google สำเร็จ|ซิงค์ไม่สำเร็จ/i.test(await admin.locator('main').innerText()) &&
    (await admin.locator('.data-space .resource-state .badge').allInnerTexts()).every((t) => t.trim() === 'ยังไม่ได้เชื่อม') &&
    (await admin.locator('.data-space .badge-active, .data-space .resource-state a').count()) === 0)
  await shot(admin, 'live-sources-not-configured-1440')
  check('[จริง] แหล่งข้อมูล: ยังไม่ได้เชื่อมบัญชี Google จึงไม่มีปุ่มสร้างหรือเลือกแหล่งข้อมูล และบอกว่าต้องเชื่อมบัญชีก่อน',
    (await admin.locator('.data-space').getByRole('button').count()) === 0 && spaceText.includes('ต้องเชื่อมบัญชี Google ของชมรมด้านบนให้ใช้งานได้ก่อน'))

  await a.goto(`${BASE}/sources`)
  await a.locator('.connection-card').waitFor()
  check('[จริง] staff ที่หน้าแหล่งข้อมูล: ไม่เห็นชื่อค่าตั้งและไม่มีปุ่มจัดการการเชื่อม',
    !(await a.locator('.connection-card').innerText()).includes('TOKEN_ENCRYPTION_KEY') &&
    (await a.locator('.connection-card').getByRole('button').count()) === 0 &&
    (await a.locator('.connection-card').getByText('ทำได้เฉพาะผู้ดูแลระบบ').isVisible()))
  await a.goto(`${BASE}/`)
  check('[จริง] ภาพรวม: สรุปแหล่งข้อมูลใช้สถานะจาก server',
    (await appears(a.locator('.source-summary', { hasText: 'ยังไม่ได้เลือกชีต' }))) && (await a.locator('.source-summary li').count()) === 6 &&
    !(await a.locator('.overview-sources').innerText()).includes('ข้อมูลตัวอย่าง'))
  await shot(a, 'live-overview-1440')

  // สถานะเชื่อมแล้ว / ต้องเชื่อมใหม่ (จำลองคำตอบ /api/sources เพื่อดูหน้าจอ)
  const sourcesMock = (google, docs) => ({
    google: { expectedEmail: 'muesport2567@gmail.com', email: 'muesport2567@gmail.com', connectedAt: '2026-10-01T03:00:00.000Z', lastCheckedAt: '2026-10-04T10:05:00.000Z', lastError: null, missingConfig: [], ...google },
    resources: [{ id: 'docs', status: docs }, { id: 'sheets', status: 'not_selected' }, { id: 'calendar', status: 'not_selected' }, { id: 'forms', status: 'not_selected' }, { id: 'excel', status: 'disabled' }],
  })
  for (const [name, google, docs, expectText] of [
    ['connected', { status: 'connected' }, 'ready', 'เชื่อมแล้ว'],
    ['needs-reconnect', { status: 'needs_reconnect', lastError: 'invalid_grant' }, 'needs_connection', 'ต้องเชื่อมใหม่'],
  ]) {
    for (const width of [1440, 390]) {
      const p = await newPage(width, width === 390 ? 844 : 900, actors.admin)
      await p.route('**/api/sources', (route) => route.fulfill({ json: sourcesMock(google, docs) }))
      await p.goto(`${BASE}/sources`)
      await p.locator('.connection-card').waitFor()
      const text = await p.locator('.connection-card').innerText()
      await p.locator('.data-space .resource-state').nth(2).waitFor()
      const space = p.locator('.data-space')
      check(`[จำลอง] แหล่งข้อมูลสถานะ ${name} ${width}px: แสดงบัญชี สถานะ เวลาตรวจล่าสุด และ Sheets/Calendar/Forms ยังไม่ได้เชื่อม (ปุ่มสร้างชุดข้อมูลมีเฉพาะเมื่อบัญชีเชื่อมอยู่)`,
        text.includes(expectText) && text.includes('4 ต.ค. 2569 17:05 น.') && text.includes('muesport2567@gmail.com') &&
        ((await space.innerText()).match(/ยังไม่ได้เชื่อม/g) ?? []).length === 3 && (await space.getByRole('button', { name: 'สร้างชุดข้อมูลชมรม' }).count()) === (name === 'connected' ? 1 : 0) &&
        (await noOverflow(p)) &&
        (await p.getByRole('button', { name: 'ตัดการเชื่อม' }).isVisible()))
      await shot(p, `live-sources-${name}-${width}`)
      if (name === 'connected' && width === 1440) {
        await p.getByRole('button', { name: 'ตัดการเชื่อม' }).click()
        check('[จำลอง] ตัดการเชื่อม: อธิบายผลก่อนยืนยัน (ไม่ลบไฟล์ Google และข้อมูลในเว็บ)',
          (await appears(p.locator('dialog[open]').getByText('ไฟล์ ปฏิทิน และฟอร์มใน Google ของชมรมไม่ถูกลบ'))) && (await p.locator('dialog[open]').getByText('จะหยุดซิงค์กับ Google Sheets, Calendar และ Forms').isVisible()))
        await p.screenshot({ path: `${OUT}/live-sources-disconnect-confirm-1440.png` })
      }
      await p.context().close()
    }
  }

  // ================= 6. เอกสาร: ส่วนที่คุยกับ Worker จริง =================
  await a.locator('.sidebar').getByRole('link', { name: 'เอกสาร', exact: true }).click()
  check('[จริง] เอกสาร: รายการว่างบอกสิ่งที่ทำได้ และไม่ดึงเอกสารอื่นใน Drive',
    (await appears(a.getByText('ยังไม่มีเอกสาร'))) && (await a.getByText('เอกสารอื่นใน Google Drive ของชมรมจะไม่ถูกดึงเข้ามา').isVisible()))
  await shot(a, 'live-documents-empty-1440')
  await a.getByRole('link', { name: 'สร้างเอกสารแรก' }).click()
  await a.getByRole('button', { name: 'สร้างเอกสาร' }).click()
  check('[จริง] สร้างเอกสาร: ชื่อบังคับ ตรวจก่อนส่ง และ focus ไปที่ช่องชื่อ',
    (await appears(a.locator('#document-title-error', { hasText: 'กรอกชื่อเอกสาร' }))) && (await a.evaluate(() => document.activeElement?.id)) === 'document-title')
  await a.locator('#document-title').fill('ทดสอบสร้างเอกสารจริง')
  await a.locator('#document-text').fill('บรรทัดแรก\nบรรทัดที่สอง 🎮')
  const errorsBeforeCreate = consoleErrors.length
  await a.getByRole('button', { name: 'สร้างเอกสาร' }).click()
  const createAlert = a.locator('.editor-card .form-alert')
  check('[จริง] สร้างเอกสารขณะยังไม่ได้เชื่อม Google: Worker ปฏิเสธ แจ้งเหตุผลจริง ไม่แสดงว่าสร้างแล้ว และ draft ยังอยู่',
    (await appears(createAlert)) && (await createAlert.innerText()).includes('ยังไม่ได้เชื่อมบัญชี Google ของชมรม') &&
    (await createAlert.innerText()).includes('ยังไม่ได้ส่งคำสั่งสร้างไฟล์ไป Google Docs') &&
    (await a.locator('#document-text').inputValue()) === 'บรรทัดแรก\nบรรทัดที่สอง 🎮' && new URL(a.url()).pathname === '/documents/new' &&
    (await a.locator('.toast').count()) === 0)
  await shot(a, 'live-document-create-not-connected-1440')
  ignoreErrorsSince(errorsBeforeCreate)
  const realDocs = JSON.parse((await apiAs(a, '/api/documents')).body).documents
  check('[จริง] ไม่มีเอกสารปลอมถูกลงทะเบียนเมื่อ Google ยังไม่ได้เชื่อม', realDocs.length === 0)

  // เตือนก่อนทิ้งการแก้
  await a.locator('.sidebar').getByRole('link', { name: 'สมาชิก' }).click()
  const leaveDialog = a.locator('dialog[open]', { hasText: 'ออกจากหน้านี้โดยไม่บันทึก?' })
  check('[จริง] มี draft แล้วกดเมนูไปหน้าอื่น: ถามก่อนทิ้ง', await appears(leaveDialog))
  await a.screenshot({ path: `${OUT}/live-document-leave-confirm-1440.png` })
  await a.keyboard.press('Escape')
  check('[จริง] ยกเลิกการออก: ยังอยู่หน้าเดิมและ draft ยังอยู่',
    (await gone(leaveDialog)) && new URL(a.url()).pathname === '/documents/new' && (await a.locator('#document-title').inputValue()) === 'ทดสอบสร้างเอกสารจริง')
  await a.goBack()
  check('[จริง] ปุ่มย้อนกลับของเบราว์เซอร์ขณะมี draft: ถามก่อนทิ้งเช่นกัน', await appears(leaveDialog))
  await leaveDialog.getByRole('button', { name: 'กลับไปแก้ไขต่อ' }).click()

  // session หมดอายุระหว่างแก้เอกสาร
  const a2 = await newPage(800, 600, actors.a, 0)
  await a2.goto(`${BASE}/`)
  await a2.locator('h1').waitFor()
  const loggedOut = await apiAs(a2, '/auth/logout', { method: 'POST' })
  await a2.context().close()
  const errorsBeforeExpire = consoleErrors.length
  await a.getByRole('button', { name: 'สร้างเอกสาร' }).click()
  const expiredDialog = a.locator('dialog[open]', { hasText: 'เซสชันหมดอายุ' })
  check('[จริง] session ถูกยกเลิกระหว่างแก้เอกสาร: แจ้งเซสชันหมดอายุ และ draft ยังอยู่ในหน้า',
    loggedOut.status === 200 && (await appears(expiredDialog)) && (await a.locator('#document-text').inputValue()) === 'บรรทัดแรก\nบรรทัดที่สอง 🎮')
  await a.screenshot({ path: `${OUT}/live-session-expired-1440.png` })
  await expiredDialog.getByRole('button', { name: 'เข้าสู่ระบบแล้ว ทำงานต่อ' }).click()
  check('[จริง] ยังไม่ได้เข้าสู่ระบบใหม่แล้วกดทำงานต่อ: บอกว่ายังไม่พบการเข้าสู่ระบบ', await appears(expiredDialog.getByText('ยังไม่พบการเข้าสู่ระบบ')))
  await expiredDialog.getByRole('button', { name: 'ปิดไว้ก่อน' }).click()
  check('[จริง] ปิด dialog ไว้ก่อน: แถบเตือนยังอยู่ และคัดลอก draft ได้',
    (await a.locator('.session-banner').isVisible()) && (await a.locator('#document-text').inputValue()).includes('บรรทัดที่สอง'))
  // เข้าสู่ระบบใหม่ด้วยบัญชีเดิม (จำลองด้วย session ที่สองของผู้ใช้เดิมที่สร้างไว้ในฐานทดสอบ)
  await a.context().addCookies([{ name: 'mu_session', value: actors.a.tokens[1], url: BASE, httpOnly: true, sameSite: 'Lax' }])
  await a.locator('.session-banner').getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }).click()
  await expiredDialog.getByRole('button', { name: 'เข้าสู่ระบบแล้ว ทำงานต่อ' }).click()
  check('[จริง] เข้าสู่ระบบใหม่ด้วยบัญชีเดิม: กลับมาทำงานต่อได้ draft ยังอยู่',
    (await gone(a.locator('.session-banner'))) && (await a.locator('#document-title').inputValue()) === 'ทดสอบสร้างเอกสารจริง' &&
    JSON.parse((await apiAs(a, '/api/session')).body).user.email === 'staff.a@example.com')
  ignoreErrorsSince(errorsBeforeExpire)

  // เข้าสู่ระบบใหม่เป็นอีกบัญชี: draft ต้องไม่ถูกส่งต่อ
  const switcher = await newPage(1280, 800, actors.a, 1)
  await switcher.goto(`${BASE}/documents/new`)
  await switcher.locator('#document-title').fill('draft ของ A')
  await switcher.locator('#document-text').fill('ข้อความลับของ A')
  await switcher.route('**/api/documents', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 401, json: { error: 'unauthenticated', message: 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว' } }) : route.fallback()))
  const errorsBeforeSwitch = consoleErrors.length
  await switcher.getByRole('button', { name: 'สร้างเอกสาร' }).click()
  await switcher.locator('dialog[open]', { hasText: 'เซสชันหมดอายุ' }).waitFor()
  await switcher.context().clearCookies()
  await switcher.context().addCookies([{ name: 'mu_session', value: actors.b.tokens[0], url: BASE, httpOnly: true, sameSite: 'Lax' }])
  await switcher.getByRole('button', { name: 'เข้าสู่ระบบแล้ว ทำงานต่อ' }).click()
  await switcher.waitForURL(`${BASE}/`, { timeout: 8000 }).catch(() => undefined)
  await switcher.locator('.topbar .account').waitFor()
  check('[จริง] เข้าสู่ระบบใหม่เป็นอีกบัญชี: หน้าโหลดใหม่เป็นบัญชีนั้น และ draft ของบัญชีเดิมไม่ถูกส่งต่อ',
    (await switcher.locator('.topbar .account').innerText()).includes('staff.b@example.com') && new URL(switcher.url()).pathname === '/' &&
    !(await switcher.locator('body').innerText()).includes('ข้อความลับของ A'))
  await switcher.unroute('**/api/documents')
  await switcher.goto(`${BASE}/documents/new`)
  check('[จริง] เปิดหน้าสร้างเอกสารด้วยบัญชีใหม่: ช่องว่าง ไม่มี draft เดิม',
    (await switcher.locator('#document-title').inputValue()) === '' && (await switcher.locator('#document-text').inputValue()) === '')
  ignoreErrorsSince(errorsBeforeSwitch)
  await switcher.context().close()

  // ================= 7. เอกสาร: สถานะของหน้าจอด้วย API จำลอง =================
  const iso = (minutesAgo) => new Date(Date.now() - minutesAgo * 60000).toISOString()
  const LONG = 'รายงานสรุปผลการแข่งขันและแผนการฝึกซ้อมประจำภาคเรียนที่หนึ่ง ปีการศึกษา 2569 ฉบับปรับปรุงครั้งที่สาม'
  const BODY = 'วาระที่ 1 เรื่องแจ้งเพื่อทราบ\nทีมงานรายงานความคืบหน้า 🎮\n\nวาระที่ 2 แผนการฝึกซ้อม\n' + 'รายละเอียดการฝึกซ้อมประจำสัปดาห์ '.repeat(150)

  /** API เอกสารจำลองในเบราว์เซอร์ทดสอบ ใช้ดูสถานะของหน้าจอเท่านั้น */
  async function mockDocuments(page, state) {
    const docs = () => state.docs.map(({ text: _t, revision: _r, editable: _e, reasons: _x, ...info }) => info)
    await page.route('**/api/documents**', async (route) => {
      const request = route.request()
      const url = new URL(request.url())
      const method = request.method()
      const parts = url.pathname.split('/').slice(3)
      if (state.delay) await new Promise((resolve) => setTimeout(resolve, state.delay))
      const json = (body, status = 200) => route.fulfill({ status, json: body })
      const content = (d) => ({ text: d.text, revisionId: `rev-${d.revision}`, editable: d.editable !== false, reasons: d.reasons ?? [] })
      const info = (d) => docs().find((x) => x.id === d.id)

      if (parts.length === 0 && method === 'GET') return state.listFails ? json({ error: 'internal_error', message: 'ระบบขัดข้อง ลองอีกครั้งในอีกสักครู่' }, 500) : json({ documents: docs() })
      if (parts[0] === 'operations' && method === 'GET') return json({ operations: state.operations ?? [] })
      if (parts[0] === 'operations' && method === 'POST') {
        state.resumeBodies = [...(state.resumeBodies ?? []), request.postDataJSON()]
        if (parts[1] === 'op-unknown' && !request.postDataJSON().confirmCreate) {
          return json({ error: 'operation_create_unknown', message: 'ไม่ทราบว่า Google Docs สร้างไฟล์ของงานนี้แล้วหรือยัง ระบบค้นหาแล้วยังไม่พบไฟล์ แต่ไฟล์ที่เพิ่งสร้างอาจยังไม่ปรากฏในผลค้นหา จึงยังไม่สร้างใหม่เพื่อไม่ให้เกิดไฟล์ซ้ำ', operationId: 'op-unknown', fileState: 'unknown', canConfirmCreate: true }, 409)
        }
        state.operations = []
        const d = { id: 'doc-resumed', title: 'เอกสารที่ค้างไว้', status: 'ok', statusDetail: '', googleUrl: 'https://docs.google.com/document/d/mock-resumed/edit', createdAt: iso(1), updatedAt: iso(0), lastCheckedAt: iso(0), createdByName: 'ทีมงาน เอ', updatedByName: 'ทีมงาน เอ', text: 'x', revision: 1 }
        state.docs.unshift(d)
        return json({ document: info(d) }, 201)
      }
      if (parts.length === 0 && method === 'POST') {
        state.createCalls = (state.createCalls ?? 0) + 1
        state.createKeys = [...(state.createKeys ?? []), request.headers()['idempotency-key']]
        if (state.createFailsOnce && state.createCalls === 1) {
          return json({ error: 'google_unavailable', message: 'ติดต่อ Google ไม่สำเร็จ (ไม่ทราบว่า Google Docs สร้างไฟล์แล้วหรือยัง เพราะคำสั่งไปถึง Google แต่ไม่ได้รับคำตอบที่ยืนยันได้ ระบบจะไม่สร้างไฟล์ใหม่เองเพื่อไม่ให้เกิดไฟล์ซ้ำ กด “ลองอีกครั้ง” เพื่อให้ระบบค้นหาไฟล์เดิม)', operationId: 'op-1', fileState: 'unknown', fileCreated: false }, 502)
        }
        if (state.createInProgressOnce) {
          state.createInProgressOnce = false
          return json({ error: 'operation_in_progress', message: 'กำลังสร้างเอกสารนี้อยู่จากคำขอก่อนหน้า รอสักครู่แล้วกด “ลองอีกครั้ง” ระบบจะไม่สร้างไฟล์ซ้ำ', operationId: 'op-1', fileState: 'unknown' }, 409)
        }
        const body = request.postDataJSON()
        const d = { id: 'doc-new', title: body.title, status: 'ok', statusDetail: '', googleUrl: 'https://docs.google.com/document/d/mock-new/edit', createdAt: iso(0), updatedAt: iso(0), lastCheckedAt: iso(0), createdByName: 'ทีมงาน เอ', updatedByName: 'ทีมงาน เอ', text: body.text, revision: 1 }
        state.docs.unshift(d)
        return json({ document: info(d), content: content(d) }, 201)
      }
      const d = state.docs.find((x) => x.id === parts[0])
      if (!d) return json({ error: 'not_found', message: 'ไม่พบเอกสารนี้ในระบบ ลิงก์อาจไม่ถูกต้อง' }, 404)
      if (method === 'GET') {
        if (state.readFails > 0) {
          state.readFails--
          return json({ error: 'google_error', message: 'Google ตอบกลับผิดพลาด ลองอีกครั้งในอีกสักครู่' }, 502)
        }
        if (d.status === 'unavailable') return json({ error: 'document_unavailable', message: 'เปิดเอกสารนี้จาก Google ไม่ได้ อาจถูกลบ หรือบัญชี Google ของชมรมไม่มีสิทธิ์เข้าถึงไฟล์นี้แล้ว' }, 404)
        return json({ document: info(d), content: content(d) })
      }
      if (method === 'PUT') {
        const body = request.postDataJSON()
        state.saves = [...(state.saves ?? []), body]
        if (state.saveFailsOnce) {
          state.saveFailsOnce = false
          return json({ error: 'google_error', message: 'Google ตอบกลับผิดพลาด ลองอีกครั้งในอีกสักครู่' }, 502)
        }
        if (body.title !== undefined && body.title !== d.title) {
          return json({ error: 'title_change_not_supported', message: 'เปลี่ยนชื่อเอกสารจากเว็บนี้ไม่ได้ ยังไม่ได้บันทึกอะไร เปิดเอกสารใน Google Docs เพื่อเปลี่ยนชื่อ', currentTitle: d.title }, 409)
        }
        if (state.saveUnknownOnce) {
          // Google ใช้คำสั่งไปแล้ว แต่คำตอบที่ได้ยืนยันไม่ได้
          state.saveUnknownOnce = false
          d.text = body.text
          d.revision++
          return json({ error: 'save_outcome_unknown', message: 'ไม่ทราบว่า Google Docs บันทึกการแก้ครั้งนี้แล้วหรือยัง (คำสั่งไปถึง Google แต่ไม่ได้รับคำตอบที่ยืนยันได้) ตรวจฉบับล่าสุดก่อนบันทึกซ้ำ' }, 502)
        }
        if (body.baseRevisionId !== `rev-${d.revision}`) {
          return json({ error: 'revision_conflict', message: 'เอกสารถูกแก้ไขจากที่อื่นหลังจากที่คุณเปิด', latest: { title: d.title, ...content(d) } }, 409)
        }
        d.text = body.text
        d.revision++
        d.updatedAt = iso(0)
        return json({ document: info(d), content: content(d), verified: true })
      }
      return json({ error: 'not_found', message: 'ไม่พบเส้นทาง API นี้' }, 404)
    })
  }
  const mockState = () => ({
    docs: [
      { id: 'doc-1', title: 'บันทึกการประชุมทีมงาน ครั้งที่ 12', status: 'ok', statusDetail: '', googleUrl: 'https://docs.google.com/document/d/mock-1/edit', createdAt: iso(3000), updatedAt: iso(12), lastCheckedAt: iso(12), createdByName: 'ทีมงาน เอ', updatedByName: 'ทีมงาน บี', text: BODY, revision: 7 },
      { id: 'doc-2', title: LONG, status: 'read_only', statusDetail: 'มีตาราง · มีรูปภาพหรือวัตถุแทรก', googleUrl: 'https://docs.google.com/document/d/mock-2/edit', createdAt: iso(9000), updatedAt: iso(1500), lastCheckedAt: iso(60), createdByName: 'MU Esport', updatedByName: 'MU Esport', text: 'สรุปผลการแข่งขัน\n(ตารางคะแนนอยู่ใน Google Docs)', revision: 3, editable: false, reasons: ['มีตาราง', 'มีรูปภาพหรือวัตถุแทรก'] },
      { id: 'doc-3', title: 'ร่างประกาศรับสมัคร', status: 'unavailable', statusDetail: '', googleUrl: 'https://docs.google.com/document/d/mock-3/edit', createdAt: iso(20000), updatedAt: iso(8000), lastCheckedAt: iso(30), createdByName: 'ทีมงาน เอ', updatedByName: 'ทีมงาน เอ', text: '', revision: 1 },
    ],
    operations: [{ id: 'op-9', title: 'เอกสารที่ค้างไว้', status: 'file_created', fileState: 'created', fileCreated: true, inProgress: false, canConfirmCreate: false, googleUrl: 'https://docs.google.com/document/d/mock-op/edit', lastError: 'google_error', createdAt: iso(45), userName: 'ทีมงาน เอ' }],
  })

  const d = await newPage(1440, 900, actors.a, 1)
  const state = mockState()
  await mockDocuments(d, state)
  state.delay = 700
  await d.goto(`${BASE}/documents`)
  check('[จำลอง] รายการเอกสาร: มีสถานะกำลังโหลด', await appears(d.getByText('กำลังโหลดรายการเอกสาร…'), 2000))
  await d.locator('.document-row').first().waitFor()
  state.delay = 0
  const listText = await d.locator('.document-list').innerText()
  check('[จำลอง] รายการเอกสาร: ชื่อ เวลาแก้ล่าสุด ผู้แก้ในเว็บ สถานะ และทางเปิด editor/Google Docs',
    (await d.locator('.document-row').count()) === 3 && listText.includes('โดย ทีมงาน บี') && listText.includes('แก้ในเว็บได้') &&
    listText.includes('อ่านอย่างเดียวในเว็บ') && listText.includes('เปิดจาก Google ไม่ได้') &&
    (await d.locator('.document-row').first().getByRole('link', { name: /Google Docs/ }).getAttribute('target')) === '_blank' &&
    (await d.locator('.document-row').first().getByRole('link', { name: /Google Docs/ }).getAttribute('rel')).includes('noopener'))
  check('[จำลอง] รายการเอกสาร: งานสร้างที่ค้างแสดงสถานะตามจริงพร้อมปุ่มทำต่อ',
    (await d.locator('.pending-card').innerText()).includes('สร้างไฟล์ใน Google Docs แล้ว แต่ยังเขียนเนื้อหาหรือลงทะเบียนไม่ครบ') &&
    (await d.getByRole('button', { name: 'ทำต่อให้เสร็จ' }).isVisible()))
  await shot(d, 'live-documents-list-1440')
  await d.locator('#document-search').fill('ประกาศ')
  check('[จำลอง] ค้นหาชื่อเอกสาร', (await d.locator('.document-row').count()) === 1 && (await d.getByText('พบ 1 จาก 3 ฉบับ').isVisible()))
  await d.locator('#document-search').fill('ไม่มีชื่อนี้')
  check('[จำลอง] ค้นหาไม่พบ: มีข้อความและปุ่มล้าง', (await appears(d.getByText('ไม่พบเอกสารที่ชื่อตรงกับคำค้นหา'))) && (await d.getByRole('button', { name: 'ล้างคำค้นหา' }).isVisible()))
  await d.screenshot({ path: `${OUT}/live-documents-no-results-1440.png` })
  await d.getByRole('button', { name: 'ล้างคำค้นหา' }).click()

  // เปิด editor
  state.delay = 700
  await d.locator('.document-row').first().getByRole('link', { name: /เปิด .* ในเว็บ/ }).click()
  check('[จำลอง] editor: มีสถานะกำลังโหลดเนื้อหาจาก Google Docs และ URL คงที่ /documents/<id>',
    (await appears(d.getByText('กำลังโหลดเนื้อหาล่าสุดจาก Google Docs…'), 2000)) && new URL(d.url()).pathname === '/documents/doc-1')
  await d.locator('#document-text').waitFor()
  state.delay = 0
  const saveButton = d.getByRole('button', { name: 'บันทึก', exact: true })
  check('[จำลอง] editor: โหลดชื่อและเนื้อหา ยังไม่มีการแก้ ปุ่มบันทึกปิดอยู่',
    (await d.locator('#document-title').inputValue()) === 'บันทึกการประชุมทีมงาน ครั้งที่ 12' && (await d.locator('#document-text').inputValue()) === BODY &&
    (await saveButton.isDisabled()) && (await d.locator('.editor-status').innerText()).includes('ตรงกับฉบับใน Google Docs'))
  await d.locator('#document-text').press('Control+End')
  await d.locator('#document-text').pressSequentially('\nเพิ่มบรรทัดใหม่ 🏆')
  check('[จำลอง] editor: แก้แล้วแสดงว่ายังไม่ได้บันทึก และนับตัวอักษร',
    (await d.locator('.editor-status').innerText()).includes('มีการแก้ไขที่ยังไม่ได้บันทึก') && (await saveButton.isEnabled()) &&
    (await d.locator('#document-text-count').innerText()).includes(`${(BODY.length + '\nเพิ่มบรรทัดใหม่ 🏆'.length).toLocaleString('en-US')} / 50,000`))
  await shot(d, 'live-document-editor-dirty-1440')

  state.delay = 900
  await saveButton.click()
  check('[จำลอง] editor: ระหว่างรอ Google แสดงกำลังบันทึก ยังไม่บอกว่าบันทึกแล้ว',
    (await appears(d.locator('.editor-status', { hasText: 'กำลังบันทึกไป Google Docs…' }), 800)) && (await d.getByText(/บันทึกแล้วเมื่อ/).count()) === 0)
  await d.screenshot({ path: `${OUT}/live-document-saving-1440.png` })
  await d.locator('.editor-status', { hasText: 'บันทึกแล้วเมื่อ' }).waitFor()
  check('[จำลอง] editor: ชื่อเอกสารที่สร้างแล้วเป็นช่องอ่านอย่างเดียว บอกให้เปลี่ยนใน Google Docs และคำขอบันทึกไม่ส่งชื่อ',
    (await d.locator('#document-title').getAttribute('readonly')) !== null && (await d.locator('#document-title-hint').innerText()).includes('เปลี่ยนได้ใน Google Docs') &&
    !('title' in state.saves.at(-1)))
  check('[จำลอง] editor: Google ยืนยันแล้วจึงแสดงบันทึกแล้ว และส่ง revision ที่โหลดมา',
    (await appears(d.locator('.editor-status', { hasText: 'บันทึกแล้วเมื่อ' }))) && state.saves.at(-1).baseRevisionId === 'rev-7' && state.saves.at(-1).text.endsWith('เพิ่มบรรทัดใหม่ 🏆'))
  state.delay = 0
  await shot(d, 'live-document-saved-1440')

  // บันทึกล้มเหลว เก็บ draft และลองใหม่
  await d.locator('#document-text').pressSequentially('\nบรรทัดที่จะล้มเหลวก่อน')
  state.saveFailsOnce = true
  const errorsBeforeSaveFail = consoleErrors.length
  await saveButton.click()
  const saveAlert = d.locator('.editor-card .form-alert')
  check('[จำลอง] editor: บันทึกล้มเหลว แจ้งในหน้า เก็บ draft และยังเป็นสถานะยังไม่ได้บันทึก',
    (await appears(saveAlert)) && (await saveAlert.innerText()).includes('สิ่งที่พิมพ์ไว้ยังอยู่ครบ') && (await d.locator('#document-text').inputValue()).endsWith('บรรทัดที่จะล้มเหลวก่อน') &&
    (await d.locator('.editor-status').innerText()).includes('ยังไม่ได้บันทึก'))
  await shot(d, 'live-document-save-failed-1440')
  await saveButton.click()
  check('[จำลอง] editor: ลองบันทึกอีกครั้งสำเร็จ ข้อความผิดพลาดหายไป', (await appears(d.locator('.editor-status', { hasText: 'บันทึกแล้วเมื่อ' }))) && (await saveAlert.count()) === 0)
  ignoreErrorsSince(errorsBeforeSaveFail)

  // ผลการบันทึกไม่แน่ชัด: Google อาจใช้คำสั่งไปแล้ว
  await d.locator('#document-text').pressSequentially('\nบรรทัดที่ไม่ทราบผล')
  const uncertain = await d.locator('#document-text').inputValue()
  state.saveUnknownOnce = true
  await saveButton.click()
  check('[จำลอง] editor: ไม่ทราบผลการบันทึก ไม่บอกว่าบันทึกแล้วหรือไม่มีอะไรเปลี่ยน เก็บ draft และให้ตรวจฉบับล่าสุดก่อนบันทึกซ้ำ',
    (await appears(saveAlert.getByText('ไม่ทราบว่า Google Docs บันทึกการแก้ครั้งนี้แล้วหรือยัง'))) && (await d.locator('#document-text').inputValue()) === uncertain &&
    (await d.getByText(/ยังไม่มีการเปลี่ยนแปลง/).count()) === 0 && !(await d.locator('.editor-status').innerText()).includes('บันทึกแล้ว') &&
    (await saveButton.isDisabled()) && (await saveAlert.getByRole('button', { name: 'ตรวจฉบับล่าสุดจาก Google Docs' }).isVisible()))
  await shot(d, 'live-document-save-unknown-1440')
  await saveAlert.getByRole('button', { name: 'ตรวจฉบับล่าสุดจาก Google Docs' }).click()
  check('[จำลอง] editor: ตรวจฉบับล่าสุดแล้วตรงกับที่พิมพ์ จึงยืนยันว่าบันทึกแล้ว',
    (await appears(d.locator('.editor-status', { hasText: 'บันทึกแล้วเมื่อ' }))) && (await saveAlert.count()) === 0 && (await d.locator('#document-text').inputValue()) === uncertain)

  // ผลไม่แน่ชัด และฉบับล่าสุดไม่ตรงกับที่พิมพ์: ให้เทียบและเลือกเอง
  await d.locator('#document-text').pressSequentially('\nบรรทัดที่ Google ไม่ได้บันทึก')
  const unsaved = await d.locator('#document-text').inputValue()
  state.saveUnknownOnce = true
  await saveButton.click()
  await saveAlert.getByRole('button', { name: 'ตรวจฉบับล่าสุดจาก Google Docs' }).waitFor()
  state.docs[0].text = uncertain
  await saveAlert.getByRole('button', { name: 'ตรวจฉบับล่าสุดจาก Google Docs' }).click()
  check('[จำลอง] editor: ตรวจฉบับล่าสุดแล้วไม่ตรง แสดงฉบับล่าสุดให้เทียบ และ draft ยังอยู่',
    (await appears(d.locator('.conflict-card'))) && (await d.locator('#document-latest').inputValue()) === uncertain && (await d.locator('#document-text').inputValue()) === unsaved)
  await d.locator('.conflict-card').getByRole('button', { name: 'บันทึกฉบับของฉันทับฉบับล่าสุด' }).click()
  await d.locator('.editor-status', { hasText: 'บันทึกแล้วเมื่อ' }).waitFor()

  // conflict
  await d.locator('#document-text').pressSequentially('\nส่วนที่ฉันกำลังแก้')
  const mine = await d.locator('#document-text').inputValue()
  state.docs[0].text = 'ฉบับที่คนอื่นแก้ใน Google Docs\nบรรทัดสอง'
  state.docs[0].revision++
  const errorsBeforeConflict = consoleErrors.length
  await saveButton.click()
  const conflictCard = d.locator('.conflict-card')
  check('[จำลอง] editor: revision conflict แจ้งชัด เก็บ draft ของผู้ใช้ และแสดงฉบับล่าสุดให้ตรวจ',
    (await appears(conflictCard)) && (await d.locator('#document-text').inputValue()) === mine &&
    (await d.locator('#document-latest').inputValue()) === 'ฉบับที่คนอื่นแก้ใน Google Docs\nบรรทัดสอง' && (await saveButton.isDisabled()))
  await shot(d, 'live-document-conflict-1440')
  await conflictCard.getByRole('button', { name: /ใช้ฉบับล่าสุด/ }).click()
  check('[จำลอง] conflict: เลือกใช้ฉบับล่าสุดต้องยืนยันก่อนทิ้งสิ่งที่แก้', await appears(d.locator('dialog[open]', { hasText: 'ทิ้งสิ่งที่คุณแก้' })))
  await d.locator('dialog[open]').getByRole('button', { name: 'กลับไปตรวจต่อ' }).click()
  check('[จำลอง] conflict: ยกเลิกแล้ว draft ยังอยู่', (await d.locator('#document-text').inputValue()) === mine)
  await conflictCard.getByRole('button', { name: 'บันทึกฉบับของฉันทับฉบับล่าสุด' }).click()
  check('[จำลอง] conflict: บันทึกทับหลังตรวจ ใช้ revision ล่าสุดที่เพิ่งเห็น',
    (await appears(d.locator('.editor-status', { hasText: 'บันทึกแล้วเมื่อ' }))) && state.saves.at(-1).baseRevisionId === 'rev-13' && state.docs[0].text === mine && (await conflictCard.count()) === 0)
  ignoreErrorsSince(errorsBeforeConflict)

  // ขีดจำกัดความยาว
  await d.locator('#document-text').fill('ก'.repeat(50001))
  check('[จำลอง] editor: เกิน 50,000 ตัวอักษร แจ้งก่อนส่งและปุ่มบันทึกปิด',
    (await d.locator('#document-text-count').innerText()).includes('ยาวเกิน 1 ตัวอักษร') && (await saveButton.isDisabled()))
  await d.screenshot({ path: `${OUT}/live-document-too-long-1440.png` })
  await d.locator('#document-text').fill(`${'ก'.repeat(49996)}🎮🎮`)
  check('[จำลอง] editor: นับ emoji เป็น 2 หน่วยตาม UTF-16 (49,996 + 2 emoji = 50,000 พอดี)',
    (await d.locator('#document-text-count').innerText()).startsWith('50,000 / 50,000') && (await saveButton.isEnabled()))

  // คีย์บอร์ด
  await d.locator('#document-title').focus()
  await d.keyboard.press('Tab')
  const focusOnText = await d.evaluate(() => document.activeElement?.id)
  await d.keyboard.press('Tab')
  const focusAfterText = await d.evaluate(() => document.activeElement?.textContent?.trim() ?? '')
  check('[จำลอง] คีย์บอร์ด: Tab จากชื่อไปเนื้อหา แล้วออกจากช่องเนื้อหาไปปุ่มถัดไปได้ (ไม่ติดอยู่ในช่อง)',
    focusOnText === 'document-text' && focusAfterText.includes('ยกเลิก'), focusAfterText)

  // เอกสาร rich และสถานะผิดพลาด
  await d.locator('#document-text').fill(BODY)
  await saveButton.click()
  await d.locator('.editor-status', { hasText: 'บันทึกแล้วเมื่อ' }).waitFor()
  await d.goto(`${BASE}/documents/doc-2`)
  await d.locator('#document-text').waitFor()
  check('[จำลอง] เอกสารที่มีโครงสร้าง rich: เปิดอ่านได้อย่างเดียว บอกเหตุผล ไม่มีปุ่มบันทึก และมีทางไป Google Docs',
    (await d.getByText('เอกสารนี้แก้ในเว็บไม่ได้ เปิดอ่านได้อย่างเดียว').isVisible()) && (await d.getByText('มีตาราง').first().isVisible()) &&
    (await d.locator('#document-text').getAttribute('readonly')) !== null && (await d.getByRole('button', { name: 'บันทึก', exact: true }).count()) === 0 &&
    (await d.getByRole('link', { name: 'เปิดแก้ใน Google Docs' }).getAttribute('href')).includes('mock-2'))
  await shot(d, 'live-document-read-only-1440')

  const errorsBeforeUnavailable = consoleErrors.length
  await d.goto(`${BASE}/documents/doc-3`)
  check('[จำลอง] เอกสารที่เปิดจาก Google ไม่ได้: บอกเหตุผล มีลองใหม่และทางกลับ',
    (await appears(d.getByText('เปิดเอกสารไม่สำเร็จ'))) && (await d.getByText('อาจถูกลบ หรือบัญชี Google ของชมรมไม่มีสิทธิ์').isVisible()) &&
    (await d.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }).isVisible()) && (await d.getByRole('link', { name: 'กลับไปรายการเอกสาร' }).isVisible()))
  await shot(d, 'live-document-unavailable-1440')
  await d.goto(`${BASE}/documents/no-such-doc`)
  check('[จำลอง] เอกสารที่ไม่มีในระบบ: แจ้งไม่พบและมีทางกลับ', (await appears(d.getByText('ไม่พบเอกสารนี้', { exact: true }))) && (await d.getByRole('link', { name: 'กลับไปรายการเอกสาร' }).isVisible()))
  state.readFails = 2 // โหมดพัฒนาของ React เรียก effect สองรอบ จึงให้ล้มเหลวทั้งสองคำขอแรก
  await d.goto(`${BASE}/documents/doc-1`)
  await d.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }).click()
  check('[จำลอง] โหลดเอกสารล้มเหลวแล้วลองใหม่ได้', await appears(d.locator('#document-text')))
  state.listFails = true
  await d.goto(`${BASE}/documents`)
  check('[จำลอง] รายการเอกสารโหลดไม่สำเร็จ: มีข้อผิดพลาดและปุ่มลองใหม่', (await appears(d.getByText('โหลดรายการเอกสารไม่สำเร็จ'))) && (await d.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }).isVisible()))
  state.listFails = false
  await d.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }).click()
  await d.locator('.document-row').first().waitFor()
  ignoreErrorsSince(errorsBeforeUnavailable)

  // งานค้าง: ทำต่อ
  await d.getByRole('button', { name: 'ทำต่อให้เสร็จ' }).click()
  check('[จำลอง] งานสร้างที่ค้าง: ทำต่อเสร็จแล้วเปิดเอกสารนั้น', (await appears(d.locator('.toast', { hasText: 'ครบแล้ว' }))) && new URL(d.url()).pathname === '/documents/doc-resumed')

  // สร้างเอกสาร: สำเร็จบางส่วนแล้วลองใหม่
  await d.goto(`${BASE}/documents/new`)
  state.createFailsOnce = true
  state.delay = 600
  await d.locator('#document-title').fill('แผนงานเดือนหน้า')
  await d.locator('#document-text').fill('หัวข้อ\nรายละเอียด')
  const errorsBeforePartial = consoleErrors.length
  await d.getByRole('button', { name: 'สร้างเอกสาร' }).click()
  check('[จำลอง] สร้างเอกสาร: ระหว่างรอแสดงกำลังสร้าง ปุ่มกดซ้ำไม่ได้',
    (await appears(d.locator('.editor-status', { hasText: 'กำลังสร้างใน Google Docs…' }), 500)) && (await d.getByRole('button', { name: 'กำลังสร้าง…' }).isDisabled()))
  const partialAlert = d.locator('.editor-card .form-alert')
  check('[จำลอง] สร้างเอกสารแล้วไม่ทราบผล: ไม่รับรองว่ายังไม่ได้สร้างหรือไม่มีซ้ำ บอกว่าระบบจะค้นหาไฟล์เดิม และ draft ยังอยู่',
    (await appears(partialAlert)) && (await partialAlert.innerText()).includes('ไม่ทราบว่า Google Docs สร้างไฟล์แล้วหรือยัง') &&
    !/ยังไม่ได้สร้าง|ยังไม่ได้ส่งคำสั่ง/.test(await partialAlert.innerText()) &&
    (await d.locator('#document-text').inputValue()) === 'หัวข้อ\nรายละเอียด' && (await d.locator('.toast').count()) === 0)
  await shot(d, 'live-document-create-partial-1440')
  state.delay = 0
  state.createInProgressOnce = true
  await d.getByRole('button', { name: 'สร้างเอกสาร' }).click()
  check('[จำลอง] กดสร้างซ้ำขณะคำขอก่อนยังทำอยู่: บอกว่ากำลังทำอยู่ ไม่แสดงว่าสร้างแล้ว และ draft ยังอยู่',
    (await appears(partialAlert.getByText('กำลังสร้างเอกสารนี้อยู่จากคำขอก่อนหน้า'))) && new URL(d.url()).pathname === '/documents/new' &&
    (await d.locator('#document-text').inputValue()) === 'หัวข้อ\nรายละเอียด')
  await d.getByRole('button', { name: 'สร้างเอกสาร' }).click()
  check('[จำลอง] ลองสร้างอีกครั้ง: ใช้ key เดิม (server จึงทำต่อไม่สร้างซ้ำ) สำเร็จแล้วไปที่ URL ของเอกสาร และไม่ถามเรื่องทิ้งการแก้',
    (await appears(d.locator('.toast', { hasText: 'สร้างเอกสาร “แผนงานเดือนหน้า”' }))) && new URL(d.url()).pathname === '/documents/doc-new' &&
    state.createKeys.length === 3 && new Set(state.createKeys).size === 1 && (await d.locator('dialog[open]').count()) === 0)
  ignoreErrorsSince(errorsBeforePartial)

  state.operations = [
    { id: 'op-unknown', title: 'เอกสารที่ไม่ทราบผลการสร้าง', status: 'pending', fileState: 'unknown', fileCreated: false, inProgress: false, canConfirmCreate: true, googleUrl: null, lastError: 'create_unknown', createdAt: iso(30), userName: 'ทีมงาน เอ' },
    { id: 'op-running', title: 'เอกสารที่กำลังสร้าง', status: 'pending', fileState: 'unknown', fileCreated: false, inProgress: true, canConfirmCreate: false, googleUrl: null, lastError: null, createdAt: iso(1), userName: 'ทีมงาน เอ' },
  ]
  await d.goto(`${BASE}/documents`)
  const unknownRow = d.locator('.pending-list li', { hasText: 'เอกสารที่ไม่ทราบผลการสร้าง' })
  const runningRow = d.locator('.pending-list li', { hasText: 'เอกสารที่กำลังสร้าง' })
  check('[จำลอง] งานค้างที่ไม่ทราบผล: บอกว่าไม่ทราบผลและจะไม่สร้างใหม่เอง ไม่บอกว่ายังไม่ได้สร้าง',
    (await appears(unknownRow)) && (await unknownRow.innerText()).includes('ไม่ทราบว่า Google Docs สร้างไฟล์แล้วหรือยัง') && !(await unknownRow.innerText()).includes('ยังไม่ได้ส่งคำสั่ง'))
  check('[จำลอง] งานค้างที่กำลังทำ: ปุ่มทำต่อและนำออกจากรายการกดไม่ได้',
    (await runningRow.innerText()).includes('กำลังทำอยู่จากคำขอก่อนหน้า') && (await runningRow.getByRole('button', { name: 'นำออกจากรายการ' }).isDisabled()) &&
    (await runningRow.getByRole('button').first().isDisabled()))
  await shot(d, 'live-documents-pending-unknown-1440')
  await unknownRow.getByRole('button', { name: 'ค้นหาไฟล์เดิมและทำต่อ' }).click()
  check('[จำลอง] ค้นหาไฟล์เดิมแล้วยังไม่พบ: แจ้งว่ายังไม่สร้างใหม่ และไม่ได้ส่งคำยืนยันสร้างใหม่',
    (await appears(unknownRow.locator('.form-alert', { hasText: 'จึงยังไม่สร้างใหม่เพื่อไม่ให้เกิดไฟล์ซ้ำ' }))) && state.resumeBodies.at(-1).confirmCreate === false)
  await unknownRow.getByRole('button', { name: 'ยืนยันสร้างไฟล์ใหม่' }).click()
  const confirmCreate = d.locator('dialog[open]', { hasText: 'สร้างไฟล์ใหม่สำหรับ' })
  check('[จำลอง] ยืนยันสร้างไฟล์ใหม่: ต้องยืนยันอีกชั้น พร้อมบอกให้ตรวจ Google Drive ก่อนและความเสี่ยงไฟล์ซ้ำ',
    (await appears(confirmCreate)) && (await confirmCreate.innerText()).includes('ตรวจ Google Drive ของบัญชีชมรม') && (await confirmCreate.innerText()).includes('ไฟล์ซ้ำ'))
  await d.screenshot({ path: `${OUT}/live-documents-confirm-create-1440.png` })
  await confirmCreate.getByRole('button', { name: 'ตรวจแล้ว สร้างไฟล์ใหม่' }).click()
  check('[จำลอง] ยืนยันแล้ว: ส่งคำยืนยันไปกับคำขอทำต่อ และเปิดเอกสารที่ได้',
    (await appears(d.locator('.toast', { hasText: 'ครบแล้ว' }))) && state.resumeBodies.at(-1).confirmCreate === true)
  await d.context().close()

  // ================= 7.1 ออกจากระบบ: ล้มเหลวต้องไม่ถูกกลบ (Worker + D1 จริง) =================
  const out = actors.out
  const logoutButton = (p, mobile) => (mobile ? p.locator('dialog.mobile-menu[open] .account button') : p.locator('.topbar .account button'))
  const accountError = (p, mobile) => (mobile ? p.locator('dialog.mobile-menu[open] .account-error') : p.locator('.logout-alert'))
  const sessionUser = (p) => p.evaluate(async () => (await (await fetch('/api/session')).json()).user)
  const oldSessionStatus = async (p, token) => (await p.request.get(`${BASE}/api/members`, { headers: { Cookie: `mu_session=${token}` } })).status()
  let tokenIndex = 0
  for (const [width, height, mobile] of [[1440, 900, false], [390, 844, true]]) {
    const tag = `[จริง] ออกจากระบบ ${width}px`
    const token = out.tokens[tokenIndex]
    const p = await newPage(width, height, out, tokenIndex++)
    let prompts = 0
    p.on('dialog', (dialog) => {
      prompts++
      void dialog.accept()
    })
    await p.goto(`${BASE}/documents/new`)
    await p.locator('#document-title').fill('ร่างก่อนออกจากระบบ')
    await p.locator('#document-text').fill('ข้อความที่ยังไม่ได้บันทึก')
    const draftIntact = async () =>
      (await p.locator('#document-title').inputValue()) === 'ร่างก่อนออกจากระบบ' && (await p.locator('#document-text').inputValue()) === 'ข้อความที่ยังไม่ได้บันทึก'
    if (mobile) await p.getByRole('button', { name: 'เปิดเมนู' }).click()
    const button = logoutButton(p, mobile)
    await button.waitFor()

    // 1) server ตอบ 500 (หน่วงเพื่อดูสถานะระหว่างรอ)
    let logoutRequests = 0
    await p.route('**/auth/logout', async (route) => {
      logoutRequests++
      await new Promise((resolve) => setTimeout(resolve, 700))
      return route.fulfill({ status: 500, json: { error: 'internal_error', message: 'ระบบขัดข้อง ลองอีกครั้งในอีกสักครู่' } })
    })
    await button.click()
    const pendingShown = (await appears(button.filter({ hasText: 'กำลังออกจากระบบ…' }), 600)) && (await button.getAttribute('aria-disabled')) === 'true'
    await button.click({ force: true })
    await button.click({ force: true })
    check(`${tag}: ระหว่างรอแสดงกำลังออกจากระบบ และกดซ้ำไม่ส่งคำขอเพิ่ม`, pendingShown && logoutRequests === 1, `คำขอ ${logoutRequests} ครั้ง`)
    const error = accountError(p, mobile)
    check(`${tag}: server ตอบ 500 → เห็นข้อผิดพลาดภาษาไทย ยังไม่บอกว่าออกแล้ว ยังอยู่หน้าเดิม และ draft ไม่ถูกทิ้ง`,
      (await appears(error)) && (await error.innerText()).includes('ออกจากระบบไม่สำเร็จ') && (await error.innerText()).includes('ยังอยู่ในระบบ') &&
      (await error.getAttribute('role')) === 'alert' && new URL(p.url()).pathname === '/documents/new' &&
      (await p.getByText('ออกจากระบบแล้ว').count()) === 0 && (await draftIntact()) && prompts === 0)
    check(`${tag}: หลังล้มเหลว session ยังใช้ได้จริง (ไม่ได้แสดงผลหลอก) และ focus ยังอยู่ที่ปุ่มสำหรับลองใหม่`,
      (await sessionUser(p))?.email === 'logout-review@example.com' && (await oldSessionStatus(p, token)) === 200 &&
      (await p.evaluate(() => document.activeElement?.textContent?.trim())) === 'ออกจากระบบอีกครั้ง')
    await p.screenshot({ path: `${OUT}/live-logout-failed-${width}.png` })
    await p.unroute('**/auth/logout')

    // 2) เครือข่ายล้มเหลว
    await p.route('**/auth/logout', (route) => route.abort('failed'))
    await button.click()
    check(`${tag}: เครือข่ายล้มเหลว → แจ้งว่าเชื่อมต่อไม่ได้และยังอยู่ในระบบ draft ยังอยู่`,
      (await appears(error.getByText('เชื่อมต่อระบบกลางไม่ได้'))) && (await error.innerText()).includes('ยังอยู่ในระบบ') && (await draftIntact()) &&
      new URL(p.url()).pathname === '/documents/new')
    await p.route('**/api/session', (route) => route.abort('failed'))
    await button.click()
    check(`${tag}: ตรวจสถานะ session ไม่ได้เลย → บอกว่ายืนยันไม่ได้ ไม่บอกว่าสำเร็จ และ draft ยังอยู่`,
      (await appears(error.getByText('ยืนยันไม่ได้ว่าออกจากระบบแล้วหรือยัง'))) && (await p.getByText('ออกจากระบบแล้ว', { exact: true }).count()) === 0 &&
      new URL(p.url()).pathname === '/documents/new' && (await draftIntact()))
    await p.unroute('**/api/session')
    await p.unroute('**/auth/logout')

    // 3) ลองใหม่สำเร็จ
    const otherTab = await p.context().newPage()
    await otherTab.goto(`${BASE}/members`)
    await otherTab.locator('#main h1').waitFor()
    // ข้อความของขั้นก่อนหน้า “ยืนยันไม่ได้ว่าออกจากระบบแล้วหรือยัง” มีคำว่า “ออกจากระบบแล้ว” อยู่ข้างใน และยังแสดงอยู่ระหว่างลองใหม่ (ตามที่ออกแบบ)
    // ตัวตรวจจึงต้องรอ URL ของหน้าเข้าสู่ระบบอย่างเจาะจง และจับข้อความแจ้งผลแบบตรงตัวในหน้านั้น ไม่ใช่จับ substring ระหว่างที่ยังไม่เปลี่ยนหน้า
    // เก็บเฉพาะ method, path, status และการเปลี่ยนหน้า (ไม่มี cookie, token หรือเนื้อหา) ไว้แสดงเมื่อข้อตรวจไม่ผ่าน
    const trace = []
    const started = Date.now()
    const note = (text) => trace.push(`${Date.now() - started}ms ${text}`)
    p.on('request', (r) => /^\/(api|auth)\//.test(new URL(r.url()).pathname) && note(`→ ${r.method()} ${new URL(r.url()).pathname}`))
    p.on('response', (r) => /^\/(api|auth)\//.test(new URL(r.url()).pathname) && note(`← ${r.status()} ${new URL(r.url()).pathname}`))
    p.on('framenavigated', (f) => f === p.mainFrame() && note(`nav ${new URL(f.url()).pathname}${new URL(f.url()).search}`))
    // หน่วงคำตอบที่สำเร็จของ server จริง เพื่อให้มีช่วงที่คำขอส่งไปแล้วแต่หน้ายังไม่เปลี่ยน
    let delayedLogouts = 0
    await p.route('**/auth/logout', async (route) => {
      delayedLogouts++
      const response = await route.fetch()
      await new Promise((resolve) => setTimeout(resolve, 1500))
      return route.fulfill({ response })
    })
    await button.click()
    await p.waitForTimeout(500)
    const during = {
      path: new URL(p.url()).pathname,
      substring: await p.getByText('ออกจากระบบแล้ว').count(),
      exact: await p.getByText('ออกจากระบบแล้ว', { exact: true }).count(),
      oldMessage: await error.getByText('ยืนยันไม่ได้ว่าออกจากระบบแล้วหรือยัง').count(),
    }
    check(`${tag}: ระหว่างรอคำตอบออกจากระบบ (หน่วง 1.5 วินาที): ยังอยู่หน้าเดิม ข้อความเก่ายังแสดง ซึ่งการจับ substring จะเข้าใจผิดว่าออกแล้ว แต่การจับแบบตรงตัวไม่พบ`,
      during.path === '/documents/new' && during.oldMessage === 1 && during.substring >= 1 && during.exact === 0 && delayedLogouts === 1, JSON.stringify(during))
    const arrived = await p.waitForURL((url) => url.pathname === '/login' && url.searchParams.get('loggedOut') === '1', { timeout: 8000 }).then(() => true, () => false)
    const notice = arrived && (await appears(p.locator('p.notice').getByText('ออกจากระบบแล้ว', { exact: true })))
    check(`${tag}: ลองใหม่สำเร็จ → ไปหน้าเข้าสู่ระบบ บอกว่าออกจากระบบแล้ว และไม่ถูกถามเรื่องทิ้งร่างซ้ำ`,
      arrived && notice && new URL(p.url()).pathname === '/login' && new URL(p.url()).searchParams.get('loggedOut') === '1' &&
      (await p.getByText('ยืนยันไม่ได้ว่าออกจากระบบแล้วหรือยัง').count()) === 0 && prompts === 0 && delayedLogouts === 1,
      arrived && notice && prompts === 0 ? '' : `${new URL(p.url()).pathname}${new URL(p.url()).search} · ถามทิ้งร่าง ${prompts} ครั้ง · ${trace.join(' | ')}`)
    await p.unroute('**/auth/logout')
    check(`${tag}: หลังออกจากระบบ /api/session ไม่คืน user, session เดิมใช้กับ API ไม่ได้ และ cookie ถูกล้าง`,
      (await sessionUser(p)) === null && (await oldSessionStatus(p, token)) === 401 &&
      !(await p.context().cookies()).some((c) => c.name === 'mu_session' && c.value))
    await otherTab.reload()
    check(`${tag}: อีกแท็บที่เปิดค้างไว้ refresh แล้วไม่เห็นข้อมูล ถูกพาไปหน้าเข้าสู่ระบบ`,
      (await appears(otherTab.getByRole('heading', { name: 'เข้าสู่ระบบ' }))) && (await otherTab.locator('tbody tr').count()) === 0)
    await p.context().close()

    // 4) server ลบ session แล้ว แต่คำตอบหาย
    const lost = await newPage(width, height, out, tokenIndex)
    const lostToken = out.tokens[tokenIndex++]
    await lost.goto(`${BASE}/members`)
    await lost.locator('#main h1').waitFor()
    if (mobile) await lost.getByRole('button', { name: 'เปิดเมนู' }).click()
    await lost.route('**/auth/logout', async (route) => {
      await route.fetch()
      return route.abort('failed')
    })
    await logoutButton(lost, mobile).click()
    check(`${tag}: server ลบ session แล้วแต่คำตอบหาย → ตรวจสถานะแล้วยืนยันว่าออกจากระบบ ไม่กลับเข้าเว็บเอง`,
      (await appears(lost.locator('p.notice').getByText('ออกจากระบบแล้ว', { exact: true }))) && new URL(lost.url()).pathname === '/login' &&
      (await sessionUser(lost)) === null && (await oldSessionStatus(lost, lostToken)) === 401)
    await lost.waitForTimeout(500)
    check(`${tag}: หลังยืนยันแล้วไม่ถูกพากลับหน้าหลัก`, new URL(lost.url()).pathname === '/login')
    await lost.context().close()

    // 5) session ถูกยกเลิกไปก่อนกดออกจากระบบ
    const gone1 = await newPage(width, height, out, tokenIndex)
    const killer = await newPage(800, 600, out, tokenIndex++)
    await gone1.goto(`${BASE}/members`)
    await gone1.locator('#main h1').waitFor()
    await killer.goto(`${BASE}/`)
    await killer.locator('#main h1').waitFor()
    const killed = await apiAs(killer, '/auth/logout', { method: 'POST' })
    await killer.context().close()
    if (mobile) await gone1.getByRole('button', { name: 'เปิดเมนู' }).click()
    await logoutButton(gone1, mobile).click()
    check(`${tag}: session หมดไปก่อนกดออกจากระบบ → ไปหน้าเข้าสู่ระบบได้ถูกต้อง ไม่ค้างที่ข้อผิดพลาดหรือกล่องเซสชันหมดอายุ`,
      killed.status === 200 && (await appears(gone1.locator('p.notice').getByText('ออกจากระบบแล้ว', { exact: true }))) && new URL(gone1.url()).pathname === '/login' &&
      (await gone1.locator('dialog[open]').count()) === 0)
    await gone1.context().close()
  }

  // ================= 8. ทุกหน้า ทุกความกว้าง + แนวนอน =================
  const VIEWPORTS = [
    [1440, 900, '1440'], [1024, 768, '1024'], [768, 1024, '768'], [390, 844, '390'], [320, 568, '320'],
    [844, 390, 'landscape-844x390'], [667, 375, 'landscape-667x375'],
  ]
  const PAGES = [
    ['/', 'overview'], ['/members', 'members'], ['/calendar', 'calendar'], ['/documents', 'documents'],
    ['/documents/doc-1', 'document-editor'], ['/documents/new', 'document-new'], ['/sources', 'sources'], ['/team', 'team'],
  ]
  // สัญญาณ “โหลดเสร็จ” ที่ sweep และข้อตรวจอื่นใช้รอ (สถานะกำลังโหลดหายไป) ต้องหมายความว่าข้อมูลชุดล่าสุดถูกวาดแล้ว
  // ไม่เช่นนั้นข้อตรวจที่วัดหน้าทันทีหลังสัญญาณนี้จะวัดหน้าว่าง และผู้ใช้จะเห็นข้อความว่าไม่มีข้อมูลชั่วครู่ทั้งที่มีข้อมูล
  async function loadSignalCheck(engine, engineName) {
    for (const [name, options] of [
      // เปิดด้วยลิงก์ของกำหนดการ: ไม่ขึ้นกับว่ากำหนดการทดสอบอยู่ในเดือนที่ปฏิทินแสดงหรือไม่
      ['ปฏิทิน (เปิดด้วยลิงก์ของกำหนดการ)', { url: `${BASE}/calendar?event=${eventId}`, api: '/api/events', dataSelector: 'dialog.dialog h2', wrongText: 'ไม่พบกำหนดการที่ต้องการเปิด' }],
      ['สมาชิก', { url: `${BASE}/members`, api: '/api/members', dataSelector: '.members-table tbody tr', wrongText: 'ยังไม่มีสมาชิก' }],
    ]) {
      const p = await newPage(1440, 900, actors.admin, 0, engine)
      const result = await probeLoadSignal(p, options)
      check(`[${engineName}] ${name}: หน้ายังแสดง “กำลังโหลด” จนกว่าคำตอบชุดล่าสุดจะมาถึง ไม่ขึ้นว่าโหลดเสร็จหรือ “${options.wrongText}” ก่อนข้อมูลจริง`,
        result.ok, JSON.stringify(result.detail))
      await p.context().close()
    }
  }

  async function sweep(engine, engineName, viewports, shots) {
    for (const [width, height, label] of viewports) {
      const p = await newPage(width, height, actors.admin, 0, engine)
      // เหตุการณ์ของหน้าแบบย่อ (method, path, สถานะ) เก็บไว้ใช้เป็นหลักฐานเฉพาะเมื่อข้อตรวจปฏิทินเดือนไม่ผ่าน
      const trace = traceApi(p)
      await mockDocuments(p, mockState())
      const mobile = width < 768
      const menuMode = width < 1024
      for (const [path, name] of PAGES) {
        trace.reset()
        await p.goto(BASE + path)
        await p.locator('#main h1').waitFor()
        await p.locator('.state-block[role="status"]').waitFor({ state: 'detached' }).catch(() => undefined)
        const fits = await noOverflow(p)
        check(`[${engineName}] ${label} ${path}: ไม่ล้นจอแนวนอน`, fits, fits ? '' : `scrollWidth ${await p.evaluate(() => document.documentElement.scrollWidth)}`)
        if (shots) await shot(p, `live-${name}-${label}`)

        if (name === 'calendar') {
          const pressed = await p.getByRole('button', { name: mobile ? 'รายการ' : 'เดือน', exact: true }).getAttribute('aria-pressed')
          check(`[${engineName}] ${label} ปฏิทิน: ${mobile ? 'มือถือเริ่มที่มุมมองรายการ' : 'จอกว้างเริ่มที่มุมมองเดือน'}`, pressed === 'true')
          if (!mobile && width >= 1024) {
            // เป้าหมายคือกำหนดการที่ชุดตรวจสร้างไว้ในขั้นที่ 3 (รู้ id แน่นอน) อ่านค่าปัจจุบันจาก API ด้วย session ของหน้านี้
            // ไม่สมมติว่าป้ายแรกของหน้าคือรายการนี้ และรอให้ป้ายของรายการนี้แสดงก่อนตรวจ (ดู scripts/ui-data-ready.mjs)
            const apiEvents = JSON.parse((await apiAs(p, '/api/events')).body).events ?? []
            const target = apiEvents.find((e) => e.id === eventId)
            const result = target
              ? await checkMonthChip(p, target)
              : { ok: false, problems: ['ข้อมูลทดสอบ: ไม่พบกำหนดการที่ชุดตรวจสร้างไว้ในคำตอบของ /api/events'], seen: null }
            const ok = result.ok && target.title.startsWith('ประชุมทีมงาน')
            let detail = ok ? `วันที่ ${result.seen.target.day} เวลา ${result.seen.target.timePart.text} “${result.seen.target.titlePart.text.slice(0, 24)}…” (รอ ${result.waitedMs}ms)` : ''
            if (!ok) {
              // เก็บภาพหน้าจอ เหตุการณ์ของหน้า และรายการที่แสดงเทียบกับข้อมูลจาก API เพื่อแยกว่าสาเหตุอยู่ที่หน้าเว็บ ข้อมูลทดสอบ หรือตัวตรวจ
              const files = await saveMonthChipDiagnostics(p, {
                dir: OUT, name: `diag-month-chip-${engineName.replace(/[^A-Za-z]/g, '')}-${label}`, target, result, trace: trace.lines(), apiEvents,
              })
              detail = `${result.problems.join(' · ') || 'ชื่อของกำหนดการทดสอบไม่ขึ้นต้นด้วย “ประชุมทีมงาน”'} — หลักฐาน: ${files.report}${files.screenshot ? ` , ${files.screenshot}` : ''}`
            }
            check(`[${engineName}] ${label} ปฏิทินเดือน: เห็นเวลาและชื่อกำหนดการในช่องวัน`, ok, detail)
          }
        }
        if (name === 'document-editor') {
          await p.locator('#document-text').waitFor()
          await p.locator('#document-text').pressSequentially(' แก้')
          const save = p.getByRole('button', { name: 'บันทึก', exact: true })
          const cancel = p.locator('.editor-actions').getByRole('link', { name: 'ยกเลิก' })
          check(`[${engineName}] ${label} editor: ปุ่มบันทึกและยกเลิกอยู่ในจอและกดได้โดยไม่ต้องเลื่อน (ไม่ถูกบัง)`, (await inViewport(save)) && (await inViewport(cancel)))
          const box = await p.locator('#document-text').boundingBox()
          check(`[${engineName}] ${label} editor: ช่องเนื้อหายังมีพื้นที่พิมพ์และเลื่อนได้`, box.height >= 110 && (await p.locator('#document-text').evaluate((el) => el.scrollHeight > el.clientHeight)), `สูง ${Math.round(box.height)}px`)
          if (mobile) check(`[${engineName}] ${label} editor: ปุ่มบันทึกสูง ≥44px`, (await save.boundingBox()).height >= 44)
          if (shots) await p.screenshot({ path: `${OUT}/live-document-editor-viewport-${label}.png` })
          await save.click()
          await p.locator('.editor-status', { hasText: 'บันทึกแล้วเมื่อ' }).waitFor()
        }
        if (name === 'members' && mobile) {
          check(`[${engineName}] ${label} สมาชิก: ตารางเป็นรายการอ่านง่าย (ไม่มีหัวตาราง) และปุ่มหลักสูง ≥44px`,
            !(await p.locator('.members-table thead').isVisible()) && (await p.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().boundingBox()).height >= 44)
        }
        if (name === 'team' && mobile) {
          check(`[${engineName}] ${label} ทีมงาน: อีเมลไม่ถูกตัดสาระ (ตัดบรรทัดได้)`,
            await p.locator('.team-email').first().evaluate((el) => el.scrollWidth <= el.clientWidth + 1))
        }
      }

      // dialog ฟอร์มในจอนี้: เลื่อนได้และปุ่มอยู่ในจอ
      await p.goto(`${BASE}/calendar`)
      await p.getByRole('button', { name: 'เพิ่มกำหนดการ' }).first().click()
      const submit = p.locator('dialog[open]').getByRole('button', { name: 'เพิ่มกำหนดการ' })
      const cancelForm = p.locator('dialog[open]').getByRole('button', { name: 'ยกเลิก' })
      check(`[${engineName}] ${label} ฟอร์มใน dialog: ปุ่มบันทึก/ยกเลิกอยู่ในจอ และเนื้อหาฟอร์มเลื่อนได้เมื่อพื้นที่ไม่พอ`,
        (await inViewport(submit)) && (await inViewport(cancelForm)) &&
        (await p.locator('dialog[open] .dialog-body').evaluate((el) => el.scrollHeight <= el.clientHeight || getComputedStyle(el).overflowY === 'auto')) && (await noOverflow(p)))
      if (shots) await p.screenshot({ path: `${OUT}/live-event-form-${label}.png` })
      await p.keyboard.press('Escape')

      check(`[${engineName}] ${label} โครงหน้า: ${menuMode ? 'เมนูซ้ายยุบเป็นปุ่มเปิดเมนูบนหัวเว็บ' : 'เมนูซ้ายแสดงเต็ม ไม่มีปุ่มเปิดเมนู'}`,
        (await p.locator('.sidebar').isVisible()) === !menuMode && (await p.getByRole('button', { name: 'เปิดเมนู' }).isVisible()) === menuMode &&
        (await p.locator('.topbar .account').isVisible()) === !menuMode)
      if (menuMode) {
        await p.goto(`${BASE}/documents`)
        await p.getByRole('button', { name: 'เปิดเมนู' }).click()
        const menu = p.locator('dialog.mobile-menu[open]')
        await menu.waitFor()
        check(`[${engineName}] ${label} เมนูมือถือ: มีเอกสาร ทีมงาน บัญชี และปุ่มออกจากระบบ เลื่อนพื้นหลังไม่ได้`,
          (await menu.getByRole('link', { name: 'เอกสาร' }).getAttribute('aria-current')) === 'page' && (await menu.getByRole('link', { name: 'ทีมงาน' }).isVisible()) &&
          (await menu.getByRole('button', { name: 'ออกจากระบบ' }).count()) === 1 && (await p.evaluate(() => getComputedStyle(document.documentElement).overflow === 'hidden')))
        if (shots) {
          await p.waitForTimeout(300) // รอแผงเมนูเลื่อนเข้าจนสุดก่อนถ่ายภาพ
          await p.screenshot({ path: `${OUT}/live-menu-${label}.png` })
        }
        await p.setViewportSize({ width: 1024, height: 768 })
        check(`[${engineName}] ${label} ขยายจอข้าม breakpoint ขณะเมนูเปิด: เมนูปิด และไม่มี scroll lock ค้าง`,
          (await gone(menu)) && (await p.evaluate(() => getComputedStyle(document.documentElement).overflow !== 'hidden')))
        await p.setViewportSize({ width, height })
        await p.getByRole('button', { name: 'เปิดเมนู' }).click()
        await menu.waitFor()
        await p.keyboard.press('Escape')
        check(`[${engineName}] ${label} เมนูมือถือ: Esc ปิด และ focus กลับที่ปุ่มเปิดเมนู`,
          (await gone(menu)) && (await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'เปิดเมนู')
      }
      await p.context().close()
    }
  }
  await loadSignalCheck(browser, 'Edge/Chromium')
  await sweep(browser, 'Edge/Chromium', VIEWPORTS, true)

  // ================= 8.1 พอร์ทัลหน้าแรก: ทางลัดตามสิทธิ์ ปฏิทินหน้าแรก ธีม และ breakpoint ของเมนู =================
  const THEME_KEY = 'mu-esport-staff:theme:v1'
  const SHORTCUTS = ['สมาชิก', 'เอกสาร', 'ปฏิทินชมรม', 'แหล่งข้อมูล']
  for (const [who, actor, token] of [['staff', actors.a, 1], ['admin', actors.admin, 0]]) {
    const p = await newPage(1440, 900, actor, token)
    await p.goto(`${BASE}/`)
    await p.locator('.shortcut').first().waitFor()
    const cards = await p.locator('.shortcut').evaluateAll((els) => els.map((el) => [el.textContent.trim(), el.getAttribute('href')]))
    const navHrefs = await p.locator('.sidebar .nav-link').evaluateAll((els) => els.map((el) => el.getAttribute('href')))
    check(`[จริง] ทางลัดหน้าแรก (${who}): มีเฉพาะ สมาชิก เอกสาร ปฏิทินชมรม แหล่งข้อมูล และทุกใบชี้ไปหน้าที่อยู่ในเมนูของสิทธิ์นี้`,
      JSON.stringify(cards.map((c) => c[0])) === JSON.stringify(SHORTCUTS) && cards.every((c) => navHrefs.includes(c[1])) &&
      navHrefs.includes('/team') === (who === 'admin'), cards.map((c) => c.join('→')).join(' '))
    if (who === 'staff') {
      let opened = true
      for (const [label, href] of cards) {
        await p.goto(`${BASE}/`)
        await p.locator('.shortcuts').getByRole('link', { name: label, exact: true }).click()
        await p.locator('#main h1').waitFor()
        opened &&= new URL(p.url()).pathname === href && (await p.locator('.state-error, .auth-denied-title').count()) === 0
      }
      check('[จริง] ทางลัดหน้าแรก (staff): กดทั้งใบแล้วเปิดหน้าปลายทางได้จริงทุกใบ', opened)
      await p.goto(`${BASE}/`)
      await p.locator('.shortcut').first().waitFor()
      const sizes = await p.locator('.shortcut').evaluateAll((els) => els.map((el) => {
        const r = el.getBoundingClientRect()
        const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2)
        return [Math.round(r.width), Math.round(r.height), el.contains(top)]
      }))
      check('[จริง] ทางลัดหน้าแรก 1440: ทุกใบสูง ≥44px กว้างพอแตะ และจุดกึ่งกลางกดถึงตัวลิงก์เอง', sizes.every(([w, h, hit]) => w >= 120 && h >= 44 && hit), JSON.stringify(sizes))
    }
    await p.context().close()
  }

  {
    const p = await newPage(1440, 900, actors.a, 1)
    const writes = []
    const syncTriggers = []
    p.on('request', (r) => {
      if (r.method() === 'GET') return
      const path = new URL(r.url()).pathname
      // คำสั่ง “ตรวจจาก Google ถ้าถึงรอบ” ที่หน้าเว็บส่งเองเมื่อเปิดหน้า ไม่ใช่การเขียนข้อมูลของผู้ใช้: นับแยก และต้องไม่เป็นแบบบังคับ (force)
      if (['sheets', 'calendar', 'forms', 'docs'].some((kind) => path === `/api/sync/${kind}`) && r.postDataJSON()?.force !== true) return void syncTriggers.push(path)
      writes.push(`${r.method()} ${path}`)
    })
    await p.goto(`${BASE}/`)
    const home = p.locator('.home-calendar')
    await home.locator('.chip').first().waitFor()
    const apiEvents = JSON.parse((await apiAs(p, '/api/events')).body).events
    const chips = await home.locator('.chip').evaluateAll((els) => els.map((el) => [el.getAttribute('data-event-id'), el.querySelector('.chip-title').textContent]))
    check('[จริง] ปฏิทินหน้าแรก: กำหนดการในช่องวันมาจากข้อมูลชุดเดียวกับ /api/events (id และชื่อตรงกัน)',
      chips.length > 0 && chips.every(([id, title]) => apiEvents.find((e) => e.id === id)?.title === title), `${chips.length} รายการ`)
    const order = await p.evaluate(() => {
      const top = (sel) => document.querySelector(sel).getBoundingClientRect().top
      return top('.shortcuts') < top('.overview-grid') && top('.overview-grid') < top('.home-calendar') &&
        document.querySelector('.stats').getBoundingClientRect().bottom <= innerHeight && top('.overview-events') < innerHeight
    })
    const gridBox = await home.locator('.month-grid').boundingBox()
    const dayFont = await home.locator('.month-day-number').first().evaluate((el) => parseFloat(getComputedStyle(el).fontSize))
    check('[จริง] หน้าแรก 1440: เรียง ทางลัด → สรุปสมาชิกและกำหนดการถัดไป (เห็นในจอแรก) → ปฏิทินเดือน ตัวเลขวันอ่านได้ ≥16px',
      order && gridBox.width >= 600 && gridBox.height >= 400 && dayFont >= 16, `ตาราง ${Math.round(gridBox.width)}×${Math.round(gridBox.height)} ตัวเลข ${dayFont}px`)
    const title0 = await home.locator('.calendar-title').innerText()
    await home.getByRole('button', { name: 'เดือนถัดไป' }).click()
    const title1 = await home.locator('.calendar-title').innerText()
    await home.getByRole('button', { name: 'วันนี้' }).click()
    const tomorrow = home.locator('.month-cell.is-today + .month-cell .month-day')
    const hasNext = (await tomorrow.count()) === 1
    if (hasNext) await tomorrow.click()
    check('[จริง] ปฏิทินหน้าแรก: เลื่อนเดือน ปุ่มวันนี้ และเลือกวันทำงานจริง แยกวันนี้ (กรอบ) กับวันที่เลือก (พื้นหลัง)',
      title1 !== title0 && (await home.locator('.calendar-title').innerText()) === title0 &&
      (!hasNext || ((await home.locator('.month-cell.is-selected.is-today').count()) === 0 && (await home.locator('.month-cell.is-selected').count()) === 1)) &&
      (await home.locator('.month-cell.is-today').evaluate((el) => getComputedStyle(el).borderTopColor !== 'rgba(0, 0, 0, 0)')))
    const [chipId, chipTitle] = chips[0]
    await home.locator(`.chip[data-event-id="${chipId}"]`).first().click()
    check('[จริง] ปฏิทินหน้าแรก: กดกำหนดการแล้วไป /calendar?event=<id> และเปิดรายละเอียดเดิมของหน้าปฏิทิน',
      (await appears(p.locator('dialog.dialog[open] h2', { hasText: chipTitle }))) && new URL(p.url()).pathname === '/calendar' &&
      new URL(p.url()).searchParams.get('event') === chipId)
    await p.reload()
    check('[จริง] ปฏิทินหน้าแรก → รายละเอียด: refresh แล้วยังเปิดรายการเดิม', await appears(p.locator('dialog.dialog[open] h2', { hasText: chipTitle })))
    await p.keyboard.press('Escape')
    await p.locator('dialog[open]').waitFor({ state: 'detached' })
    check('[จริง] ปฏิทินหน้าแรก: หน้าแรกไม่มี dialog ของตัวเองและไม่ส่งคำขอเขียนข้อมูล (มีเฉพาะคำสั่งตรวจจาก Google ตามรอบ ไม่เกินบริการละหนึ่งครั้งต่อการเปิดหน้า)',
      writes.length === 0 && new URL(p.url()).searchParams.get('event') === null && syncTriggers.every((path) => path === '/api/sync/sheets' || path === '/api/sync/calendar') && syncTriggers.length <= 8,
      `${writes.join(', ')} · ตรวจตามรอบ ${syncTriggers.length} ครั้ง`)

    // ธีม
    await p.goto(`${BASE}/`)
    await p.locator('.stats, .empty-state').first().waitFor()
    await p.locator('.overview-sources .source-summary').waitFor() // รอให้เนื้อหาโหลดครบก่อนเทียบก่อน/หลังสลับธีม
    const themeSwitch = p.getByRole('switch', { name: 'ธีมมืด' })
    const look = () => p.evaluate((key) => ({
      theme: document.documentElement.dataset.theme, stored: localStorage.getItem(key), keys: Object.keys(localStorage).join(','),
      bg: getComputedStyle(document.body).backgroundColor, panel: getComputedStyle(document.querySelector('#main')).backgroundColor,
      scheme: getComputedStyle(document.documentElement).colorScheme, main: document.querySelector('#main').innerText,
    }), THEME_KEY)
    const light = await look()
    const box = await themeSwitch.boundingBox()
    check('[จริง] ธีม: เริ่มที่ธีมสว่าง สวิตช์มีชื่อให้โปรแกรมอ่านหน้าจอ และพื้นที่กด ≥44px',
      light.theme === 'light' && light.stored === null && (await themeSwitch.getAttribute('aria-checked')) === 'false' && box.width >= 44 && box.height >= 44 &&
      light.bg === 'rgb(244, 247, 251)' && light.panel === 'rgb(255, 255, 255)', `${Math.round(box.width)}×${Math.round(box.height)} ${light.bg}`)
    await themeSwitch.focus()
    await p.keyboard.press('Space')
    const dark = await look()
    check('[จริง] ธีม: กดด้วยคีย์บอร์ดแล้วเป็นธีมมืด เก็บใน key ของธีมเท่านั้น เนื้อหาและสถานะของหน้าไม่เปลี่ยน',
      dark.theme === 'dark' && dark.stored === 'dark' && dark.keys === THEME_KEY && (await themeSwitch.getAttribute('aria-checked')) === 'true' &&
      dark.bg !== light.bg && dark.panel !== light.panel && dark.scheme === 'dark' && dark.main === light.main && writes.length === 0)
    await shot(p, 'live-overview-dark-1440')
    await p.goto(`${BASE}/calendar`)
    await p.getByRole('button', { name: 'เพิ่มกำหนดการ' }).first().click()
    await p.locator('dialog[open]').getByRole('button', { name: 'เพิ่มกำหนดการ' }).click()
    const formLook = await p.evaluate(() => {
      const rgb = (el) => getComputedStyle(el).backgroundColor
      return { dialog: rgb(document.querySelector('dialog[open]')), date: rgb(document.querySelector('#event-startDate')), scheme: getComputedStyle(document.querySelector('#event-startDate')).colorScheme }
    })
    check('[จริง] ธีมมืด: เปลี่ยนหน้าแล้วยังเป็นธีมมืด dialog ช่องวันที่ และข้อความ validation ใช้สีของธีมมืด',
      (await p.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && formLook.dialog === dark.panel && formLook.date === dark.panel &&
      formLook.scheme === 'dark' && (await p.locator('#event-title-error').isVisible()), JSON.stringify(formLook))
    await p.screenshot({ path: `${OUT}/live-event-form-dark-1440.png` })
    await p.locator('#event-title').fill('')
    await p.keyboard.press('Escape')
    await p.locator('dialog[open]').waitFor({ state: 'detached' })
    await mockDocuments(p, mockState())
    await p.goto(`${BASE}/documents/doc-1`)
    await p.locator('#document-text').waitFor()
    check('[จำลอง] ธีมมืด: editor ใช้พื้นของธีมมืด ชื่อยังอ่านอย่างเดียว',
      (await p.locator('#document-text').evaluate((el) => getComputedStyle(el).backgroundColor)) === dark.panel &&
      (await p.locator('#document-title').getAttribute('readonly')) !== null)
    await shot(p, 'live-document-editor-dark-1440')
    const errorsBeforeDark = consoleErrors.length
    await p.route('**/api/members', (route) => route.fulfill({ status: 500, json: { error: 'internal', message: 'ระบบกลางขัดข้อง (จำลอง)' } }))
    await p.goto(`${BASE}/members`)
    check('[จำลอง] ธีมมืด: สถานะโหลดไม่สำเร็จยังแสดงข้อผิดพลาดและปุ่มลองใหม่', await appears(p.getByRole('button', { name: 'ลองโหลดอีกครั้ง' })))
    await shot(p, 'live-members-load-failed-dark-1440')
    await p.unroute('**/api/members')
    ignoreErrorsSince(errorsBeforeDark)
    await p.goto(`${BASE}/`)
    await p.locator('.stats, .empty-state').first().waitFor()
    await p.getByRole('switch', { name: 'ธีมมืด' }).click()
    const back = await look()
    check('[จริง] ธีม: กดอีกครั้งกลับเป็นธีมสว่าง', back.theme === 'light' && back.bg === light.bg)
    await p.context().close()
  }

  // หน้าแรกทุกความกว้างที่กำหนด + ขอบของ breakpoint เมนู + คีย์บอร์ดใต้หัวเว็บที่เกาะด้านบน
  for (const [width, height] of [[1836, 1100], [1440, 900], [1024, 768], [768, 1024], [390, 844], [360, 740]]) {
    const p = await newPage(width, height, actors.admin)
    await p.goto(`${BASE}/`)
    await p.locator('.home-calendar .calendar-title').waitFor()
    await p.locator('.overview-sources .source-summary').waitFor()
    await p.evaluate(() => document.fonts.ready)
    const m = await p.evaluate(() => {
      const box = (sel) => document.querySelector(sel)?.getBoundingClientRect()
      const cut = [...document.querySelectorAll('.nav-label, .shortcut span, .topbar .brand-name, .button, .calendar-title')]
        .filter((el) => el.offsetParent && el.scrollWidth > el.clientWidth + 1).map((el) => el.textContent.trim())
      return {
        overflow: document.documentElement.scrollWidth - window.innerWidth, header: Math.round(box('.topbar').height), sidebar: Math.round(box('.sidebar')?.width ?? 0),
        shell: Math.round(box('.shell').width), panelPad: parseFloat(getComputedStyle(document.querySelector('#main')).paddingLeft),
        headerBg: getComputedStyle(document.querySelector('.topbar')).backgroundColor, cols: new Set([...document.querySelectorAll('.shortcut')].map((el) => Math.round(el.getBoundingClientRect().left))).size,
        topbarFits: document.querySelector('.topbar-inner').scrollWidth <= document.querySelector('.topbar-inner').clientWidth, cut,
        listPressed: document.querySelector('.home-calendar .segmented button:last-child').getAttribute('aria-pressed'),
      }
    })
    const expectSidebar = width >= 1700 ? [254, 274] : width >= 1280 ? [238, 258] : width >= 1024 ? [206, 226] : [0, 0]
    check(`[จริง] หน้าแรก ${width}px: หัวกรมท่าไม่ล้น ไม่มีข้อความถูกตัด เมนู/ทางลัด/ปฏิทินตามขนาดจอ`,
      m.overflow <= 0 && m.topbarFits && m.cut.length === 0 && m.headerBg === 'rgb(11, 31, 58)' && m.shell <= 1800 &&
      m.sidebar >= expectSidebar[0] && m.sidebar <= expectSidebar[1] && m.cols === (width < 768 ? 2 : 4) &&
      m.listPressed === String(width < 768) && (width < 768 ? m.panelPad >= 12 && m.panelPad <= 16 : width < 1280 ? m.panelPad >= 20 && m.panelPad <= 24 : m.panelPad >= 28 && m.panelPad <= 32),
      JSON.stringify(m))
    await shot(p, `live-home-${width}`)
    if (width === 1440 || width === 390) {
      // Tab ไล่ทั้งหน้า: สิ่งที่ได้ focus ต้องเห็นเส้น focus และไม่ถูกหัวเว็บบัง
      let hidden = 0
      let noRing = 0
      let steps = 0
      for (; steps < 70; steps++) {
        await p.keyboard.press('Tab')
        const f = await p.evaluate(() => {
          const el = document.activeElement
          if (!el || el === document.body) return null
          const r = el.getBoundingClientRect()
          const bar = document.querySelector('.topbar').getBoundingClientRect()
          const s = getComputedStyle(el)
          return { inBar: !!el.closest('.topbar'), skip: el.classList.contains('skip-link'), under: r.top < bar.bottom - 1 && r.bottom > bar.top, ring: s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2 }
        })
        if (!f) break
        if (!f.inBar && !f.skip && f.under) hidden++
        if (!f.ring) noRing++
      }
      check(`[จริง] หน้าแรก ${width}px คีย์บอร์ด: Tab ${steps} ครั้ง ทุกจุดมีเส้น focus และไม่ถูกหัวเว็บบัง`, steps >= 20 && hidden === 0 && noRing === 0, `ถูกบัง ${hidden} ไม่มีเส้น ${noRing}`)
    }
    if (width === 1024) {
      await p.setViewportSize({ width: 1023, height })
      const narrow = !(await p.locator('.sidebar').isVisible()) && (await p.getByRole('button', { name: 'เปิดเมนู' }).isVisible())
      await p.getByRole('button', { name: 'เปิดเมนู' }).click()
      const menu = p.locator('dialog.mobile-menu[open]')
      await menu.waitFor()
      // กดบนฉากหลังทางขวาของแผงเมนู (แผงกว้างไม่เกิน 320px)
      await p.mouse.click(900, 300)
      const closedOutside = (await gone(menu)) && (await p.evaluate(() => document.activeElement?.getAttribute('aria-label'))) === 'เปิดเมนู'
      await p.setViewportSize({ width: 1024, height })
      check('[จริง] breakpoint เมนู: 1023px เป็นเมนูเปิดปิด (กดพื้นที่ด้านนอกปิดได้และคืน focus) 1024px กลับเป็นเมนูซ้าย',
        narrow && closedOutside && (await p.locator('.sidebar').isVisible()) && !(await p.getByRole('button', { name: 'เปิดเมนู' }).isVisible()) && (await noOverflow(p)))
    }
    await p.context().close()
  }

  // ซูม 200% จำลองด้วย viewport 720×450 ที่ deviceScaleFactor 2 (เท่ากับจอ 1440×900 ที่ซูม 200%)
  {
    const context = await browser.newContext({ viewport: { width: 720, height: 450 }, deviceScaleFactor: 2, locale: 'th-TH', timezoneId: 'Asia/Bangkok' })
    await context.addCookies([{ name: 'mu_session', value: actors.admin.tokens[0], url: BASE, httpOnly: true, sameSite: 'Lax' }])
    const p = await context.newPage()
    p.on('console', (m) => m.type() === 'error' && noteError(m.text()))
    let fits = true
    for (const path of ['/', '/calendar', '/members', '/sources']) {
      await p.goto(BASE + path)
      await p.locator('#main h1').waitFor()
      await p.locator('.state-block[role="status"]').waitFor({ state: 'detached' }).catch(() => undefined)
      fits &&= await noOverflow(p)
    }
    await p.goto(`${BASE}/`)
    await p.locator('.home-calendar .calendar-title').waitFor()
    await p.screenshot({ path: `${OUT}/live-home-zoom200.png` })
    await p.getByRole('button', { name: 'เปิดเมนู' }).click()
    const menuOk = await appears(p.locator('dialog.mobile-menu[open]').getByRole('button', { name: 'ออกจากระบบ' }))
    await p.keyboard.press('Escape')
    check('[จริง] ซูม 200% (จำลอง 720×450 @2x): หน้าแรก ปฏิทิน สมาชิก แหล่งข้อมูลไม่ล้นแนวนอน และเมนู/ออกจากระบบยังเข้าถึงได้', fits && menuOk)
    await context.close()
  }

  // ================= 8.2 ข้อความเตือนต้องไม่ทับ control: ออกจากระบบล้มเหลว เซสชันหมดอายุหลังเลื่อน และ contrast ปุ่มหลัก =================
  // ตรวจจากตำแหน่งจริง (bounding box) และ hit testing (elementFromPoint) ไม่ใช่แค่ว่ามีข้อความอยู่ใน DOM
  const layoutProbe = (p, alertSelector) =>
    p.evaluate((alertSelector) => {
      const alert = document.querySelector(alertSelector)
      const a = alert?.getBoundingClientRect()
      const visible = (el) => {
        const r = el.getBoundingClientRect()
        const s = getComputedStyle(el)
        return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'
      }
      const controls = [...document.querySelectorAll('.topbar button, .sidebar a, #main a, #main button, #main input, #main select, #main textarea')].filter(visible)
      const overlapped = []
      const blocked = []
      for (const el of controls) {
        const r = el.getBoundingClientRect()
        if (a && !alert.contains(el) && r.left < a.right - 1 && r.right > a.left + 1 && r.top < a.bottom - 1 && r.bottom > a.top + 1) overlapped.push(el.textContent.trim() || el.id || el.tagName)
        const x = r.left + r.width / 2
        const y = r.top + r.height / 2
        // hit test เฉพาะ control ที่จุดกึ่งกลางอยู่ในจอ (นอกจอยังเลื่อนไปหาได้)
        if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue
        const top = document.elementFromPoint(x, y)
        if (!(top === el || el.contains(top) || top?.closest('label')?.contains(el))) {
          // แถบบันทึกของ editor เกาะขอบล่างโดยตั้งใจ ไม่นับว่าเป็นการบังจากข้อความเตือน
          if (!top?.closest('.editor-actions')) blocked.push(`${el.textContent.trim() || el.id || el.tagName} ← ${top?.className || top?.tagName}`)
        }
      }
      return { found: !!a, alertBox: a ? [Math.round(a.top), Math.round(a.bottom)] : null, overlapped, blocked, checked: controls.length }
    }, alertSelector)

  {
    const LOGOUT_MODES = [
      ['คำตอบผิดพลาด', 'ออกจากระบบไม่สำเร็จ', async (p) => p.route('**/auth/logout', (route) => route.fulfill({ status: 500, json: { error: 'internal_error', message: 'ระบบขัดข้อง' } }))],
      ['ยืนยันสถานะไม่ได้', 'ยืนยันไม่ได้ว่าออกจากระบบแล้วหรือยัง', async (p) => {
        await p.route('**/auth/logout', (route) => route.abort('failed'))
        // ปล่อยให้หน้าโหลด session ตอนเปิดได้ก่อน แล้วจึงตัด /api/session เมื่อจะกดออกจากระบบ
      }],
    ]
    const errorsBeforeAlerts = consoleErrors.length
    for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
      const narrow = width < 1024
      for (const path of ['/documents/new', '/members', '/calendar']) {
        for (const [modeName, expectText, arrange] of LOGOUT_MODES) {
          const tag = `[จำลองคำตอบ logout] ${width}px ${path} (${modeName})`
          const p = await newPage(width, height, actors.b)
          await p.goto(BASE + path)
          await p.locator('#main h1').waitFor()
          await p.locator('.state-block[role="status"]').waitFor({ state: 'detached' }).catch(() => undefined)
          const hasDraft = path === '/documents/new'
          if (hasDraft) {
            await p.locator('#document-title').fill('ร่างระหว่างออกจากระบบ')
            await p.locator('#document-text').fill('เนื้อหาร่าง')
          }
          await arrange(p)
          if (modeName === 'ยืนยันสถานะไม่ได้') await p.route('**/api/session', (route) => route.abort('failed'))
          const alert = p.locator('.logout-alert')
          let focusKept = true
          let menuShowed = true
          if (narrow) {
            await p.getByRole('button', { name: 'เปิดเมนู' }).click()
            const menu = p.locator('dialog.mobile-menu[open]')
            await menu.locator('.account button').click()
            menuShowed = (await appears(menu.locator('.account-error', { hasText: expectText }))) && (await alert.count()) === 0
            focusKept = (await p.evaluate(() => document.activeElement?.textContent?.trim())) === 'ออกจากระบบอีกครั้ง'
            await p.keyboard.press('Escape')
            await menu.waitFor({ state: 'detached' })
          } else {
            await p.locator('.topbar .account button').click()
            await alert.waitFor()
            focusKept = await p.evaluate(() => document.activeElement?.textContent?.trim() === 'ออกจากระบบอีกครั้ง' && !!document.activeElement.closest('.topbar'))
          }
          await p.unroute('**/api/session').catch(() => undefined)
          const text = (await appears(alert)) ? await alert.innerText() : ''
          const probe = await layoutProbe(p, '.logout-alert')
          const retryVisible = await p.getByRole('button', { name: 'ออกจากระบบอีกครั้ง' }).evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().width > 0).length)
          check(`${tag}: ข้อความอยู่ในแนวเนื้อหา ไม่ทับ control ใด และทุก control ในจอยังรับการกดได้ (hit test ${probe.checked} จุด)`,
            text.includes(expectText) && (await alert.getAttribute('role')) === 'alert' && probe.found && probe.overlapped.length === 0 && probe.blocked.length === 0 &&
            menuShowed && (await noOverflow(p)), JSON.stringify({ overlapped: probe.overlapped, blocked: probe.blocked, box: probe.alertBox }))
          // control เดิมของหน้ายังใช้งานได้จริง
          let works = false
          if (path === '/documents/new') {
            const back = p.getByRole('link', { name: 'รายการเอกสาร' })
            await back.focus()
            works = (await inViewport(back)) && (await p.evaluate(() => document.activeElement?.textContent?.includes('รายการเอกสาร'))) &&
              (await p.locator('#document-title').inputValue()) === 'ร่างระหว่างออกจากระบบ' && (await p.locator('#document-text').inputValue()) === 'เนื้อหาร่าง'
          } else if (path === '/members') {
            await p.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
            works = await appears(p.locator('#member-name'))
            await p.keyboard.press('Escape')
          } else {
            const before = await p.locator('.calendar-title').innerText()
            await p.getByRole('button', { name: 'เดือนถัดไป' }).click()
            works = (await p.locator('.calendar-title').innerText()) !== before
          }
          check(`${tag}: ปุ่มเดิมของหน้ายังรับ click/focus ${hasDraft ? 'ร่างยังอยู่ ' : ''}มีปุ่มลองออกจากระบบอีกครั้งที่ใช้ได้ชุดเดียว และ focus ไม่ถูกย้ายเอง`,
            works && retryVisible === 1 && focusKept && (await alert.isVisible()) && new URL(p.url()).pathname === path &&
            (await sessionUser(p))?.email === 'staff.b@example.com', `ปุ่มลองใหม่ที่เห็น ${retryVisible}`)
          if (hasDraft && modeName === 'คำตอบผิดพลาด') {
            await p.evaluate(() => window.scrollTo(0, 0))
            await p.screenshot({ path: `${OUT}/live-logout-alert-${width}.png` })
          }

          // ข้ามขอบ 1023/1024 ระหว่างมีข้อความเตือนและร่างค้าง
          if (hasDraft && modeName === 'คำตอบผิดพลาด' && width === 1440) {
            await p.setViewportSize({ width: 1023, height })
            const narrowProbe = await layoutProbe(p, '.logout-alert')
            const narrowOk = (await alert.isVisible()) && (await alert.innerText()).includes(expectText) && narrowProbe.overlapped.length === 0 && narrowProbe.blocked.length === 0 &&
              !(await p.locator('.topbar .account button').isVisible()) && (await alert.getByRole('button', { name: 'ออกจากระบบอีกครั้ง' }).isVisible())
            await p.getByRole('button', { name: 'เปิดเมนู' }).click()
            const menu = p.locator('dialog.mobile-menu[open]')
            await menu.waitFor()
            const inMenu = (await menu.locator('.account-error').innerText()).includes(expectText) && (await alert.count()) === 0
            await p.setViewportSize({ width: 1024, height })
            check(`[จำลองคำตอบ logout] resize 1440→1023→1024 ระหว่างมีข้อความและร่าง: ข้อความไม่หาย ย้ายตามตำแหน่งบัญชี ไม่มี scroll lock/เมนูค้าง ร่างยังอยู่`,
              narrowOk && inMenu && (await gone(menu)) && (await p.evaluate(() => getComputedStyle(document.documentElement).overflow !== 'hidden')) &&
              (await alert.isVisible()) && (await p.locator('.topbar .account button').innerText()).trim() === 'ออกจากระบบอีกครั้ง' &&
              !(await alert.getByRole('button').isVisible()) && (await p.locator('#document-title').inputValue()) === 'ร่างระหว่างออกจากระบบ' &&
              (await layoutProbe(p, '.logout-alert')).blocked.length === 0)
            // ธีมมืด
            await p.getByRole('switch', { name: 'ธีมมืด' }).click()
            await p.evaluate(() => window.scrollTo(0, 0))
            await p.screenshot({ path: `${OUT}/live-logout-alert-dark-1024.png` })
            await p.getByRole('switch', { name: 'ธีมมืด' }).click()
          }
          await p.context().close()
        }
      }
    }
    ignoreErrorsSince(errorsBeforeAlerts)

    // ---------- เซสชันหมดอายุ → ปิดไว้ก่อน → เลื่อน → ใช้หัวเว็บ → เปิด dialog กลับ → ตรวจสำเร็จ ----------
    const errorsBeforeExpired = consoleErrors.length
    for (const [width, height, label, dark] of [[1440, 900, '1440', false], [390, 844, '390', true], [844, 390, 'landscape-844x390', false]]) {
      const tag = `[จำลอง 401] เซสชันหมดอายุ ${label}${dark ? ' ธีมมืด' : ''}`
      const narrow = width < 1024
      const p = await newPage(width, height, actors.a, 1)
      await p.goto(`${BASE}/documents/new`)
      const draftText = Array.from({ length: 60 }, (_, i) => `บรรทัดร่างที่ ${i + 1}`).join('\n')
      await p.locator('#document-title').fill('ร่างตอนเซสชันหมดอายุ')
      await p.locator('#document-text').fill(draftText)
      await p.locator('#document-text').evaluate((el) => { el.style.height = '900px' })
      await p.evaluate(() => { window.__sameDocument = true })
      if (dark) await p.getByRole('switch', { name: 'ธีมมืด' }).click()
      await p.route('**/api/documents', (route) => (route.request().method() === 'POST' ? route.fulfill({ status: 401, json: { error: 'unauthenticated', message: 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว' } }) : route.fallback()))
      await p.getByRole('button', { name: 'สร้างเอกสาร' }).click()
      const dialog = p.locator('dialog[open]', { hasText: 'เซสชันหมดอายุ' })
      await dialog.waitFor()
      await dialog.getByRole('button', { name: 'ปิดไว้ก่อน' }).click()
      await dialog.waitFor({ state: 'detached' })
      const measure = () => p.evaluate(() => {
        const rect = (sel) => { const r = document.querySelector(sel).getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), left: r.left, width: r.width, height: r.height } }
        const hit = (sel) => { const el = document.querySelector(sel); const r = el.getBoundingClientRect(); if (!r.width) return null; const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2); return top === el || el.contains(top) }
        const banner = rect('.session-banner')
        const bar = rect('.topbar')
        const sticky = rect('.sticky-top')
        const sidebar = document.querySelector('.sidebar').getBoundingClientRect()
        return {
          banner: [banner.top, banner.bottom], bar: [bar.top, bar.bottom], overlap: Math.max(0, Math.min(banner.bottom, bar.bottom) - Math.max(banner.top, bar.top)),
          inView: banner.top >= 0 && bar.top >= 0 && bar.bottom <= innerHeight, stickyVar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-height')),
          stickyHeight: Math.ceil(sticky.height), sidebarClear: sidebar.width === 0 || sidebar.top >= sticky.bottom - 1,
          hitMenu: hit('.topbar-menu'), hitTheme: hit('.theme-switch'), hitBannerButton: hit('.session-banner button'), scrollY: Math.round(scrollY),
        }
      })
      const atTop = await measure()
      await p.evaluate(() => window.scrollTo(0, 400))
      await p.waitForTimeout(150)
      const scrolled = await measure()
      check(`${tag}: แถบเตือนกับหัวเว็บไม่ซ้อนทับกันทั้งก่อนและหลังเลื่อน 400px และพื้นที่ที่เว้นใช้ความสูงจริง`,
        atTop.overlap === 0 && scrolled.overlap === 0 && scrolled.scrollY >= 300 && scrolled.inView && scrolled.sidebarClear &&
        scrolled.stickyVar === scrolled.stickyHeight && scrolled.stickyHeight === scrolled.bar[1] - scrolled.banner[0], JSON.stringify(scrolled))
      check(`${tag}: หลังเลื่อน hit test ที่ปุ่มเมนู สวิตช์ธีม และปุ่มของแถบเตือนได้ตัวปุ่มเอง ไม่ถูกบัง`,
        scrolled.hitTheme === true && scrolled.hitBannerButton === true && (narrow ? scrolled.hitMenu === true : scrolled.hitMenu === null), JSON.stringify([scrolled.hitMenu, scrolled.hitTheme, scrolled.hitBannerButton]))
      await p.screenshot({ path: `${OUT}/live-session-expired-scrolled-${label}${dark ? '-dark' : ''}.png` })

      let menuOk = true
      if (narrow) {
        await p.getByRole('button', { name: 'เปิดเมนู' }).click()
        const menu = p.locator('dialog.mobile-menu[open]')
        menuOk = (await appears(menu.getByRole('link', { name: 'สมาชิก' }))) && (await menu.getByRole('button', { name: 'ออกจากระบบ' }).count()) === 1
        await p.keyboard.press('Escape')
        menuOk &&= (await gone(menu)) && (await p.evaluate(() => getComputedStyle(document.documentElement).overflow !== 'hidden'))
      }
      const themeBefore = await p.evaluate(() => document.documentElement.dataset.theme)
      await p.getByRole('switch', { name: 'ธีมมืด' }).click()
      const themeToggled = (await p.evaluate(() => document.documentElement.dataset.theme)) !== themeBefore
      await p.getByRole('switch', { name: 'ธีมมืด' }).click()
      // คัดลอกร่าง: เลือกทั้งช่องเนื้อหาแล้วอ่านข้อความที่เลือก
      await p.locator('#document-text').focus()
      await p.keyboard.press('Control+A')
      const selected = await p.evaluate(() => { const el = document.querySelector('#document-text'); return el.value.slice(el.selectionStart, el.selectionEnd) })
      // คีย์บอร์ด: ย้อน Tab จากช่องเนื้อหาขึ้นไป จุดที่ได้ focus ต้องไม่อยู่ใต้ส่วนที่เกาะด้านบน
      let hidden = 0
      for (let i = 0; i < 6; i++) {
        await p.keyboard.press('Shift+Tab')
        hidden += await p.evaluate(() => {
          const el = document.activeElement
          if (!el || el === document.body || el.closest('.sticky-top') || el.classList.contains('skip-link')) return 0
          const r = el.getBoundingClientRect()
          return r.top < document.querySelector('.sticky-top').getBoundingClientRect().bottom - 1 && r.bottom > 0 ? 1 : 0
        })
      }
      check(`${tag}: ยังเปิดเมนู/สลับธีมได้ เลือกคัดลอกร่างได้ครบ และ focus จากคีย์บอร์ดไม่ถูกหัวเว็บหรือแถบเตือนบัง`,
        menuOk && themeToggled && selected === draftText && hidden === 0, `ถูกบัง ${hidden}`)

      await p.unroute('**/api/documents')
      await p.locator('.session-banner').getByRole('button', { name: 'เข้าสู่ระบบอีกครั้ง' }).click()
      const reopened = await appears(dialog)
      await dialog.getByRole('button', { name: 'เข้าสู่ระบบแล้ว ทำงานต่อ' }).click()
      const resumed = (await gone(p.locator('.session-banner'))) && (await gone(dialog))
      // ความสูงส่วนที่เกาะด้านบนถูกวัดใหม่ในเฟรมถัดไป (ResizeObserver) จึงรอให้ค่าตามทันก่อนอ่าน ค่าที่ต้องได้ยังเท่าเดิม
      await p.waitForFunction(() => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-height')) === Math.ceil(document.querySelector('.topbar').getBoundingClientRect().height), null, { timeout: 2000 }).catch(() => undefined)
      const after = await p.evaluate(() => ({
        same: window.__sameDocument === true, stickyVar: parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sticky-height')),
        bar: Math.ceil(document.querySelector('.topbar').getBoundingClientRect().height), title: document.querySelector('#document-title').value, text: document.querySelector('#document-text').value,
      }))
      check(`${tag}: เปิด dialog กลับจากแถบเตือนได้ ตรวจสำเร็จแล้วแถบหาย พื้นที่ด้านบนกลับเท่าหัวเว็บ หน้าไม่ถูกโหลดใหม่และร่างยังอยู่`,
        reopened && resumed && after.same && after.stickyVar === after.bar && after.title === 'ร่างตอนเซสชันหมดอายุ' && after.text === draftText, JSON.stringify({ ...after, text: after.text.length }))
      await p.context().close()
    }
    ignoreErrorsSince(errorsBeforeExpired)

    // ---------- contrast ของปุ่มหลัก จากสีที่เบราว์เซอร์คำนวณจริง ----------
    const p = await newPage(1440, 900, actors.a, 1)
    await mockDocuments(p, mockState())
    const contrastOf = (locator) => locator.evaluate((el) => {
      const parse = (c) => c.match(/[\d.]+/g).slice(0, 3).map(Number)
      const lum = ([r, g, b]) => [r, g, b].map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4 }).reduce((sum, v, i) => sum + v * [0.2126, 0.7152, 0.0722][i], 0)
      const s = getComputedStyle(el)
      const [a, b] = [lum(parse(s.color)), lum(parse(s.backgroundColor))].sort((x, y) => y - x)
      return { ratio: Math.round(((a + 0.05) / (b + 0.05)) * 100) / 100, bg: s.backgroundColor, color: s.color, size: s.fontSize, outline: s.outlineStyle }
    })
    const TARGETS = [
      ['เพิ่มสมาชิก (หน้าแรก)', '/', (q) => q.locator('.page-header').getByRole('link', { name: 'เพิ่มสมาชิก' }), null],
      ['เพิ่มกำหนดการ (ปฏิทิน)', '/calendar', (q) => q.locator('.page-header').getByRole('button', { name: 'เพิ่มกำหนดการ' }), null],
      ['เพิ่มกำหนดการ (ใน dialog)', '/calendar', (q) => q.locator('dialog[open]').getByRole('button', { name: 'เพิ่มกำหนดการ' }), (q) => q.locator('.page-header').getByRole('button', { name: 'เพิ่มกำหนดการ' }).click()],
      ['สร้างเอกสาร', '/documents/new', (q) => q.getByRole('button', { name: 'สร้างเอกสาร' }), null],
      ['บันทึก (editor)', '/documents/doc-1', (q) => q.getByRole('button', { name: 'บันทึก', exact: true }), (q) => q.locator('#document-text').pressSequentially(' แก้')],
    ]
    for (const theme of ['light', 'dark']) {
      const rows = []
      let disabledSame = true
      for (const [name, path, find, prepare] of TARGETS) {
        await p.goto(BASE + path)
        await p.locator('#main h1').waitFor()
        if ((await p.evaluate(() => document.documentElement.dataset.theme)) !== theme) await p.getByRole('switch', { name: 'ธีมมืด' }).click()
        if (name === 'บันทึก (editor)') {
          await p.locator('#document-text').waitFor()
          // ปุ่มที่ยังกดไม่ได้: hover แล้วสีต้องไม่เปลี่ยน (พฤติกรรม disabled เดิม)
          const idle = find(p)
          if (await idle.isDisabled()) {
            const before = (await contrastOf(idle)).bg
            await idle.hover({ force: true })
            disabledSame &&= (await contrastOf(idle)).bg === before && (await idle.evaluate((el) => getComputedStyle(el).opacity)) === '0.5'
            await p.mouse.move(5, 300)
          }
        }
        if (prepare) await prepare(p)
        const button = find(p)
        await button.waitFor()
        await p.mouse.move(5, 300)
        const normal = await contrastOf(button)
        await button.hover()
        const hover = await contrastOf(button)
        await p.mouse.down()
        const active = await contrastOf(button)
        // ปล่อยปุ่มเมาส์นอกปุ่ม เพื่อไม่ให้นับเป็นการกด
        await p.mouse.move(5, 300)
        await p.mouse.up()
        await button.focus()
        await p.keyboard.press('Shift+Tab')
        await p.keyboard.press('Tab')
        const focus = await contrastOf(button)
        rows.push({ name, normal, hover, active, focus })
        await p.keyboard.press('Escape')
      }
      const worst = Math.min(...rows.flatMap((r) => [r.normal.ratio, r.hover.ratio, r.active.ratio, r.focus.ratio]))
      check(`[contrast] ปุ่มหลักธีม${theme === 'dark' ? 'มืด' : 'สว่าง'}: normal/hover/active/focus ของทั้ง ${rows.length} ปุ่ม ≥ 4.5:1 hover ยังต่างจากปกติ focus มีเส้นกรอบ และปุ่ม disabled ไม่เปลี่ยนสีเมื่อ hover`,
        worst >= 4.5 && rows.every((r) => r.hover.bg !== r.normal.bg && r.active.bg !== r.hover.bg && r.focus.outline !== 'none' && r.normal.color === 'rgb(255, 255, 255)') && disabledSame,
        `ต่ำสุด ${worst}:1 · ${rows.map((r) => `${r.name} ${r.normal.ratio}/${r.hover.ratio}/${r.active.ratio}/${r.focus.ratio}`).join(' · ')}`)
      if (theme === 'dark') {
        await p.goto(`${BASE}/documents/new`)
        await p.getByRole('button', { name: 'สร้างเอกสาร' }).hover()
        await p.screenshot({ path: `${OUT}/live-primary-hover-dark-1440.png` })
      }
    }
    await p.getByRole('switch', { name: 'ธีมมืด' }).click()
    await p.context().close()
  }

  // ================= 8.3 ทีมงาน: อีเมลไม่ถูกป้ายเบียดบนจอแคบ และปุ่มขนาดเล็กบน tablet แตะได้ ≥44px =================
  // รายชื่อจำลอง (ตอบ GET /api/users ในเบราว์เซอร์ทดสอบ) ไม่มีการเขียนข้อมูล: เปิดกล่องยืนยันแล้วปิดเท่านั้น
  {
    const LONG_EMAIL = 'very.long.staff.account.name.for.layout.check@student-organization.example.ac.th'
    const teamUsers = [
      { id: actors.admin.id ?? 'club', email: 'muesport2567@gmail.com', name: 'MU Esport', role: 'admin', status: 'active', isClubAccount: true, hasSignedIn: true, createdAt: '2026-10-01T03:00:00.000Z', lastLoginAt: '2026-10-05T10:00:00.000Z' },
      { id: 't-staff', email: 'staff.member@example.com', name: 'ทีมงาน ตัวอย่าง', role: 'staff', status: 'active', isClubAccount: false, hasSignedIn: true, createdAt: '2026-10-02T03:00:00.000Z', lastLoginAt: '2026-10-05T09:00:00.000Z' },
      { id: 't-admin', email: 'second.admin@example.com', name: '', role: 'admin', status: 'active', isClubAccount: false, hasSignedIn: false, createdAt: '2026-10-02T04:00:00.000Z', lastLoginAt: null },
      { id: 't-revoked', email: 'former.staff@example.com', name: 'อดีตทีมงาน', role: 'staff', status: 'revoked', isClubAccount: false, hasSignedIn: true, createdAt: '2026-10-02T05:00:00.000Z', lastLoginAt: '2026-10-03T09:00:00.000Z' },
      { id: 't-long', email: LONG_EMAIL, name: 'บัญชีอีเมลยาว', role: 'staff', status: 'active', isClubAccount: false, hasSignedIn: false, createdAt: '2026-10-02T06:00:00.000Z', lastLoginAt: null },
    ]
    const measureTeam = (p) => p.evaluate(() => {
      const list = document.querySelector('.team-list').getBoundingClientRect()
      const rows = [...document.querySelectorAll('.team-row')].map((row) => {
        const box = (sel) => row.querySelector(sel)?.getBoundingClientRect()
        const email = row.querySelector('.team-email')
        const style = getComputedStyle(email)
        const main = box('.team-main')
        const badges = box('.team-badges')
        const actions = box('.team-actions')
        const buttons = [...row.querySelectorAll('.team-actions .button')].map((el) => {
          const r = el.getBoundingClientRect()
          const top = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 1))
          return { h: Math.round(r.height), w: Math.round(r.width), inView: r.bottom <= innerHeight && r.top >= 0, hit: el.contains(top) }
        })
        return {
          email: email.textContent, mainWidth: Math.round(main.width), rowWidth: Math.round(row.getBoundingClientRect().width),
          lines: Math.round(email.getBoundingClientRect().height / parseFloat(style.lineHeight)),
          clipped: email.scrollWidth > email.clientWidth + 1 || style.textOverflow === 'ellipsis' || style.whiteSpace === 'nowrap' || style.overflow === 'hidden',
          badgesBeside: badges.top < main.bottom - 1 && badges.left < main.right - 1 ? 'overlap' : badges.top >= main.bottom - 1 ? 'below' : 'beside',
          actionsBelow: actions ? actions.top >= badges.bottom - 1 : null, badgeHeight: Math.round(row.querySelector('.badge').getBoundingClientRect().height),
          buttons, fits: main.right <= list.right + 1 && (!actions || actions.right <= list.right + 1),
        }
      })
      return { rows, overflow: document.documentElement.scrollWidth - innerWidth }
    })
    const errorsBeforeTeam = consoleErrors.length
    for (const theme of ['light', 'dark']) {
      for (const [width, height] of [[360, 740], [390, 844], [768, 1024], [1023, 768], [1024, 768], [1440, 900]]) {
        const tag = `[จำลองรายชื่อ] ทีมงาน ${width}px ธีม${theme === 'dark' ? 'มืด' : 'สว่าง'}`
        const p = await newPage(width, height, actors.admin)
        if (theme === 'dark') await p.addInitScript((key) => localStorage.setItem(key, 'dark'), THEME_KEY)
        await p.route('**/api/users', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { users: teamUsers } }) : route.fallback()))
        await p.goto(`${BASE}/team`)
        await p.locator('.team-row').first().waitFor()
        await p.evaluate(() => document.fonts.ready)
        const m = await measureTeam(p)
        const narrow = width < 768
        const normal = m.rows.filter((r) => r.email !== LONG_EMAIL)
        const long = m.rows.find((r) => r.email === LONG_EMAIL)
        check(`${tag}: อีเมลทั่วไปอยู่บรรทัดเดียวครบทุกบัญชี${narrow ? ' ข้อมูลบัญชีได้ความกว้างเต็มแถว ป้ายอยู่ใต้ข้อมูล ปุ่มอยู่ใต้ป้าย' : ''} ไม่ล้น`,
          m.overflow <= 0 && normal.length === 4 && normal.every((r) => r.lines === 1 && !r.clipped && r.fits) &&
          (!narrow || m.rows.every((r) => r.mainWidth >= r.rowWidth - 2 && r.badgesBeside === 'below' && r.actionsBelow !== false)) &&
          m.rows.every((r) => r.badgesBeside !== 'overlap'), JSON.stringify(m.rows.map((r) => [r.email.slice(0, 14), r.mainWidth, r.rowWidth, r.lines, r.badgesBeside])))
        check(`${tag}: อีเมลยาวมากขึ้นบรรทัดใหม่ได้ ไม่ถูกตัดหรือซ่อนส่วนท้าย และไม่ดันแถวล้น`,
          !!long && !long.clipped && long.fits && (width > 400 || long.lines >= 2) && (await p.locator('.team-email', { hasText: LONG_EMAIL }).innerText()) === LONG_EMAIL, `บรรทัด ${long?.lines}`)
        const buttons = m.rows.flatMap((r) => r.buttons)
        const clubRow = m.rows.find((r) => r.email === 'muesport2567@gmail.com')
        check(`${tag}: ปุ่มจัดการ${width < 1024 ? 'สูง ≥44px' : 'มีขนาดกดได้'} กดถึงตัวปุ่มเอง ป้ายสถานะยังเป็นป้าย (ไม่ถูกขยาย) และบัญชีชมรมไม่มีปุ่มจัดการ`,
          buttons.length === 7 && buttons.every((b) => (width < 1024 ? b.h >= 44 : b.h >= 36) && b.w >= 44 && (!b.inView || b.hit)) &&
          m.rows.every((r) => r.badgeHeight < 36) && clubRow.buttons.length === 0, JSON.stringify(buttons.map((b) => [b.w, b.h])))
        // เปิดกล่องยืนยันแต่ละแบบแล้วปิด: focus ต้องกลับไปที่ปุ่มเดิม (ไม่กดยืนยัน จึงไม่มีการเขียนข้อมูล)
        let dialogsOk = true
        for (const [name, expect] of [['เปลี่ยน staff.member@example.com เป็นผู้ดูแลระบบ', 'staff.member@example.com'], ['ถอนสิทธิ์ staff.member@example.com', 'ถอนสิทธิ์ staff.member@example.com?'], ['คืนสิทธิ์ former.staff@example.com', 'former.staff@example.com']]) {
          const button = p.getByRole('button', { name, exact: true })
          await button.click()
          const dialog = p.locator('dialog.dialog[open]')
          dialogsOk &&= (await appears(dialog.locator('h2', { hasText: expect }))) && (await noOverflow(p))
          await p.keyboard.press('Escape')
          dialogsOk &&= (await gone(dialog)) && (await p.evaluate((n) => document.activeElement?.getAttribute('aria-label') === n, name))
        }
        check(`${tag}: กล่องยืนยันเปลี่ยน/ถอน/คืนสิทธิ์เปิดได้ และปิดแล้ว focus กลับไปที่ปุ่มเดิม`, dialogsOk)
        if (theme === 'light' || width === 390 || width === 768) {
          await p.evaluate(() => window.scrollTo(0, 0))
          await shot(p, `live-team-rows-${width}${theme === 'dark' ? '-dark' : ''}`)
        }

        // ปุ่มทุกปุ่มในหน้าอื่นที่ใช้ปุ่มขนาดเล็กร่วมกัน บนจอสัมผัส (<1024px) ต้องสูง ≥44px
        if (theme === 'light' && width < 1024) {
          await mockDocuments(p, mockState())
          const small = []
          for (const path of ['/documents', '/sources', '/calendar?event=no-such-id', '/members']) {
            await p.goto(BASE + path)
            await p.locator('#main h1').waitFor()
            await p.locator('.state-block[role="status"]').waitFor({ state: 'detached' }).catch(() => undefined)
            small.push(...(await p.evaluate((path) => [...document.querySelectorAll('.button, .icon-button, .segmented button')]
              .filter((el) => el.getBoundingClientRect().width > 0)
              .map((el) => [path, el.textContent.trim() || el.getAttribute('aria-label'), Math.round(el.getBoundingClientRect().height)])
              .filter(([, , h]) => h < 44), path)))
            if (!(await noOverflow(p))) small.push([path, 'ล้นแนวนอน', 0])
          }
          check(`[จำลอง] ${width}px: ปุ่มในหน้าเอกสาร แหล่งข้อมูล ปฏิทิน และสมาชิกสูง ≥44px ทุกปุ่ม และหน้าไม่ล้น`, small.length === 0, JSON.stringify(small.slice(0, 6)))
        }
        await p.context().close()
      }
    }
    ignoreErrorsSince(errorsBeforeTeam)
  }

  // ================= 8.4 Google Sync: สถานะบนทุกหน้า การตั้งค่า ฟอร์ม และฉบับใหม่ของเอกสาร =================
  // ทุกข้อในส่วนนี้ตอบ API ของระบบด้วยข้อมูลจำลองในเบราว์เซอร์ทดสอบ เพื่อดูหน้าจอในแต่ละสถานะ ไม่มีการเรียก Google จริง
  // (การซิงค์จริงสองทิศทางตรวจใน test/sync-*.test.ts กับ Google จำลองฝั่ง Worker)
  {
    const errorsBeforeSync = consoleErrors.length
    const iso = (minutesAgo = 0) => new Date(Date.now() - minutesAgo * 60_000).toISOString()
    const unlinked = (kind) => ({ kind, linked: kind === 'docs', resource: null, syncing: false, lastSuccessAt: null, lastAttemptAt: null, error: null, retryAt: null, issues: [], dataVersion: 1 })
    const linkedStatus = (kind, name, over = {}) => ({
      ...unlinked(kind), linked: true, lastSuccessAt: iso(1), lastAttemptAt: iso(1), ...over,
      resource: { id: `res-${kind}`, name, url: `https://docs.google.com/mock/${kind}`, origin: 'created', access: 'write', ...(over.resource ?? {}) },
    })
    /** ตอบ /api/sync ด้วยสถานะใน state และนับคำสั่งซิงค์ที่หน้าเว็บส่ง */
    const mockSync = async (target, state) => {
      state.runs ??= []
      await target.route('**/api/sync', (route) => route.fulfill({ json: { sync: ['sheets', 'calendar', 'forms', 'docs'].map((k) => state.statuses[k] ?? unlinked(k)) } }))
      await target.route('**/api/sync/*', async (route) => {
        const kind = new URL(route.request().url()).pathname.split('/').pop()
        const body = route.request().postDataJSON() ?? {}
        state.runs.push({ kind, force: body.force === true })
        if (state.delay && body.force) await new Promise((resolve) => setTimeout(resolve, state.delay))
        state.onRun?.(kind, body.force === true)
        const status = state.statuses[kind] ?? unlinked(kind)
        await route.fulfill({ json: { ran: status.linked, skipped: status.linked ? null : 'not_linked', status } })
      })
    }
    const themed = async (p, theme) => theme === 'dark' && (await p.addInitScript((key) => localStorage.setItem(key, 'dark'), THEME_KEY))
    const tap = (p, selector) => p.locator(selector).evaluateAll((els) => els.filter((el) => el.getBoundingClientRect().width > 0).map((el) => Math.round(el.getBoundingClientRect().height)))

    // ---------- สมาชิก: ที่มา เวลาอัปเดต กำลังซิงค์ ล้มเหลว อาจไม่ล่าสุด และไม่ทับร่าง ----------
    const memberOf = (id, name, over = {}) => ({ id, name, nickname: name.slice(0, 2), role: 'member', status: 'active', contact: '', note: '', addedAt: '2026-10-01', version: 1, source: 'sheets', sourceState: 'ok', ...over })
    for (const [width, height, theme] of [[1440, 900, 'light'], [390, 844, 'light'], [390, 844, 'dark'], [1440, 900, 'dark']]) {
      const tag = `[จำลอง] สมาชิก+ชีต ${width}px ธีม${theme === 'dark' ? 'มืด' : 'สว่าง'}`
      const p = await newPage(width, height, actors.a, 1)
      await themed(p, theme)
      const state = { statuses: { sheets: linkedStatus('sheets', 'MU Esport — ทะเบียนสมาชิก') } }
      const members = [memberOf('m1', 'อารี ทดสอบ'), memberOf('m2', 'บุญมี เฉพาะเว็บ', { source: 'local' }), memberOf('m3', 'ชาตรี หายจากชีต', { sourceState: 'missing' })]
      await mockSync(p, state)
      await p.route('**/api/members', (route) => (route.request().method() === 'GET' ? route.fulfill({ json: { members } }) : route.fallback()))
      await p.route('**/api/members/m1', (route) => route.fulfill({ status: 409, json: { error: 'version_conflict', message: 'ข้อมูลนี้ถูกแก้ไขจากที่อื่นหลังจากที่คุณเปิด ยังไม่ได้บันทึกสิ่งที่คุณแก้', current: { ...members[0], nickname: 'จาก Google', version: 2 } } }))
      await p.goto(`${BASE}/members`)
      const row = p.locator('.sync-row[data-sync-kind="sheets"]')
      await row.waitFor()
      await p.locator('tbody tr').nth(2).waitFor()
      check(`${tag}: บอกที่มา (Google Sheets + ชื่อและลิงก์ต้นฉบับ) เวลาอัปเดตล่าสุด และมีปุ่ม “อัปเดตจาก Google”`,
        (await row.getAttribute('data-sync-state')) === 'ok' && (await row.locator('.badge-source').innerText()).includes('Google Sheets') &&
        (await row.locator('a.sync-origin').getAttribute('href')) === 'https://docs.google.com/mock/sheets' && /อัปเดตล่าสุด .+ น\./.test(await row.locator('.sync-state').innerText()) &&
        (await row.getByRole('button', { name: 'อัปเดตจาก Google Sheets' }).isEnabled()))
      check(`${tag}: สมาชิกที่อยู่เฉพาะในเว็บและที่ไม่พบในชีตมีป้ายกำกับ ไม่ปนกับสำเนาจากชีต และหน้าไม่ล้น`,
        (await p.locator('tbody tr', { hasText: 'บุญมี' }).locator('.source-note').innerText()) === 'เฉพาะในเว็บ' &&
        (await p.locator('tbody tr', { hasText: 'ชาตรี' }).locator('.source-note').innerText()) === 'ไม่พบในชีตต้นฉบับ' &&
        (await p.locator('tbody tr', { hasText: 'อารี' }).locator('.source-note').count()) === 0 && (await noOverflow(p)))
      if (width < 1024) check(`${tag}: ปุ่มในแถบสถานะสูง ≥44px`, (await tap(p, '.sync-row .button')).every((h) => h >= 44), JSON.stringify(await tap(p, '.sync-row .button')))
      await shot(p, `live-sync-members-${width}${theme === 'dark' ? '-dark' : ''}`)

      // มีร่างค้างในฟอร์มแก้ไข แล้วสำเนาจาก Google เปลี่ยน: รายการด้านหลังอัปเดต แต่ร่างและ focus ไม่ถูกแตะ
      await p.getByRole('button', { name: 'ดูรายละเอียด อารี ทดสอบ' }).click()
      await p.getByRole('button', { name: 'แก้ไข' }).click()
      await p.locator('#member-nickname').fill('ร่างของฉัน')
      await p.locator('#member-nickname').focus()
      members[0] = { ...members[0], nickname: 'จาก Google', version: 2 }
      members.push(memberOf('m4', 'ดารา มาใหม่'))
      state.statuses.sheets = { ...state.statuses.sheets, dataVersion: 2, lastSuccessAt: iso(0) }
      await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await p.locator('tbody tr', { hasText: 'ดารา มาใหม่' }).waitFor({ state: 'attached' })
      check(`${tag}: ข้อมูลใหม่จาก Google ขึ้นในรายการโดยไม่ต้องโหลดหน้าใหม่ ส่วนร่างที่กำลังกรอกและ focus ยังอยู่`,
        (await p.locator('#member-nickname').inputValue()) === 'ร่างของฉัน' && (await p.evaluate(() => document.activeElement?.id)) === 'member-nickname' &&
        (await p.locator('tbody tr', { hasText: 'อารี' }).locator('.member-nickname').innerText()) === 'จาก Google')
      await p.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
      check(`${tag}: บันทึกจากร่างเก่าได้ข้อความ conflict พร้อมปุ่มโหลดค่าล่าสุด และค่าที่กรอกยังอยู่`,
        (await appears(p.locator('dialog[open] .form-alert', { hasText: 'ถูกแก้ไขจากที่อื่น' }))) && (await p.locator('#member-nickname').inputValue()) === 'ร่างของฉัน' &&
        (await p.getByRole('button', { name: 'โหลดค่าล่าสุด (แทนที่ค่าที่กรอกไว้)' }).isVisible()))
      await p.getByRole('button', { name: 'ยกเลิก' }).click()
      await p.getByRole('button', { name: 'ทิ้งการแก้ไข' }).click()
      // ปิดฟอร์มแล้วกลับมาที่รายละเอียดของสมาชิกคนเดิม: ปิดรายละเอียดก่อนทำขั้นถัดไป
      await p.locator('dialog[open] .detail-list').waitFor()
      await p.keyboard.press('Escape')
      await gone(p.locator('dialog[open]'))

      if (theme === 'light') {
        // สมาชิกที่ไม่พบในชีต: อธิบาย ไม่มีปุ่มแก้ และมีทางเปิดต้นฉบับ
        await p.getByRole('button', { name: 'ดูรายละเอียด ชาตรี หายจากชีต' }).click()
        const dialog = p.locator('dialog[open]')
        check(`${tag}: สมาชิกที่ไม่พบในชีต: บอกว่าเก็บไว้ไม่ลบ ไม่มีปุ่มแก้ไข/พักการใช้งาน และมีลิงก์เปิดชีตต้นฉบับ`,
          (await appears(dialog.getByText('ไม่พบแถวของสมาชิกนี้ในชีตต้นฉบับแล้ว'))) && (await dialog.getByRole('button', { name: /แก้ไข|พักการใช้งาน/ }).count()) === 0 &&
          (await dialog.getByRole('link', { name: /เปิดชีตต้นฉบับ/ }).getAttribute('href')) === 'https://docs.google.com/mock/sheets')
        await p.keyboard.press('Escape')

        // กำลังซิงค์ → ล้มเหลว (ข้อมูลเดิมยังอยู่) → อาจไม่ล่าสุด → รายการที่ต้องแก้
        state.delay = 700
        state.onRun = (kind, force) => {
          if (force) state.statuses.sheets = { ...state.statuses.sheets, error: { code: 'rate_limited', message: 'Google จำกัดจำนวนคำขอชั่วคราว ระบบจะเว้นระยะแล้วลองใหม่เอง' }, retryAt: iso(-2) }
        }
        const forcedBefore = state.runs.filter((r) => r.force).length
        await row.getByRole('button', { name: 'อัปเดตจาก Google Sheets' }).click()
        const busy = (await appears(row.locator('.sync-state', { hasText: 'กำลังซิงค์…' }), 600)) && (await row.getByRole('button', { name: 'อัปเดตจาก Google Sheets' }).isDisabled())
        await row.locator('.sync-state-error').waitFor()
        const failedText = await row.locator('.sync-state').innerText()
        check(`${tag}: กด “อัปเดตจาก Google” แสดง “กำลังซิงค์…” และกดซ้ำไม่ได้ระหว่างรอ แล้วส่งคำสั่งครั้งเดียว`, busy && state.runs.filter((r) => r.force).length === forcedBefore + 1)
        check(`${tag}: ซิงค์ไม่สำเร็จ: แจ้งเหตุผล บอกว่าข้อมูลอาจยังไม่ล่าสุดพร้อมเวลาสำเร็จครั้งก่อน และรายชื่อเดิมยังอยู่ครบ ไม่กลายเป็นว่าง`,
          failedText.includes('ซิงค์ไม่สำเร็จ: Google จำกัดจำนวนคำขอ') && failedText.includes('ข้อมูลอาจยังไม่ล่าสุด') && failedText.includes('อัปเดตสำเร็จล่าสุด') &&
          (await row.locator('.sync-state').getAttribute('role')) === 'alert' && (await p.locator('tbody tr').count()) === 4)
        await shot(p, `live-sync-members-error-${width}`)
        state.delay = 0
        state.onRun = undefined
        state.statuses.sheets = linkedStatus('sheets', 'MU Esport — ทะเบียนสมาชิก', {
          lastSuccessAt: iso(12), dataVersion: 2, resource: { access: 'read' },
          issues: [{ code: 'duplicate_id', where: 'แถว 2 และ 4', message: 'รหัสสมาชิกซ้ำกัน ระบบจึงไม่อัปเดตสมาชิกรหัสนี้จนกว่าจะแก้ให้เหลือแถวเดียว' }, { code: 'invalid_row', where: 'แถว 7', message: 'ไม่มีชื่อ' }],
        })
        await p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
        await row.locator('.sync-state-stale').waitFor()
        check(`${tag}: ไม่มีรอบสำเร็จนานเกินกำหนดแสดง “ข้อมูลอาจยังไม่ล่าสุด” และรายการที่ต้องแก้ในต้นฉบับเปิดดูได้พร้อมเลขแถว`,
          (await row.locator('.sync-state').innerText()).startsWith('ข้อมูลอาจยังไม่ล่าสุด') && (await row.locator('.sync-issues summary').innerText()).includes('มี 2 รายการ') &&
          (await row.locator('.sync-issues li').first().evaluate((el) => el.textContent)).includes('แถว 2 และ 4'))
        check(`${tag}: ชีตที่อ่านได้อย่างเดียวแสดงป้าย “อ่านอย่างเดียว” และปุ่มเพิ่มสมาชิกถูกปิด`,
          (await appears(row.getByText('อ่านอย่างเดียว'))) && (await p.getByRole('button', { name: 'เพิ่มสมาชิก' }).isDisabled()))
      }
      await p.context().close()
    }

    // หลายแท็บในเบราว์เซอร์เดียวกัน: รอบตรวจอัตโนมัติสั่งซิงค์จากแท็บเดียว แท็บอื่นอ่านสถานะแทน
    {
      const first = await newPage(1280, 800, actors.b)
      const context = first.context()
      const state = { statuses: { sheets: linkedStatus('sheets', 'ทะเบียน'), calendar: linkedStatus('calendar', 'กำหนดการ') } }
      await mockSync(context, state)
      await first.goto(`${BASE}/members`)
      await first.locator('.sync-row[data-sync-kind="sheets"][data-sync-state="ok"]').waitFor()
      const second = await context.newPage()
      const third = await context.newPage()
      for (const tab of [second, third]) {
        await tab.goto(`${BASE}/calendar`)
        await tab.locator('.sync-row[data-sync-kind="calendar"][data-sync-state="ok"]').waitFor()
      }
      const posts = (kind) => state.runs.filter((r) => r.kind === kind && !r.force).length
      check('[จำลอง] สามแท็บเปิดพร้อมกัน: รอบอัตโนมัติสั่งซิงค์บริการละหนึ่งครั้ง แท็บอื่นแสดงสถานะเดียวกันโดยไม่สั่งซ้ำ', posts('sheets') === 1 && posts('calendar') === 1, JSON.stringify(state.runs))
      await context.close()
    }

    // ---------- ปฏิทิน: กำหนดการซ้ำแก้จากเว็บไม่ได้ และปฏิทินอ่านอย่างเดียว ----------
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const p = await newPage(width, height, actors.a, 1)
      const today = new Date(Date.now() + 7 * 3_600_000).toISOString().slice(0, 10)
      const eventOf = (id, title, over = {}) => ({ id, title, allDay: false, start: `${today}T18:00`, end: `${today}T20:00`, location: '', description: '', version: 1, source: 'calendar', recurring: false, editable: true, editNote: '', googleUrl: `https://calendar.google.com/event?eid=${id}`, ...over })
      const state = { statuses: { calendar: linkedStatus('calendar', 'MU Esport — กำหนดการ') } }
      await mockSync(p, state)
      await p.route('**/api/events', (route) => route.fulfill({ json: { events: [
        eventOf('e1', 'นัดซ้อมทีม'),
        eventOf('e2', 'ซ้อมประจำสัปดาห์', { recurring: true, editable: false, editNote: 'เป็นกำหนดการซ้ำ การแก้ครั้งเดียวหรือทั้งชุดต้องทำใน Google Calendar เพื่อไม่ให้ชุดกำหนดการเสียหาย' }),
        eventOf('e3', 'ประชุมในเว็บ', { source: 'local', googleUrl: null }),
      ] } }))
      await p.goto(`${BASE}/calendar?event=e2`)
      const dialog = p.locator('dialog[open]')
      await dialog.waitFor()
      check(`[จำลอง] ปฏิทิน ${width}px: กำหนดการซ้ำบอกเหตุผลที่แก้จากเว็บไม่ได้ ไม่มีปุ่มแก้ไข และมีลิงก์เปิดใน Google Calendar`,
        (await appears(dialog.getByText('แก้จากเว็บไม่ได้: เป็นกำหนดการซ้ำ'))) && (await dialog.getByRole('button', { name: 'แก้ไข' }).count()) === 0 &&
        (await dialog.getByRole('link', { name: /เปิดใน Google Calendar/ }).getAttribute('href')) === 'https://calendar.google.com/event?eid=e2' &&
        (await dialog.getByText('Google Calendar · กำหนดการซ้ำ').isVisible()) && (await noOverflow(p)))
      await shot(p, `live-sync-calendar-recurring-${width}`, false)
      await p.keyboard.press('Escape')
      await p.goto(`${BASE}/calendar?event=e3`)
      await dialog.waitFor()
      check(`[จำลอง] ปฏิทิน ${width}px: รายการที่ยังไม่ได้ย้ายขึ้น Google บอกว่าอยู่เฉพาะในเว็บ และยังแก้ได้`,
        (await dialog.getByText('เฉพาะในเว็บ (ยังไม่อยู่ใน Google Calendar)').isVisible()) && (await dialog.getByRole('button', { name: 'แก้ไข' }).isVisible()))
      await p.keyboard.press('Escape')
      state.statuses.calendar = linkedStatus('calendar', 'ปฏิทินของคณะ', { resource: { access: 'read', origin: 'selected' }, dataVersion: 1 })
      await p.goto(`${BASE}/calendar?event=e1`)
      await dialog.waitFor()
      check(`[จำลอง] ปฏิทิน ${width}px: ปฏิทินอ่านอย่างเดียว ไม่มีปุ่มแก้ไขในรายละเอียด และปุ่มเพิ่มกำหนดการถูกปิด`,
        (await dialog.getByRole('button', { name: 'แก้ไข' }).count()) === 0 && (await dialog.getByText('มีสิทธิ์อ่านปฏิทินนี้อย่างเดียว').isVisible()) &&
        (await p.getByRole('button', { name: 'เพิ่มกำหนดการ' }).first().isDisabled()))
      await p.context().close()
    }

    // ---------- ฟอร์ม: คำถาม คำตอบอ่านอย่างเดียว แก้คำถาม conflict และเพิ่มสมาชิกจากคำตอบ ----------
    const formView = (over = {}) => ({
      form: { id: 'f1', name: 'สมัครสมาชิก', title: 'สมัครสมาชิก MU Esport', description: 'กรอกให้ครบ', revisionId: 'r1', editUrl: 'https://docs.google.com/forms/d/f1/edit', responderUrl: 'https://docs.google.com/forms/d/e/f1/viewform', isQuiz: false, published: true, acceptingResponses: true, writable: true, mapping: { name: 'q1', nickname: 'q2' }, canConfigure: false, ...over },
      items: [
        { itemId: 'i1', kind: 'short_text', title: 'ชื่อ-นามสกุล', description: '', required: true, questions: [{ id: 'q1', label: '' }], options: [], editable: true, editNote: '', removedAt: null },
        { itemId: 'i2', kind: 'short_text', title: 'ชื่อเล่น', description: '', required: true, questions: [{ id: 'q2', label: '' }], options: [], editable: true, editNote: '', removedAt: null },
        { itemId: 'i3', kind: 'checkbox', title: 'เกมที่เล่น', description: 'เลือกได้หลายข้อ', required: false, questions: [{ id: 'q3', label: '' }], options: [{ value: 'ROV', isOther: false }, { value: 'Valorant', isOther: false }, { value: '', isOther: true }], editable: true, editNote: '', removedAt: null },
        { itemId: 'i4', kind: 'grid', title: 'วันที่สะดวก', description: '', required: false, questions: [{ id: 'q4', label: 'จันทร์' }, { id: 'q5', label: 'อังคาร' }], options: [{ value: 'ว่าง', isOther: false }], editable: false, editNote: 'คำถามแบบตาราง แก้ใน Google Forms', removedAt: null },
        { itemId: 'i9', kind: 'short_text', title: 'เบอร์โทร (คำถามเดิม)', description: '', required: false, questions: [{ id: 'q9', label: '' }], options: [], editable: false, editNote: '', removedAt: '2026-10-02T03:00:00.000Z' },
      ],
      responses: [
        { responseId: 'rA', createTime: '2026-10-05T03:00:00.000Z', lastSubmittedTime: '2026-10-05T04:00:00.000Z', respondentEmail: 'applicant@example.com', answers: { q1: { values: ['อารี ใจดี'], files: [] }, q2: { values: ['อา'], files: [] }, q3: { values: ['ROV', 'Valorant'], files: [] }, q9: { values: ['0812345678'], files: [] } }, sourceState: 'ok', reviewStatus: 'new', memberId: null, candidate: { name: 'อารี ใจดี', nickname: 'อา', contact: '', note: '' }, duplicates: [{ id: 'm1', name: 'อารี ใจดี', nickname: 'อารี' }] },
        { responseId: 'rB', createTime: '2026-10-04T03:00:00.000Z', lastSubmittedTime: '2026-10-04T03:00:00.000Z', respondentEmail: '', answers: { q1: { values: ['บุญมี'], files: [] } }, sourceState: 'missing', reviewStatus: 'imported', memberId: 'm2', candidate: { name: 'บุญมี', nickname: '', contact: '', note: '' }, duplicates: [] },
      ],
      responseCount: 2,
    })
    for (const [who, actor, width, height, theme] of [['ทีมงาน', actors.a, 1440, 900, 'light'], ['ทีมงาน', actors.a, 390, 844, 'dark'], ['ผู้ดูแล', actors.admin, 768, 1024, 'light']]) {
      const tag = `[จำลอง] ฟอร์ม (${who}) ${width}px ธีม${theme === 'dark' ? 'มืด' : 'สว่าง'}`
      const p = await newPage(width, height, actor, actor === actors.a ? 1 : 0)
      await themed(p, theme)
      const state = { statuses: { forms: linkedStatus('forms', 'สมัครสมาชิก') } }
      let view = formView({ canConfigure: who === 'ผู้ดูแล' })
      const sent = []
      await mockSync(p, state)
      await p.route('**/api/forms', (route) => route.fulfill({ json: view }))
      await p.route('**/api/forms/**', async (route) => {
        const request = route.request()
        const path = new URL(request.url()).pathname
        sent.push({ method: request.method(), path, body: request.postDataJSON() })
        if (path.endsWith('/items/i3') && request.postDataJSON().expectedRevision === 'r1' && sent.filter((s) => s.path.endsWith('/items/i3')).length === 1) {
          // ครั้งแรก: ฟอร์มถูกแก้ที่ Google ไปก่อน
          view = formView({ canConfigure: who === 'ผู้ดูแล', revisionId: 'r2' })
          view.items[2] = { ...view.items[2], title: 'เกมที่เล่น (แก้ที่ Google)' }
          return route.fulfill({ status: 409, json: { error: 'revision_conflict', message: 'ฟอร์มถูกแก้ไขใน Google Forms หลังจากที่คุณเปิด ยังไม่ได้บันทึกสิ่งที่คุณแก้ หน้านี้แสดงฉบับล่าสุดแล้ว ตรวจก่อนบันทึกอีกครั้ง' } })
        }
        if (path.endsWith('/import')) {
          view.responses[0] = { ...view.responses[0], reviewStatus: 'imported', memberId: 'm9', duplicates: [] }
          return route.fulfill({ status: 201, json: { ...view, memberId: 'm9' } })
        }
        if (path.endsWith('/items/i3')) {
          view.items[2] = { ...view.items[2], title: request.postDataJSON().title, options: [...request.postDataJSON().options.map((value) => ({ value, isOther: false })), { value: '', isOther: true }] }
          view.form.revisionId = 'r3'
        }
        return route.fulfill({ json: { ...view, verified: true } })
      })
      await p.goto(`${BASE}/forms`)
      await p.locator('.form-item').first().waitFor()
      check(`${tag}: เมนูมี “ฟอร์ม” และหน้าแสดงหัวเรื่อง คำถามตามลำดับ ชนิด ตัวเลือก และเหตุผลของคำถามที่แก้จากเว็บไม่ได้`,
        (await p.locator('.form-item').count()) === 4 && (await p.locator('.form-item').nth(2).innerText()).includes('ตัวเลือก: ROV · Valorant · อื่น ๆ (ผู้ตอบพิมพ์เอง)') &&
        (await p.locator('.form-item').nth(3).innerText()).includes('คำถามแบบตาราง แก้ใน Google Forms') && (await p.locator('.form-item').nth(3).getByRole('button').count()) === 0 &&
        (await p.getByRole('heading', { name: 'สมัครสมาชิก MU Esport' }).isVisible()) && (await noOverflow(p)) &&
        (width < 1024 || (await p.locator('.sidebar').getByRole('link', { name: 'ฟอร์ม', exact: true }).getAttribute('aria-current')) === 'page'))
      check(`${tag}: คำตอบที่ได้รับแสดงสถานะการตรวจ คำตอบที่ถูกลบที่ Google และคำเตือนอาจซ้ำ; ปุ่มจับคู่คำถามมีเฉพาะผู้ดูแล`,
        (await p.locator('.response-row').count()) === 2 && (await p.locator('.response-row').first().innerText()).includes('อาจซ้ำกับสมาชิกเดิม') &&
        (await p.locator('.response-row').nth(1).innerText()).includes('ถูกลบที่ Google Forms แล้ว') && (await p.locator('.response-row').nth(1).innerText()).includes('เพิ่มเป็นสมาชิกแล้ว') &&
        (await p.getByRole('button', { name: 'จับคู่คำถามกับทะเบียนสมาชิก' }).count()) === (who === 'ผู้ดูแล' ? 1 : 0))
      if (width < 1024) check(`${tag}: ปุ่มทั้งหมดในหน้าสูง ≥44px`, (await tap(p, 'main .button')).every((h) => h >= 44), JSON.stringify(await tap(p, 'main .button')))
      await shot(p, `live-forms-${width}${theme === 'dark' ? '-dark' : ''}`)

      // คำตอบต้นฉบับ: อ่านอย่างเดียว จับคู่กับคำถามด้วย ID รวมคำถามที่ถูกลบ
      const viewButton = p.locator('.response-row').first().getByRole('button', { name: 'ดูคำตอบ' })
      await viewButton.click()
      const dialog = p.locator('dialog[open]')
      const answers = await dialog.locator('.answer-list').innerText()
      check(`${tag}: ดูคำตอบต้นฉบับ: ไม่มีช่องกรอกหรือปุ่มแก้/ส่งคำตอบ คำตอบของคำถามที่ถูกลบยังอ่านได้พร้อมป้าย และปิดแล้ว focus กลับปุ่มเดิม`,
        (await dialog.locator('input, textarea, select, [contenteditable]').count()) === 0 && (await dialog.getByRole('button').count()) === 2 &&
        answers.includes('เบอร์โทร (คำถามเดิม)') && answers.includes('คำถามถูกลบแล้ว') && answers.includes('0812345678') && answers.includes('ROV\nValorant') && (await noOverflow(p)))
      await p.keyboard.press('Escape')
      await gone(dialog)
      check(`${tag}: ปิดกล่องคำตอบแล้ว focus กลับไปที่ปุ่ม “ดูคำตอบ” เดิม`, await viewButton.evaluate((el) => el === document.activeElement))

      // แก้คำถาม: conflict แล้วเลือกบันทึกค่าที่กรอกทับฉบับล่าสุด
      await p.getByRole('button', { name: 'แก้ไขคำถาม เกมที่เล่น' }).click()
      await p.locator('#question-title').fill('เกมที่อยากแข่ง')
      await p.getByRole('button', { name: 'เพิ่มตัวเลือก' }).click()
      await p.locator('#question-option-2').fill('FC Online')
      await p.getByRole('button', { name: 'บันทึกไป Google Forms' }).click()
      const alert = dialog.locator('.form-alert')
      check(`${tag}: แก้คำถามจากฉบับเก่า: แจ้ง conflict แสดงค่าล่าสุดจาก Google ค่าที่กรอกยังอยู่ และปุ่มบันทึกปกติถูกปิดจนกว่าจะเลือก`,
        (await appears(alert.getByText('ฟอร์มถูกแก้ไขใน Google Forms'))) && (await appears(alert.getByText('เกมที่เล่น (แก้ที่ Google)'))) &&
        (await p.locator('#question-title').inputValue()) === 'เกมที่อยากแข่ง' && (await p.locator('#question-option-2').inputValue()) === 'FC Online' &&
        (await dialog.getByRole('button', { name: 'บันทึกไป Google Forms' }).isDisabled()) && (await dialog.getByText('ตัวเลือก “อื่น ๆ (ผู้ตอบพิมพ์เอง)” ของฟอร์มนี้ยังอยู่ตามเดิม').isVisible()))
      await shot(p, `live-forms-conflict-${width}${theme === 'dark' ? '-dark' : ''}`, false)
      await alert.getByRole('button', { name: 'บันทึกค่าที่ฉันกรอกทับฉบับล่าสุด' }).click()
      await gone(dialog)
      const saved = sent.filter((s) => s.path.endsWith('/items/i3'))
      check(`${tag}: บันทึกครั้งที่สองอ้าง revision ล่าสุด ส่งเฉพาะข้อความ บังคับตอบ และตัวเลือก แล้วหน้าแสดงผลที่ Google ยืนยัน`,
        saved.length === 2 && saved[1].body.expectedRevision === 'r2' && JSON.stringify(saved[1].body.options) === JSON.stringify(['ROV', 'Valorant', 'FC Online']) &&
        (await appears(p.locator('.form-item', { hasText: 'เกมที่อยากแข่ง' }))) && (await appears(p.locator('.toast', { hasText: 'บันทึกคำถามไป Google Forms แล้ว' }))))

      // ตรวจก่อนเพิ่มเป็นสมาชิก
      await p.getByRole('button', { name: 'ตรวจและเพิ่มเป็นสมาชิก' }).click()
      check(`${tag}: ตรวจก่อนเพิ่มสมาชิก: เติมค่าตามการจับคู่ เตือนรายการที่อาจซ้ำ และบอกว่าไม่ให้สิทธิ์เข้าหลังบ้าน`,
        (await p.locator('#import-name').inputValue()) === 'อารี ใจดี' && (await p.locator('#import-nickname').inputValue()) === 'อา' &&
        (await appears(dialog.getByText('อาจซ้ำกับสมาชิกที่มีอยู่'))) && (await dialog.getByText('การเพิ่มนี้ไม่ให้สิทธิ์เข้าหลังบ้าน').isVisible()) && (await noOverflow(p)))
      await p.locator('#import-name').fill('')
      await p.getByRole('button', { name: 'เพิ่มเป็นสมาชิก', exact: true }).click()
      const blocked = (await appears(p.locator('#import-name-error'))) && !sent.some((s) => s.path.endsWith('/import'))
      await p.locator('#import-name').fill('อารี ใจดี (รุ่น 69)')
      await p.getByRole('button', { name: 'เพิ่มเป็นสมาชิก', exact: true }).click()
      await gone(dialog)
      const imported = sent.find((s) => s.path.endsWith('/import'))
      check(`${tag}: ชื่อว่างถูกกันไว้ก่อนส่ง แล้วเพิ่มด้วยค่าที่ทีมงานปรับ (ไม่มีบทบาทหรือสิทธิ์ในคำขอ) และรายการคำตอบเปลี่ยนเป็น “เพิ่มเป็นสมาชิกแล้ว”`,
        blocked && imported?.path === '/api/forms/responses/rA/import' && JSON.stringify(Object.keys(imported.body).sort()) === JSON.stringify(['contact', 'name', 'nickname', 'note']) &&
        imported.body.name === 'อารี ใจดี (รุ่น 69)' && (await appears(p.locator('.response-row').first().getByText('เพิ่มเป็นสมาชิกแล้ว'))))
      await p.context().close()
    }
    {
      // ยังไม่ได้เชื่อมฟอร์ม: บอกตามจริง ไม่มีรายการปลอม
      for (const [who, actor] of [['ทีมงาน', actors.a], ['ผู้ดูแล', actors.admin]]) {
        const p = await newPage(1280, 800, actor, actor === actors.a ? 1 : 0)
        await p.goto(`${BASE}/forms`)
        check(`[จริง] ฟอร์ม (${who}) ยังไม่ได้เชื่อม: บอกว่ายังไม่ได้เชื่อม Google Forms ไม่มีคำถามหรือคำตอบแสดง และทางไปตั้งค่ามีเฉพาะผู้ดูแล`,
          (await appears(p.getByText('ยังไม่ได้เชื่อม Google Forms').first())) && (await p.locator('.form-item, .response-row').count()) === 0 &&
          (await p.getByRole('link', { name: 'ไปตั้งค่าที่หน้าแหล่งข้อมูล' }).count()) === (who === 'ผู้ดูแล' ? 1 : 0))
        await p.context().close()
      }
    }

    // ---------- แหล่งข้อมูล: พื้นที่ข้อมูลชมรม ----------
    const sourcesConnected = {
      google: { status: 'connected', expectedEmail: 'muesport2567@gmail.com', email: 'muesport2567@gmail.com', connectedAt: '2026-10-01T03:00:00.000Z', lastCheckedAt: iso(3), lastError: null, missingConfig: [] },
      resources: [{ id: 'docs', status: 'ready' }, { id: 'sheets', status: 'not_selected' }, { id: 'calendar', status: 'not_selected' }, { id: 'forms', status: 'not_selected' }, { id: 'excel', status: 'disabled' }],
    }
    const setupInfo = (over = {}) => ({
      scopes: { driveFile: true, calendarCreated: false, calendarExisting: false },
      picker: { configured: false, missing: ['GOOGLE_PICKER_API_KEY', 'GOOGLE_CLOUD_PROJECT_NUMBER'], apiKey: '', appId: '', clientId: 'mock-client' },
      local: { members: 4, events: 2 }, operations: [], sync: [], ...over,
    })
    for (const [width, height, theme] of [[1440, 900, 'light'], [390, 844, 'dark']]) {
      const tag = `[จำลอง] ตั้งค่าพื้นที่ข้อมูล ${width}px ธีม${theme === 'dark' ? 'มืด' : 'สว่าง'}`
      const p = await newPage(width, height, actors.admin)
      await themed(p, theme)
      const state = { statuses: {} }
      const creates = []
      let info = setupInfo()
      await mockSync(p, state)
      await p.route('**/api/sources', (route) => route.fulfill({ json: sourcesConnected }))
      await p.route('**/api/setup', (route) => route.fulfill({ json: info }))
      await p.route('**/api/setup/create', async (route) => {
        const request = route.request()
        const body = request.postDataJSON()
        creates.push({ kind: body.kind, name: body.name, key: request.headers()['idempotency-key'], confirm: body.confirmCreate === true })
        // ฟอร์ม: ครั้งแรกคำตอบของ Google หาย
        if (body.kind === 'forms' && creates.filter((c) => c.kind === 'forms').length === 1) {
          return route.fulfill({ status: 502, json: { error: 'operation_create_unknown', message: 'ไม่ทราบว่า Google สร้างฟอร์มแล้วหรือยัง ระบบจะไม่สร้างใหม่เอง กด “ลองอีกครั้ง” เพื่อให้ระบบค้นหารายการเดิม', canConfirmCreate: false } })
        }
        state.statuses[body.kind] = linkedStatus(body.kind, body.name)
        return route.fulfill({ status: 201, json: { status: state.statuses[body.kind] } })
      })
      await p.goto(`${BASE}/sources`)
      const space = p.locator('.data-space')
      await space.locator('.resource-state').nth(2).waitFor()
      // ปุ่มขอสิทธิ์และคำอธิบาย Picker มาจาก /api/setup ซึ่งโหลดแยกจากสถานะซิงค์: รอให้ส่วนนี้แสดงก่อนอ่านข้อความ
      await space.getByText('GOOGLE_PICKER_API_KEY').waitFor()
      const spaceText = await space.innerText()
      check(`${tag}: แสดงสถานะจริงของชีต ปฏิทิน ฟอร์ม (ยังไม่ได้เชื่อม) Excel ยังไม่เปิดใช้ และอธิบายสิ่งที่ยังขาดของ Picker โดยไม่มีช่องวางลิงก์`,
        (await space.locator('.resource-row').count()) === 3 && (spaceText.match(/ยังไม่ได้เชื่อม/g) ?? []).length === 3 && (await space.locator('.badge-active, .resource-state a').count()) === 0 &&
        spaceText.includes('GOOGLE_PICKER_API_KEY') && (await space.getByRole('button', { name: 'เลือกชีตที่มีอยู่' }).isDisabled()) &&
        (await space.locator('input[type="url"], input[type="text"]').count()) === 0 && (await p.locator('.source-card', { hasText: 'Excel' }).innerText()).includes('ยังไม่เปิดใช้') &&
        (await p.locator('.source-card').count()) === 2 && (await noOverflow(p)))
      check(`${tag}: ปฏิทินต้องขอสิทธิ์แยก มีปุ่มขอสิทธิ์สองทางพร้อมคำอธิบายความกว้างของสิทธิ์`,
        (await space.getByRole('button', { name: 'ขอสิทธิ์เพื่อเลือกปฏิทินที่มีอยู่' }).isVisible()) && (await space.getByRole('button', { name: 'ขอสิทธิ์เพื่อสร้างปฏิทินใหม่' }).isVisible()) &&
        spaceText.includes('Google จะแสดงหน้าขออนุญาตให้ตรวจก่อน'))
      await shot(p, `live-setup-space-${width}${theme === 'dark' ? '-dark' : ''}`)

      const opener = space.getByRole('button', { name: 'สร้างชุดข้อมูลชมรม' })
      await opener.click()
      const dialog = p.locator('dialog[open]')
      await dialog.locator('#create-name-sheets').waitFor()
      check(`${tag}: “สร้างชุดข้อมูลชมรม”: เสนอชื่อที่แก้ได้ บอกสิ่งที่จะสร้างและข้อมูลเดิม ปฏิทินที่ยังไม่มีสิทธิ์ติ๊กไม่ได้ และยังไม่มีคำสั่งสร้างจนกว่าจะยืนยัน`,
        (await dialog.locator('#create-name-sheets').inputValue()) === 'MU Esport — ทะเบียนสมาชิก' && (await dialog.locator('#create-name-forms').inputValue()) === 'MU Esport — สมัครสมาชิก' &&
        (await dialog.locator('[data-create="calendar"] input[type="checkbox"]').isDisabled()) && (await dialog.getByText('สมาชิก 4 คน และกำหนดการ 2 รายการ').isVisible()) &&
        (await dialog.getByText('ระบบจับคู่แถวด้วยคอลัมน์รหัสสมาชิก').isVisible()) && creates.length === 0 && (await noOverflow(p)))
      await shot(p, `live-setup-create-${width}${theme === 'dark' ? '-dark' : ''}`, false)
      await dialog.locator('#create-name-sheets').fill('ทะเบียนสมาชิกชมรม 2569')
      await dialog.getByRole('button', { name: 'สร้าง 2 รายการในบัญชีชมรม' }).click()
      await dialog.locator('[data-create="forms"] .form-alert').waitFor()
      check(`${tag}: ชีตสร้างและเชื่อมแล้ว ส่วนฟอร์มที่ไม่ทราบผลแสดงแยกจากล้มเหลว และบอกว่าระบบจะไม่สร้างซ้ำเอง`,
        (await dialog.locator('[data-create="sheets"] .create-result-ok').isVisible()) && (await dialog.locator('[data-create="forms"] .form-alert').innerText()).includes('ไม่ทราบว่า Google สร้างฟอร์มแล้วหรือยัง') &&
        creates.length === 2 && creates[0].name === 'ทะเบียนสมาชิกชมรม 2569')
      await dialog.getByRole('button', { name: 'ลองรายการที่ยังไม่เสร็จอีกครั้ง' }).click()
      await dialog.getByRole('button', { name: 'เสร็จ' }).waitFor()
      const formCreates = creates.filter((c) => c.kind === 'forms')
      check(`${tag}: ลองอีกครั้งใช้ operation key เดิมของฟอร์ม (ไม่เริ่มงานสร้างใหม่) และไม่ส่งคำสั่งสร้างชีตซ้ำ`,
        formCreates.length === 2 && formCreates[0].key === formCreates[1].key && /^[A-Za-z0-9_-]{16,64}$/.test(formCreates[0].key) && creates.filter((c) => c.kind === 'sheets').length === 1)
      info = setupInfo({ local: { members: 4, events: 2 } })
      await dialog.getByRole('button', { name: 'เสร็จ' }).click()
      await gone(dialog)
      await space.locator('[data-resource="sheets"] .badge-active').waitFor()
      check(`${tag}: หลังสร้าง: ชีตและฟอร์มแสดง “เชื่อมแล้ว” พร้อมลิงก์เปิดต้นฉบับ มีปุ่มย้ายสมาชิกเดิมขึ้น Google และปุ่มยกเลิกการเชื่อม`,
        (await space.locator('[data-resource="sheets"] a').getAttribute('href')) === 'https://docs.google.com/mock/sheets' &&
        (await space.locator('[data-resource="sheets"]').getByRole('button', { name: 'ย้ายสมาชิกในเว็บ 4 รายการขึ้น Google' }).isVisible()) &&
        (await space.locator('[data-resource="forms"]').getByRole('button', { name: 'ยกเลิกการเชื่อม' }).isVisible()) &&
        (await space.locator('[data-resource="calendar"]').innerText()).includes('ยังไม่ได้เชื่อม') && (await noOverflow(p)))
      await shot(p, `live-setup-linked-${width}${theme === 'dark' ? '-dark' : ''}`)
      await space.locator('[data-resource="sheets"]').getByRole('button', { name: 'ยกเลิกการเชื่อม' }).click()
      check(`${tag}: ยกเลิกการเชื่อม: อธิบายก่อนยืนยันว่าต้นฉบับใน Google ไม่ถูกลบและรายชื่อในเว็บยังอยู่`,
        (await appears(dialog.getByText('ไม่ถูกลบหรือแก้'))) && (await dialog.getByText('รายชื่อสมาชิกที่แสดงอยู่ยังอยู่ในเว็บครบ').isVisible()) && (await noOverflow(p)))
      await p.keyboard.press('Escape')
      await p.context().close()
    }

    // เลือกชีตที่มีอยู่: หน้าต่างเลือกไฟล์ของ Google ถูกแทนด้วยสคริปต์จำลองในเบราว์เซอร์ทดสอบ (ไม่ได้เปิด Picker จริง)
    {
      const p = await newPage(1280, 900, actors.admin)
      const state = { statuses: {} }
      const links = []
      await mockSync(p, state)
      await p.route('**/api/sources', (route) => route.fulfill({ json: sourcesConnected }))
      await p.route('**/api/setup', (route) => route.fulfill({ json: setupInfo({ picker: { configured: true, missing: [], apiKey: 'mock-key', appId: '123', clientId: 'mock-client' } }) }))
      await p.route('https://accounts.google.com/gsi/client', (route) => route.fulfill({ contentType: 'text/javascript', body: 'window.google = window.google || {}; google.accounts = { oauth2: { initTokenClient: (c) => ({ requestAccessToken: () => { window.__pickerHint = c.hint; window.__pickerScope = c.scope; c.callback({ access_token: "browser-only-token" }) } }) } };' }))
      await p.route('https://apis.google.com/js/api.js', (route) => route.fulfill({ contentType: 'text/javascript', body: `window.gapi = { load: (name, o) => { window.google = window.google || {}; const B = function () {}; for (const m of ['addView','setOAuthToken','setDeveloperKey','setAppId','setLocale']) B.prototype[m] = function () { return this }; B.prototype.setCallback = function (cb) { this.cb = cb; return this }; B.prototype.build = function () { return { setVisible: () => this.cb({ action: 'picked', docs: [{ id: 'picked-sheet-id-000001', name: 'ชีตเดิมของชมรม' }] }) } }; const V = function () {}; for (const m of ['setMimeTypes','setIncludeFolders','setSelectFolderEnabled','setMode']) V.prototype[m] = function () { return this }; google.picker = { PickerBuilder: B, DocsView: V, DocsViewMode: { LIST: 'list' }, Action: { PICKED: 'picked', CANCEL: 'cancel' } }; o.callback() } };` }))
      await p.route('**/api/setup/preview', (route) => {
        const body = route.request().postDataJSON()
        const columns = body.columns ?? { name: 'ชื่อ-นามสกุล', nickname: 'ชื่อเล่น' }
        return route.fulfill({ json: {
          kind: 'sheets', resourceId: body.resourceId, name: 'ชีตเดิมของชมรม', writable: true, tabs: [{ sheetId: 0, title: 'รายชื่อ' }, { sheetId: 7, title: 'เก่า' }], sheetId: body.sheetId ?? 0, headerRow: body.headerRow ?? 1,
          headers: ['ลำดับ', 'ชื่อ-นามสกุล', 'ชื่อเล่น', 'เบอร์'], columns,
          stats: { rows: 12, withId: 0, withoutId: 12, invalid: 1, duplicateIds: 0, matchedLocal: 0, newFromSheet: 12, localOnly: 4 }, problem: null,
          issues: [{ code: 'invalid_row', where: 'แถว 9', message: 'ไม่มีชื่อ' }],
        } })
      })
      await p.route('**/api/setup/link', (route) => {
        links.push(route.request().postDataJSON())
        state.statuses.sheets = linkedStatus('sheets', 'ชีตเดิมของชมรม', { resource: { origin: 'selected' } })
        return route.fulfill({ status: 201, json: { status: state.statuses.sheets } })
      })
      await p.goto(`${BASE}/sources`)
      await p.locator('.data-space').getByRole('button', { name: 'เลือกชีตที่มีอยู่' }).click()
      const dialog = p.locator('dialog[open]')
      await dialog.locator('#link-col-name').waitFor()
      const picker = await p.evaluate(() => ({ hint: window.__pickerHint, scope: window.__pickerScope }))
      check('[จำลอง Picker] เลือกชีตที่มีอยู่: ขอสิทธิ์เฉพาะ drive.file โดยแนะบัญชีชมรม แล้วแสดง preview จาก server: แท็บ แถวหัวตาราง การจับคู่ที่เสนอ และจำนวนก่อนเชื่อม',
        picker.hint === 'muesport2567@gmail.com' && picker.scope === 'https://www.googleapis.com/auth/drive.file' && (await dialog.locator('#link-col-name').inputValue()) === 'ชื่อ-นามสกุล' &&
        (await dialog.locator('#link-tab option').count()) === 2 && (await dialog.getByText('แถวข้อมูลในชีต 12 แถว').isVisible()) && (await dialog.getByText('สมาชิกในเว็บที่ยังไม่อยู่ในชีต 4 คน').isVisible()) &&
        (await dialog.locator('.sync-issues summary').innerText()).includes('(1)'))
      check('[จำลอง Picker] ชีตไม่มีคอลัมน์รหัส: อธิบายเหตุผล และปุ่มเชื่อมถูกปิดจนกว่าผู้ดูแลจะยืนยันให้เพิ่มคอลัมน์รหัส',
        (await dialog.getByText('ชีตนี้ยังไม่มีคอลัมน์รหัสสมาชิก').isVisible()) && (await dialog.getByRole('button', { name: 'เชื่อมชีตนี้' }).isDisabled()) && links.length === 0 && (await noOverflow(p)))
      await shot(p, 'live-setup-sheet-preview-1280', false)
      await dialog.locator('#link-col-contact').selectOption('เบอร์')
      await dialog.getByLabel(/ให้ระบบเพิ่มคอลัมน์ “รหัสสมาชิก”/).check()
      await dialog.getByRole('button', { name: 'เชื่อมชีตนี้' }).click()
      await gone(dialog)
      check('[จำลอง Picker] ยืนยันแล้วส่งการจับคู่ตามหัวคอลัมน์ (ไม่ใช่เลขคอลัมน์) พร้อมคำยืนยันเพิ่มคอลัมน์รหัส และหน้าแสดงว่าเชื่อมแล้วแบบ “เลือกจากที่มีอยู่”',
        links.length === 1 && links[0].resourceId === 'picked-sheet-id-000001' && links[0].addIdColumn === true &&
        JSON.stringify(links[0].columns) === JSON.stringify({ name: 'ชื่อ-นามสกุล', nickname: 'ชื่อเล่น', contact: 'เบอร์' }) &&
        (await appears(p.locator('[data-resource="sheets"]', { hasText: 'เลือกจากที่มีอยู่' }))))
      await p.context().close()
    }
    {
      // ทีมงานทั่วไป: เห็นสถานะ แต่ไม่มีปุ่มตั้งค่า และ API ตั้งค่าตอบ 403 จาก Worker จริง
      const p = await newPage(390, 844, actors.a, 1)
      await p.route('**/api/sources', (route) => route.fulfill({ json: sourcesConnected }))
      await p.goto(`${BASE}/sources`)
      const space = p.locator('.data-space')
      await space.locator('.resource-state').nth(2).waitFor()
      const denied = await Promise.all([apiAs(p, '/api/setup'), apiAs(p, '/api/setup/create', { method: 'POST', key: 'ui-check-staff-key-0001', body: { kind: 'sheets', name: 'x' } }), apiAs(p, '/api/setup/link/sheets', { method: 'DELETE' })])
      check('[จริง] ทีมงานที่หน้าแหล่งข้อมูล 390px: เห็นสถานะแหล่งข้อมูล ไม่มีปุ่มสร้าง/เลือก/ยกเลิก และ API ตั้งค่าตอบ 403',
        (await space.getByRole('button').count()) === 0 && (await space.getByText('ทำได้เฉพาะผู้ดูแลระบบ').isVisible()) && denied.every((r) => r.status === 403) && (await noOverflow(p)), JSON.stringify(denied.map((r) => r.status)))
      await p.context().close()
    }

    // ---------- เอกสาร: มีฉบับใหม่ใน Google ระหว่างเปิดหน้า ----------
    for (const [width, height, theme] of [[1440, 900, 'light'], [390, 844, 'dark']]) {
      const tag = `[จำลอง] เอกสาร ฉบับใหม่ใน Google ${width}px ธีม${theme === 'dark' ? 'มืด' : 'สว่าง'}`
      const p = await newPage(width, height, actors.a, 1)
      await themed(p, theme)
      const remote = { revision: 1, text: 'ฉบับที่ 1' }
      const info = { id: 'doc-1', title: 'วาระประชุม', status: 'ok', statusDetail: '', googleUrl: 'https://docs.google.com/document/d/x/edit', createdAt: iso(600), updatedAt: iso(60), lastCheckedAt: iso(1), createdByName: 'ทีมงาน เอ', updatedByName: 'ทีมงาน เอ', origin: 'created' }
      let reads = 0
      await p.route('**/api/documents/doc-1', (route) => (reads++, route.fulfill({ json: { document: info, content: { text: remote.text, revisionId: `rev-${remote.revision}`, editable: true, reasons: [] } } })))
      await p.route('**/api/documents/doc-1/revision', (route) => route.fulfill({ json: { revisionId: `rev-${remote.revision}`, title: info.title } }))
      await p.goto(`${BASE}/documents/doc-1`)
      const editor = p.locator('#document-text')
      await editor.waitFor()
      const poll = () => p.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))

      // ไม่มีร่าง: โหลดฉบับใหม่ให้เอง
      Object.assign(remote, { revision: 2, text: 'ฉบับที่ 2 จาก Google' })
      await poll()
      check(`${tag}: ไม่มีร่างค้าง → เว็บโหลดฉบับใหม่จาก Google ให้เองและบอกเวลา`,
        (await appears(p.locator('.editor-status', { hasText: 'โหลดฉบับใหม่จาก Google Docs ให้แล้ว' }))) && (await editor.inputValue()) === 'ฉบับที่ 2 จาก Google')

      // มีร่าง: ไม่ทับ แสดงทางเลือก
      await editor.fill('ร่างของฉันที่ยังไม่บันทึก')
      await editor.focus()
      const readsBefore = reads
      Object.assign(remote, { revision: 3, text: 'ฉบับที่ 3 จาก Google' })
      await poll()
      const banner = p.locator('.remote-card')
      check(`${tag}: มีร่างค้าง → แจ้ง “มีฉบับใหม่ใน Google Docs” โดยไม่โหลดทับ: ร่างและ focus ยังอยู่ และยังไม่มีการดึงเนื้อหา`,
        (await appears(banner)) && (await editor.inputValue()) === 'ร่างของฉันที่ยังไม่บันทึก' && (await p.evaluate(() => document.activeElement?.id)) === 'document-text' && reads === readsBefore &&
        (await banner.getByRole('button').count()) === 3 && (await noOverflow(p)))
      if (width < 1024) check(`${tag}: ปุ่มทางเลือกสูง ≥44px`, (await tap(p, '.remote-card .button')).every((h) => h >= 44))
      await shot(p, `live-doc-remote-${width}${theme === 'dark' ? '-dark' : ''}`)

      await banner.getByRole('button', { name: 'เก็บร่างของฉันไว้ก่อน' }).click()
      await poll()
      await p.waitForTimeout(300)
      const kept = (await banner.count()) === 0 && (await editor.inputValue()) === 'ร่างของฉันที่ยังไม่บันทึก'
      Object.assign(remote, { revision: 4, text: 'ฉบับที่ 4 จาก Google' })
      await poll()
      check(`${tag}: “เก็บร่างของฉันไว้ก่อน” ไม่เตือนซ้ำสำหรับฉบับเดิม แต่เตือนอีกเมื่อ Google มีฉบับใหม่กว่า`, kept && (await appears(banner)))
      await banner.getByRole('button', { name: 'เปรียบเทียบกับฉบับล่าสุด' }).click()
      check(`${tag}: “เปรียบเทียบกับฉบับล่าสุด” แสดงฉบับจาก Google ข้างร่าง ร่างยังอยู่ และมีทางเลือกใช้ฉบับล่าสุดหรือบันทึกทับ`,
        (await appears(p.locator('#document-latest'))) && (await p.locator('#document-latest').inputValue()) === 'ฉบับที่ 4 จาก Google' && (await editor.inputValue()) === 'ร่างของฉันที่ยังไม่บันทึก' &&
        (await p.getByRole('button', { name: 'ใช้ฉบับล่าสุด (ทิ้งที่ฉันแก้)' }).isVisible()) && (await p.getByRole('button', { name: 'บันทึกฉบับของฉันทับฉบับล่าสุด' }).isVisible()) && (await noOverflow(p)))
      await p.getByRole('button', { name: 'ใช้ฉบับล่าสุด (ทิ้งที่ฉันแก้)' }).click()
      await p.getByRole('button', { name: 'ทิ้งที่ฉันแก้', exact: true }).click()
      check(`${tag}: ใช้ฉบับล่าสุดต้องยืนยันก่อนทิ้งร่าง แล้วช่องเนื้อหาเป็นฉบับจาก Google`, (await editor.inputValue()) === 'ฉบับที่ 4 จาก Google')
      await p.context().close()
    }
    ignoreErrorsSince(errorsBeforeSync)
  }

  // ================= 9. ออกจากระบบ =================
  const leaving = await newPage(1440, 900, actors.b)
  await leaving.goto(`${BASE}/members`)
  await leaving.locator('.topbar .account').getByRole('button', { name: 'ออกจากระบบ' }).click()
  check('[จริง] ออกจากระบบ: กลับหน้าเข้าสู่ระบบ และ session เดิมใช้ไม่ได้',
    (await appears(leaving.locator('p.notice').getByText('ออกจากระบบแล้ว', { exact: true }))) && (await apiAs(leaving, '/api/members')).status === 401)
  await leaving.goBack()
  check('[จริง] หลังออกจากระบบ กดย้อนกลับไม่เห็นข้อมูลสมาชิก', (await appears(leaving.getByRole('heading', { name: 'เข้าสู่ระบบ' }))) && (await leaving.locator('tbody tr').count()) === 0)
  await leaving.context().close()

  // ค่าลับต้องไม่อยู่ในไฟล์ที่ส่งให้เบราว์เซอร์
  const scan = await newPage(1280, 800, actors.admin)
  const bodies = []
  scan.on('response', async (response) => {
    const type = response.headers()['content-type'] ?? ''
    if (/javascript|json|html|css/.test(type)) bodies.push(await response.text().catch(() => ''))
  })
  await scan.goto(`${BASE}/sources`)
  await scan.locator('.connection-card').waitFor()
  await scan.goto(`${BASE}/team`)
  await scan.locator('.team-row').first().waitFor()
  const everything = bodies.join('\n')
  check('[จริง] ไฟล์และคำตอบที่ส่งให้เบราว์เซอร์ไม่มี session token ของผู้ใช้ refresh token หรือ token ที่เข้ารหัส',
    bodies.length > 5 && !actors.admin.tokens.some((t) => everything.includes(t)) && !/"refresh_token"\s*:|"access_token"\s*:|client_secret=|\bv1\.[A-Za-z0-9_-]{16}\./.test(everything), `${bodies.length} ไฟล์`)
  check('[จริง] cookie ของ session เป็น HttpOnly จึงอ่านจาก JavaScript ไม่ได้', !(await scan.evaluate(() => document.cookie)).includes('mu_session'))
  await scan.context().close()

  await a.context().close()
  await b.context().close()
  await admin.context().close()
  check('[Edge/Chromium] ไม่มี error ใน console นอกช่วงที่จงใจจำลองความล้มเหลว', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
  await browser.close()
  browser = undefined

  // ================= 10. WebKit (เอนจินของ Safari) ถ้าติดตั้งไว้ =================
  let webkitBrowser = null
  try {
    webkitBrowser = await webkit.launch()
  } catch (error) {
    console.log(`SKIP  WebKit: เปิดไม่ได้ (${String(error).split('\n')[0]}) ติดตั้งด้วย \`npx playwright-core install webkit\``)
  }
  if (webkitBrowser) {
    browser = webkitBrowser
    consoleErrors.length = 0
    await loadSignalCheck(webkitBrowser, 'WebKit')
    await sweep(webkitBrowser, 'WebKit', [[1440, 900, '1440'], [390, 844, '390'], [320, 568, '320'], [844, 390, 'landscape-844x390']], false)
    const w = await newPage(390, 844, actors.a, 1, webkitBrowser)
    await w.goto(`${BASE}/members`)
    await w.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
    await w.locator('#member-name').fill('เพิ่มจาก WebKit')
    await w.locator('#member-nickname').fill('เว็บคิต')
    await w.getByRole('button', { name: 'เพิ่มสมาชิก' }).last().click()
    check('[WebKit][จริง] 390: เพิ่มสมาชิกผ่าน Worker และ D1 ได้ (cookie session และ CSRF ทำงาน)', await appears(w.locator('.toast', { hasText: 'เพิ่มจาก WebKit' })))
    await w.screenshot({ path: `${OUT}/live-webkit-members-390.png` })
    await w.keyboard.press('Tab')
    await w.context().close()
    check('[WebKit] ไม่มี error ใน console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))
    await webkitBrowser.close()
    browser = undefined
  }

  console.log(failed ? `\nไม่ผ่าน ${failed} รายการ (ผ่าน ${passed})` : `\nผ่านทุกรายการ (${passed})`)
  exitCode = failed ? 1 : 0
} catch (error) {
  console.error('\nชุดตรวจหยุดกลางทาง:', error)
  console.log(`ก่อนหยุด: ผ่าน ${passed} ไม่ผ่าน ${failed}`)
} finally {
  await browser?.close().catch(() => undefined)
  stopServer()
}
process.exit(exitCode)
