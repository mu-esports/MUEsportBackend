-- การนำคำตอบ Google Forms หนึ่งคำตอบไปเพิ่มเป็นสมาชิก ทำได้ครั้งเดียวไม่ว่าทีมงานกี่คนจะกดพร้อมกัน
-- แถวนี้คือ "สิทธิ์นำเข้า" ของ (form_id, response_id): PRIMARY KEY ทำให้มีผู้จองได้คนเดียว และ member_id ถูกกำหนดตั้งแต่ตอนจอง
-- ทุกคำขอ (จากทุกบัญชี) ใช้ member_id เดียวกันนี้ การลองใหม่หลังล้มเหลวกลางทางจึงทำต่อรายการเดิม ไม่สร้างสมาชิกหรือแถวในชีตเพิ่ม
-- เพิ่มตารางเท่านั้น ไม่แก้หรือลบข้อมูลเดิม
CREATE TABLE form_imports (
  form_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  -- รหัสสมาชิกที่จองไว้ก่อนสร้าง ใช้เป็นรหัสแถวในชีตด้วยเมื่อเชื่อม Sheets
  member_id TEXT NOT NULL,
  -- ค่าของทะเบียนสมาชิกที่ผู้จองคนแรกยืนยัน (ชื่อ ชื่อเล่น ช่องทางติดต่อ หมายเหตุ) ใช้ทำต่อให้จบด้วยค่าเดิมเสมอ
  payload_hash TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'completed')),
  -- ผู้กระทำ เก็บไว้เพื่อ audit ไม่ได้เป็นส่วนของตัวตนของงานนำเข้า
  claimed_by TEXT NOT NULL,
  claimed_at TEXT NOT NULL,
  completed_by TEXT,
  completed_at TEXT,
  PRIMARY KEY (form_id, response_id)
);
