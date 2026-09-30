-- Nightly snapshot feed (D-005, D-018). Raw per-date payload parts are kept
-- here; provisional values are projected into mf_daily until an export lands.
CREATE TABLE mf_snapshots (
  date TEXT PRIMARY KEY,
  nutrition_json TEXT,
  nutrition_at TEXT,
  health_json TEXT,
  health_at TEXT,
  missing_json TEXT
);

-- Apple Health steps arrive only through the snapshot; separate from MacroFactor's own import.
ALTER TABLE mf_daily ADD COLUMN steps_health INTEGER;
