// ตรวจ flow หลักในเบราว์เซอร์จริงและเก็บ screenshot
// ใช้: เปิดโหมดข้อมูลตัวอย่างด้วย `npm run dev:demo` ก่อน แล้วรัน `npm run check:ui`
// ตัวแปร: BASE_URL (ค่าเริ่มต้น http://localhost:5174), BROWSER_CHANNEL (msedge | chrome)
import { mkdirSync } from 'node:fs'
import { chromium } from 'playwright-core'

const BASE = process.env.BASE_URL ?? 'http://localhost:5174'
const CHANNEL = process.env.BROWSER_CHANNEL ?? 'msedge'
const OUT = 'screenshots'
const STORAGE_KEY = 'mu-esport-staff:data:v1'
mkdirSync(OUT, { recursive: true })

let failed = 0
const check = (name, ok, extra = '') => {
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`)
}

const browser = await chromium.launch({ channel: CHANNEL })
const consoleErrors = []

async function newPage(width, height) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()))
  page.on('pageerror', (e) => consoleErrors.push(String(e)))
  return page
}

const noOverflow = (page) =>
  page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
// รอให้องค์ประกอบแสดงผล (หลังเปลี่ยนหน้าแบบ client-side) แทนการตรวจทันที
const appears = (locator) => locator.waitFor({ timeout: 3000 }).then(() => true, () => false)
const gone = (locator) => locator.waitFor({ state: 'detached', timeout: 3000 }).then(() => true, () => false)
const focusLabel = (page) =>
  page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '')
const scrollLocked = (page) => page.evaluate(() => getComputedStyle(document.documentElement).overflow === 'hidden')
const stored = (page) => page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
const shot = (page, name) => page.screenshot({ path: `${OUT}/${name}.png`, fullPage: true })
const stat = async (page, label) =>
  parseInt(await page.locator('.stats div', { hasText: label }).locator('dd').innerText(), 10)

// ---------- 1. Screenshot ทุกหน้า 3 ความกว้าง + ตรวจไม่ล้นจอ ----------
const PAGES = [['overview', '/'], ['members', '/members'], ['calendar', '/calendar'], ['sources', '/sources']]
for (const [width, height] of [[1440, 900], [1024, 768], [390, 844]]) {
  const page = await newPage(width, height)
  for (const [name, path] of PAGES) {
    await page.goto(BASE + path)
    await page.locator('h1').waitFor()
    await page.waitForLoadState('networkidle')
    await page.evaluate(() => document.fonts.ready)
    check(`ไม่ล้นแนวนอน ${name} @${width}`, await noOverflow(page))
    await shot(page, `${name}-${width}`)
  }
  if (width === 390) {
    await page.goto(BASE + '/')
    await page.locator('.home-calendar .calendar-title').waitFor()
    check('มือถือ: ปฏิทินหน้าแรกเริ่มที่มุมมองรายการ และทางลัดเป็น 2 คอลัมน์',
      (await page.locator('.home-calendar').getByRole('button', { name: 'รายการ' }).getAttribute('aria-pressed')) === 'true' &&
      (await page.locator('.shortcut').evaluateAll((els) => new Set(els.map((el) => Math.round(el.getBoundingClientRect().left))).size)) === 2)
    await page.goto(BASE + '/calendar')
    check('มือถือ: ปฏิทินเริ่มที่มุมมองรายการ',
      (await page.getByRole('button', { name: 'รายการ' }).getAttribute('aria-pressed')) === 'true')
    await page.getByRole('button', { name: 'เดือน', exact: true }).click()
    check('มือถือ: มุมมองเดือนไม่ล้น', await noOverflow(page))
    await shot(page, 'calendar-month-390')

    const menu = page.locator('dialog.mobile-menu')
    const opener = page.getByRole('button', { name: 'เปิดเมนู' })
    const inMenu = () => page.evaluate(() => !!document.activeElement?.closest('dialog.mobile-menu'))
    check('มือถือ: เมนูปิดอยู่ตอนเริ่ม', (await menu.count()) === 0 && !(await page.getByRole('link', { name: 'สมาชิก' }).isVisible()))

    await opener.focus()
    await page.keyboard.press('Enter')
    await menu.waitFor()
    check('เมนู: เป็น modal dialog', await menu.evaluate((d) => d.matches(':modal')))
    check('เมนู: focus เข้าเมนูที่หน้าปัจจุบัน', (await inMenu()) && (await focusLabel(page)) === 'ปฏิทิน', await focusLabel(page))
    let stayed = true
    let seen = new Set()
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab')
      stayed &&= await inMenu()
      seen.add(await focusLabel(page))
    }
    check('เมนู: Tab วนอยู่ในเมนูและปุ่มปิด', stayed && seen.size === 5, [...seen].join(', '))
    stayed = true
    seen = new Set()
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Shift+Tab')
      stayed &&= await inMenu()
      seen.add(await focusLabel(page))
    }
    check('เมนู: Shift+Tab วนอยู่ในเมนูและปุ่มปิด', stayed && seen.size === 5, [...seen].join(', '))
    check('เมนู: ล็อกการเลื่อนเนื้อหาด้านหลัง', await scrollLocked(page))
    const blocked = await page.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }).click({ timeout: 1000 }).then(() => false, () => true)
    check('เมนู: กดเนื้อหาด้านหลังไม่ได้', blocked && (await menu.count()) === 1 && (await page.getByText('รีเซ็ตข้อมูลตัวอย่าง?').count()) === 0)
    check('เมนู: เนื้อหาด้านหลังรับ focus ไม่ได้',
      await page.evaluate(() => { const b = document.querySelector('.sample-banner button'); b.focus(); return document.activeElement !== b }))
    await menu.getByRole('link', { name: 'ปฏิทิน' }).focus()
    await page.waitForTimeout(250)
    await shot(page, 'menu-open-390')

    await page.keyboard.press('Escape')
    check('เมนู: Esc ปิดและคืน focus ไปปุ่มเปิดเมนู', (await gone(menu)) && (await focusLabel(page)) === 'เปิดเมนู')
    check('เมนู: ปลดล็อกการเลื่อนหลังปิด', !(await scrollLocked(page)))
    await opener.click()
    await menu.getByRole('button', { name: 'ปิดเมนู' }).click()
    check('เมนู: ปุ่มปิดคืน focus ไปปุ่มเปิดเมนู', (await gone(menu)) && (await focusLabel(page)) === 'เปิดเมนู')

    await opener.click()
    await menu.getByRole('link', { name: 'สมาชิก' }).click()
    await page.waitForURL('**/members')
    check('เมนู: เลือกหน้าแล้วปิดเมนู และ focus ไปหัวข้อหน้าปลายทาง',
      (await gone(menu)) &&
      (await page.waitForFunction(() => document.activeElement?.tagName === 'H1' && document.activeElement.textContent === 'สมาชิก', null, { timeout: 3000 }).then(() => true, () => false)) &&
      !(await scrollLocked(page)))

    await opener.click()
    await menu.waitFor()
    await page.setViewportSize({ width: 1024, height: 768 })
    const closedOnResize = await gone(menu)
    await page.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }).click()
    const usable = await appears(page.getByText('รีเซ็ตข้อมูลตัวอย่าง?'))
    await page.getByRole('button', { name: 'ยกเลิก' }).click()
    check('เมนู: ขยายเป็น desktop แล้วไม่เหลือ modal หรือ scroll lock',
      closedOnResize && usable && !(await scrollLocked(page)) && (await page.locator('.sidebar').isVisible()))
    await page.setViewportSize({ width: 390, height: 844 })

    await page.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
    await page.locator('#member-name').waitFor()
    check('มือถือ: ฟอร์มไม่ล้น', await noOverflow(page))
    await page.screenshot({ path: `${OUT}/member-form-390.png` })
    await page.keyboard.press('Escape')

    // เปิดกำหนดการจากภาพรวมบนมือถือ (ปฏิทินอยู่ในมุมมองรายการ)
    await page.goto(BASE + '/')
    const link = page.locator('.upcoming-link').first()
    const id = decodeURIComponent((await link.getAttribute('href')).split('event=')[1])
    await link.click()
    check('มือถือ: เปิดรายละเอียดกำหนดการจากภาพรวม', await appears(page.locator('dialog.dialog[open]')))
    await page.screenshot({ path: `${OUT}/event-detail-from-overview-390.png` })
    await page.keyboard.press('Escape')
    check('มือถือ: ปิดแล้ว focus อยู่ที่รายการนั้นในมุมมองรายการ',
      await page.evaluate((id) => document.activeElement?.getAttribute('data-event-id') === id, id))
  }
  await page.context().close()
}

// ---------- 2. Flow หลักที่ 1440 ----------
const page = await newPage(1440, 900)
await page.goto(BASE + '/')
const total0 = await stat(page, 'สมาชิกทั้งหมด')
const active0 = await stat(page, 'สถานะใช้งาน')
check('ภาพรวม: แสดงจำนวนสมาชิก', total0 === 12 && active0 === 10, `ทั้งหมด ${total0} ใช้งาน ${active0}`)
check('ภาพรวม: มีกำหนดการที่กำลังจะมาถึง', (await page.locator('.upcoming-list li').count()) > 0)
check('ป้ายข้อมูลตัวอย่างแสดงอยู่', await page.getByText('ข้อมูลตัวอย่าง', { exact: true }).isVisible())

// พอร์ทัลหน้าแรกในโหมดตัวอย่าง
check('ทางลัดหน้าแรก (ตัวอย่าง): มีเฉพาะ สมาชิก ปฏิทินชมรม แหล่งข้อมูล ไม่มีเอกสาร/ทีมงาน และตรงกับเมนู',
  JSON.stringify(await page.locator('.shortcut').allInnerTexts()) === JSON.stringify(['สมาชิก', 'ปฏิทินชมรม', 'แหล่งข้อมูล']) &&
  JSON.stringify(await page.locator('.sidebar .nav-label').allInnerTexts()) === JSON.stringify(['ภาพรวม', 'สมาชิก', 'ปฏิทิน', 'แหล่งข้อมูล']) &&
  (await page.locator('.topbar .account').count()) === 0 && (await page.locator('.topbar-mode').innerText()).trim() === 'โหมดตัวอย่าง')
{
  const home = page.locator('.home-calendar')
  const homeChip = home.locator('.chip').first()
  const chipId = await homeChip.getAttribute('data-event-id')
  const chipTitle = await homeChip.locator('.chip-title').innerText()
  const before = await stored(page)
  check('ปฏิทินหน้าแรก (ตัวอย่าง): ใช้กำหนดการชุดเดียวกับที่เก็บไว้',
    JSON.parse(before).events.find((e) => e.id === chipId)?.title === chipTitle)
  await page.getByRole('switch', { name: 'ธีมมืด' }).click()
  check('ธีม (ตัวอย่าง): สลับเป็นธีมมืดโดยไม่แตะข้อมูลสมาชิก/กำหนดการ และจำใน key แยก',
    (await page.evaluate(() => document.documentElement.dataset.theme)) === 'dark' && (await stored(page)) === before &&
    (await page.evaluate(() => localStorage.getItem('mu-esport-staff:theme:v1'))) === 'dark')
  await shot(page, 'overview-dark-1440')
  await page.getByRole('switch', { name: 'ธีมมืด' }).click()
  await homeChip.click()
  check('ปฏิทินหน้าแรก (ตัวอย่าง): กดกำหนดการแล้วเปิดรายละเอียดที่หน้าปฏิทิน',
    (await appears(page.locator('dialog.dialog[open] h2', { hasText: chipTitle }))) && new URL(page.url()).searchParams.get('event') === chipId)
  await page.keyboard.press('Escape')
  await page.goto(BASE + '/')
  await page.locator('.stats').waitFor()
}

// ทางลัดเพิ่มสมาชิกจากภาพรวม
await page.getByRole('link', { name: 'เพิ่มสมาชิก' }).click()
await page.locator('#member-name').waitFor()
check('ทางลัดเพิ่มสมาชิกเปิดฟอร์ม', page.url().endsWith('/members'))
check('focus อยู่ที่ช่องแรกของฟอร์ม', await page.evaluate(() => document.activeElement?.id === 'member-name'))

// validation + เก็บค่าที่กรอก
await page.getByRole('button', { name: 'เพิ่มสมาชิก' }).last().click()
check('validation: ชื่อว่าง', await page.locator('#member-name-error').isVisible())
check('validation: ชื่อเล่นว่าง', await page.locator('#member-nickname-error').isVisible())
check('validation: รหัสนักศึกษาบังคับกรอก', await page.locator('#member-student-id-error').isVisible())
await page.locator('#member-name').fill('ทดสอบ ระบบตรวจ')
await page.locator('#member-contact').fill('check@example.com')
await page.getByRole('button', { name: 'เพิ่มสมาชิก' }).last().click()
check('validation: ค่าที่กรอกยังอยู่เมื่อผิดพลาด',
  (await page.locator('#member-name').inputValue()) === 'ทดสอบ ระบบตรวจ' &&
  (await page.locator('#member-contact').inputValue()) === 'check@example.com' &&
  (await page.locator('#member-nickname-error').isVisible()))
await page.screenshot({ path: `${OUT}/member-form-validation-1440.png` })

// เตือนก่อนทิ้งข้อมูล
await page.keyboard.press('Escape')
check('ปิดฟอร์มขณะแก้ไข: เตือนก่อนทิ้ง', await page.getByText('ทิ้งการแก้ไขที่ยังไม่บันทึก?').isVisible())
await page.screenshot({ path: `${OUT}/discard-confirm-1440.png` })
await page.getByRole('button', { name: 'กลับไปแก้ไขต่อ' }).click()
check('กลับไปแก้ไขต่อ: ค่าเดิมยังอยู่', (await page.locator('#member-name').inputValue()) === 'ทดสอบ ระบบตรวจ')

// บันทึก
await page.locator('#member-nickname').fill('เช็ก')
await page.locator('#member-student-id').fill('6543210')
await page.getByRole('button', { name: 'เพิ่มสมาชิก' }).last().click()
await page.locator('.toast').waitFor()
check('เพิ่มสมาชิก: แจ้งผลสำเร็จ', (await page.locator('.toast').innerText()).includes('เพิ่มสมาชิก'))
const row = page.locator('tbody tr', { hasText: 'ทดสอบ ระบบตรวจ' })
check('เพิ่มสมาชิก: แสดงในตาราง', (await row.count()) === 1)

// แก้ไข
await row.getByRole('button', { name: /ดูรายละเอียด/ }).click()
await page.getByRole('button', { name: 'แก้ไข' }).click()
await page.locator('#member-nickname').fill('เช็กแล้ว')
await page.locator('#member-role').selectOption('staff')
await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
await page.locator('.toast', { hasText: 'บันทึกการแก้ไข' }).waitFor()
check('แก้ไขสมาชิก: ตารางอัปเดต', (await row.innerText()).includes('เช็กแล้ว') && (await row.innerText()).includes('ทีมงาน'))
check('ปิด dialog: focus กลับไปที่ปุ่มเดิม',
  await page.evaluate(() => document.activeElement?.getAttribute('aria-label')?.includes('ทดสอบ ระบบตรวจ') ?? false))

// พักการใช้งาน / เปิดกลับ
await row.getByRole('button', { name: /ดูรายละเอียด/ }).click()
await page.screenshot({ path: `${OUT}/member-detail-1440.png` })
await page.getByRole('button', { name: 'พักการใช้งาน' }).click()
check('พักการใช้งาน: อธิบายผลก่อนยืนยัน', await page.getByText('ข้อมูลทั้งหมดไม่ถูกลบ').isVisible())
await page.screenshot({ path: `${OUT}/suspend-confirm-1440.png` })
await page.getByRole('button', { name: 'พักการใช้งาน' }).last().click()
await page.locator('.toast', { hasText: 'พักการใช้งาน' }).waitFor()
check('พักการใช้งาน: สถานะในตารางเปลี่ยน', (await row.locator('.badge').innerText()).includes('พักการใช้งาน'))

await page.getByRole('link', { name: 'ภาพรวม' }).click()
check('ภาพรวมสอดคล้องหลังเพิ่ม+พัก',
  (await stat(page, 'สมาชิกทั้งหมด')) === total0 + 1 && (await stat(page, 'สถานะใช้งาน')) === active0)
await page.locator('.sidebar').getByRole('link', { name: 'สมาชิก', exact: true }).click()
await row.getByRole('button', { name: /ดูรายละเอียด/ }).click()
await page.getByRole('button', { name: 'เปิดใช้งานอีกครั้ง' }).click()
await page.locator('.toast', { hasText: 'เปิดใช้งาน' }).waitFor()
check('เปิดใช้งานกลับ: สถานะเป็นใช้งาน', (await row.locator('.badge').innerText()).trim() === 'ใช้งาน')

// ค้นหา / ตัวกรอง / ล้าง
const rows = page.locator('tbody tr')
const all = await rows.count()
await page.locator('#member-search').fill('เช็กแล้ว')
check('ค้นหาด้วยชื่อเล่น', (await rows.count()) === 1)
await page.locator('#member-search').fill('ผู้ดูแล')
check('ค้นหาด้วยบทบาท', (await rows.count()) === 2)
await page.locator('#member-search').fill('')
await page.locator('#filter-status').selectOption('suspended')
check('ตัวกรองสถานะ', (await rows.count()) === 2)
await page.locator('#filter-role').selectOption('admin')
check('ไม่พบผลลัพธ์: แสดงข้อความ', await page.getByText('ไม่พบสมาชิกที่ตรงกับเงื่อนไข').isVisible())
await page.screenshot({ path: `${OUT}/members-no-results-1440.png` })
await page.getByRole('button', { name: 'ล้างตัวกรอง' }).first().click()
check('ล้างตัวกรอง: กลับมาครบ',
  (await rows.count()) === all && (await page.locator('#filter-status').inputValue()) === '')

// พักการใช้งานจากฟอร์มแก้ไข
const confirmBox = page.locator('dialog.dialog-sm')
const saveEdit = page.getByRole('button', { name: 'บันทึกการแก้ไข' })
await row.getByRole('button', { name: /ดูรายละเอียด/ }).click()
await page.getByRole('button', { name: 'แก้ไข' }).click()
await page.locator('#member-note').fill('โน้ตก่อนพัก')
await page.locator('#member-status').selectOption('suspended')
const beforeSuspend = await stored(page)
await saveEdit.click()
check('ฟอร์ม→พัก: อธิบายผลด้วยข้อความเดียวกับหน้ารายละเอียด และขอยืนยัน',
  (await appears(confirmBox.getByText('สมาชิกยังอยู่ในรายชื่อ และข้อมูลทั้งหมดไม่ถูกลบ'))) &&
  (await confirmBox.getByText('เปิดใช้งานกลับได้ทุกเมื่อจากหน้ารายละเอียดสมาชิก').isVisible()))
check('ฟอร์ม→พัก: ก่อนยืนยันยังไม่เขียนข้อมูล', (await stored(page)) === beforeSuspend)
await page.screenshot({ path: `${OUT}/suspend-from-form-1440.png` })
await confirmBox.getByRole('button', { name: 'ยกเลิก' }).click()
check('ฟอร์ม→พัก: ยกเลิกแล้วกลับฟอร์ม ค่าที่กรอกยังอยู่ ข้อมูลไม่เปลี่ยน',
  (await gone(confirmBox)) &&
  (await page.locator('#member-note').inputValue()) === 'โน้ตก่อนพัก' &&
  (await page.locator('#member-status').inputValue()) === 'suspended' &&
  (await page.locator('#member-nickname').inputValue()) === 'เช็กแล้ว' &&
  (await stored(page)) === beforeSuspend)

// validation มาก่อนการยืนยัน
await page.locator('#member-nickname').fill('')
await saveEdit.click()
check('ฟอร์ม→พัก: validation ไม่ผ่านจะยังไม่ถามยืนยัน',
  (await page.locator('#member-nickname-error').isVisible()) && (await confirmBox.count()) === 0)
await page.locator('#member-nickname').fill('เช็กแล้ว')

// จำลองบันทึกล้มเหลว
await page.evaluate(() => {
  window.__setItem = Storage.prototype.setItem
  Storage.prototype.setItem = () => { throw new Error('จำลองบันทึกล้มเหลว') }
})
await saveEdit.click()
await confirmBox.getByRole('button', { name: 'พักการใช้งาน' }).click()
check('ฟอร์ม→พัก: บันทึกล้มเหลวแล้วแจ้งพร้อมวิธีลองใหม่ ค่าฟอร์มยังอยู่',
  (await appears(page.locator('.form-alert'))) &&
  (await page.locator('#member-note').inputValue()) === 'โน้ตก่อนพัก' &&
  (await page.locator('#member-status').inputValue()) === 'suspended' &&
  (await stored(page)) === beforeSuspend)
await page.screenshot({ path: `${OUT}/member-save-failed-1440.png` })
await page.evaluate(() => {
  window.__writes = 0
  Storage.prototype.setItem = function (...args) { window.__writes++; return window.__setItem.apply(this, args) }
})
await saveEdit.click()
await confirmBox.getByRole('button', { name: 'พักการใช้งาน' }).click()
await page.locator('.toast', { hasText: 'พักการใช้งาน' }).waitFor()
const savedMember = JSON.parse(await stored(page)).members.find((m) => m.name === 'ทดสอบ ระบบตรวจ')
check('ฟอร์ม→พัก: ยืนยันแล้วบันทึกทุกช่องในครั้งเดียว',
  savedMember.status === 'suspended' && savedMember.note === 'โน้ตก่อนพัก' && (await page.evaluate(() => window.__writes)) === 1,
  `เขียน ${await page.evaluate(() => window.__writes)} ครั้ง`)
await page.evaluate(() => { Storage.prototype.setItem = window.__setItem })
check('ฟอร์ม→พัก: สถานะในรายการเปลี่ยน', (await row.locator('.badge').innerText()).includes('พักการใช้งาน'))
await page.locator('#filter-status').selectOption('suspended')
check('ฟอร์ม→พัก: ตัวกรองสถานะนับรวมสมาชิกที่เพิ่งพัก', (await rows.count()) === 3 && (await row.count()) === 1)
await page.getByRole('button', { name: 'ล้างตัวกรอง' }).first().click()

// แก้ข้อมูลทั่วไปโดยไม่เปลี่ยนเป็นพักการใช้งาน: ไม่ถามยืนยัน
const other = page.locator('tbody tr', { hasText: 'อริสา ลองดู' })
await other.getByRole('button', { name: /ดูรายละเอียด/ }).click()
await page.getByRole('button', { name: 'แก้ไข' }).click()
await page.locator('#member-note').fill('แก้หมายเหตุทั่วไป')
await saveEdit.click()
check('แก้ข้อมูลทั่วไป: บันทึกทันทีโดยไม่ถามยืนยัน',
  (await appears(page.locator('.toast', { hasText: 'บันทึกการแก้ไข “อริสา ลองดู”' }))) && (await confirmBox.count()) === 0)

await page.getByRole('link', { name: 'ภาพรวม' }).click()
check('ฟอร์ม→พัก: ตัวเลขภาพรวมสอดคล้อง',
  (await stat(page, 'สมาชิกทั้งหมด')) === total0 + 1 &&
  (await stat(page, 'สถานะใช้งาน')) === active0 &&
  (await stat(page, 'พักการใช้งาน')) === 3)

// ---------- 3. ปฏิทิน ----------
await page.getByRole('link', { name: 'ปฏิทิน', exact: true }).click()
check('ปฏิทิน: เดสก์ท็อปเริ่มที่มุมมองเดือน',
  (await page.getByRole('button', { name: 'เดือน', exact: true }).getAttribute('aria-pressed')) === 'true')
const monthTitle = await page.locator('.calendar-title').innerText()
await page.getByRole('button', { name: 'เดือนถัดไป' }).click()
const nextTitle = await page.locator('.calendar-title').innerText()
await page.getByRole('button', { name: 'วันนี้' }).click()
check('เลื่อนเดือนและปุ่มวันนี้', nextTitle !== monthTitle && (await page.locator('.calendar-title').innerText()) === monthTitle,
  `${monthTitle} → ${nextTitle}`)

// เวลาไม่ถูกต้อง
await page.getByRole('button', { name: 'เพิ่มกำหนดการ' }).first().click()
await page.locator('#event-title').fill('ซ้อมตรวจระบบ')
check('ฟอร์มกำหนดการ: มีคำอธิบายรูปแบบช่องกรอกและสรุปวันเวลา',
  (await page.locator('#event-datetime-hint').isVisible()) && (await page.locator('.form-preview').isVisible()))
await page.locator('#event-startTime').fill('20:00')
await page.locator('#event-endTime').fill('19:00')
await page.getByRole('button', { name: 'เพิ่มกำหนดการ' }).last().click()
check('validation: เวลาสิ้นสุดก่อนเวลาเริ่ม', await page.locator('#event-endTime-error').isVisible())
check('validation: ชื่อกำหนดการยังอยู่', (await page.locator('#event-title').inputValue()) === 'ซ้อมตรวจระบบ')
await page.screenshot({ path: `${OUT}/event-form-validation-1440.png` })
const startDate = await page.locator('#event-startDate').inputValue()
const before = new Date(Date.parse(startDate) - 86400000).toISOString().slice(0, 10)
await page.locator('#event-endTime').fill('21:00')
await page.locator('#event-endDate').fill(before)
await page.getByRole('button', { name: 'เพิ่มกำหนดการ' }).last().click()
check('validation: วันสิ้นสุดก่อนวันเริ่ม', await page.locator('#event-endDate-error').isVisible())
await page.locator('#event-endDate').fill(startDate)
await page.locator('#event-location').fill('ห้องทดสอบ')
await page.getByRole('button', { name: 'เพิ่มกำหนดการ' }).last().click()
await page.locator('.toast', { hasText: 'เพิ่มกำหนดการ' }).waitFor()
check('เพิ่มกำหนดการ: แสดงในปฏิทินพร้อมเวลา',
  await page.locator('.chip', { hasText: 'ซ้อมตรวจระบบ' }).first().innerText().then((t) => t.includes('20:00')))

// ทั้งวัน
await page.getByRole('button', { name: 'เพิ่มกำหนดการ' }).first().click()
await page.locator('#event-title').fill('วันตรวจทั้งวัน')
await page.getByLabel('ทั้งวัน').check()
check('ทั้งวัน: ซ่อนช่องเวลา', (await page.locator('#event-startTime').count()) === 0)
await page.getByRole('button', { name: 'เพิ่มกำหนดการ' }).last().click()
await page.locator('.toast', { hasText: 'วันตรวจทั้งวัน' }).waitFor()
check('ทั้งวัน: แสดงคำว่า "ทั้งวัน"',
  (await page.locator('.day-panel .event-row', { hasText: 'วันตรวจทั้งวัน' }).innerText()).includes('ทั้งวัน'))

// ดูรายละเอียด + แก้ไข
await page.locator('.day-panel .event-row', { hasText: 'ซ้อมตรวจระบบ' }).click()
check('รายละเอียดกำหนดการ: แสดงช่วงเวลา', await appears(page.getByText('20:00–21:00 น.')))
await page.screenshot({ path: `${OUT}/event-detail-1440.png` })
await page.getByRole('button', { name: 'แก้ไข' }).click()
await page.locator('#event-title').fill('ซ้อมตรวจระบบ (แก้ไข)')
await page.getByRole('button', { name: 'บันทึกการแก้ไข' }).click()
await page.locator('.toast', { hasText: 'บันทึกการแก้ไข' }).waitFor()
check('แก้ไขกำหนดการ: ปฏิทินอัปเดต', (await page.locator('.chip', { hasText: 'ซ้อมตรวจระบบ (แก้ไข)' }).count()) > 0)
await shot(page, 'calendar-after-add-1440')

await page.getByRole('button', { name: 'รายการ' }).click()
check('มุมมองรายการ: แสดงกำหนดการที่เพิ่ม', await page.locator('.agenda .event-row', { hasText: 'วันตรวจทั้งวัน' }).first().isVisible())
await shot(page, 'calendar-list-1440')

// วันที่ไม่มีรายการ
await page.getByRole('button', { name: 'เดือน', exact: true }).click()
await page.getByRole('button', { name: 'เดือนถัดไป' }).click()
await page.getByRole('button', { name: 'เดือนถัดไป' }).click()
check('วันที่ไม่มีรายการ: มีข้อความและปุ่มเพิ่ม',
  (await page.getByText('ไม่มีกำหนดการในวันที่เลือก').isVisible()) &&
  (await page.locator('.day-panel').getByRole('button', { name: /เพิ่มกำหนดการวันที่/ }).isVisible()))

await page.getByRole('link', { name: 'ภาพรวม' }).click()
check('ภาพรวม: เห็นกำหนดการที่เพิ่ม', await appears(page.locator('.upcoming-list').getByText('วันตรวจทั้งวัน')))

// ---------- 4. คงอยู่หลัง refresh + รีเซ็ต ----------
await page.goto(BASE + '/members')
await page.reload()
check('หลัง refresh: สมาชิกที่เพิ่มยังอยู่', (await page.locator('tbody tr', { hasText: 'ทดสอบ ระบบตรวจ' }).count()) === 1)
await page.goto(BASE + '/calendar')
check('หลัง refresh: กำหนดการที่เพิ่มยังอยู่', (await page.locator('.chip', { hasText: 'วันตรวจทั้งวัน' }).count()) > 0)

await page.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }).click()
check('รีเซ็ต: ถามยืนยันก่อน', await page.getByText('รีเซ็ตข้อมูลตัวอย่าง?').isVisible())
await page.screenshot({ path: `${OUT}/reset-confirm-1440.png` })
await page.getByRole('button', { name: 'ยกเลิก' }).click()
check('รีเซ็ต: ยกเลิกแล้วข้อมูลยังอยู่', (await page.locator('.chip', { hasText: 'วันตรวจทั้งวัน' }).count()) > 0)
await page.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }).click()
await page.getByRole('button', { name: 'รีเซ็ตข้อมูล', exact: true }).click()
await page.locator('.toast', { hasText: 'รีเซ็ต' }).waitFor()
check('รีเซ็ต: กำหนดการที่เพิ่มหายไป', (await page.locator('.chip', { hasText: 'วันตรวจทั้งวัน' }).count()) === 0)
await page.getByRole('link', { name: 'ภาพรวม' }).click()
check('รีเซ็ต: จำนวนสมาชิกกลับเป็นค่าเริ่มต้น', (await stat(page, 'สมาชิกทั้งหมด')) === total0)

// ---------- 5. แหล่งข้อมูล ----------
await page.locator('.sidebar').getByRole('link', { name: 'แหล่งข้อมูล', exact: true }).click()
await page.locator('.source-card').first().waitFor()
check('แหล่งข้อมูล: 4 รายการ', (await page.locator('.source-card').count()) === 4)
const bodyText = await page.locator('main').innerText()
check('แหล่งข้อมูล: ไม่มีคำว่าเชื่อมสำเร็จ/sync สำเร็จ', !/สำเร็จ|เชื่อมต่อแล้ว|synced/i.test(bodyText))
await page.getByRole('button', { name: 'ดูรายละเอียด Excel' }).click()
check('รายละเอียดแหล่งข้อมูล: ระบุว่ายังไม่เปิดใช้งาน',
  (await page.getByText('ฟีเจอร์นี้ยังไม่เปิดใช้งาน').isVisible()) && (await page.getByText('การจับคู่คอลัมน์').isVisible()))
await page.screenshot({ path: `${OUT}/source-detail-1440.png` })
await page.keyboard.press('Escape')
check('Esc ปิด dialog', (await page.locator('dialog[open]').count()) === 0)

// ---------- 5.1 เปิดกำหนดการจากภาพรวม ----------
await page.getByRole('link', { name: 'ภาพรวม' }).click()
const links = page.locator('.upcoming-link')
await links.first().waitFor()
const firstTitle = await links.first().locator('.upcoming-title').innerText()
const firstId = decodeURIComponent((await links.first().getAttribute('href')).split('event=')[1])
check('ภาพรวม: รายการกำหนดการเป็นลิงก์ ไม่มีองค์ประกอบคลิกซ้อน',
  (await links.count()) === (await page.locator('.upcoming-list li').count()) &&
  (await page.locator('.upcoming-link a, .upcoming-link button').count()) === 0)
// ไปถึงลิงก์ด้วย Tab จริง เพื่อดูเส้น focus แบบที่ผู้ใช้คีย์บอร์ดเห็น
await page.getByRole('link', { name: 'ดูปฏิทิน' }).focus()
await page.keyboard.press('Tab')
check('ภาพรวม: Tab ถึงรายการกำหนดการและเห็นเส้น focus',
  await page.evaluate(() => {
    const el = document.activeElement
    return el?.classList.contains('upcoming-link') && el.matches(':focus-visible') && getComputedStyle(el).outlineStyle !== 'none'
  }))
await page.screenshot({ path: `${OUT}/overview-link-focus-1440.png` })
await page.keyboard.press('Enter')
check('ภาพรวม→ปฏิทิน: เปิดรายละเอียดของรายการที่กด',
  (await appears(page.locator('dialog.dialog[open] h2', { hasText: firstTitle }))) && new URL(page.url()).pathname === '/calendar')
await page.screenshot({ path: `${OUT}/event-detail-from-overview-1440.png` })
await page.keyboard.press('Escape')
check('ภาพรวม→ปฏิทิน: ปิดแล้ว focus อยู่ที่รายการนั้นในวันที่เลือก',
  await page.evaluate((id) => {
    const el = document.activeElement
    return el?.getAttribute('data-event-id') === id && !!el.closest('.day-panel')
  }, firstId))
check('ภาพรวม→ปฏิทิน: วันที่เลือกอยู่ในเดือนที่แสดง', (await page.locator('.month-cell.is-selected:not(.is-outside)').count()) === 1)

await page.getByRole('link', { name: 'ภาพรวม' }).click()
const multi = page.locator('.upcoming-link', { hasText: 'เปิดรับสมัครสมาชิกใหม่' })
const multiId = decodeURIComponent((await multi.getAttribute('href')).split('event=')[1])
const multiStart = JSON.parse(await stored(page)).events.find((e) => e.id === multiId).start.slice(0, 10)
await multi.click()
check('ภาพรวม→ปฏิทิน (หลายวัน): เปิดรายละเอียดพร้อมช่วงวัน',
  (await appears(page.locator('dialog.dialog[open] h2', { hasText: 'เปิดรับสมัครสมาชิกใหม่' }))) &&
  /–.*ทั้งวัน/.test(await page.locator('dialog.dialog[open] .detail-list').innerText()))
await page.keyboard.press('Escape')
check('ภาพรวม→ปฏิทิน (หลายวัน): เลือกวันเริ่มของรายการ',
  (await page.locator('.month-cell.is-selected .month-day-number').innerText()) === String(Number(multiStart.slice(8))) &&
  (await page.locator(`.day-panel .event-row[data-event-id="${multiId}"]`).count()) === 1)

const errorsBeforeMissing = consoleErrors.length
await page.goto(BASE + '/calendar?event=no-such-id')
check('ID ไม่พบ: แจ้งว่าไม่พบ มีทางกลับปฏิทิน และหน้าไม่พัง',
  (await appears(page.getByText('ไม่พบกำหนดการที่ต้องการเปิด'))) &&
  (await page.locator('.month-grid').isVisible()) &&
  (await page.locator('dialog[open]').count()) === 0 &&
  consoleErrors.length === errorsBeforeMissing)
await page.screenshot({ path: `${OUT}/calendar-event-not-found-1440.png` })
await page.getByRole('button', { name: 'กลับไปดูปฏิทินเดือนนี้' }).click()
check('ID ไม่พบ: กดกลับแล้วข้อความหายและใช้ปฏิทินต่อได้', await gone(page.getByText('ไม่พบกำหนดการที่ต้องการเปิด')))
check('ID ไม่พบ: กดกลับแล้ว focus ไปที่หัวข้อเดือนของปฏิทิน',
  await page.waitForFunction(() => document.activeElement?.classList.contains('calendar-title'), null, { timeout: 2000 }).then(() => true, () => false))

// ---------- 5.2 ปฏิทิน: ชื่อยาว หลายรายการในวันเดียว กำหนดการหลายวัน ----------
const todayBkk = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Bangkok' }).format(new Date())
const plusDays = (d, n) => new Date(Date.parse(d) + n * 86400000).toISOString().slice(0, 10)
const LONG = 'ประชุมเตรียมงานแข่งขันภายในชมรมรอบคัดเลือกและแบ่งหน้าที่ทีมงานทุกฝ่ายก่อนวันจริง'
const BUSY = [
  { id: 'busy-1', title: LONG, allDay: false, start: `${todayBkk}T09:00`, end: `${todayBkk}T10:30`, location: 'ห้องประชุม (ตัวอย่าง)', description: 'รายละเอียดทดสอบ' },
  { id: 'busy-2', title: 'ซ้อมทีม A', allDay: false, start: `${todayBkk}T13:00`, end: `${todayBkk}T15:00`, location: '', description: '' },
  { id: 'busy-3', title: 'ถ่ายทอดสดรอบชิงชนะเลิศและพิธีมอบรางวัล', allDay: false, start: `${todayBkk}T18:00`, end: `${todayBkk}T21:00`, location: '', description: '' },
  { id: 'busy-4', title: 'สัปดาห์กิจกรรมชมรมประจำภาคเรียน', allDay: true, start: `${todayBkk}T00:00`, end: `${plusDays(todayBkk, 3)}T23:59`, location: '', description: '' },
  { id: 'busy-5', title: 'แข่งข้ามคืน', allDay: false, start: `${todayBkk}T22:00`, end: `${plusDays(todayBkk, 1)}T02:00`, location: '', description: '' },
]
for (const [width, height] of [[1920, 1080], [1440, 900], [1024, 768], [390, 844]]) {
  const p = await newPage(width, height)
  await p.goto(BASE + '/')
  await p.locator('.stats').waitFor()
  await p.evaluate(([key, extra]) => {
    const data = JSON.parse(localStorage.getItem(key))
    data.events.push(...extra)
    localStorage.setItem(key, JSON.stringify(data))
  }, [STORAGE_KEY, BUSY])
  await p.goto(BASE + '/calendar')
  await p.locator('.calendar-card').waitFor()
  await p.evaluate(() => document.fonts.ready)

  if (width === 390) {
    check('ปฏิทินแน่น @390: มุมมองรายการเป็นค่าเริ่มต้นและไม่ล้น',
      (await p.getByRole('button', { name: 'รายการ' }).getAttribute('aria-pressed')) === 'true' && (await noOverflow(p)))
    await shot(p, 'calendar-busy-list-390')
    await p.getByRole('button', { name: 'เดือน', exact: true }).click()
    await p.locator('.month-cell.is-today .month-day').click()
    check('ปฏิทินแน่น @390: มุมมองเดือนไม่ล้น และแตะวันแล้วเห็นครบทุกรายการ',
      (await noOverflow(p)) && (await p.locator('.day-panel .event-row').count()) === 5)
    await p.evaluate(() => window.scrollTo(0, 0))
    await shot(p, 'calendar-busy-month-390')
    await p.context().close()
    continue
  }

  const cell = p.locator('.month-cell.is-today')
  const metrics = await cell.locator('.chip', { hasText: LONG }).evaluate((chip) => {
    const title = chip.querySelector('.chip-title')
    const time = chip.querySelector('.chip-time')
    const style = getComputedStyle(title)
    return {
      lines: Math.round(title.clientHeight / parseFloat(style.lineHeight)),
      clamped: title.scrollHeight > title.clientHeight,
      fontSize: parseFloat(style.fontSize),
      timeAbove: time.getBoundingClientRect().bottom <= title.getBoundingClientRect().top + 1,
      cellWidth: Math.round(chip.closest('.month-cell').getBoundingClientRect().width),
    }
  })
  check(`ปฏิทินแน่น @${width}: ชื่อยาวแสดง 2 บรรทัดแล้วตัด เวลาแยกบรรทัด ฟอนต์ไม่ถูกลด`,
    metrics.lines === 2 && metrics.clamped && metrics.timeAbove && metrics.fontSize >= 13,
    `ช่องวันกว้าง ${metrics.cellWidth}px ฟอนต์ ${metrics.fontSize}px`)
  check(`ปฏิทินแน่น @${width}: ไม่ล้นแนวนอน`, await noOverflow(p))

  const place = await p.evaluate(() => {
    const grid = document.querySelector('.month-grid').getBoundingClientRect()
    const panel = document.querySelector('.day-panel').getBoundingClientRect()
    return panel.left >= grid.right ? 'side' : panel.top >= grid.bottom ? 'below' : 'overlap'
  })
  check(`ปฏิทินแน่น @${width}: แผงวันที่เลือกอยู่${width >= 1920 ? 'ด้านข้าง' : 'ใต้ตาราง'}`, place === (width >= 1920 ? 'side' : 'below'), place)

  // ชื่อเต็มเปิดดูได้ด้วยคีย์บอร์ด
  await cell.locator('.chip', { hasText: LONG }).focus()
  await p.keyboard.press('Enter')
  check(`ปฏิทินแน่น @${width}: Enter ที่ chip เปิดชื่อเต็ม วันเวลา และรายละเอียด`,
    (await appears(p.locator('dialog.dialog[open] h2', { hasText: LONG }))) &&
    (await p.locator('dialog.dialog[open]').getByText('09:00–10:30 น.').isVisible()) &&
    (await p.locator('dialog.dialog[open]').getByText('รายละเอียดทดสอบ').isVisible()))
  if (width === 1440) await p.screenshot({ path: `${OUT}/event-detail-long-title-1440.png` })
  await p.keyboard.press('Escape')
  check(`ปฏิทินแน่น @${width}: ปิดแล้ว focus กลับไปที่ chip`,
    await p.evaluate(() => document.activeElement?.classList.contains('chip') ?? false))

  // “อีก N รายการ” เปิดรายการของวันนั้น
  const more = cell.locator('.chip-more')
  check(`ปฏิทินแน่น @${width}: มี “อีก 3 รายการ”`, (await more.innerText()).trim() === 'อีก 3 รายการ')
  await p.locator('.month-cell.is-today + .month-cell .month-day').click()
  await more.focus()
  await p.keyboard.press('Enter')
  await p.waitForTimeout(150)
  check(`ปฏิทินแน่น @${width}: “อีก N รายการ” พาไปรายการของวันนั้นครบ 5 รายการ`,
    (await p.evaluate(() => document.activeElement?.id === 'day-panel-title')) &&
    (await p.locator('.day-panel .event-row').count()) === 5 &&
    (await p.locator('.day-panel .event-row', { hasText: LONG }).isVisible()))

  // วันนี้ กับ วันที่เลือก
  await p.locator('.month-cell.is-today + .month-cell .month-day').click()
  check(`ปฏิทินแน่น @${width}: แยก “วันนี้” กับ “วันที่เลือก”`,
    (await p.locator('.month-cell.is-today.is-selected').count()) === 0 &&
    (await p.locator('.month-cell.is-selected').count()) === 1 &&
    (await p.locator('.month-cell.is-today .month-today-label').isVisible()) &&
    (await p.locator('.day-panel .today-tag').count()) === 0 &&
    (await p.locator('.day-panel .day-panel-label').innerText()) === 'วันที่เลือก')
  await p.evaluate(() => window.scrollTo(0, 0))
  await shot(p, `calendar-busy-${width}`)
  await p.context().close()
}

// ---------- 5.3 ลิงก์รายละเอียดคงอยู่เมื่อ refresh + ข้อความแจ้งผลเมื่อเปิด dialog ใหม่ ----------
const failWrites = (p) => p.evaluate(() => {
  window.__setItem = Storage.prototype.setItem
  Storage.prototype.setItem = () => { throw new Error('จำลองบันทึกล้มเหลว') }
})
const restoreWrites = (p) => p.evaluate(() => { Storage.prototype.setItem = window.__setItem })

for (const [width, height] of [[1440, 900], [390, 844]]) {
  const p = await newPage(width, height)
  const tag = `[${width}]`
  const openDialog = p.locator('dialog.dialog[open]')
  const eventParam = () => new URL(p.url()).searchParams.get('event')
  const historyLength = () => p.evaluate(() => history.length)
  const missingText = p.getByText('ไม่พบกำหนดการที่ต้องการเปิด')

  // ภาพรวม → รายละเอียด → refresh
  await p.goto(BASE + '/')
  const link = p.locator('.upcoming-link').first()
  await link.waitFor()
  const title = await link.locator('.upcoming-title').innerText()
  const id = decodeURIComponent((await link.getAttribute('href')).split('event=')[1])
  const lengthAtOverview = await historyLength()
  await link.click()
  check(`${tag} รายละเอียดเปิดอยู่: URL ยังมี ?event=<id>`,
    (await appears(openDialog.locator('h2', { hasText: title }))) && eventParam() === id)
  await p.reload()
  check(`${tag} refresh: รายละเอียดรายการเดิมยังเปิด และ URL ยังมี event`,
    (await appears(openDialog.locator('h2', { hasText: title }))) && eventParam() === id)
  check(`${tag} refresh: เดือน/วันที่ที่แสดงมีรายการนั้น`,
    (await p.locator(`.event-row[data-event-id="${id}"]`).count()) >= 1)
  await p.screenshot({ path: `${OUT}/event-detail-after-refresh-${width}.png` })
  await p.keyboard.press('Escape')
  check(`${tag} ปิดรายละเอียด: ลบ event ออกจาก URL และ focus ไปที่รายการนั้น`,
    (await gone(openDialog)) && eventParam() === null && new URL(p.url()).pathname === '/calendar' &&
    (await p.evaluate((eid) => document.activeElement?.getAttribute('data-event-id') === eid, id)))
  check(`${tag} เปิด/ปิดรายละเอียดไม่เพิ่มประวัติเกินการเข้าหน้าปฏิทิน 1 รายการ`,
    (await historyLength()) === lengthAtOverview + 1, `${lengthAtOverview} → ${await historyLength()}`)
  await p.goBack()
  check(`${tag} Back: กลับภาพรวม ไม่มี dialog`,
    (await appears(p.locator('.upcoming-link').first())) && new URL(p.url()).pathname === '/' && (await p.locator('dialog[open]').count()) === 0)
  await p.goForward()
  await p.locator('.calendar-card').waitFor()
  await p.waitForTimeout(300)
  check(`${tag} Forward: กลับปฏิทินโดยไม่เปิด dialog ซ้ำ`,
    new URL(p.url()).pathname === '/calendar' && eventParam() === null && (await p.locator('dialog[open]').count()) === 0)

  // เปิดลิงก์โดยตรงพร้อม parameter อื่น
  await p.goto(`${BASE}/calendar?event=${encodeURIComponent(id)}&keep=1`)
  check(`${tag} เปิดลิงก์โดยตรง: เปิดรายละเอียด`, await appears(openDialog.locator('h2', { hasText: title })))
  await openDialog.getByRole('button', { name: 'ปิด', exact: true }).last().click()
  check(`${tag} ปิดรายละเอียด: ลบเฉพาะ event รักษา parameter อื่น`,
    (await gone(openDialog)) && new URL(p.url()).search === '?keep=1', new URL(p.url()).search)

  // เปิดจากในหน้าปฏิทิน
  const lengthInPage = await historyLength()
  await p.locator(`.event-row[data-event-id="${id}"]`).first().click()
  check(`${tag} เปิดจากในปฏิทิน: URL มี event โดยไม่เพิ่มประวัติ`,
    (await appears(openDialog)) && eventParam() === id && (await historyLength()) === lengthInPage)
  await p.reload()
  check(`${tag} เปิดจากในปฏิทินแล้ว refresh: รายละเอียดยังเปิด`, await appears(openDialog.locator('h2', { hasText: title })))
  await p.keyboard.press('Escape')
  await gone(openDialog)

  // ID ไม่พบ
  const errorsBefore = consoleErrors.length
  await p.goto(`${BASE}/calendar?event=no-such-id&keep=1`)
  const lengthMissing = await historyLength()
  check(`${tag} ID ไม่พบ: แสดงข้อความเดิม ไม่มี dialog`, (await appears(missingText)) && (await p.locator('dialog[open]').count()) === 0)
  await p.reload()
  check(`${tag} ID ไม่พบ + refresh: ยังแสดงข้อความ ไม่วนนำทาง`,
    (await appears(missingText)) && (await historyLength()) === lengthMissing && consoleErrors.length === errorsBefore)
  await p.getByRole('button', { name: 'กลับไปดูปฏิทินเดือนนี้' }).click()
  check(`${tag} ID ไม่พบ: กลับปฏิทินแล้วข้อความหาย เหลือ parameter อื่น ไม่เพิ่มประวัติ`,
    (await gone(missingText)) && new URL(p.url()).search === '?keep=1' && (await historyLength()) === lengthMissing)
  await p.goBack()
  await p.locator('.calendar-card').waitFor()
  await p.waitForTimeout(300)
  check(`${tag} ID ไม่พบ: Back ไม่พากลับไปที่ลิงก์ที่ไม่พบ`,
    !p.url().includes('no-such-id') && (await missingText.count()) === 0)

  // ข้อความสำเร็จเก่า + เปิด dialog ใหม่ทันที
  await p.goto(BASE + '/calendar')
  const addButton = p.getByRole('button', { name: 'เพิ่มกำหนดการ' })
  await addButton.first().click()
  await p.locator('#event-title').fill('ตรวจข้อความแจ้งผล')
  await p.getByLabel('ทั้งวัน').check()
  await addButton.last().click()
  const toastShown = await appears(p.locator('.toast', { hasText: 'ตรวจข้อความแจ้งผล' }))
  await addButton.first().click()
  await p.locator('#event-title').waitFor()
  check(`${tag} มีข้อความสำเร็จแล้วเปิด dialog ใหม่: ข้อความเก่าถูกปิด ไม่ค้างหลังฉากมืด`,
    toastShown && (await gone(p.locator('.toast'))))
  await p.screenshot({ path: `${OUT}/toast-cleared-on-dialog-${width}.png` })

  // บันทึกล้มเหลวในฟอร์ม
  await p.locator('#event-title').fill('ตรวจบันทึกล้มเหลว')
  await p.getByLabel('ทั้งวัน').check()
  await failWrites(p)
  await addButton.last().click()
  const alert = p.locator('dialog[open] .form-alert')
  check(`${tag} บันทึกล้มเหลว: ข้อผิดพลาดแสดงในฟอร์ม (ใน dialog ที่เปิดอยู่) และค่าที่กรอกยังอยู่`,
    (await appears(alert)) && (await alert.getAttribute('role')) === 'alert' &&
    (await p.locator('#event-title').inputValue()) === 'ตรวจบันทึกล้มเหลว' &&
    (await p.getByLabel('ทั้งวัน').isChecked()),
    await alert.innerText().catch(() => ''))
  await p.screenshot({ path: `${OUT}/event-save-failed-${width}.png` })
  await restoreWrites(p)
  await addButton.last().click()
  check(`${tag} บันทึกล้มเหลว: ลองใหม่แล้วบันทึกได้`,
    (await appears(p.locator('.toast', { hasText: 'ตรวจบันทึกล้มเหลว' }))) && (await p.locator('dialog[open]').count()) === 0)

  if (width < 768) {
    await p.getByRole('button', { name: 'เปิดเมนู' }).click()
    await p.locator('dialog.mobile-menu[open]').waitFor()
    check(`${tag} มีข้อความสำเร็จแล้วเปิดเมนู: ข้อความเก่าถูกปิด`, await gone(p.locator('.toast')))
    await p.keyboard.press('Escape')
  } else {
    // เปลี่ยนสถานะสมาชิกล้มเหลว: แจ้งในหน้ารายละเอียดที่เปิดอยู่
    await p.goto(BASE + '/members')
    const activeRow = p.locator('tbody tr', { has: p.locator('.badge', { hasText: /^ใช้งาน$/ }) }).first()
    await activeRow.getByRole('button', { name: /ดูรายละเอียด/ }).click()
    await failWrites(p)
    await p.getByRole('button', { name: 'พักการใช้งาน' }).click()
    await p.locator('dialog.dialog-sm').getByRole('button', { name: 'พักการใช้งาน' }).click()
    const statusAlert = p.locator('dialog[open] .detail-alert')
    check(`${tag} พักการใช้งานล้มเหลว: แจ้งในหน้ารายละเอียดที่เปิดอยู่ สถานะยังเป็นค่าเดิม`,
      (await appears(statusAlert)) && (await p.locator('dialog[open] .badge').innerText()).trim() === 'ใช้งาน' &&
      (await p.locator('.toast').count()) === 0)
    await p.screenshot({ path: `${OUT}/member-status-failed-${width}.png` })
    await restoreWrites(p)
    await p.getByRole('button', { name: 'พักการใช้งาน' }).click()
    await p.locator('dialog.dialog-sm').getByRole('button', { name: 'พักการใช้งาน' }).click()
    check(`${tag} พักการใช้งานล้มเหลว: ลองใหม่แล้วสำเร็จ`, await appears(p.locator('.toast', { hasText: 'พักการใช้งาน' })))

    // ข้อผิดพลาดเก่าที่ยังไม่ได้ปิด: ไม่ค้างหลังฉากมืด และกลับมาเมื่อปิด dialog
    await failWrites(p)
    await p.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }).click()
    await p.getByRole('button', { name: 'รีเซ็ตข้อมูล', exact: true }).click()
    const errorToast = p.locator('.toast-error')
    const errorShown = await appears(errorToast)
    await restoreWrites(p)
    await p.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
    await p.locator('#member-name').waitFor()
    const hiddenBehindModal = (await p.locator('.toast').count()) === 0
    await p.keyboard.press('Escape')
    check(`${tag} ข้อผิดพลาดที่ยังไม่ได้ปิด: ไม่ค้างหลังฉากมืด และกลับมาให้ปิดได้หลังปิด dialog`,
      errorShown && hiddenBehindModal && (await appears(errorToast)))
    await errorToast.getByRole('button', { name: 'ปิดข้อความ' }).click()
  }
  await p.context().close()
}

// ---------- 6. คีย์บอร์ด + สถานะว่าง/ผิดพลาด ----------
await page.goto(BASE + '/members')
await page.locator('h1').waitFor()
await page.keyboard.press('Tab')
check('คีย์บอร์ด: Tab แรกคือลิงก์ข้ามไปยังเนื้อหา',
  await page.evaluate(() => document.activeElement?.classList.contains('skip-link') ?? false))
await page.locator('#member-search').focus()
await page.screenshot({ path: `${OUT}/focus-ring-1440.png` })

await page.evaluate((key) => localStorage.setItem(key, JSON.stringify({ members: [], events: [] })), STORAGE_KEY)
await page.goto(BASE + '/')
check('ไม่มีข้อมูล: ภาพรวมบอกสิ่งที่เริ่มทำได้',
  (await page.getByText('ยังไม่มีสมาชิก').isVisible()) && (await page.locator('.stats').count()) === 0)
await shot(page, 'overview-empty-1440')
await page.goto(BASE + '/members')
check('ไม่มีข้อมูล: หน้าสมาชิก', await page.getByRole('button', { name: 'เพิ่มสมาชิกคนแรก' }).isVisible())

await page.evaluate((key) => localStorage.setItem(key, '{เสีย'), STORAGE_KEY)
const expectedErrors = consoleErrors.length
await page.goto(BASE + '/members')
check('ข้อมูลเสีย: แสดงข้อผิดพลาดพร้อมวิธีลองใหม่',
  (await page.getByText('โหลดข้อมูลไม่สำเร็จ').isVisible()) && (await page.getByRole('button', { name: 'ลองโหลดอีกครั้ง' }).isVisible()))
await shot(page, 'members-error-1440')
await page.getByRole('button', { name: 'รีเซ็ตข้อมูลตัวอย่าง' }).click()
await page.getByRole('button', { name: 'รีเซ็ตข้อมูล', exact: true }).click()
check('ข้อมูลเสีย: รีเซ็ตแล้วกลับมาใช้งานได้', await page.locator('tbody tr').first().isVisible())

consoleErrors.splice(expectedErrors) // ไม่นับช่วงจำลองข้อมูลเสีย
check('ไม่มี error ใน console', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '))

await browser.close()
console.log(failed ? `\nไม่ผ่าน ${failed} รายการ` : '\nผ่านทุกรายการ')
process.exit(failed ? 1 : 0)
