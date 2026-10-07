-- บัญชีสมาชิก (รหัสนักศึกษา + รหัสผ่าน) และคลังไฟล์ Google ของชมรม
-- เพิ่มคอลัมน์และตารางเท่านั้น ไม่แก้หรือลบข้อมูลเดิม: สมาชิกเดิมได้ student_id ว่าง (ยังเปิดบัญชีไม่ได้จนกว่าจะกรอก)
-- session ของทีมงาน (ตาราง sessions) และการเชื่อม Google เดิมไม่ถูกแตะ

-- รหัสนักศึกษาในทะเบียน: เก็บเป็นข้อความ (คงเลขศูนย์นำหน้า) ว่าง = ยังไม่ได้กรอก
ALTER TABLE members ADD COLUMN student_id TEXT NOT NULL DEFAULT '';
-- ที่มาของค่าปัจจุบัน: web = กรอกในเว็บ, sheet = อ่านจากคอลัมน์ที่จับคู่ในชีต
-- ใช้ตัดสินตอนช่องในชีตว่าง: ค่าที่มาจากชีตถือว่าถูกลบที่ชีต ส่วนค่าที่กรอกในเว็บจะไม่ถูกล้างเงียบ ๆ
ALTER TABLE members ADD COLUMN student_id_origin TEXT NOT NULL DEFAULT 'web';
-- ค่าที่ชีตระบุแต่ระบบยังไม่ใช้ (ซ้ำกับคนอื่นหรือผิดรูปแบบ): เก็บไว้แสดงให้ผู้ดูแลแก้ และกันการเปิดบัญชีของรายการที่ยังไม่แน่นอน
-- student_id_issue: '' = ไม่มีปัญหา, duplicate = ซ้ำกันในชีต, taken = ซ้ำกับสมาชิกคนอื่นในระบบ, invalid = ผิดรูปแบบ
ALTER TABLE members ADD COLUMN student_id_issue TEXT NOT NULL DEFAULT '';
ALTER TABLE members ADD COLUMN student_id_claimed TEXT NOT NULL DEFAULT '';
-- รหัสนักศึกษาไม่ซ้ำกันทั้งทะเบียน (ไม่สนตัวพิมพ์เล็กใหญ่ของอักษรอังกฤษ)
CREATE UNIQUE INDEX members_student_id_unique ON members (student_id COLLATE NOCASE) WHERE student_id <> '';

-- บัญชีเข้าสู่ระบบของสมาชิก: ผูกกับ member ID ที่เสถียร (ไม่ใช่เลขแถวในชีต) สมาชิกหนึ่งคนมีได้บัญชีเดียว
-- login_id = รหัสนักศึกษา ณ ตอนที่ผู้ดูแลเปิดบัญชีหรือยืนยันการเปลี่ยน ไม่ตามค่าในทะเบียนเองโดยอัตโนมัติ
-- password_hash = สตริงรูปแบบ PHC ($argon2id$v=19$m=...,t=...,p=...$salt$hash) มี algorithm และ parameters ในตัว ไม่มี plaintext
CREATE TABLE member_accounts (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  login_id TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('active', 'disabled')),
  -- 1 = รหัสผ่านชั่วคราวที่ผู้ดูแลตั้ง ต้องเปลี่ยนก่อนใช้งานหน้าสมาชิก
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1)),
  password_set_at TEXT NOT NULL,
  -- users.id ของผู้ดูแลที่ตั้งหรือรีเซ็ต; NULL = สมาชิกเปลี่ยนเอง
  password_set_by TEXT,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  disabled_at TEXT,
  last_login_at TEXT
);

-- session ของสมาชิกแยกตารางจาก session ของทีมงาน: token ของสมาชิกไม่มีทางจับคู่กับแถวในตาราง sessions ได้
-- เก็บเฉพาะ SHA-256 ของ session secret เหมือนฝั่งทีมงาน
CREATE TABLE member_sessions (
  token_hash TEXT PRIMARY KEY,
  member_id TEXT NOT NULL REFERENCES member_accounts(member_id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX member_sessions_member_idx ON member_sessions(member_id);
CREATE INDEX member_sessions_expires_idx ON member_sessions(expires_at);

-- สมาชิกถูกพักการใช้งาน (จากเว็บ จากชีต หรือจากรอบซิงค์): ยกเลิก session ของสมาชิกคนนั้นทันทีในคำสั่งเดียวกัน
-- ทำเป็น trigger เพื่อให้ครอบคลุมทุกเส้นทางที่เปลี่ยนสถานะ และ session เดิมจะไม่กลับมาใช้ได้เมื่อเปิดใช้งานสมาชิกอีกครั้ง
CREATE TRIGGER members_suspend_revokes_sessions AFTER UPDATE OF status ON members WHEN NEW.status <> 'active' BEGIN DELETE FROM member_sessions WHERE member_id = NEW.id; END;

-- ตัวนับจำกัดการลองเข้าสู่ระบบ: key = hash ของรหัสนักศึกษาที่กรอก หรือ hash ของ IP (ไม่เก็บค่าจริง)
-- strikes = จำนวนครั้งที่ถูกพักติดต่อกัน ใช้ยืดเวลาพักรอบถัดไป
CREATE TABLE login_throttle (
  key TEXT PRIMARY KEY,
  attempts INTEGER NOT NULL,
  window_started_at TEXT NOT NULL,
  locked_until TEXT,
  strikes INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
);
CREATE INDEX login_throttle_updated_idx ON login_throttle(updated_at);

-- สำเนาชั่วคราวของรายการไฟล์จาก Google Drive ต่อหนึ่งคำค้น/หน้า (metadata เท่านั้น ไม่มีเนื้อหาไฟล์และไม่มี token)
CREATE TABLE library_cache (
  key TEXT PRIMARY KEY,
  body_json TEXT NOT NULL,
  fetched_at TEXT NOT NULL
);
CREATE INDEX library_cache_fetched_idx ON library_cache(fetched_at);

-- สถานะการเรียก Drive ของคลังไฟล์: ใช้เว้นระยะเมื่อ Google จำกัดคำขอหรือล้มเหลว
CREATE TABLE library_state (
  id TEXT PRIMARY KEY CHECK (id = 'drive'),
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  last_error_code TEXT,
  last_success_at TEXT,
  updated_at TEXT NOT NULL
);
