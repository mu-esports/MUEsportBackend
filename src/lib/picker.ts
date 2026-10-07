import { AppError } from '../data/errors'

/**
 * เปิดหน้าต่างเลือกไฟล์ของ Google (Google Picker) ให้ผู้ดูแลเลือกไฟล์เดิมในบัญชีชมรม
 * - ใช้หน้าต่างของ Google เอง: เว็บไซต์ไม่เห็นรายการไฟล์ใน Drive เห็นเฉพาะไฟล์ที่ผู้ดูแลกดเลือก
 * - ไฟล์ที่เลือกจะเปิดสิทธิ์ drive.file ให้แอปนี้สำหรับบัญชีที่เลือก (ต้องเป็นบัญชีชมรม) server ตรวจซ้ำด้วยสิทธิ์ของตัวเองก่อนผูกเสมอ
 * - access token ที่ได้ในเบราว์เซอร์ใช้กับ Picker เท่านั้น อยู่ในหน่วยความจำ ไม่ถูกเก็บและไม่ส่งไป server
 */
export interface PickerConfig {
  apiKey: string
  appId: string
  clientId: string
}

export type PickKind = 'sheets' | 'forms' | 'docs'

const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
const MIME: Record<PickKind, string> = {
  sheets: 'application/vnd.google-apps.spreadsheet',
  forms: 'application/vnd.google-apps.form',
  docs: 'application/vnd.google-apps.document',
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Global = any
const win = () => window as unknown as { gapi?: Global; google?: Global }

const scripts = new Map<string, Promise<void>>()
function loadScript(src: string): Promise<void> {
  let pending = scripts.get(src)
  if (!pending) {
    pending = new Promise<void>((resolve, reject) => {
      const tag = document.createElement('script')
      tag.src = src
      tag.async = true
      tag.onload = () => resolve()
      tag.onerror = () => {
        scripts.delete(src)
        reject(new AppError('picker_unavailable', 0, 'โหลดหน้าต่างเลือกไฟล์ของ Google ไม่ได้ ตรวจการเชื่อมต่ออินเทอร์เน็ตหรือส่วนขยายที่บล็อกสคริปต์ของ Google แล้วลองอีกครั้ง'))
      }
      document.head.appendChild(tag)
    })
    scripts.set(src, pending)
  }
  return pending
}

function requestToken(config: PickerConfig, loginHint: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = win().google.accounts.oauth2.initTokenClient({
      client_id: config.clientId,
      scope: DRIVE_FILE_SCOPE,
      hint: loginHint,
      callback: (response: { access_token?: string; error?: string }) => {
        if (response.access_token) resolve(response.access_token)
        else reject(new AppError('picker_denied', 0, 'ไม่ได้รับอนุญาตจาก Google จึงยังไม่ได้เลือกไฟล์'))
      },
      error_callback: () => reject(new AppError('picker_cancelled', 0, 'หน้าต่างขออนุญาตของ Google ถูกปิดหรือถูกบล็อก ยังไม่ได้เลือกไฟล์ (ถ้าเบราว์เซอร์บล็อก popup ให้อนุญาตสำหรับเว็บไซต์นี้)')),
    })
    client.requestAccessToken({ prompt: '' })
  })
}

/** คืนไฟล์ที่ผู้ดูแลเลือก หรือ null เมื่อปิดหน้าต่างโดยไม่เลือก */
export async function pickFile(config: PickerConfig, kind: PickKind, loginHint: string): Promise<{ id: string; name: string } | null> {
  await Promise.all([loadScript('https://apis.google.com/js/api.js'), loadScript('https://accounts.google.com/gsi/client')])
  await new Promise<void>((resolve, reject) =>
    win().gapi.load('picker', { callback: resolve, onerror: () => reject(new AppError('picker_unavailable', 0, 'โหลดหน้าต่างเลือกไฟล์ของ Google ไม่ได้ ลองอีกครั้ง')) }),
  )
  const token = await requestToken(config, loginHint)
  const picker = win().google.picker
  return new Promise((resolve) => {
    const view = new picker.DocsView().setMimeTypes(MIME[kind]).setIncludeFolders(false).setSelectFolderEnabled(false).setMode(picker.DocsViewMode.LIST)
    new picker.PickerBuilder()
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
      .setVisible(true)
  })
}
