import { nowIso } from './env'
import type { Ctx } from './env'
import { HttpError, json } from './http'
import { audit, requireMember, requireMutation, requireUser } from './session'

/**
 * รูปโปรไฟล์ของคนในทะเบียนสมาชิก (ใช้ร่วมกันทั้งหน้าสมาชิก หน้านักกีฬา และบัญชีของสมาชิกเอง) คนละหนึ่งรูป
 * - เบราว์เซอร์ย่อและตัดรูปให้ไม่เกิน 512×512 และไม่เกิน 256 KiB ก่อนส่ง server ตรวจซ้ำจากเนื้อไฟล์จริงทุกข้อ ไม่เชื่อชื่อไฟล์หรือชนิดที่เบราว์เซอร์แจ้ง
 * - server ไม่แปลงหรือถอดรหัสภาพ (ไม่ใช้ CPU หนัก): อ่านเฉพาะลายเซ็นของไฟล์และขนาดภาพจากส่วนหัว
 * - เก็บในตาราง member_photos ของ D1 แยกจากทะเบียน รายชื่อสมาชิกอ่านเฉพาะรุ่นของรูป (version) ไม่อ่านตัวรูป
 * - อ่านรูปได้เฉพาะ session ที่มีสิทธิ์: ทีมงานอ่านได้ทุกคนในทะเบียน สมาชิกอ่านได้เฉพาะรูปของตัวเอง ไม่มี URL สาธารณะ
 */
export const MAX_PHOTO_BYTES = 256 * 1024
export const MAX_PHOTO_SIDE = 512

type PhotoType = 'image/jpeg' | 'image/png' | 'image/webp'
export interface PhotoInfo {
  type: PhotoType
  width: number
  height: number
}

const ascii = (bytes: Uint8Array, offset: number, text: string) => {
  if (offset + text.length > bytes.length) return false
  for (let i = 0; i < text.length; i++) if (bytes[offset + i] !== text.charCodeAt(i)) return false
  return true
}
const u16be = (b: Uint8Array, o: number) => (b[o] << 8) | b[o + 1]
const u16le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8)
const u24le = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8) | (b[o + 2] << 16)
const u32be = (b: Uint8Array, o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0

function png(bytes: Uint8Array): PhotoInfo | null {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]
  if (bytes.length < 33 || signature.some((value, index) => bytes[index] !== value)) return null
  // chunk แรกต้องเป็น IHDR ยาว 13 ไบต์: กว้าง สูง อยู่ถัดจากชื่อ chunk
  if (u32be(bytes, 8) !== 13 || !ascii(bytes, 12, 'IHDR')) return null
  return { type: 'image/png', width: u32be(bytes, 16), height: u32be(bytes, 20) }
}

function jpeg(bytes: Uint8Array): PhotoInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null
  let offset = 2
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) return null
    const marker = bytes[offset + 1]
    // ไบต์เติม 0xFF ก่อน marker
    if (marker === 0xff) {
      offset++
      continue
    }
    // marker ที่ไม่มีความยาวตามหลัง
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      offset += 2
      continue
    }
    // เริ่มข้อมูลภาพหรือจบไฟล์ก่อนพบขนาดภาพ: ไม่ใช่ JPEG ที่ใช้ได้
    if (marker === 0xda || marker === 0xd9) return null
    const length = u16be(bytes, offset + 2)
    if (length < 2) return null
    // SOF0–SOF15 ยกเว้น DHT (C4), JPG (C8) และ DAC (CC): มีความสูงและความกว้างของภาพ
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (offset + 9 > bytes.length) return null
      return { type: 'image/jpeg', height: u16be(bytes, offset + 5), width: u16be(bytes, offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

function webp(bytes: Uint8Array): PhotoInfo | null {
  if (bytes.length < 30 || !ascii(bytes, 0, 'RIFF') || !ascii(bytes, 8, 'WEBP')) return null
  if (ascii(bytes, 12, 'VP8 ')) {
    // lossy: frame tag 3 ไบต์ ตามด้วย start code 9D 01 2A แล้วกว้าง/สูง 14 บิต
    if (bytes[23] !== 0x9d || bytes[24] !== 0x01 || bytes[25] !== 0x2a) return null
    return { type: 'image/webp', width: u16le(bytes, 26) & 0x3fff, height: u16le(bytes, 28) & 0x3fff }
  }
  if (ascii(bytes, 12, 'VP8L')) {
    if (bytes[20] !== 0x2f) return null
    const bits = (bytes[21] | (bytes[22] << 8) | (bytes[23] << 16) | (bytes[24] << 24)) >>> 0
    return { type: 'image/webp', width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 }
  }
  if (ascii(bytes, 12, 'VP8X')) {
    // บิต 0x02 = ภาพเคลื่อนไหว: รูปโปรไฟล์รับเฉพาะภาพนิ่ง
    if (bytes[20] & 0x02) return null
    return { type: 'image/webp', width: u24le(bytes, 24) + 1, height: u24le(bytes, 27) + 1 }
  }
  return null
}

/** ชนิดจริงและขนาดภาพจากเนื้อไฟล์ (null = ไม่ใช่ JPEG/PNG/WebP ภาพนิ่งที่อ่านส่วนหัวได้) ไฟล์ SVG, HTML หรือไฟล์อื่นที่ตั้งชื่อเป็นรูปจึงไม่ผ่าน */
export function inspectImage(bytes: Uint8Array): PhotoInfo | null {
  const info = png(bytes) ?? jpeg(bytes) ?? webp(bytes)
  if (!info || info.width < 1 || info.height < 1) return null
  return info
}

const ALLOWED_DECLARED = ['image/jpeg', 'image/png', 'image/webp', 'application/octet-stream']

const notFound = () => new HttpError(404, 'not_found', 'ไม่พบสมาชิกนี้ อาจถูกลบหรือลิงก์ไม่ถูกต้อง')
const tooLarge = () => new HttpError(413, 'photo_too_large', `ไฟล์รูปต้องไม่เกิน ${MAX_PHOTO_BYTES / 1024} KB ยังไม่ได้บันทึกรูป`)

const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')

/** จำกัดระหว่างอ่านด้วย: คำขอแบบ chunked อาจไม่มี Content-Length และต้องไม่ถูกโหลดเต็มก่อนตรวจขนาด */
async function readPhoto(request: Request): Promise<Uint8Array> {
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > MAX_PHOTO_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw tooLarge()
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const bytes = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
  return bytes
}

/** PUT /api/members/:id/photo — ทีมงานตั้งหรือเปลี่ยนรูปของคนในทะเบียน เนื้อหาคำขอคือไฟล์รูปโดยตรง รูปเดิมถูกแทนเมื่อบันทึกสำเร็จเท่านั้น */
async function upload(ctx: Ctx, memberId: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const declared = (ctx.request.headers.get('Content-Type') ?? '').split(';')[0].trim().toLowerCase()
  if (!ALLOWED_DECLARED.includes(declared)) throw new HttpError(415, 'unsupported_image', 'รูปต้องเป็นไฟล์ JPEG, PNG หรือ WebP ยังไม่ได้บันทึกรูป')
  if (Number(ctx.request.headers.get('Content-Length') ?? '0') > MAX_PHOTO_BYTES) throw tooLarge()
  const bytes = await readPhoto(ctx.request)
  // ตัดสินจากเนื้อไฟล์จริง ไม่ใช่ชนิดที่เบราว์เซอร์แจ้งหรือชื่อไฟล์
  const info = inspectImage(bytes)
  if (!info) throw new HttpError(415, 'unsupported_image', 'ไฟล์นี้ไม่ใช่รูป JPEG, PNG หรือ WebP ที่ใช้ได้ ยังไม่ได้บันทึกรูป')
  if (info.width > MAX_PHOTO_SIDE || info.height > MAX_PHOTO_SIDE) {
    throw new HttpError(422, 'photo_dimensions', `รูปต้องมีขนาดไม่เกิน ${MAX_PHOTO_SIDE}×${MAX_PHOTO_SIDE} พิกเซล ยังไม่ได้บันทึกรูป`)
  }
  const member = await ctx.env.DB.prepare('SELECT id FROM members WHERE id = ?').bind(memberId).first<{ id: string }>()
  if (!member) throw notFound()

  const version = hex(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))).slice(0, 16)
  // คำสั่งเดียว: สำเร็จแล้วรูปใหม่แทนรูปเดิมทั้งชุด ล้มเหลวแล้วรูปเดิมยังอยู่ครบ
  await ctx.env.DB.prepare(
    `INSERT INTO member_photos (member_id, content_type, bytes, size, width, height, version, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (member_id) DO UPDATE SET content_type = excluded.content_type, bytes = excluded.bytes, size = excluded.size, width = excluded.width,
       height = excluded.height, version = excluded.version, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
  )
    .bind(memberId, info.type, bytes, bytes.length, info.width, info.height, version, session.user.id, nowIso())
    .run()
  await audit(ctx.env, session.user.id, 'member_photo.updated', memberId)
  return json({ photoVersion: version })
}

/** DELETE /api/members/:id/photo — ทีมงานลบรูปของคนในทะเบียน ไม่มีรูปอยู่แล้วก็ตอบสำเร็จ (เรียกซ้ำได้) */
async function remove(ctx: Ctx, memberId: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const member = await ctx.env.DB.prepare('SELECT id FROM members WHERE id = ?').bind(memberId).first<{ id: string }>()
  if (!member) throw notFound()
  const result = await ctx.env.DB.prepare('DELETE FROM member_photos WHERE member_id = ?').bind(memberId).run()
  if (result.meta.changes > 0) await audit(ctx.env, session.user.id, 'member_photo.removed', memberId)
  return json({ photoVersion: null })
}

const PHOTO_HEADERS = {
  // เบราว์เซอร์เก็บสำเนาได้เฉพาะของผู้ใช้คนนี้ และต้องถาม server ก่อนใช้ทุกครั้ง: session ที่หมดอายุหรือถูกยกเลิกจะไม่ได้รูปจากสำเนาเดิม
  'Cache-Control': 'private, no-cache',
  Vary: 'Cookie',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Content-Disposition': 'inline',
}

const toBytes = (value: unknown): Uint8Array | null => {
  if (value instanceof Uint8Array) return value
  if (value instanceof ArrayBuffer) return new Uint8Array(value)
  if (Array.isArray(value)) return Uint8Array.from(value as number[])
  return null
}

/**
 * GET /api/members/:id/photo — รูปโปรไฟล์ของคนในทะเบียน
 * ทีมงานอ่านได้ทุกคน สมาชิกอ่านได้เฉพาะรูปของตัวเอง (รหัสคนอื่นตอบเหมือนไม่มีรูป) ตรวจ session ทุกคำขอรวมถึงคำขอที่ถามว่ารูปเปลี่ยนหรือยัง
 */
async function read(ctx: Ctx, memberId: string): Promise<Response> {
  const session = ctx.session
  if (!session) throw new HttpError(401, 'unauthenticated', 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว')
  const noPhoto = () => new HttpError(404, 'no_photo', 'ไม่มีรูปโปรไฟล์')
  if (session.kind === 'staff') requireUser(ctx)
  else if (requireMember(ctx).member.id !== memberId) throw noPhoto()

  // อ่านเฉพาะข้อมูลประกอบก่อน: คำขอที่รูปยังไม่เปลี่ยนไม่ต้องอ่านตัวรูปจากฐานข้อมูล
  const meta = await ctx.env.DB.prepare('SELECT version, content_type, size FROM member_photos WHERE member_id = ?')
    .bind(memberId)
    .first<{ version: string; content_type: string; size: number }>()
  if (!meta) throw noPhoto()
  const etag = `"${meta.version}"`
  const headers = { ...PHOTO_HEADERS, ETag: etag }
  if ((ctx.request.headers.get('If-None-Match') ?? '').split(',').some((value) => value.trim() === etag)) return new Response(null, { status: 304, headers })

  const row = await ctx.env.DB.prepare('SELECT bytes FROM member_photos WHERE member_id = ? AND version = ?').bind(memberId, meta.version).first<{ bytes: unknown }>()
  const bytes = toBytes(row?.bytes)
  if (!bytes) throw noPhoto()
  return new Response(bytes, { headers: { ...headers, 'Content-Type': meta.content_type, 'Content-Length': String(bytes.length) } })
}

export async function handleMemberPhoto(ctx: Ctx, memberId: string): Promise<Response | null> {
  const method = ctx.request.method
  // คำตอบที่ไม่ใช่รูป (ไม่มีสิทธิ์ ไม่มีรูป) เป็น JSON แบบ no-store เหมือน API อื่น เบราว์เซอร์จึงไม่เก็บไว้ใช้แทนรูป
  if (method === 'GET') return read(ctx, memberId)
  if (method === 'PUT') return upload(ctx, memberId)
  if (method === 'DELETE') return remove(ctx, memberId)
  return null
}
