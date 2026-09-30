-- Oura tables: one per endpoint, keyed by Oura's own local day (or record id).
-- Extracted columns serve the tools; `raw` keeps the full record for reprocessing.

CREATE TABLE oura_daily_readiness (
  day TEXT PRIMARY KEY,
  score INTEGER,
  temperature_deviation REAL,
  temperature_trend_deviation REAL,
  contributors TEXT,
  timestamp TEXT,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_daily_sleep (
  day TEXT PRIMARY KEY,
  score INTEGER,
  contributors TEXT,
  timestamp TEXT,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_sleep (
  id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  type TEXT,
  bedtime_start TEXT,
  bedtime_end TEXT,
  total_sleep_s INTEGER,
  time_in_bed_s INTEGER,
  efficiency INTEGER,
  latency_s INTEGER,
  deep_s INTEGER,
  rem_s INTEGER,
  light_s INTEGER,
  awake_s INTEGER,
  average_hrv REAL,
  lowest_hr INTEGER,
  average_hr REAL,
  average_breath REAL,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);
CREATE INDEX oura_sleep_day ON oura_sleep(day);

CREATE TABLE oura_daily_activity (
  day TEXT PRIMARY KEY,
  steps INTEGER,
  active_calories INTEGER,
  total_calories INTEGER,
  score INTEGER,
  high_s INTEGER,
  medium_s INTEGER,
  low_s INTEGER,
  sedentary_s INTEGER,
  non_wear_s INTEGER,
  timestamp TEXT,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_daily_stress (
  day TEXT PRIMARY KEY,
  stress_high_s INTEGER,
  recovery_high_s INTEGER,
  day_summary TEXT,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_daily_resilience (
  day TEXT PRIMARY KEY,
  level TEXT,
  contributors TEXT,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_daily_spo2 (
  day TEXT PRIMARY KEY,
  spo2_average REAL,
  breathing_disturbance_index REAL,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_vo2_max (
  day TEXT PRIMARY KEY,
  vo2_max REAL,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_cardio_age (
  day TEXT PRIMARY KEY,
  vascular_age INTEGER,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_rest_mode (
  id TEXT PRIMARY KEY,
  start_day TEXT,
  end_day TEXT,
  start_time TEXT,
  end_time TEXT,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_tags (
  id TEXT PRIMARY KEY,
  start_day TEXT,
  end_day TEXT,
  start_time TEXT,
  end_time TEXT,
  tag_type_code TEXT,
  comment TEXT,
  custom_name TEXT,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

CREATE TABLE oura_workouts (
  id TEXT PRIMARY KEY,
  day TEXT,
  activity TEXT,
  calories REAL,
  distance REAL,
  start_datetime TEXT,
  end_datetime TEXT,
  intensity TEXT,
  label TEXT,
  source TEXT,
  raw TEXT NOT NULL,
  synced_at TEXT NOT NULL
);

-- Sync bookkeeping. sync_state is a small key/value table; sync_runs is the log.
CREATE TABLE sync_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sync_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT NOT NULL,
  kind TEXT NOT NULL,
  range_start TEXT,
  range_end TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  ok INTEGER,
  records INTEGER,
  error TEXT
);
