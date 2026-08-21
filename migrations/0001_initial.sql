PRAGMA foreign_keys = ON;

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  apple_subject TEXT UNIQUE,
  email TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE devices (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, id)
);

CREATE TABLE live_records (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  origin_device_id TEXT NOT NULL,
  sync_token TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE journal_records (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  origin_device_id TEXT NOT NULL,
  sync_token TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE habits_records (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  origin_device_id TEXT NOT NULL,
  sync_token TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE setline_records (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  origin_device_id TEXT NOT NULL,
  sync_token TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE kith_records (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  origin_device_id TEXT NOT NULL,
  sync_token TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (user_id, id)
);

CREATE TABLE anchor_records (
  id TEXT NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  deleted_at TEXT,
  version INTEGER NOT NULL CHECK (version > 0),
  origin_device_id TEXT NOT NULL,
  sync_token TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  PRIMARY KEY (user_id, id)
);

CREATE INDEX live_records_freshness ON live_records(user_id, updated_at DESC);
CREATE INDEX journal_records_freshness ON journal_records(user_id, updated_at DESC);
CREATE INDEX habits_records_freshness ON habits_records(user_id, updated_at DESC);
CREATE INDEX setline_records_freshness ON setline_records(user_id, updated_at DESC);
CREATE INDEX kith_records_freshness ON kith_records(user_id, updated_at DESC);
CREATE INDEX anchor_records_freshness ON anchor_records(user_id, updated_at DESC);

CREATE TABLE sync_changes (
  cursor INTEGER PRIMARY KEY AUTOINCREMENT,
  change_id TEXT NOT NULL UNIQUE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  record_id TEXT NOT NULL,
  operation TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
  version INTEGER NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  origin_device_id TEXT NOT NULL,
  payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
  idempotency_key TEXT NOT NULL,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX sync_changes_pull ON sync_changes(user_id, domain, cursor);

CREATE TABLE idempotency_keys (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  idempotency_key TEXT NOT NULL,
  domain TEXT NOT NULL,
  record_id TEXT NOT NULL,
  change_id TEXT NOT NULL REFERENCES sync_changes(change_id) ON DELETE CASCADE,
  result_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (user_id, idempotency_key)
);

CREATE TABLE life_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  event_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  occurred_at TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  actor TEXT NOT NULL,
  summary TEXT NOT NULL,
  metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json))
);
CREATE INDEX life_events_timeline ON life_events(user_id, occurred_at DESC);

CREATE TABLE pace_actions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  domain TEXT NOT NULL,
  tool_name TEXT NOT NULL,
  input_json TEXT NOT NULL CHECK (json_valid(input_json)),
  original_instruction TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  completed_at TEXT,
  before_json TEXT CHECK (before_json IS NULL OR json_valid(before_json)),
  after_json TEXT CHECK (after_json IS NULL OR json_valid(after_json)),
  undo_payload TEXT CHECK (undo_payload IS NULL OR json_valid(undo_payload)),
  undone_at TEXT,
  UNIQUE (user_id, idempotency_key)
);
CREATE INDEX pace_actions_activity ON pace_actions(user_id, created_at DESC);
