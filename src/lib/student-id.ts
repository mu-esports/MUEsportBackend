/** ตัวเลขที่มี u/U นำหน้าเป็นรหัสเดียวกับตัวเลขล้วน คงเลขศูนย์นำหน้าและไม่แปลงเป็น number */
export const normalizeStudentId = (value: string): string => value.trim().replace(/^u(?=\d+$)/i, '')

export const studentIdKey = (value: string): string => normalizeStudentId(value).toLowerCase()

/**
 * คำที่หน้าเข้าสู่ระบบใช้เลือกช่องทาง Google ของทีมงาน (พิมพ์ในช่องชื่อผู้ใช้ ไม่สนตัวพิมพ์เล็กใหญ่)
 * เป็นคำเลือกช่องทางเท่านั้น ไม่ใช่บัญชีหรือรหัสผ่าน และใช้เป็นรหัสนักศึกษาไม่ได้ เพราะบัญชีที่ใช้รหัสนี้จะเข้าสู่ระบบจากหน้าเว็บไม่ได้
 */
export const GOOGLE_LOGIN_WORD = 'google'
export const isGoogleLoginWord = (value: string): boolean => value.trim().toLowerCase() === GOOGLE_LOGIN_WORD

/** อ่านบัญชีเดิมได้ทั้งที่เก็บตัวเลขล้วนและที่เก็บ u/U นำหน้า (SQL เปรียบเทียบแบบ NOCASE) */
export const studentIdAliases = (value: string): [string, string] => {
  const normalized = normalizeStudentId(value)
  return [normalized, /^\d+$/.test(normalized) ? `u${normalized}` : normalized]
}
