import { AppError } from '../data/errors'

/**
 * เปิดหน้าต่างเลือกไฟล์ของ Google (Google Picker) ให้ผู้ดูแลเลือกไฟล์เดิมในบัญชีชมรม เป็นเครื่องมือตั้งค่าแหล่งข้อมูลของทีมงานเท่านั้น
 * (หน้าไฟล์ชมรมและตัวอย่างไฟล์ไม่ใช้ Picker และไม่เปิดหน้าต่างของ Google)
 * - ใช้หน้าต่างของ Google เอง: เว็บไซต์ไม่เห็นรายการไฟล์ใน Drive เห็นเฉพาะไฟล์ที่ผู้ดูแลกดเลือก
 * - ไฟล์ที่เลือกจะเปิดสิทธิ์ drive.file ให้แอปนี้สำหรับบัญชีที่เลือก (ต้องเป็นบัญชีชมรม) server ตรวจซ้ำด้วยสิทธิ์ของตัวเองก่อนผูกเสมอ
 * - access token ที่ได้ในเบราว์เซอร์ใช้กับ Picker เท่านั้น อยู่ในหน่วยความจำ ไม่ถูกเก็บและไม่ส่งไป server
 *
 * ลำดับการทำงานที่ควบคุมไว้
 * 1. โหลดสคริปต์ของ Google ล่วงหน้า (preloadPicker) ตั้งแต่เปิดหน้าตั้งค่า เพื่อให้ตอนกดปุ่ม คำขอสิทธิ์เกิดทันทีในจังหวะเดียวกับการกด
 *    เบราว์เซอร์จึงถือว่าหน้าต่างขออนุญาตมาจากการกดของผู้ใช้ ไม่ถูกบล็อกเป็น popup
 * 2. มีการเลือกไฟล์ได้ทีละครั้ง: กดซ้ำระหว่างที่ยังเปิดอยู่ได้ผลของครั้งเดิม ไม่เปิดหน้าต่างซ้อน
 * 3. token ที่ได้ใช้ซ้ำจนใกล้หมดอายุ จึงไม่เปิดหน้าต่างขออนุญาตทุกครั้งที่เลือกไฟล์
 * 4. ปิด ยกเลิก ล้มเหลว หรือออกจากหน้า: หน้าต่างเลือกไฟล์ถูกรื้อออก และ focus กลับไปที่ปุ่มที่เปิด
 */
export interface PickerConfig {
  apiKey: string
  appId: string
  clientId: string
}

export type PickKind = 'sheets' | 'forms' | 'docs'
export interface PickedFile {
  id: string
  name: string
}

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const MIME: Record<PickKind, string> = {
  sheets: 'application/vnd.google-apps.spreadsheet',
  forms: 'application/vnd.google-apps.form',
  docs: 'application/vnd.google-apps.document',
}
const SCRIPTS = ['https://apis.google.com/js/api.js', 'https://accounts.google.com/gsi/client']
const LOAD_TIMEOUT_MS = 15_000

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Global = any
const win = () => window as unknown as { gapi?: Global; google?: Global }

const unavailable = () =>
  new AppError('picker_unavailable', 0, 'โหลดหน้าต่างเลือกไฟล์ของ Google ไม่ได้ ตรวจการเชื่อมต่ออินเทอร์เน็ตหรือส่วนขยายที่บล็อกสคริปต์ของ Google แล้วลองอีกครั้ง')

const scripts = new Map<string, Promise<void>>()
function loadScript(src: string): Promise<void> {
  let pending = scripts.get(src)
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const tag = document.createElement('script')
      tag.src = src
      tag.async = true
      const fail = () => {
        // โหลดไม่สำเร็จ: เอาแท็กออกและลืมผลนี้ เพื่อให้การกดครั้งถัดไปโหลดใหม่ได้
        scripts.delete(src)
        tag.remove()
        reject(unavailable())
      }
      const timer = setTimeout(fail, LOAD_TIMEOUT_MS)
      tag.onload = () => {
        clearTimeout(timer)
        resolve()
      }
      tag.onerror = () => {
        clearTimeout(timer)
        fail()
      }
      document.head.appendChild(tag)
    })
    scripts.set(src, pending)
  }
  return pending
}

let ready: Promise<void> | null = null
let isReady = false

/** โหลดสคริปต์และส่วนประกอบของ Picker ให้พร้อมก่อนผู้ใช้กดปุ่ม เรียกซ้ำได้ และลองใหม่ได้เมื่อครั้งก่อนล้มเหลว */
export function preloadPicker(): Promise<void> {
  if (!ready) {
    ready = Promise.all(SCRIPTS.map(loadScript))
      .then(
        () =>
          new Promise<void>((resolve, reject) => {
            const gapi = win().gapi
            if (!gapi?.load || !win().google?.accounts?.oauth2) return reject(unavailable())
            gapi.load('picker', { callback: resolve, onerror: () => reject(unavailable()), timeout: LOAD_TIMEOUT_MS, ontimeout: () => reject(unavailable()) })
          }),
      )
      .then(() => {
        isReady = true
      })
      .catch((error: unknown) => {
        ready = null
        throw error
      })
  }
  return ready
}

interface Token {
  value: string
  clientId: string
  expiresAt: number
}
let cachedToken: Token | null = null

function requestToken(config: PickerConfig, loginHint: string): Promise<string> {
  if (cachedToken && cachedToken.clientId === config.clientId && cachedToken.expiresAt > Date.now()) return Promise.resolve(cachedToken.value)
  return new Promise((resolve, reject) => {
    const client = win().google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: DRIVE_FILE_SCOPE,
      hint: loginHint,
      callback: (response: { access_token?: string; expires_in?: number | string; error?: string }) => {
        if (!response.access_token) return reject(new AppError('picker_denied', 0, 'ไม่ได้รับอนุญาตจาก Google จึงยังไม่ได้เลือกไฟล์'))
        const seconds = Number(response.expires_in)
        // ใช้ซ้ำได้จนเกือบหมดอายุ (เก็บในหน่วยความจำของหน้านี้เท่านั้น)
        cachedToken = { value: response.access_token, clientId: config.clientId, expiresAt: Date.now() + (Number.isFinite(seconds) && seconds > 120 ? (seconds - 60) * 1000 : 0) }
        resolve(response.access_token)
      },
      error_callback: (error: { type?: string }) =>
        reject(
          error?.type === 'popup_failed_to_open'
            ? new AppError('picker_popup_blocked', 0, 'เบราว์เซอร์บล็อกหน้าต่างขออนุญาตของ Google ยังไม่ได้เลือกไฟล์ อนุญาต popup ของเว็บไซต์นี้แล้วกดปุ่มอีกครั้ง')
            : new AppError('picker_cancelled', 0, 'หน้าต่างขออนุญาตของ Google ถูกปิดก่อนเสร็จ ยังไม่ได้เลือกไฟล์ กดปุ่มอีกครั้งเมื่อพร้อม'),
        ),
    })
    client.requestAccessToken({ prompt: '' })
  })
}

interface Active {
  promise: Promise<PickedFile | null>
  /** ปิดหน้าต่างเลือกไฟล์โดยไม่เลือก */
  cancel(): void
}
let active: Active | null = null

/** มีหน้าต่างเลือกไฟล์เปิดอยู่: ปิดโดยไม่เลือกไฟล์ (ใช้เมื่อผู้ใช้กดยกเลิกจากหน้าเว็บ หรือออกจากหน้าตั้งค่า) */
export function cancelPick(): void {
  active?.cancel()
}

/**
 * คืนไฟล์ที่ผู้ดูแลเลือก หรือ null เมื่อปิดหน้าต่างโดยไม่เลือก
 * ต้องเรียกจากการกดปุ่มโดยตรง และควรเรียก preloadPicker ไว้ก่อน (ถ้ายังโหลดไม่เสร็จจะรอโหลดก่อน ซึ่งเบราว์เซอร์อาจบล็อกหน้าต่างขออนุญาต)
 */
export function pickFile(config: PickerConfig, kind: PickKind, loginHint: string): Promise<PickedFile | null> {
  // กดซ้ำระหว่างที่ยังเปิดอยู่: ใช้ผลของครั้งเดิม ไม่เปิดซ้อน
  if (active) return active.promise
  const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
  let instance: Global = null
  let settle: ((file: PickedFile | null) => void) | null = null
  let cancelled = false

  const dispose = () => {
    try {
      instance?.setVisible(false)
      instance?.dispose?.()
    } catch {
      // หน้าต่างถูก Google ปิดไปแล้ว
    }
    instance = null
  }

  const run = async (): Promise<PickedFile | null> => {
    // พร้อมอยู่แล้ว: ไม่มี await ก่อนขอ token คำขอจึงอยู่ในจังหวะเดียวกับการกดปุ่ม
    if (!isReady) await preloadPicker()
    const token = await requestToken(config, loginHint)
    if (cancelled) return null
    const picker = win().google.picker
    return new Promise<PickedFile | null>((resolve) => {
      settle = resolve
      const view = new picker.DocsView().setMimeTypes(MIME[kind]).setIncludeFolders(false).setSelectFolderEnabled(false).setMode(picker.DocsViewMode.LIST)
      instance = new picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(token)
        .setDeveloperKey(config.apiKey)
        .setAppId(config.appId)
        .setLocale('th')
        .setCallback((data: { action: string; docs?: { id: string; name: string }[] }) => {
          if (data.action === picker.Action.PICKED && data.docs?.[0]) resolve({ id: data.docs[0].id, name: data.docs[0].name })
          else if (data.action === picker.Action.CANCEL) resolve(null)
        })
        .build()
      instance.setVisible(true)
    })
  }

  const promise = run().finally(() => {
    dispose()
    active = null
    // หน้าต่างของ Google ถูกวางทับหน้าเว็บ: คืน focus ไปที่ปุ่มที่เปิด
    if (opener?.isConnected) opener.focus()
  })
  active = {
    promise,
    cancel: () => {
      cancelled = true
      settle?.(null)
    },
  }
  return promise
}
