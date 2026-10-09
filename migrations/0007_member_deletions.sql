-- ลบทะเบียนเฉพาะในเว็บ โดยคง Google Sheets ต้นฉบับไว้
-- เก็บเฉพาะ opaque member ID เพื่อกันรอบซิงค์สร้างข้อมูลที่ลบแล้วกลับมา ไม่เก็บชื่อ รหัสนักศึกษา รูป หรือรหัสผ่าน
CREATE TABLE member_deletions (
  member_id TEXT PRIMARY KEY,
  deleted_by TEXT NOT NULL,
  deleted_at TEXT NOT NULL
);

-- ครอบคลุมรอบซิงค์ที่อ่านชีตไว้ก่อนคำสั่งลบ และการนำเข้าซ้ำด้วย ID เดิม
CREATE TRIGGER prevent_deleted_member_insert BEFORE INSERT ON members
WHEN EXISTS (SELECT 1 FROM member_deletions WHERE member_id = NEW.id)
BEGIN SELECT RAISE(IGNORE); END;
