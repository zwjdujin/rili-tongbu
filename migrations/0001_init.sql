-- rili-tongbu D1 schema (v0.0.1)

-- 已绑定的终端设备（华为/iOS/Windows/其他）
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  platform TEXT NOT NULL,            -- huawei / ios / windows / other
  token TEXT NOT NULL UNIQUE,        -- 设备同步凭证
  created_at INTEGER NOT NULL,
  last_seen INTEGER
);

-- 日历（多个日历桶，事件归属于某个日历）
CREATE TABLE IF NOT EXISTS calendars (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  color TEXT NOT NULL DEFAULT '#3b82f6',
  created_at INTEGER NOT NULL
);

-- 日历事件（软删除：deleted=1）
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,               -- 客户端生成的事件 uid
  calendar_id TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  location TEXT DEFAULT '',
  start_at INTEGER NOT NULL,         -- UTC 毫秒
  end_at INTEGER NOT NULL,
  all_day INTEGER NOT NULL DEFAULT 0,
  reminder_minutes INTEGER,          -- 提前提醒分钟数，NULL 表示不提醒
  recurrence TEXT,                   -- RRULE 字符串，NULL 表示单次
  updated_at INTEGER NOT NULL,       -- 最后修改时间（UTC 毫秒），用于冲突合并
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_by TEXT                    -- 最后修改的设备 id
);

CREATE INDEX IF NOT EXISTS idx_events_calendar ON events(calendar_id);
CREATE INDEX IF NOT EXISTS idx_events_updated ON events(updated_at);

-- 变更日志：增量同步的游标来源
CREATE TABLE IF NOT EXISTS change_log (
  log_id INTEGER PRIMARY KEY AUTOINCREMENT,
  device_id TEXT,
  event_id TEXT NOT NULL,
  op TEXT NOT NULL,                  -- upsert / delete
  changed_at INTEGER NOT NULL
);

-- R2 备份快照登记
CREATE TABLE IF NOT EXISTS backups (
  key TEXT PRIMARY KEY,
  created_at INTEGER NOT NULL,
  event_count INTEGER NOT NULL,
  size_bytes INTEGER NOT NULL
);
