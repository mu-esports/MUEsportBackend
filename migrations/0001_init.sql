-- MU Esport Staff: โครงสร้างฐานข้อมูลกลางรอบแรก (Cloudflare D1)
-- เวลาเก็บเป็น ISO 8601 UTC ยกเว้นคอลัมน์ที่ระบุว่าเป็นเวลาท้องถิ่น Asia/Bangkok

-- ผู้เข้าสู่ระบบ (ทีมงาน) แยกจากตาราง members ซึ่งเป็นรายชื่อสมาชิกชมรม
CREATE TABLE users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  google_sub TEXT UNIQUE,
  name TEXT NOT NULL DEFAULT '',
  role TEXT NOT NULL CHECK (role IN ('staff', 'admin')),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  is_bootstrap INTEGER NOT NULL DEFAULT 0 CHECK (is_bootstrap IN (0, 1)),
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_login_at TEXT
);

-- เก็บเฉพาะ hash ของ session secret
CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX sessions_user_idx ON sessions(user_id);
CREATE INDEX sessions_expires_idx ON sessions(expires_at);

-- state ของ OAuth ใช้ครั้งเดียว ผูกกับเบราว์เซอร์และจุดประสงค์
CREATE TABLE oauth_states (
  state_hash TEXT PRIMARY KEY,
  purpose TEXT NOT NULL CHECK (purpose IN ('login', 'connect')),
  browser_hash TEXT NOT NULL,
  nonce TEXT NOT NULL,
  code_verifier TEXT NOT NULL,
  return_path TEXT NOT NULL,
  user_id TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX oauth_states_expires_idx ON oauth_states(expires_at);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  nickname TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('member', 'staff', 'admin')),
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  contact TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  added_at TEXT NOT NULL,            -- YYYY-MM-DD ตามเวลา Asia/Bangkok
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE events (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  all_day INTEGER NOT NULL CHECK (all_day IN (0, 1)),
  start_at TEXT NOT NULL,            -- YYYY-MM-DDTHH:mm ตามเวลา Asia/Bangkok
  end_at TEXT NOT NULL,
  location TEXT NOT NULL DEFAULT '',
  description TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  CHECK (end_at >= start_at)
);
CREATE INDEX events_start_idx ON events(start_at);

-- กันการสร้างซ้ำเมื่อ retry: key ผูกกับผู้ใช้ ชนิดคำสั่ง และ payload
CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL,
  key TEXT NOT NULL,
  operation TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);

-- การเชื่อม Google ของชมรม มีได้แถวเดียว refresh token เก็บแบบเข้ารหัส
CREATE TABLE google_connections (
  id TEXT PRIMARY KEY CHECK (id = 'club'),
  google_sub TEXT NOT NULL,
  email TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  refresh_token_enc TEXT,
  access_token_enc TEXT,
  access_token_expires_at TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'needs_reconnect', 'error', 'disconnected')),
  last_checked_at TEXT,
  last_error TEXT,
  connected_by TEXT,
  connected_at TEXT,
  updated_at TEXT NOT NULL
);

-- เอกสารที่สร้างผ่านแอป เนื้อหาอยู่ใน Google Docs ไม่เก็บใน D1
CREATE TABLE documents (
  id TEXT PRIMARY KEY,
  google_document_id TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'read_only', 'unavailable')),
  status_detail TEXT NOT NULL DEFAULT '',
  created_by TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_checked_at TEXT
);
CREATE INDEX documents_updated_idx ON documents(updated_at);

-- งานสร้างเอกสาร ใช้ทำต่อเมื่อ Google สำเร็จแต่ขั้นถัดไปล้มเหลว
-- content เก็บชั่วคราวเพื่อทำต่อ และล้างเมื่องานเสร็จ
CREATE TABLE document_operations (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  idem_key TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  title TEXT NOT NULL,
  content TEXT,
  status TEXT NOT NULL CHECK (status IN ('pending', 'file_created', 'completed', 'failed')),
  google_document_id TEXT,
  document_id TEXT,
  last_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (user_id, idem_key)
);
CREATE INDEX document_operations_status_idx ON document_operations(status);

-- แหล่งข้อมูลที่เลือกไว้ (Sheets/Calendar) รอบนี้ยังไม่มีการตั้งค่า
CREATE TABLE resource_configs (
  kind TEXT PRIMARY KEY CHECK (kind IN ('sheets', 'calendar')),
  resource_id TEXT NOT NULL,
  resource_name TEXT NOT NULL DEFAULT '',
  config_json TEXT NOT NULL DEFAULT '{}',
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- บันทึกการดำเนินการด้านสิทธิ์และการเชื่อมต่อ ไม่เก็บ token เนื้อหาเอกสาร หรือข้อมูลติดต่อสมาชิก
CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  user_id TEXT,
  action TEXT NOT NULL,
  target TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT ''
);
