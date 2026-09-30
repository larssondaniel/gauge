-- MacroFactor tables, keyed by local date. Exports are authoritative; snapshot
-- rows (step 3) are provisional and any export covering a date overwrites them.

CREATE TABLE mf_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  received_at TEXT NOT NULL,
  filename TEXT,
  bytes INTEGER,
  layout TEXT,
  coverage_start TEXT,
  coverage_end TEXT,
  daily_rows INTEGER,
  food_rows INTEGER,
  checkin_rows INTEGER,
  kv_key TEXT,
  ok INTEGER NOT NULL,
  error TEXT
);

CREATE TABLE mf_daily (
  date TEXT PRIMARY KEY,
  expenditure REAL,
  trend_weight_lb REAL,
  scale_weight_lb REAL,
  fat_percent REAL,
  calories REAL,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  fiber_g REAL,
  alcohol_g REAL,
  sodium_mg REAL,
  caffeine_mg REAL,
  water_g REAL,
  sugars_g REAL,
  saturated_fat_g REAL,
  potassium_mg REAL,
  target_calories REAL,
  target_protein_g REAL,
  target_carbs_g REAL,
  target_fat_g REAL,
  -- 'export' when the file carried targets; 'checkin' when derived from Nutrition Program Settings (D-019)
  targets_source TEXT,
  steps INTEGER,
  fasting INTEGER,
  partial_logging INTEGER,
  micros TEXT,
  -- 'export' or 'snapshot' (provisional)
  source TEXT NOT NULL,
  upload_id INTEGER,
  updated_at TEXT NOT NULL
);

CREATE TABLE mf_food_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  date TEXT NOT NULL,
  time TEXT,
  name TEXT,
  serving_size TEXT,
  serving_qty REAL,
  serving_weight_g REAL,
  calories REAL,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  fiber_g REAL,
  alcohol_g REAL,
  sodium_mg REAL,
  caffeine_mg REAL,
  micros TEXT,
  upload_id INTEGER
);
CREATE INDEX mf_food_log_date ON mf_food_log(date, time);

CREATE TABLE mf_checkins (
  update_date TEXT NOT NULL,
  weekday TEXT NOT NULL,
  calories REAL,
  protein_g REAL,
  carbs_g REAL,
  fat_g REAL,
  expenditure REAL,
  daily_average_calories REAL,
  weight_lb REAL,
  expenditure_mode TEXT,
  upload_id INTEGER,
  PRIMARY KEY (update_date, weekday)
);

CREATE TABLE mf_weight_goals (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  goal TEXT,
  status TEXT,
  start_date TEXT,
  end_date TEXT,
  goal_weight_lb REAL,
  rate_pct_per_week REAL,
  starting_scale_weight_lb REAL,
  starting_trend_weight_lb REAL,
  original_eta_days REAL,
  checkpoint_date TEXT,
  checkpoint_weight_lb REAL,
  ending_scale_weight_lb REAL,
  ending_trend_weight_lb REAL,
  upload_id INTEGER
);

CREATE TABLE mf_body_metrics (
  date TEXT PRIMARY KEY,
  waist_in REAL,
  chest_in REAL,
  hips_in REAL,
  neck_in REAL,
  shoulders_in REAL,
  visual_body_fat TEXT,
  all_json TEXT,
  upload_id INTEGER
);
