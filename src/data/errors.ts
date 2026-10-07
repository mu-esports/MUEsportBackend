/** ข้อผิดพลาดที่มีข้อความไทยพร้อมแสดงให้ผู้ใช้ และรหัสให้โปรแกรมแยกกรณี */
export class AppError extends Error {
  constructor(
    public code: string,
    public status: number,
    message: string,
    public data: Record<string, unknown> = {},
  ) {
    super(message)
  }
}

export const messageOf = (error: unknown, fallback: string) => (error instanceof AppError ? error.message : fallback)
export const hasCode = (error: unknown, code: string) => error instanceof AppError && error.code === code

/**
 * Google อาจรับคำสั่งไปแล้วแต่ระบบยืนยันผลไม่ได้ (คำตอบหาย อ่านกลับไม่ตรง หรือค่าลงผิดตำแหน่ง)
 * หน้าเว็บต้องไม่บอกว่า "ไม่สำเร็จ ยังไม่มีการเปลี่ยนแปลง" และไม่บอกว่าสำเร็จ
 */
export const isUnconfirmed = (error: unknown) =>
  error instanceof AppError && ['save_outcome_unknown', 'saved_unverified', 'write_misplaced'].includes(error.code)
