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
