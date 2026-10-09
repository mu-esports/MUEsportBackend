import { AppError } from '../data/errors'

// CSRF token ผูกกับ session ได้มาจาก /api/session และส่งกลับทุกคำสั่งที่เปลี่ยนข้อมูล
let csrfToken: string | null = null
let unauthorizedHandler: (() => void) | null = null

export const setCsrfToken = (token: string | null) => {
  csrfToken = token
}
export const onUnauthorized = (handler: (() => void) | null) => {
  unauthorizedHandler = handler
}
/** ใช้กับคำขอที่ไม่ได้ผ่าน api() (เช่น เนื้อหาไฟล์) เมื่อ server ตอบว่าเซสชันใช้ไม่ได้แล้ว */
export const notifyUnauthorized = () => unauthorizedHandler?.()

interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE'
  body?: unknown
  idempotencyKey?: string
  /** ไม่แจ้งสถานะเซสชันหมดอายุเมื่อได้ 401 (ผู้เรียกจัดการเอง เช่น ตอนออกจากระบบ) */
  quiet401?: boolean
  /** ส่งไฟล์เป็นเนื้อหาของคำขอโดยตรง (เช่น รูปโปรไฟล์) ใช้แทน body */
  file?: Blob
  /** ยกเลิกคำขอที่ค้างอยู่ (เช่น ผู้ใช้ปิดกล่องระหว่างส่ง) */
  signal?: AbortSignal
}

/** เรียก API ของระบบกลาง คืนข้อมูลเมื่อ server ยืนยันสำเร็จเท่านั้น */
export async function api<T>(path: string, { method = 'GET', body, idempotencyKey, quiet401, file, signal }: Options = {}): Promise<T> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (file) headers['Content-Type'] = file.type || 'application/octet-stream'
  else if (body !== undefined) headers['Content-Type'] = 'application/json'
  if (method !== 'GET' && csrfToken) headers['X-CSRF-Token'] = csrfToken
  if (idempotencyKey) headers['Idempotency-Key'] = idempotencyKey

  let response: Response
  try {
    response = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      cache: 'no-store',
      body: file ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal,
    })
  } catch {
    // ผู้เรียกยกเลิกเอง: ไม่ใช่ปัญหาการเชื่อมต่อ
    if (signal?.aborted) throw new AppError('aborted', 0, 'ยกเลิกคำขอแล้ว')
    throw new AppError('network', 0, 'เชื่อมต่อระบบกลางไม่ได้ ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง')
  }

  const isJson = (response.headers.get('Content-Type') ?? '').includes('application/json')
  const data = isJson ? ((await response.json().catch(() => null)) as Record<string, unknown> | null) : null
  if (!response.ok || !data) {
    if (response.status === 401 && path !== '/api/session' && !quiet401) unauthorizedHandler?.()
    throw new AppError(
      typeof data?.error === 'string' ? data.error : `http_${response.status}`,
      response.status,
      typeof data?.message === 'string' ? data.message : 'ระบบกลางตอบกลับผิดพลาด ลองอีกครั้งในอีกสักครู่',
      data ?? {},
    )
  }
  return data as T
}

/** key กันการสร้างซ้ำ: คำขอเดิม (retry) ใช้ key เดิม ข้อมูลเปลี่ยนเมื่อไรจึงออก key ใหม่ */
export function createKeyTracker() {
  let last = { payload: '', key: '' }
  const keyFor = (payload: unknown): string => {
    const serialized = JSON.stringify(payload)
    if (last.payload !== serialized) last = { payload: serialized, key: crypto.randomUUID() }
    return last.key
  }
  /** เริ่มงานใหม่โดยตั้งใจ: คำขอถัดไปใช้ key ใหม่แม้ข้อมูลเหมือนเดิม */
  keyFor.reset = () => {
    last = { payload: '', key: '' }
  }
  return keyFor
}
