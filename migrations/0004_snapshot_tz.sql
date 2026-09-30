-- Keep the phone-reported UTC offset with each snapshot part (travel days).
ALTER TABLE mf_snapshots ADD COLUMN tz_offset TEXT;
