-- ควบคุมงานสร้างเอกสารให้มีผู้ทำทีละหนึ่งคำขอ และแยกกรณี "ไม่ทราบผลการสร้างไฟล์" ออกจาก "ยังไม่ได้สร้าง"
-- เพิ่มคอลัมน์เท่านั้น ไม่แก้หรือลบข้อมูลเดิม

-- lease: คำขอที่กำลังทำงานนี้อยู่ (ค่าสุ่มต่อคำขอ) และเวลาที่สิทธิ์หมด ใช้ข้าม Worker instance ได้เพราะอยู่ใน D1
ALTER TABLE document_operations ADD COLUMN lease_owner TEXT;
ALTER TABLE document_operations ADD COLUMN lease_expires_at TEXT;

-- บันทึกก่อนส่งคำสั่งสร้างไฟล์ไป Google ทุกครั้ง
-- ถ้ามีค่านี้แต่ยังไม่มี google_document_id แปลว่าไม่ทราบผล (Google อาจสร้างแล้วแต่คำตอบไม่กลับมา) ระบบจะไม่สร้างใหม่เอง
ALTER TABLE document_operations ADD COLUMN create_attempted_at TEXT;

-- นำงานออกจากรายการโดยเก็บแถวไว้เป็นหลักฐาน (ไม่ลบ) เพื่อให้ไฟล์ที่อาจถูกสร้างแล้วยังตามได้
ALTER TABLE document_operations ADD COLUMN dismissed_at TEXT;
ALTER TABLE document_operations ADD COLUMN dismissed_by TEXT;
