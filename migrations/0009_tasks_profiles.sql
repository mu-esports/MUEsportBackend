CREATE TABLE member_profiles (
  member_id TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
  email TEXT NOT NULL DEFAULT '',
  contacts_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(contacts_json)),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TEXT NOT NULL
);
CREATE TABLE tasks (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, category TEXT NOT NULL, instructions TEXT NOT NULL,
  start_at TEXT NOT NULL, due_at TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('individual','group')),
  status TEXT NOT NULL CHECK(status IN ('open','archived')),
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL, updated_by TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL, mutation_token TEXT NOT NULL
);
CREATE TABLE task_assignees (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  member_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  PRIMARY KEY(task_id, member_id)
);
CREATE INDEX task_assignees_member ON task_assignees(member_id, task_id);
CREATE TABLE task_units (
  id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  unit_key TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 1,
  current_submission_id TEXT, mutation_token TEXT NOT NULL DEFAULT '',
  UNIQUE(task_id, unit_key)
);
CREATE TABLE task_submissions (
  id TEXT PRIMARY KEY, unit_id TEXT NOT NULL REFERENCES task_units(id) ON DELETE CASCADE,
  submitted_by TEXT REFERENCES members(id) ON DELETE SET NULL,
  mode TEXT NOT NULL CHECK(mode IN ('link','file')),
  link_url TEXT NOT NULL DEFAULT '', note TEXT NOT NULL DEFAULT '',
  submitted_at TEXT NOT NULL, late INTEGER NOT NULL CHECK(late IN (0,1)),
  payload_hash TEXT NOT NULL
);
CREATE INDEX task_submissions_unit ON task_submissions(unit_id);
CREATE TABLE task_files (
  id TEXT PRIMARY KEY, submission_id TEXT NOT NULL REFERENCES task_submissions(id) ON DELETE CASCADE,
  name TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, sha256 TEXT NOT NULL
);
CREATE INDEX task_files_submission ON task_files(submission_id);
-- Binary chunks stay below D1's 2 MB row limit; private downloads enforce assignment permissions.
CREATE TABLE task_file_chunks (
  file_id TEXT NOT NULL REFERENCES task_files(id) ON DELETE CASCADE,
  part INTEGER NOT NULL, bytes BLOB NOT NULL, PRIMARY KEY(file_id, part)
);
CREATE TRIGGER task_remove_individual_unit AFTER DELETE ON task_assignees BEGIN
  DELETE FROM task_units WHERE task_id = OLD.task_id AND unit_key = OLD.member_id;
END;
