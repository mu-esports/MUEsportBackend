import { api } from '../api/client'

/**
 * รูปโปรไฟล์ของคนในทะเบียน (ใช้ร่วมกันทั้งหน้าสมาชิก หน้านักกีฬา และบัญชีของสมาชิกเอง)
 * รูปถูกย่อและตัดในเบราว์เซอร์ก่อนส่ง server ตรวจชนิดและขนาดจากเนื้อไฟล์ซ้ำอีกครั้ง และส่งรูปเฉพาะให้ session ที่มีสิทธิ์
 */
export const PHOTO_INPUT_TYPES = ['image/jpeg', 'image/png', 'image/webp']
export const MAX_INPUT_BYTES = 5 * 1024 * 1024
export const MAX_PHOTO_BYTES = 256 * 1024
export const MAX_PHOTO_SIDE = 512

const path = (memberId: string) => `/api/members/${encodeURIComponent(memberId)}/photo`

/** URL ของรูป: มีรุ่นของรูปอยู่ด้วย เปลี่ยนรูปแล้ว URL เปลี่ยน จึงไม่ค้างรูปเก่า (เบราว์เซอร์ส่ง cookie ของเว็บไปเอง) */
export const photoUrl = (memberId: string, version: string) => `${path(memberId)}?v=${encodeURIComponent(version)}`

export const photosApi = {
  /** ตั้งหรือเปลี่ยนรูป: สำเร็จแล้วรูปใหม่แทนรูปเดิม ไม่สำเร็จรูปเดิมยังอยู่ */
  upload: async (memberId: string, photo: Blob, signal?: AbortSignal) => (await api<{ photoVersion: string }>(path(memberId), { method: 'PUT', file: photo, signal })).photoVersion,
  remove: async (memberId: string) => (await api<{ photoVersion: null }>(path(memberId), { method: 'DELETE' })).photoVersion,
}

/** ปัญหาของไฟล์ที่ผู้ใช้เลือก (ข้อความพร้อมแสดง) */
export class PhotoError extends Error {}

export interface PreparedPhoto {
  blob: Blob
  width: number
  height: number
}

const encode = (canvas: HTMLCanvasElement, quality: number) => new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality))

/**
 * เตรียมรูปจากไฟล์ที่ผู้ใช้เลือก: รับ JPEG/PNG/WebP ไม่เกิน 5 MB ตัดเป็นสี่เหลี่ยมจัตุรัสตรงกลางรูป ย่อให้ไม่เกิน 512×512
 * แล้วเข้ารหัสเป็น JPEG ไม่เกิน 256 KiB ทั้งหมดทำในเบราว์เซอร์ ไฟล์ต้นฉบับไม่ถูกส่งออกจากเครื่อง
 */
export async function preparePhoto(file: File): Promise<PreparedPhoto> {
  if (!PHOTO_INPUT_TYPES.includes(file.type)) throw new PhotoError('เลือกรูปเป็นไฟล์ JPEG, PNG หรือ WebP เท่านั้น')
  if (file.size > MAX_INPUT_BYTES) throw new PhotoError('ไฟล์รูปใหญ่เกิน 5 MB เลือกรูปที่เล็กกว่านี้')
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new PhotoError('เปิดไฟล์นี้เป็นรูปไม่ได้ ไฟล์อาจเสียหายหรือไม่ใช่รูปจริง เลือกไฟล์อื่น')
  }
  try {
    const side = Math.min(bitmap.width, bitmap.height)
    if (side < 1) throw new PhotoError('รูปนี้ไม่มีขนาดที่ใช้ได้ เลือกไฟล์อื่น')
    const size = Math.min(MAX_PHOTO_SIDE, side)
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const context = canvas.getContext('2d')
    if (!context) throw new PhotoError('เบราว์เซอร์นี้ย่อรูปไม่ได้ ลองใช้เบราว์เซอร์อื่น')
    // รูปที่มีส่วนโปร่งใสได้พื้นขาว (JPEG ไม่มีความโปร่งใส)
    context.fillStyle = '#ffffff'
    context.fillRect(0, 0, size, size)
    context.imageSmoothingQuality = 'high'
    context.drawImage(bitmap, (bitmap.width - side) / 2, (bitmap.height - side) / 2, side, side, 0, 0, size, size)
    for (const quality of [0.86, 0.76, 0.64, 0.5]) {
      const blob = await encode(canvas, quality)
      if (blob && blob.type === 'image/jpeg' && blob.size <= MAX_PHOTO_BYTES) return { blob, width: size, height: size }
    }
    throw new PhotoError('ย่อรูปนี้ให้เล็กพอไม่ได้ ลองใช้รูปอื่น')
  } finally {
    bitmap.close()
  }
}
