-- Google Sync สองทาง: แหล่งข้อมูลที่เชื่อม สถานะการซิงค์ และสำเนาข้อมูลจาก Google
-- เพิ่มตารางและคอลัมน์เท่านั้น ไม่แก้หรือลบข้อมูลเดิม (สมาชิกและกำหนดการที่มีอยู่ยังเป็นข้อมูลในเว็บจนกว่าผู้ดูแลจะย้ายขึ้น Google)
-- ตาราง resource_configs เดิมจำกัดชนิดไว้ที่ sheets/calendar และไม่เคยถูกใช้ จึงคงไว้ตามเดิมและใช้ sync_resources แทน

-- แหล่งข้อมูลที่ผู้ดูแลสร้างหรือเลือกไว้ ชนิดละหนึ่งแหล่ง
CREATE TABLE sync_resources (
  kind TEXT PRIMARY KEY CHECK (kind IN ('sheets', 'calendar', 'forms')),
  resource_id TEXT NOT NULL,
  resource_name TEXT NOT NULL DEFAULT '',
  resource_url TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL CHECK (origin IN ('created', 'selected')),
  -- read = บัญชีชมรมมีสิทธิ์อ่านอย่างเดียว เว็บจะไม่เขียนกลับ
  access TEXT NOT NULL DEFAULT 'write' CHECK (access IN ('write', 'read')),
  config_json TEXT NOT NULL DEFAULT '{}',
  linked_by TEXT NOT NULL,
  linked_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- สถานะการซิงค์ต่อบริการ: cursor/รุ่นของต้นฉบับ ผลล่าสุด backoff และ lease กันงานซ้อน
CREATE TABLE sync_state (
  kind TEXT PRIMARY KEY CHECK (kind IN ('sheets', 'calendar', 'forms', 'docs')),
  resource_id TEXT NOT NULL DEFAULT '',
  cursor TEXT,
  remote_version TEXT,
  -- เพิ่มทุกครั้งที่สำเนาใน D1 เปลี่ยน หน้าเว็บใช้ตัดสินว่าต้องโหลดรายการใหม่หรือไม่
  data_version INTEGER NOT NULL DEFAULT 0,
  last_attempt_at TEXT,
  last_success_at TEXT,
  last_error_code TEXT,
  last_error_message TEXT,
  failure_count INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT,
  -- รายการที่ต้องแก้ที่ต้นฉบับ (เลขแถวและเหตุผล ไม่มีข้อมูลติดต่อ)
  issues_json TEXT NOT NULL DEFAULT '[]',
  lease_owner TEXT,
  lease_expires_at TEXT,
  updated_at TEXT NOT NULL
);

-- กันการเขียนไปแหล่งเดียวกันซ้อนกันจากหลายคำขอของเว็บ (เช่น กดเพิ่มพร้อมกันจากสองอุปกรณ์) ใช้ช่วงสั้น ๆ ระหว่างอ่านและเขียน
CREATE TABLE write_locks (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

-- งานสร้างแหล่งข้อมูลใหม่ในบัญชีชมรม ใช้ operation ID กันการสร้างซ้ำเมื่อ retry
-- create_attempted_at มีค่าแต่ยังไม่มี resource_id = ไม่ทราบผล ระบบจะค้นหาของเดิมก่อนเสมอ
CREATE TABLE setup_operations (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('sheets', 'calendar', 'forms')),
  user_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pending', 'resource_created', 'completed', 'failed')),
  resource_id TEXT,
  create_attempted_at TEXT,
  last_error TEXT,
  lease_owner TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, idem_key)
);

-- สมาชิก: source = 'sheets' คือสำเนาจากชีตที่เชื่อม, 'local' คือข้อมูลที่อยู่เฉพาะในเว็บ
ALTER TABLE members ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE members ADD COLUMN source_resource_id TEXT;
-- missing = เคยมาจากชีตแต่ไม่พบแถวแล้ว เก็บไว้ ไม่ลบอัตโนมัติ
ALTER TABLE members ADD COLUMN source_state TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE members ADD COLUMN source_hash TEXT;
ALTER TABLE members ADD COLUMN source_missing_at TEXT;
-- คำตอบ Google Forms ที่นำมาเพิ่มเป็นสมาชิก (ถ้ามี)
ALTER TABLE members ADD COLUMN origin_response_id TEXT;

-- กำหนดการ: source = 'calendar' คือสำเนาจาก Google Calendar จับคู่ด้วย calendar ID + event ID
ALTER TABLE events ADD COLUMN source TEXT NOT NULL DEFAULT 'local';
ALTER TABLE events ADD COLUMN google_calendar_id TEXT;
ALTER TABLE events ADD COLUMN google_event_id TEXT;
ALTER TABLE events ADD COLUMN etag TEXT;
-- รายการย่อยของกำหนดการซ้ำ: id ของ series ต้นทาง
ALTER TABLE events ADD COLUMN recurring_event_id TEXT;
-- cancelled = ถูกยกเลิก/ลบใน Google แล้ว ไม่แสดงในปฏิทิน แต่ไม่ลบแถว
ALTER TABLE events ADD COLUMN source_state TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE events ADD COLUMN html_link TEXT;
-- 0 = แก้จากเว็บไม่ได้ (เช่น กำหนดการซ้ำ) ให้เปิด Google Calendar แทน; edit_note บอกเหตุผล
ALTER TABLE events ADD COLUMN editable INTEGER NOT NULL DEFAULT 1;
ALTER TABLE events ADD COLUMN edit_note TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN seen_run TEXT;
CREATE UNIQUE INDEX events_google_idx ON events(google_calendar_id, google_event_id) WHERE google_event_id IS NOT NULL;
CREATE INDEX events_series_idx ON events(google_calendar_id, recurring_event_id);

-- series ของกำหนดการซ้ำ เก็บตัวตนของ series และสถานะการกระจายรายการย่อย
CREATE TABLE calendar_series (
  calendar_id TEXT NOT NULL,
  event_id TEXT NOT NULL,
  etag TEXT,
  needs_expand INTEGER NOT NULL DEFAULT 1,
  expanded_at TEXT,
  seen_run TEXT,
  PRIMARY KEY (calendar_id, event_id)
);

-- โครงสร้างฟอร์ม: จับคู่ด้วย item ID / question ID คำถามที่ถูกลบเก็บไว้ (removed_at) เพื่อให้คำตอบเก่ายังอ่านได้
CREATE TABLE form_items (
  form_id TEXT NOT NULL,
  item_id TEXT NOT NULL,
  position INTEGER NOT NULL,
  kind TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  required INTEGER NOT NULL DEFAULT 0,
  -- [{ id, label }] question ID ทั้งหมดของ item นี้ (ตารางมีหลายข้อ)
  questions_json TEXT NOT NULL DEFAULT '[]',
  options_json TEXT NOT NULL DEFAULT '[]',
  editable INTEGER NOT NULL DEFAULT 0,
  edit_note TEXT NOT NULL DEFAULT '',
  removed_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (form_id, item_id)
);

-- คำตอบต้นฉบับจาก Forms API เก็บตามที่ได้รับ (อ่านอย่างเดียว) จับคู่ด้วย response ID
CREATE TABLE form_responses (
  form_id TEXT NOT NULL,
  response_id TEXT NOT NULL,
  create_time TEXT NOT NULL,
  last_submitted_time TEXT NOT NULL,
  respondent_email TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '{}',
  source_state TEXT NOT NULL DEFAULT 'ok',
  -- การนำไปใช้ในเว็บ ไม่เปลี่ยนคำตอบต้นฉบับ
  review_status TEXT NOT NULL DEFAULT 'new' CHECK (review_status IN ('new', 'imported', 'dismissed')),
  member_id TEXT,
  reviewed_by TEXT,
  reviewed_at TEXT,
  seen_run TEXT,
  first_seen_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (form_id, response_id)
);
CREATE INDEX form_responses_time_idx ON form_responses(form_id, last_submitted_time);

-- เอกสารที่ผู้ดูแลเลือกจากไฟล์เดิม (ไม่ได้สร้างผ่านเว็บ)
ALTER TABLE documents ADD COLUMN origin TEXT NOT NULL DEFAULT 'created';
