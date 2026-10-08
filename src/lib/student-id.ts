/** ตัวเลขที่มี u/U นำหน้าเป็นรหัสเดียวกับตัวเลขล้วน คงเลขศูนย์นำหน้าและไม่แปลงเป็น number */
export const normalizeStudentId = (value: string): string => value.trim().replace(/^u(?=\d+$)/i, '')

export const studentIdKey = (value: string): string => normalizeStudentId(value).toLowerCase()

/** อ่านบัญชีเดิมได้ทั้งที่เก็บตัวเลขล้วนและที่เก็บ u/U นำหน้า (SQL เปรียบเทียบแบบ NOCASE) */
export const studentIdAliases = (value: string): [string, string] => {
  const normalized = normalizeStudentId(value)
  return [normalized, /^\d+$/.test(normalized) ? `u${normalized}` : normalized]
}
