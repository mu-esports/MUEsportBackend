// ตัวตรวจของชุดตรวจ UI โหมดจริง (ui-check-live.mjs) ที่เกี่ยวกับ “ข้อมูลของหน้าพร้อมแสดงแล้วหรือยัง”
// แยกเป็นไฟล์ เพื่อให้ตรวจกรณีเหล่านี้แบบแยกเดี่ยวได้ด้วยโค้ดชุดเดียวกับที่ชุดตรวจเต็มใช้
//
// 1) checkMonthChip — “ปฏิทินเดือน: เห็นเวลาและชื่อกำหนดการในช่องวัน”
// - เป้าหมายคือกำหนดการที่ระบุด้วย id จากข้อมูลทดสอบจริง (/api/events) ไม่สมมติว่าป้ายแรกในหน้าคือรายการที่ต้องการ
// - รอให้ป้ายของรายการเป้าหมายแสดงก่อนตรวจ (รอตามเงื่อนไขภายในเวลาสูงสุด ไม่ใช่หน่วงเวลาตายตัว)
// - ข้อยืนยันไม่ถูกผ่อน: เวลาและชื่อต้องตรงกับข้อมูล มองเห็นได้จริง อยู่ภายในกรอบของช่องวันที่ถูกต้อง และไม่ถูกองค์ประกอบอื่นบัง
//
// 2) probeLoadSignal — สถานะ “กำลังโหลด” ของหน้าต้องหายเมื่อข้อมูลชุดล่าสุดมาถึงแล้วเท่านั้น
// - dev server เปิด React StrictMode ซึ่งเรียก effect ตอนเปิดหน้าซ้ำ จึงมีคำขออ่านข้อมูลสองชุดและหน้าใช้ผลของชุดล่าสุด
//   ถ้าหน้าขึ้นว่าโหลดเสร็จตั้งแต่ชุดแรกตอบ ผู้ใช้จะเห็น “ไม่มีข้อมูล” ชั่วครู่ทั้งที่มีข้อมูล
//   และข้อตรวจที่วัดหน้าทันทีหลังสัญญาณนี้จะวัดหน้าว่าง (สาเหตุฝั่งหน้าเว็บของข้อตรวจปฏิทินเดือนที่เคยผ่านไม่สม่ำเสมอ)
import { writeFileSync } from 'node:fs'

const BANGKOK_OFFSET_MS = 7 * 60 * 60 * 1000
const monthIndex = (month) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7))
const attr = (value) => String(value).replace(/["\\]/g, '\\$&')

/** ป้ายเวลาที่ช่องวันเริ่มของกำหนดการต้องแสดง ตามกติกาเดียวกับหน้าเว็บ (eventTimeLabel ใน src/lib/datetime.ts) */
export const expectedChipTime = (event) => (event.allDay ? 'ทั้งวัน' : event.start.slice(11, 16))

/** ภาพรวมของปฏิทินเดือน ณ ขณะหนึ่ง อ่านในคำสั่งเดียวเพื่อไม่ให้ค่าที่นำมาเทียบมาจากคนละจังหวะของหน้า */
function snapshotMonth({ id }) {
  const text = (el) => (el?.textContent ?? '').replace(/\s+/g, ' ').trim()
  const box = (rect) => [Math.round(rect.left), Math.round(rect.top), Math.round(rect.width), Math.round(rect.height)]
  const grid = document.querySelector('.month-grid')
  const describe = (chip) => {
    const cell = chip.closest('.month-cell')
    return {
      id: chip.getAttribute('data-event-id'),
      day: text(cell?.querySelector('.month-day-number')),
      outside: !!cell?.classList.contains('is-outside'),
      time: text(chip.querySelector('.chip-time')),
      title: text(chip.querySelector('.chip-title')),
    }
  }
  const chips = grid ? [...grid.querySelectorAll('.chip')] : []
  const mine = chips.filter((chip) => chip.getAttribute('data-event-id') === id)
  let target = null
  if (mine.length > 0) {
    const chip = mine[0]
    const cell = chip.closest('.month-cell')
    // เลื่อนช่องวันมากลางจอก่อนวัด: ตรวจสิ่งที่ผู้ใช้เห็นเมื่อเลื่อนมาถึงช่องนี้ โดยไม่ถูกหัวเว็บที่เกาะด้านบนบัง
    cell.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    const cellRect = cell.getBoundingClientRect()
    const gridRect = grid.getBoundingClientRect()
    const part = (selector) => {
      const el = chip.querySelector(selector)
      if (!el) return { present: false }
      const rect = el.getBoundingClientRect()
      const style = getComputedStyle(el)
      const shown =
        rect.width > 0 && rect.height > 0 && style.visibility === 'visible' && style.display !== 'none' && parseFloat(style.fontSize) > 0 &&
        (typeof el.checkVisibility === 'function' ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : Number(style.opacity) > 0)
      const top = shown ? document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2) : null
      return {
        present: true,
        text: text(el),
        shown,
        // อยู่ภายในกรอบของช่องวัน (ยอมให้คลาดได้ 1px จากการปัดเศษ)
        insideCell: rect.left >= cellRect.left - 1 && rect.right <= cellRect.right + 1 && rect.top >= cellRect.top - 1 && rect.bottom <= cellRect.bottom + 1,
        inViewport: rect.top >= 0 && rect.left >= 0 && rect.bottom <= innerHeight && rect.right <= innerWidth,
        // จุดกึ่งกลางเป็นของป้ายนี้จริง ไม่ถูกองค์ประกอบอื่นบัง
        hit: !!top && chip.contains(top),
        box: box(rect),
      }
    }
    target = {
      ...describe(chip),
      count: mine.length,
      cellInsideGrid: cellRect.left >= gridRect.left - 1 && cellRect.right <= gridRect.right + 1 && cellRect.top >= gridRect.top - 1 && cellRect.bottom <= gridRect.bottom + 1,
      cellBox: box(cellRect),
      timePart: part('.chip-time'),
      titlePart: part('.chip-title'),
    }
  }
  return {
    monthView: !!grid,
    monthTitle: text(document.querySelector('.calendar-title')),
    loading: !!document.querySelector('#main .state-block[role="status"]'),
    emptyDayPanel: !!document.querySelector('.day-panel .empty-state'),
    chips: chips.map(describe),
    target,
  }
}

/**
 * รอให้กำหนดการเป้าหมายแสดงเป็นป้ายในช่องวันของปฏิทินเดือน แล้วตรวจว่าเวลาและชื่อมองเห็นได้จริงภายในช่องวันนั้น
 * ใช้กับกำหนดการที่วันเริ่มอยู่ในเดือนเดียวกับที่ระบุ (ป้ายแรกของรายการจึงอยู่ในช่องของวันเริ่ม)
 * @param {import('playwright-core').Page} page หน้า /calendar ที่อยู่ในมุมมองเดือน
 * @param {{ id: string, title: string, start: string, end: string, allDay: boolean }} target กำหนดการจากข้อมูลทดสอบ
 * @param {{ timeout?: number, shownMonth?: string }} [options] timeout = เวลารอสูงสุดให้ป้ายปรากฏ, shownMonth = เดือนที่หน้าแสดงอยู่ (YYYY-MM)
 *   ค่าเริ่มต้นคือเดือนปัจจุบันตามเวลาไทย ซึ่งเป็นเดือนที่ปฏิทินเปิดเมื่อเพิ่งโหลดหน้า
 * @returns {Promise<{ ok: boolean, problems: string[], seen: ReturnType<typeof snapshotMonth>, waitedMs: number }>}
 */
export async function checkMonthChip(page, target, { timeout = 6000, shownMonth } = {}) {
  const startedAt = Date.now()
  const problems = []

  // กำหนดการเป้าหมายอาจอยู่คนละเดือนกับที่หน้าแสดง (เช่น ชุดตรวจรันข้ามสิ้นเดือน): เลื่อนไปเดือนของรายการก่อน ไม่สมมติว่าอยู่เดือนนี้
  const from = shownMonth ?? new Date(Date.now() + BANGKOK_OFFSET_MS).toISOString().slice(0, 7)
  const steps = monthIndex(from) - monthIndex(target.start.slice(0, 7))
  for (let i = 0; i < Math.abs(steps); i++) {
    await page.getByRole('button', { name: steps > 0 ? 'เดือนก่อนหน้า' : 'เดือนถัดไป', exact: true }).click()
  }

  const chip = page.locator(`.month-grid .month-cell .chip[data-event-id="${attr(target.id)}"]`).first()
  const appeared = await chip.waitFor({ state: 'visible', timeout }).then(() => true, () => false)
  const waitedMs = Date.now() - startedAt
  if (!appeared) problems.push(`รอ ${timeout}ms แล้วยังไม่เห็นป้ายของกำหนดการเป้าหมายในช่องวันของปฏิทินเดือน`)

  const seen = await page.evaluate(snapshotMonth, { id: target.id })
  if (!seen.monthView) problems.push('หน้าไม่ได้อยู่ในมุมมองเดือน')
  const found = seen.target
  if (found) {
    const day = String(Number(target.start.slice(8, 10)))
    const singleDay = target.start.slice(0, 10) === target.end.slice(0, 10)
    if (singleDay && found.count !== 1) problems.push(`มีป้ายของรายการนี้ ${found.count} ป้าย (กำหนดการวันเดียวต้องมี 1 ป้าย)`)
    if (found.day !== day || found.outside) problems.push(`ป้ายอยู่ในช่องวันที่ ${found.day}${found.outside ? ' (ช่องของเดือนอื่น)' : ''} ไม่ใช่วันที่ ${day} ของเดือนที่แสดง`)
    if (!found.cellInsideGrid) problems.push('ช่องวันของรายการล้นออกนอกตารางเดือน')
    const expected = { 'เวลา': expectedChipTime(target), 'ชื่อ': target.title }
    for (const [label, part] of [['เวลา', found.timePart], ['ชื่อ', found.titlePart]]) {
      if (!part.present) {
        problems.push(`ป้ายไม่มีส่วนแสดง${label}`)
        continue
      }
      if (part.text !== expected[label]) problems.push(`${label}ที่แสดง “${part.text}” ไม่ตรงกับข้อมูล “${expected[label]}”`)
      if (!part.shown) problems.push(`${label}ไม่ถูกแสดง (ถูกซ่อน โปร่งใส หรือไม่มีขนาด)`)
      else {
        if (!part.insideCell) problems.push(`${label}ล้นออกนอกกรอบของช่องวัน`)
        if (!part.inViewport) problems.push(`${label}ไม่อยู่ในพื้นที่ที่มองเห็นของหน้าจอแม้เลื่อนช่องวันมากลางจอแล้ว`)
        if (!part.hit) problems.push(`${label}ถูกองค์ประกอบอื่นบัง`)
      }
    }
    // เงื่อนไขเดิมของข้อตรวจนี้ (Playwright เห็นว่าส่วนเวลาแสดงอยู่) ยังต้องเป็นจริง
    if (!(await chip.locator('.chip-time').isVisible())) problems.push('Playwright เห็นว่าส่วนเวลาของป้ายไม่แสดง')
  } else if (appeared) {
    problems.push('ป้ายของรายการเป้าหมายหายไประหว่างตรวจ')
  }
  return { ok: problems.length === 0, problems, seen, waitedMs }
}

/**
 * เปิดหน้าโดยกั้นคำตอบของคำขออ่านข้อมูล “ตัวล่าสุด” ไว้ แล้วตรวจว่าหน้ายังแสดงสถานะกำลังโหลดจนกว่าคำตอบนั้นจะมาถึง
 * - คำขอแรกของ api ได้คำตอบจริงทันที คำขอถัดไปได้คำตอบจริงเช่นกันแต่ถูกกั้นไว้จนกว่าตัวตรวจจะปล่อย (ไม่ใช่การหน่วงตามเวลา)
 * - ระหว่างกั้น ให้เวลาหน้าแสดงอาการไม่เกิน holdMs: ถ้าหน้าขึ้นว่าโหลดเสร็จโดยยังไม่มีข้อมูล เงื่อนไขจะเป็นจริงทันทีและข้อตรวจไม่ผ่าน
 * - ตัวสังเกตในหน้าเองบันทึกตั้งแต่เริ่มโหลดว่าเคยมีช่วงที่สถานะกำลังโหลดหายไปก่อนข้อมูล หรือเคยแสดงข้อความว่าไม่มีข้อมูลหรือไม่
 * ถ้าหน้าส่งคำขอเพียงครั้งเดียว (เช่น production build ซึ่งไม่มีการเรียก effect ซ้ำ) จะไม่มีอะไรถูกกั้น และข้อตรวจยืนยันเพียงว่าไม่มีช่วงว่าง
 * @param {import('playwright-core').Page} page หน้าใหม่ที่ยังไม่ได้เปิด URL ใด
 * @param {{ url: string, api: string, dataSelector: string, wrongText: string, holdMs?: number, timeout?: number }} options
 *   api = path ของคำขออ่านข้อมูล, dataSelector = องค์ประกอบที่มีเมื่อข้อมูลถูกวาดแล้ว, wrongText = ข้อความที่หน้าแสดงเมื่อเข้าใจว่าไม่มีข้อมูล
 */
export async function probeLoadSignal(page, { url, api, dataSelector, wrongText, holdMs = 1000, timeout = 6000 }) {
  await page.addInitScript(({ dataSelector, wrongText }) => {
    const seen = (window.__loadSignal = { hadLoading: false, readyWithoutData: false, wrongShown: false })
    new MutationObserver(() => {
      const main = document.querySelector('#main')
      if (!main) return
      const loading = main.querySelector('.state-block[role="status"]')
      const data = document.querySelector(dataSelector)
      if (loading) seen.hadLoading = true
      if (seen.hadLoading && !loading && !data) seen.readyWithoutData = true
      if (!data && main.textContent.includes(wrongText)) seen.wrongShown = true
    }).observe(document, { childList: true, subtree: true })
  }, { dataSelector, wrongText })

  let requests = 0
  let release
  const gate = new Promise((resolve) => (release = resolve))
  let answered
  const firstAnswered = new Promise((resolve) => (answered = resolve))
  await page.route(`**${api}`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback()
    const index = ++requests
    const response = await route.fetch().catch(() => null)
    if (!response) return route.abort().catch(() => undefined)
    if (index === 1) answered()
    else await gate
    return route.fulfill({ response }).catch(() => undefined)
  })

  try {
    await page.goto(url)
    await page.locator('#main h1').waitFor({ timeout })
    // หน้าต้องส่งคำขออ่านข้อมูลอย่างน้อยหนึ่งครั้ง: ถ้าไม่ส่งเลยให้หยุดพร้อมเหตุผล ไม่รอค้าง
    let timer
    await Promise.race([
      firstAnswered,
      new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`หน้า ${new URL(url).pathname} ไม่ได้ส่งคำขอ ${api} ภายใน ${timeout}ms`)), timeout))),
    ]).finally(() => clearTimeout(timer))
    const premature = await page
      .waitForFunction(({ dataSelector }) => {
        const main = document.querySelector('#main')
        return !!main && !main.querySelector('.state-block[role="status"]') && !document.querySelector(dataSelector)
      }, { dataSelector }, { timeout: holdMs })
      .then(() => true, () => false)
    const loadingDuringHold = await page.locator('#main .state-block[role="status"]').isVisible()
    const held = requests >= 2
    release()
    const dataShown = await page.locator(dataSelector).first().waitFor({ state: 'visible', timeout }).then(() => true, () => false)
    const loadingGone = await page.locator('#main .state-block[role="status"]').waitFor({ state: 'detached', timeout }).then(() => true, () => false)
    const seen = await page.evaluate(() => window.__loadSignal)
    const ok = requests >= 1 && !premature && (!held || loadingDuringHold) && dataShown && loadingGone && !seen.readyWithoutData && !seen.wrongShown
    return { ok, detail: { requests, held, premature, loadingDuringHold, dataShown, loadingGone, readyWithoutData: seen.readyWithoutData, wrongShown: seen.wrongShown } }
  } finally {
    release()
  }
}

/**
 * บันทึกเหตุการณ์ของหน้าแบบย่อไว้ประกอบการวินิจฉัย: method, path, รหัสสถานะ และการเปลี่ยนหน้า พร้อมเวลาที่ผ่านไป
 * ไม่บันทึก header, cookie, token, query string หรือเนื้อหาของคำขอและคำตอบ
 */
export function traceApi(page) {
  let startedAt = Date.now()
  let lines = []
  const at = () => `${Date.now() - startedAt}ms`
  const apiPath = (url) => {
    const { pathname } = new URL(url)
    return /^\/(api|auth)\//.test(pathname) ? pathname : null
  }
  page.on('request', (request) => {
    const path = apiPath(request.url())
    if (path) lines.push(`${at()} → ${request.method()} ${path}`)
  })
  page.on('response', (response) => {
    const path = apiPath(response.url())
    if (path) lines.push(`${at()} ← ${response.status()} ${path}`)
  })
  page.on('requestfailed', (request) => {
    const path = apiPath(request.url())
    if (path) lines.push(`${at()} ✕ ${request.method()} ${path}`)
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) lines.push(`${at()} nav ${new URL(frame.url()).pathname}`)
  })
  return {
    /** เริ่มช่วงบันทึกใหม่ (เรียกก่อนเปิดหน้าที่จะตรวจ) */
    reset() {
      startedAt = Date.now()
      lines = []
    },
    lines: () => [...lines],
  }
}

/**
 * เก็บหลักฐานเมื่อข้อตรวจไม่ผ่าน เพื่อแยกว่าสาเหตุมาจากหน้าเว็บ ข้อมูลทดสอบ หรือตัวตรวจ:
 * ภาพหน้าจอ, เหตุการณ์ของหน้า (ดู traceApi) และรายการที่หน้าแสดงเทียบกับข้อมูลจาก API
 * ข้อมูลที่เก็บมีเฉพาะกำหนดการของชุดทดสอบ (id ชื่อ วันเวลา) ไม่มี cookie, token หรือข้อมูลติดต่อสมาชิก
 */
export async function saveMonthChipDiagnostics(page, { dir, name, target, result, trace = [], apiEvents = [] }) {
  const screenshot = `${dir}/${name}.png`
  const report = `${dir}/${name}.json`
  const captured = await page.screenshot({ path: screenshot, fullPage: true }).then(() => true, () => false)
  const brief = (event) => ({ id: event.id, title: event.title, start: event.start, end: event.end, allDay: event.allDay })
  writeFileSync(report, JSON.stringify({
    at: new Date().toISOString(),
    page: new URL(page.url()).pathname,
    viewport: page.viewportSize(),
    target: target ? brief(target) : null,
    problems: result.problems,
    waitedMs: result.waitedMs ?? null,
    shown: result.seen,
    apiEvents: apiEvents.map(brief),
    trace,
  }, null, 2))
  return { screenshot: captured ? screenshot : null, report }
}
