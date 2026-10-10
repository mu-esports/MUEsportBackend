// ตรวจอนิเมชันของเว็บในเบราว์เซอร์จริง: เปลี่ยนหน้า สลับธีม ปุ่ม กล่องโต้ตอบ ข้อความแจ้งผล ปฏิทิน และโหมดลดการเคลื่อนไหว
// ใช้: `node scripts/ui-check-motion.mjs` (สคริปต์เปิดและปิด dev server เอง: โหมดข้อมูลตัวอย่างที่พอร์ต 5184 แล้วโหมดใช้งานจริงกับ D1 local ที่พอร์ต 5193)
// ตัวแปร: MOTION_DEMO_PORT, UI_LIVE_PORT, UI_STATE_DIR, BROWSER_CHANNEL (msedge | chrome)
// เก็บภาพกลางอนิเมชันและคลิปสั้นไว้ที่ screenshots/motion/
// หลังบ้านตรวจด้วยข้อมูลตัวอย่างในเบราว์เซอร์ ส่วนหน้าสมาชิก หน้าเข้าสู่ระบบ และจำนวนคำขอ ตรวจกับ Worker + D1 local จริง ไม่มีข้อใดแตะ Google หรือ production
import { spawn, spawnSync } from 'node:child_process'
import { mkdirSync, renameSync } from 'node:fs'
import { chromium } from 'playwright-core'
import { prepareLocalDatabase } from './local-fixtures.mjs'
import { rapidOk, rapidThemeSwitch } from './ui-check-motion-rapid.mjs'

const DEMO_PORT = Number(process.env.MOTION_DEMO_PORT ?? 5184)
const LIVE_PORT = Number(process.env.UI_LIVE_PORT ?? 5193)
const STATE_DIR = process.env.UI_STATE_DIR ?? '.wrangler/ui-test-state-motion'
const CHANNEL = process.env.BROWSER_CHANNEL ?? 'msedge'
const OUT = 'screenshots/motion'
const THEME_KEY = 'mu-esport-staff:theme:v1'
mkdirSync(OUT, { recursive: true })

let failed = 0
let passed = 0
const check = (name, ok, extra = '') => {
  if (ok) passed++
  else failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? `  — ${extra}` : ''}`)
}

function startServer(args, env = {}) {
  const child = spawn('npx', ['vite', ...args, '--strictPort'], { shell: true, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.on('data', (chunk) => (log += chunk))
  child.stderr.on('data', (chunk) => (log += chunk))
  return {
    log: () => log,
    stop() {
      if (child.pid === undefined) return
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'])
      else child.kill('SIGTERM')
    },
  }
}
async function waitFor(url, server) {
  for (let i = 0; i < 90; i++) {
    try {
      if ((await fetch(url)).ok) return
    } catch {
      // ยังไม่พร้อม
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  throw new Error(`dev server ไม่พร้อมภายในเวลา\n${server.log()}`)
}

const consoleErrors = []
const noteError = (text) => !/Failed to load resource/.test(text) && consoleErrors.push(text)
let browser
let server
let exitCode = 1

async function newPage(width, height, { theme = 'light', reduced = false, cookie, base, video } = {}) {
  const context = await browser.newContext({
    viewport: { width, height },
    locale: 'th-TH',
    timezoneId: 'Asia/Bangkok',
    reducedMotion: reduced ? 'reduce' : 'no-preference',
    ...(video ? { recordVideo: { dir: OUT, size: { width, height } } } : {}),
  })
  if (cookie) await context.addCookies([{ name: 'mu_session', value: cookie, url: base, httpOnly: true, sameSite: 'Lax' }])
  await context.addInitScript(([key, value]) => localStorage.setItem(key, value), [THEME_KEY, theme])
  await context.addInitScript(() => {
    window.__ghostsSeen = 0
    const watch = () =>
      new MutationObserver((records) => {
        for (const record of records) for (const node of record.addedNodes) if (node instanceof HTMLElement && node.inert && node.getAttribute('aria-hidden') === 'true') window.__ghostsSeen++
      }).observe(document.body, { childList: true })
    if (document.body) watch()
    else document.addEventListener('DOMContentLoaded', watch)
  })
  const page = await context.newPage()
  page.setDefaultTimeout(8000)
  page.on('console', (m) => m.type() === 'error' && noteError(m.text()))
  page.on('pageerror', (e) => noteError(String(e)))
  return page
}
const saveVideo = async (page, name) => {
  const video = page.video()
  await page.context().close()
  if (video) renameSync(await video.path(), `${OUT}/${name}.webm`)
}

/** อนิเมชันที่กฎ CSS กำหนดให้องค์ประกอบ (ชื่อ keyframes และระยะเวลา) อ่านจากค่าที่คำนวณแล้ว จึงไม่ขึ้นกับจังหวะที่ตรวจ */
const animationsOf = (page, selector) =>
  page.evaluate((selector) => {
    const el = document.querySelector(selector)
    if (!el) return null
    const style = getComputedStyle(el)
    return style.animationName.split(', ').map((name, i) => ({ name, ms: Math.round(parseFloat(style.animationDuration.split(', ')[i] ?? style.animationDuration) * 1000) }))
  }, selector)
const settled = (page, selector) =>
  page.waitForFunction((selector) => document.querySelector(selector)?.getAnimations().every((a) => a.playState === 'finished' || a.effect?.getTiming().iterations === Infinity), selector).then(() => true, () => false)
/** หยุดทุกอนิเมชันของหน้าไว้ที่เวลาเดียวกัน เพื่อถ่ายภาพกลางการเคลื่อนไหวได้ตรงทุกครั้ง */
const freezeAt = (page, ms) =>
  page.evaluate((ms) => {
    for (const a of document.getAnimations()) {
      if (a.effect?.getTiming().iterations === Infinity) continue
      a.pause()
      a.currentTime = ms
    }
  }, ms)
const resume = (page) => page.evaluate(() => document.getAnimations().forEach((a) => a.playState === 'paused' && a.play()))
/** จำนวนเงาตอนปิดที่เคยถูกเพิ่มเข้าหน้านี้ตั้งแต่โหลด */
const ghosts = (page) => page.evaluate(() => window.__ghostsSeen)
const noGhost = (page) => page.waitForFunction(() => document.querySelectorAll('body > div[inert][aria-hidden="true"]').length === 0).then(() => true, () => false)
const focusText = (page) => page.evaluate(() => document.activeElement?.getAttribute('aria-label') ?? document.activeElement?.textContent?.trim() ?? '')
const noOverflow = (page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)
const luminance = ([r, g, b]) => {
  const f = (v) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}
const contrast = (a, b) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * กดสวิตช์ธีมแล้ววัดการเปลี่ยน: ธีมถูกตั้งเมื่อไร อนิเมชันของภาพหน้า (View Transition) ชื่ออะไร ยาวเท่าไร และจบเมื่อไร
 * ระหว่างเล่น ทุกจุดบนจอเป็นธีมเก่าหรือธีมใหม่เต็ม ๆ (ภาพธีมใหม่ถูกเปิดด้วย clip-path ไม่ได้ผสมสี) จึงไม่มีสีกึ่งกลาง
 */
const themeSwitch = (page) =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const root = document.documentElement
        const started = performance.now()
        let seen = null
        document.querySelector('.theme-switch').click()
        const tick = () => {
          const running = document.getAnimations().filter((a) => a.effect?.pseudoElement?.startsWith('::view-transition'))
          if (running.length && !seen) seen = running.map((a) => ({ pseudo: a.effect.pseudoElement, name: a.animationName, ms: a.effect.getTiming().duration, blend: getComputedStyle(root, a.effect.pseudoElement).mixBlendMode }))
          if ((root.classList.contains('theme-switching') || !seen) && performance.now() - started < 2000) requestAnimationFrame(tick)
          else resolve({ seen, ms: Math.round(performance.now() - started), theme: root.dataset.theme, left: root.classList.contains('theme-switching') || root.style.getPropertyValue('--theme-x') !== '' })
        }
        requestAnimationFrame(tick)
      }),
  )
const revealOk = (result) => {
  const reveal = result.seen?.find((a) => a.pseudo === '::view-transition-new(root)')
  return !!reveal && reveal.name === 'theme-reveal' && reveal.ms >= 180 && reveal.ms <= 250 && reveal.blend === 'normal' && !result.seen.some((a) => a.pseudo === '::view-transition-old(root)')
}

try {
  browser = await chromium.launch({ channel: CHANNEL })

  // ================= หลังบ้าน (ข้อมูลตัวอย่างในเบราว์เซอร์) =================
  const DEMO = `http://localhost:${DEMO_PORT}`
  server = startServer(['--mode', 'demo', '--port', String(DEMO_PORT)])
  await waitFor(DEMO, server)
  console.log(`โหมดข้อมูลตัวอย่างพร้อมที่ ${DEMO}`)

  for (const [w, h, theme] of [[1440, 900, 'light'], [1440, 900, 'dark'], [390, 844, 'light'], [390, 844, 'dark']]) {
    const tag = `หลังบ้าน ${w}px ธีม${theme === 'dark' ? 'มืด' : 'สว่าง'}`
    const mobile = w < 1024
    const p = await newPage(w, h, { theme, video: theme === 'light' })
    await p.goto(DEMO)
    await p.locator('main#main h1').waitFor()
    await settled(p, 'main#main')

    const go = async (label, path) => {
      if (mobile) {
        await p.getByRole('button', { name: 'เปิดเมนู' }).click()
        await p.locator('.mobile-menu[open] .nav-link', { hasText: label }).click()
      } else await p.locator('.sidebar .nav-link', { hasText: label }).click()
      await p.waitForURL(`${DEMO}${path}`)
      await p.locator('main#main h1', { hasText: label }).waitFor()
    }

    // ---- เปลี่ยนหน้า ----
    await go('สมาชิก', '/members')
    const entering = await animationsOf(p, 'main#main')
    const ready = await p.evaluate(() => ({ h1: document.querySelector('main#main h1')?.textContent, events: getComputedStyle(document.querySelector('main#main')).pointerEvents }))
    check(`${tag}: เปลี่ยนหน้าแล้วเนื้อหาใหม่อยู่ในหน้าทันที มีอนิเมชันเข้า 160–220 ms และยังรับการกดระหว่างเล่น`,
      ready.h1 === 'สมาชิก' && ready.events !== 'none' && entering?.some((a) => a.name === 'page-enter' && a.ms >= 160 && a.ms <= 220), JSON.stringify({ entering, ready }))
    await freezeAt(p, 70)
    await p.screenshot({ path: `${OUT}/page-mid-${w}-${theme}.png` })
    // กดปุ่มในหน้าใหม่ทั้งที่อนิเมชันยังไม่จบ (ถูกหยุดค้างไว้): ต้องทำงาน
    await p.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
    const opened = await p.locator('dialog.dialog[open]').waitFor().then(() => true, () => false)
    check(`${tag}: ปุ่มในหน้าใหม่กดได้ทันทีโดยไม่ต้องรออนิเมชันเปลี่ยนหน้า`, opened)
    await resume(p)

    // ---- กล่องโต้ตอบ: เปิด ----
    const dialogIn = await animationsOf(p, 'dialog.dialog[open]')
    check(`${tag}: กล่องโต้ตอบเปิดพร้อมอนิเมชันเข้า และ focus อยู่ในกล่องที่ช่องแรกตามเดิม`,
      dialogIn?.some((a) => a.name === 'dialog-enter' && a.ms >= 150 && a.ms <= 220) && (await p.evaluate(() => document.activeElement?.id)) === 'member-name', JSON.stringify(dialogIn))
    await freezeAt(p, 60)
    await p.screenshot({ path: `${OUT}/dialog-open-mid-${w}-${theme}.png` })
    await resume(p)
    await settled(p, 'dialog.dialog[open]')
    // ข้อความแจ้งข้อผิดพลาดเดิมยังทำงาน
    await p.locator('dialog[open]').getByRole('button', { name: 'เพิ่มสมาชิก' }).click()
    check(`${tag}: ข้อความแจ้งข้อผิดพลาดของฟอร์มยังแสดงที่ช่องและ focus ไปที่ช่องที่ผิด`,
      (await p.locator('#member-name-error').isVisible()) && (await p.evaluate(() => document.activeElement?.id)) === 'member-name')
    // ร่างฟอร์ม: พิมพ์แล้วกด Esc ต้องถามก่อนทิ้ง (อนิเมชันไม่ทำให้ร่างหาย)
    await p.locator('#member-name').fill('ร่าง ทดสอบอนิเมชัน')
    await p.keyboard.press('Escape')
    const confirm = p.locator('dialog[open]').last()
    await confirm.getByRole('button', { name: 'กลับไปแก้ไขต่อ' }).waitFor()
    await confirm.getByRole('button', { name: 'กลับไปแก้ไขต่อ' }).click()
    await p.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 1)
    check(`${tag}: กด Esc ขณะมีร่างยังถามยืนยันก่อน และกลับมาแล้วสิ่งที่พิมพ์ยังอยู่ครบ`, (await p.locator('#member-name').inputValue()) === 'ร่าง ทดสอบอนิเมชัน')
    await noGhost(p)

    // ---- กล่องโต้ตอบ: ปิด ----
    await p.keyboard.press('Escape')
    const ghostsBeforeClose = await ghosts(p)
    await p.locator('dialog[open]').last().getByRole('button', { name: /ทิ้ง/ }).click()
    await p.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 0)
    const closing = await p.evaluate(() => ({ open: document.querySelectorAll('dialog[open]').length, ghost: window.__ghostsSeen, focus: document.activeElement?.textContent?.trim() }))
    check(`${tag}: ปิดกล่องแล้วกล่องจริงหายและ focus กลับไปที่ปุ่มที่เปิดทันที ส่วนที่จางออกเป็นเงาที่กดไม่ได้ และถูกเก็บออกเองเมื่อจบ`,
      closing.open === 0 && closing.focus === 'เพิ่มสมาชิก' && closing.ghost > ghostsBeforeClose && (await noGhost(p)), JSON.stringify(closing))

    // ---- ข้อความแจ้งผล ----
    await p.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
    await p.locator('#member-name').fill('ทดสอบ อนิเมชัน')
    await p.locator('#member-nickname').fill('โมชัน')
    await p.locator('#member-student-id').fill('6599001')
    await p.locator('dialog[open]').getByRole('button', { name: 'เพิ่มสมาชิก' }).click()
    await p.locator('.toast').waitFor()
    const toastIn = await animationsOf(p, '.toast')
    await freezeAt(p, 60)
    await p.screenshot({ path: `${OUT}/toast-mid-${w}-${theme}.png` })
    await resume(p)
    const ghostsBeforeToast = await ghosts(p)
    await p.getByRole('button', { name: 'ปิดข้อความ' }).click()
    const toastOut = await p.evaluate(() => ({ toast: document.querySelectorAll('.toast').length, ghost: window.__ghostsSeen }))
    check(`${tag}: ข้อความแจ้งผลเข้าอย่างนุ่มนวล ปิดแล้วหายจากหน้าทันที (เงาจางออกแล้วถูกเก็บ)`,
      toastIn?.some((a) => a.name === 'toast-enter') && toastOut.toast === 0 && toastOut.ghost > ghostsBeforeToast && (await noGhost(p)), JSON.stringify({ toastIn, toastOut }))

    // ---- ปุ่ม: hover / กด / คีย์บอร์ด ----
    const button = p.getByRole('button', { name: 'เพิ่มสมาชิก' }).first()
    const box = await button.boundingBox()
    const layoutBefore = await p.evaluate(() => [...document.querySelectorAll('main#main *')].slice(0, 60).map((el) => `${el.offsetTop},${el.offsetLeft},${el.offsetWidth},${el.offsetHeight}`).join('|'))
    await p.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await p.mouse.down()
    await p.waitForFunction(() => document.querySelector('.page-header .button')?.getAnimations().every((a) => a.playState === 'finished'))
    const pressed = await p.evaluate(() => {
      const el = document.querySelector('.page-header .button')
      const style = getComputedStyle(el)
      return { transform: style.transform, transition: style.transitionProperty, layout: [...document.querySelectorAll('main#main *')].slice(0, 60).map((x) => `${x.offsetTop},${x.offsetLeft},${x.offsetWidth},${x.offsetHeight}`).join('|') }
    })
    await p.mouse.move(2, 2)
    await p.mouse.up()
    check(`${tag}: กดปุ่มแล้วยุบลง 1px ด้วย transform โดยขนาดและตำแหน่งของส่วนอื่นในหน้าไม่เปลี่ยน`,
      pressed.transform === 'matrix(1, 0, 0, 1, 0, 1)' && pressed.layout === layoutBefore && pressed.transition.includes('background-color') && !pressed.transition.includes('all'), JSON.stringify({ transform: pressed.transform, transition: pressed.transition }))
    await p.locator('#member-search').focus()
    await p.keyboard.press('Shift+Tab')
    const ring = await p.evaluate(() => {
      const el = document.activeElement
      const style = getComputedStyle(el)
      return { text: el?.textContent?.trim(), visible: el?.matches(':focus-visible'), width: style.outlineWidth, style: style.outlineStyle }
    })
    check(`${tag}: ใช้คีย์บอร์ดเลื่อน focus ไปที่ปุ่มแล้วมีวงแหวน focus ชัดเจนทันที`, ring.visible && ring.style === 'solid' && parseFloat(ring.width) >= 2, JSON.stringify(ring))

    // ---- สลับธีม ----
    const result = await themeSwitch(p)
    const want = theme === 'dark' ? 'light' : 'dark'
    check(`${tag}: สลับธีมแล้วธีมใหม่แผ่ออกจากสวิตช์ภายใน 180–250 ms ทุกจุดบนจอเป็นธีมเก่าหรือใหม่เต็ม ๆ (ไม่ผสมสี จึงไม่มีช่วงที่ข้อความกลืนกับพื้น) และไม่มีกฎชั่วคราวค้างหลังจบ`,
      result.theme === want && revealOk(result) && !result.left && result.ms <= 1000, JSON.stringify(result))
    const knob = await p.evaluate(() => ({ checked: document.querySelector('.theme-switch').getAttribute('aria-checked'), stored: localStorage.getItem('mu-esport-staff:theme:v1') }))
    check(`${tag}: สวิตช์ธีมแสดงสถานะใหม่ และธีมถูกจำไว้เหมือนเดิม`, knob.checked === String(want === 'dark') && knob.stored === want)
    // ภาพกลางการสลับ (หยุดทุก transition ไว้ที่กึ่งกลาง)
    await p.evaluate(() => document.querySelector('.theme-switch').click())
    await p.waitForFunction(() => document.getAnimations().some((a) => a.effect?.pseudoElement === '::view-transition-new(root)'))
    await freezeAt(p, 110)
    await p.screenshot({ path: `${OUT}/theme-mid-${w}-${theme}.png` })
    await resume(p)
    await p.waitForFunction(() => !document.documentElement.classList.contains('theme-switching'))
    check(`${tag}: สลับธีมกลับแล้วได้สีเดิมครบ ไม่มีสีค้างจากการสลับ`,
      (await p.evaluate(() => getComputedStyle(document.body).backgroundColor)) === (theme === 'dark' ? 'rgb(9, 13, 22)' : 'rgb(244, 247, 251)'))

    // ---- กดสวิตช์ธีมซ้ำขณะที่อนิเมชันของรอบก่อนยังเล่นอยู่ (2 ครั้ง แล้ว 3 ครั้งสองรอบ: จบที่ธีมเดิมของหน้านี้) ----
    const rapid = []
    for (const presses of [2, 3, 3]) rapid.push({ presses, ...(await rapidThemeSwitch(p, presses)) })
    check(`${tag}: กดสวิตช์ธีมซ้ำกลางอนิเมชัน: ธีมสุดท้ายตรงกับการกดล่าสุด รอบเก่าที่จบไม่ล้างสถานะของรอบใหม่ (class และตำแหน่งวงอยู่ครบทุกเฟรม) และไม่มีอะไรค้างหลังจบ`,
      rapid.every((result) => rapidOk(result, result.presses)) && (await p.evaluate(() => document.documentElement.dataset.theme)) === theme, JSON.stringify(rapid))
    await p.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
    const usable = await p.locator('#member-name').waitFor().then(() => true, () => false)
    await p.keyboard.press('Escape')
    await p.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 0)
    check(`${tag}: หลังกดสวิตช์ซ้ำ ปุ่มในหน้ายังกดได้ตามปกติ และการกดปุ่มยังยุบด้วย transition เดิม`,
      usable && (await p.evaluate(() => getComputedStyle(document.querySelector('.page-header .button')).transitionProperty)).includes('transform'))

    // ---- ปฏิทิน: เลือกวันแล้วหน้าไม่เลื่อนเอง และไม่เล่นอนิเมชันเปลี่ยนหน้าซ้ำ ----
    await go('ปฏิทิน', '/calendar')
    if (mobile) await p.locator('.segmented button', { hasText: 'เดือน' }).click()
    await p.locator('.month-cell .month-day').first().waitFor()
    await settled(p, 'main#main')
    await p.evaluate(() => {
      document.querySelector('main#main').dataset.mark = 'same'
      window.scrollTo(0, 0)
    })
    const scrollBefore = await p.evaluate(() => window.scrollY)
    await p.locator('.month-cell:not(.is-selected) .month-day').nth(9).click()
    await p.locator('.month-cell.is-selected').waitFor()
    const after = await p.evaluate(() => ({ y: window.scrollY, mark: document.querySelector('main#main').dataset.mark, replay: document.querySelector('main#main').getAnimations().some((a) => a.animationName === 'page-enter' && a.playState === 'running') }))
    check(`${tag}: เลือกวันในปฏิทินแล้วหน้าไม่เลื่อนเอง หน้าเดิมไม่ถูกสร้างใหม่ และไม่เล่นอนิเมชันเปลี่ยนหน้าซ้ำ`, after.y === scrollBefore && after.mark === 'same' && !after.replay, JSON.stringify(after))
    check(`${tag}: ไม่มีส่วนใดล้นจอ`, await noOverflow(p))
    await p.screenshot({ path: `${OUT}/calendar-${w}-${theme}.png` })

    if (mobile) {
      await p.getByRole('button', { name: 'เปิดเมนู' }).click()
      const menu = await animationsOf(p, '.mobile-menu[open]')
      await p.keyboard.press('Escape')
      const closed = await p.evaluate(() => ({ open: document.querySelectorAll('.mobile-menu[open]').length, focus: document.activeElement?.getAttribute('aria-label') }))
      check(`${tag}: เมนูมือถือเลื่อนเข้า ปิดด้วย Esc แล้ว focus กลับไปที่ปุ่มเปิดเมนู`, menu?.some((a) => a.name === 'menu-in') && closed.open === 0 && closed.focus === 'เปิดเมนู' && (await noGhost(p)), JSON.stringify({ menu, closed }))
    }
    if (theme === 'light') await saveVideo(p, `backoffice-${w}`)
    else await p.context().close()
  }

  // ---- โหมดลดการเคลื่อนไหว ----
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const tag = `ลดการเคลื่อนไหว ${w}px`
    const p = await newPage(w, h, { reduced: true })
    await p.goto(`${DEMO}/members`)
    await p.locator('main#main h1').waitFor()
    const still = await p.evaluate(() => ({
      page: getComputedStyle(document.querySelector('main#main')).animationName,
      button: getComputedStyle(document.querySelector('.page-header .button')).transitionDuration,
    }))
    await p.getByRole('button', { name: 'เพิ่มสมาชิก' }).first().click()
    await p.locator('dialog.dialog[open]').waitFor()
    const dialogName = await p.evaluate(() => getComputedStyle(document.querySelector('dialog.dialog[open]')).animationName)
    await p.keyboard.press('Escape')
    await p.waitForFunction(() => document.querySelectorAll('dialog[open]').length === 0)
    const ghostCount = await ghosts(p)
    const switched = await p.evaluate(() => {
      document.querySelector('.theme-switch').click()
      const root = document.documentElement
      return { theme: root.dataset.theme, animating: root.classList.contains('theme-switching'), transition: document.getAnimations().some((a) => a.effect?.pseudoElement?.startsWith('::view-transition')), bg: getComputedStyle(document.body).backgroundColor }
    })
    // กดซ้ำสองครั้งติดกันในโหมดนี้: เปลี่ยนทันทีทุกครั้ง จบที่ธีมของการกดล่าสุด ไม่มีสถานะชั่วคราว
    const twice = await p.evaluate(() => {
      const button = document.querySelector('.theme-switch')
      const root = document.documentElement
      const seen = []
      for (let i = 0; i < 2; i++) {
        button.click()
        seen.push(root.dataset.theme)
      }
      return { seen: seen.join(','), animating: root.classList.contains('theme-switching') || root.style.getPropertyValue('--theme-x') !== '', transition: document.getAnimations().some((a) => a.effect?.pseudoElement?.startsWith('::view-transition')) }
    })
    await p.waitForFunction(() => document.querySelector('.theme-switch').getAttribute('aria-checked') === 'true')
    check(`${tag}: กดสวิตช์ธีมซ้ำติดกัน: เปลี่ยนทันทีทุกครั้ง จบที่ธีมของการกดล่าสุด และไม่มี class หรือตำแหน่งวงค้าง`,
      twice.seen === 'light,dark' && !twice.animating && !twice.transition && (await p.evaluate(() => localStorage.getItem('mu-esport-staff:theme:v1'))) === 'dark', JSON.stringify(twice))
    check(`${tag}: ไม่มีอนิเมชันเปลี่ยนหน้า กล่องโต้ตอบ เงาตอนปิด หรือ transition ของปุ่ม และธีมเปลี่ยนทันที แต่ทุกอย่างยังทำงานครบ`,
      still.page === 'none' && still.button.split(',').every((d) => parseFloat(d) === 0) && dialogName === 'none' && ghostCount === 0 &&
      switched.theme === 'dark' && !switched.animating && !switched.transition && switched.bg === 'rgb(9, 13, 22)' && (await focusText(p)) === 'เพิ่มสมาชิก', JSON.stringify({ still, dialogName, ghostCount, switched }))
    await p.context().close()
  }
  server.stop()
  server = null

  // ================= หน้าสมาชิก หน้าเข้าสู่ระบบ และจำนวนคำขอ (Worker + D1 local จริง) =================
  const LIVE = `http://localhost:${LIVE_PORT}`
  const actors = prepareLocalDatabase(
    STATE_DIR,
    [{ key: 'admin', email: 'muesport2567@gmail.com', role: 'admin', name: 'MU Esport' }],
    [
      { key: 'member', name: 'ณิชา ตัวอย่างสุข', nickname: 'มายด์', studentId: '0065002', password: 'Ready-Member-4410', sessions: 3 },
      { key: 'other', name: 'กฤตเมธ ตัวอย่างเกม', nickname: 'เมธ', studentId: '6500004' },
    ],
  )
  server = startServer(['--port', String(LIVE_PORT)], { MU_STATE_DIR: STATE_DIR })
  await waitFor(`${LIVE}/api/session`, server)
  console.log(`โหมดใช้งานจริง (D1 local) พร้อมที่ ${LIVE}`)

  // เส้นทางเดียวกันสองรอบ: มีอนิเมชัน กับลดการเคลื่อนไหว คำขอข้อมูลต้องเท่ากัน (อนิเมชันไม่ทำให้โหลดซ้ำ)
  const apiCalls = async (reduced, cookie, steps) => {
    const p = await newPage(1440, 900, { reduced, cookie, base: LIVE })
    // หลายหน้าโหลดข้อมูลใหม่เองเมื่อหน้าต่างได้ focus หรือกลับมาแสดง (พฤติกรรมเดิม) ซึ่งขึ้นกับหน้าต่างทดสอบ ไม่เกี่ยวกับอนิเมชัน:
    // ปิดสัญญาณสองอย่างนี้ทั้งสองรอบ เพื่อให้จำนวนคำขอขึ้นกับการเปลี่ยนหน้าอย่างเดียว
    await p.addInitScript(() => {
      window.addEventListener('focus', (event) => event.stopImmediatePropagation(), true)
      document.addEventListener('visibilitychange', (event) => event.stopImmediatePropagation(), true)
    })
    const calls = []
    p.on('request', (r) => {
      const url = new URL(r.url())
      if (url.pathname.startsWith('/api/')) calls.push(`${new URL(p.url()).pathname} → ${r.method()} ${url.pathname}`)
    })
    await steps(p)
    await p.waitForLoadState('networkidle')
    await p.context().close()
    return [...new Set(calls)].sort().join('\n')
  }
  const staffTour = async (p) => {
    await p.goto(`${LIVE}/members`)
    await p.locator('.members-table tbody tr').first().waitFor()
    await p.waitForLoadState('networkidle')
    for (const [label, path] of [['ปฏิทิน', '/calendar'], ['สมาชิก', '/members'], ['ภาพรวม', '/']]) {
      await p.locator('.sidebar .nav-link', { hasText: label }).click()
      await p.waitForURL(`${LIVE}${path}`)
      await p.locator('main#main h1').waitFor()
      await p.waitForLoadState('networkidle')
    }
  }
  const memberTour = async (p) => {
    await p.goto(`${LIVE}/member`)
    await p.locator('main#main h1').waitFor()
    await p.waitForLoadState('networkidle')
    for (const [label, path] of [['กิจกรรม', '/member/activities'], ['บัญชีของฉัน', '/member/account'], ['หน้าแรก', '/member']]) {
      await p.locator('.m-nav .m-nav-link', { hasText: label }).click()
      await p.waitForURL(`${LIVE}${path}`)
      await p.locator('main#main h1').waitFor()
      await p.waitForLoadState('networkidle')
    }
  }
  const staffMoving = await apiCalls(false, actors.admin.tokens[0], staffTour)
  const staffStill = await apiCalls(true, actors.admin.tokens[0], staffTour)
  check('[D1 local] หลังบ้าน: ทุกหน้าในเส้นทางเรียก API ชุดเดียวกันทั้งแบบมีอนิเมชันและแบบไม่มี (อนิเมชันไม่ทำให้โหลดข้อมูลเพิ่ม)', staffMoving === staffStill && staffMoving.length > 0, staffMoving === staffStill ? `${staffMoving.split('\n').length} คู่หน้า/API` : `--- มีอนิเมชัน\n${staffMoving}\n--- ลดการเคลื่อนไหว\n${staffStill}`)
  const memberMoving = await apiCalls(false, actors.member.tokens[0], memberTour)
  const memberStill = await apiCalls(true, actors.member.tokens[1], memberTour)
  check('[D1 local] หน้าสมาชิก: ทุกหน้าในเส้นทางเรียก API ชุดเดียวกันทั้งแบบมีอนิเมชันและแบบไม่มี (อนิเมชันไม่ทำให้โหลดข้อมูลเพิ่ม)', memberMoving === memberStill && memberMoving.length > 0, memberMoving === memberStill ? `${memberMoving.split('\n').length} คู่หน้า/API` : `--- มีอนิเมชัน\n${memberMoving}\n--- ลดการเคลื่อนไหว\n${memberStill}`)

  for (const [w, h, theme] of [[1440, 900, 'light'], [390, 844, 'dark']]) {
    const tag = `[D1 local] หน้าสมาชิก ${w}px ธีม${theme === 'dark' ? 'มืด' : 'สว่าง'}`
    const p = await newPage(w, h, { theme, cookie: actors.member.tokens[2], base: LIVE, video: true })
    await p.goto(`${LIVE}/member`)
    await p.locator('main#main h1').waitFor()
    await settled(p, 'main#main')
    await p.locator(w < 768 ? '.m-tabbar .m-tab' : '.m-nav .m-nav-link', { hasText: 'กิจกรรม' }).click()
    await p.waitForURL(`${LIVE}/member/activities`)
    const entering = await animationsOf(p, 'main#main')
    check(`${tag}: เปลี่ยนหน้ามีอนิเมชันเข้า 160–220 ms และหัวข้อของหน้าใหม่อยู่ในหน้าทันที`,
      entering?.some((a) => a.name === 'page-enter' && a.ms >= 160 && a.ms <= 220) && (await p.locator('main#main h1').count()) === 1, JSON.stringify(entering))
    await freezeAt(p, 70)
    await p.screenshot({ path: `${OUT}/member-page-mid-${w}-${theme}.png` })
    await resume(p)
    await settled(p, 'main#main')
    const result = await themeSwitch(p)
    check(`${tag}: สลับธีมแล้วธีมใหม่แผ่ออกจากสวิตช์ภายใน 180–250 ms โดยไม่ผสมสี และไม่มีกฎชั่วคราวค้างหลังจบ`, revealOk(result) && !result.left, JSON.stringify(result))
    // สมาชิกเปิดหน้าหลังบ้าน: ถูกพากลับ ไม่มีข้อมูลหลังบ้านแสดงแม้ชั่วขณะที่อนิเมชันเล่น
    const leaked = []
    p.on('response', (r) => new URL(r.url()).pathname === '/api/members' && leaked.push(r.status()))
    await p.goto(`${LIVE}/members`)
    await p.waitForURL((url) => url.pathname.startsWith('/member') && url.pathname !== '/members')
    check(`${tag}: สมาชิกเปิดหน้าหลังบ้านถูกพากลับหน้าสมาชิก ไม่มีตารางหรือข้อมูลหลังบ้านปรากฏ`, (await p.locator('.members-table, .sidebar').count()) === 0 && leaked.every((status) => status !== 200), JSON.stringify(leaked))
    check(`${tag}: ไม่มีส่วนใดล้นจอ`, await noOverflow(p))
    await saveVideo(p, `member-${w}-${theme}`)
  }

  {
    const p = await newPage(390, 844, {})
    await p.goto(`${LIVE}/login`)
    await p.locator('#login-username').waitFor()
    const entering = await animationsOf(p, '.login-main')
    const usable = await p.locator('#login-username').isEditable()
    await freezeAt(p, 70)
    await p.screenshot({ path: `${OUT}/login-mid-390.png` })
    await resume(p)
    check('[D1 local] หน้าเข้าสู่ระบบ 390px: จางเข้าเบา ๆ และช่องกรอกใช้ได้ทันที', entering?.some((a) => a.name === 'page-enter') && usable, JSON.stringify(entering))
    await p.context().close()
  }

  check('ไม่มีข้อผิดพลาดใน console ของเบราว์เซอร์ที่ไม่ได้คาดไว้', consoleErrors.length === 0, consoleErrors.slice(0, 5).join(' | '))
  console.log(`\nผลตรวจอนิเมชัน: ผ่าน ${passed} ข้อ ไม่ผ่าน ${failed} ข้อ`)
  exitCode = failed === 0 ? 0 : 1
} catch (error) {
  console.error('ชุดตรวจหยุดก่อนจบ:', error)
  console.log(`\nผลตรวจ (ไม่ครบ): ผ่าน ${passed} ข้อ ไม่ผ่าน ${failed} ข้อ ก่อนหยุด`)
} finally {
  await browser?.close().catch(() => undefined)
  server?.stop()
}
process.exit(exitCode)
