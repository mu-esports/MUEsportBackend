-- ลบบัญชีเข้าสู่ระบบของสมาชิก, โปรไฟล์นักกีฬา และรูปโปรไฟล์
-- เพิ่มคอลัมน์และตารางเท่านั้น ไม่แก้หรือลบข้อมูลเดิม: ทะเบียนสมาชิก บัญชีสมาชิก session และการเชื่อม Google เดิมไม่ถูกแตะ
-- Worker รุ่นก่อนหน้านี้ยังทำงานได้กับฐานข้อมูลหลัง migration นี้ (คอลัมน์ใหม่มีค่าเริ่มต้น ตารางใหม่ยังไม่ถูกอ่าน)

-- รุ่นของบัญชีเข้าสู่ระบบ: ค่าสุ่มที่เปลี่ยนทุกครั้งที่ผู้ดูแลเปิดบัญชี ตั้ง/รีเซ็ตรหัสผ่าน ปิดบัญชี หรือเปลี่ยนรหัสเข้าสู่ระบบ
-- และเมื่อสมาชิกเปลี่ยนรหัสผ่านเอง กล่องยืนยันลบบัญชีส่งค่าที่เห็นมาด้วย: ถ้าบัญชีถูกเปลี่ยนหรือสร้างใหม่ระหว่างนั้น ค่าจะไม่ตรงและไม่ลบ
-- เป็นค่าสุ่ม (ไม่ใช่ตัวนับ) เพื่อให้บัญชีที่ถูกลบแล้วเปิดใหม่ไม่มีทางได้ค่าเดิมซ้ำ
ALTER TABLE member_accounts ADD COLUMN revision TEXT NOT NULL DEFAULT '';
UPDATE member_accounts SET revision = lower(hex(randomblob(12))) WHERE revision = '';

-- โปรไฟล์นักกีฬา: ข้อมูลเพิ่มเติมของคนในทะเบียนสมาชิก ผูกกับ member ID ที่เสถียร (ไม่ใช่เลขแถวในชีต) คนละหนึ่งโปรไฟล์
-- ชื่อ ชื่อเล่น รหัสนักศึกษา และรูป มาจากทะเบียนสมาชิกเสมอ ไม่เก็บซ้ำที่นี่ นักกีฬาไม่ใช่สิทธิ์ของระบบและไม่เกี่ยวกับบัญชีเข้าสู่ระบบ
-- ข้อมูลในตารางนี้อยู่ในเว็บเท่านั้น การซิงค์ Google Sheets ไม่อ่านและไม่เขียนตารางนี้
CREATE TABLE athletes (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  game TEXT NOT NULL,
  team TEXT NOT NULL DEFAULT '',
  position TEXT NOT NULL DEFAULT '',
  -- ชื่อในเกม (in-game name)
  ign TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL CHECK (status IN ('active', 'inactive')),
  note TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- รูปโปรไฟล์ของคนในทะเบียน (ใช้ร่วมกันทั้งหน้าสมาชิกและหน้านักกีฬา) คนละหนึ่งรูป เก็บเป็นไฟล์ขนาดเล็กที่ย่อจากเบราว์เซอร์แล้ว
-- แยกตารางจาก members เพื่อไม่ให้การอ่านรายชื่อดึงข้อมูลรูป: รายชื่ออ่านเฉพาะ version
-- version = ส่วนต้นของ SHA-256 ของไฟล์ ใช้เป็นส่วนหนึ่งของ URL และ ETag: เปลี่ยนรูปแล้วค่าเปลี่ยนเสมอ
CREATE TABLE member_photos (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  content_type TEXT NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  bytes BLOB NOT NULL,
  size INTEGER NOT NULL CHECK (size > 0 AND size <= 262144),
  width INTEGER NOT NULL CHECK (width BETWEEN 1 AND 512),
  height INTEGER NOT NULL CHECK (height BETWEEN 1 AND 512),
  version TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
