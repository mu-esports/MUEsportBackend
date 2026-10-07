/** ข้อผิดพลาดที่ตอบกลับผู้ใช้ได้: มีรหัสสำหรับโปรแกรม และข้อความไทยสำหรับแสดงผล */
export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public extra: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  // ข้อมูลหลังบ้านห้ามเก็บใน cache ใด ๆ
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  const all = new Headers(BASE_HEADERS)
  new Headers(headers).forEach((value, key) => all.append(key, value))
  return new Response(JSON.stringify(data), { status, headers: all })
}

export function errorResponse(error: HttpError): Response {
  const retryAfter = error.extra.retryAfterSeconds
  const headers: Record<string, string> = typeof retryAfter === 'number' && retryAfter > 0 ? { 'Retry-After': String(Math.ceil(retryAfter)) } : {}
  return json({ error: error.code, message: error.message, ...error.extra }, error.status, headers)
}

export function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store' })
  for (const cookie of cookies) headers.append('Set-Cookie', cookie)
  return new Response(null, { status: 302, headers })
}

const MAX_BODY_BYTES = 256 * 1024

/** อ่าน JSON object จาก body โดยจำกัดขนาด */
export async function readJson(request: Request, maxBytes = MAX_BODY_BYTES): Promise<Record<string, unknown>> {
  const type = request.headers.get('Content-Type') ?? ''
  if (!type.toLowerCase().startsWith('application/json')) {
    throw new HttpError(415, 'unsupported_media_type', 'รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง')
  }
  const tooLarge = new HttpError(413, 'payload_too_large', 'ข้อมูลที่ส่งมามีขนาดใหญ่เกินกำหนด')
  const declared = Number(request.headers.get('Content-Length') ?? '0')
  if (declared > maxBytes) throw tooLarge
  const buffer = await request.arrayBuffer()
  if (buffer.byteLength > maxBytes) throw tooLarge
  let parsed: unknown
  try {
    parsed = JSON.parse(new TextDecoder().decode(buffer))
  } catch {
    throw new HttpError(400, 'invalid_json', 'รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง')
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new HttpError(400, 'invalid_json', 'รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง')
  }
  return parsed as Record<string, unknown>
}

export function parseCookies(request: Request): Record<string, string> {
  const out: Record<string, string> = {}
  for (const part of (request.headers.get('Cookie') ?? '').split(';')) {
    const index = part.indexOf('=')
    if (index < 0) continue
    out[part.slice(0, index).trim()] = part.slice(index + 1).trim()
  }
  return out
}

interface CookieOptions {
  maxAge: number
  path?: string
  secure: boolean
}

/** cookie ของระบบเป็น HttpOnly + SameSite=Lax เสมอ และ Secure เมื่อเป็น HTTPS */
export function cookie(name: string, value: string, { maxAge, path = '/', secure }: CookieOptions): string {
  return [
    `${name}=${value}`,
    `Path=${path}`,
    `Max-Age=${maxAge}`,
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
  ].join('; ')
}

export const isHttps = (url: URL) => url.protocol === 'https:'
