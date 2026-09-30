/** Schema text for the `query` tool description and the SQL allow-list. */
export const QUERY_SCHEMA = `Tables (SQLite, dates are local YYYY-MM-DD text):
mf_daily(date PK, expenditure, trend_weight_lb, scale_weight_lb, fat_percent, calories, protein_g, carbs_g, fat_g, fiber_g, alcohol_g, sodium_mg, caffeine_mg, water_g, sugars_g, saturated_fat_g, potassium_mg, target_calories, target_protein_g, target_carbs_g, target_fat_g, targets_source, steps, steps_health, fasting, partial_logging, micros JSON, source, updated_at)
mf_food_log(id, date, time HH:MM, name, serving_size, serving_qty, serving_weight_g, calories, protein_g, carbs_g, fat_g, fiber_g, alcohol_g, sodium_mg, caffeine_mg, micros JSON)
mf_checkins(update_date, weekday, calories, protein_g, carbs_g, fat_g, expenditure, daily_average_calories, weight_lb, expenditure_mode)
mf_weight_goals(goal, status, start_date, end_date, goal_weight_lb, rate_pct_per_week, starting_scale_weight_lb, starting_trend_weight_lb, ending_scale_weight_lb, ending_trend_weight_lb)
mf_body_metrics(date PK, waist_in, chest_in, hips_in, neck_in, shoulders_in, visual_body_fat, all_json)
mf_snapshots(date PK, nutrition_json, nutrition_at, health_json, health_at, missing_json, tz_offset)
oura_daily_readiness(day PK, score, temperature_deviation, temperature_trend_deviation, contributors JSON, timestamp)
oura_daily_sleep(day PK, score, contributors JSON, timestamp)
oura_sleep(id PK, day, type [long_sleep|sleep|late_nap|rest|deleted], bedtime_start, bedtime_end, total_sleep_s, time_in_bed_s, efficiency, latency_s, deep_s, rem_s, light_s, awake_s, average_hrv, lowest_hr, average_hr, average_breath, raw JSON with hrv/heart_rate series)
oura_daily_activity(day PK, steps, active_calories, total_calories, score, high_s, medium_s, low_s, sedentary_s, non_wear_s, timestamp)
oura_daily_stress(day PK, stress_high_s, recovery_high_s, day_summary)
oura_daily_resilience(day PK, level, contributors JSON)
oura_daily_spo2(day PK, spo2_average, breathing_disturbance_index)
oura_vo2_max(day PK, vo2_max); oura_cardio_age(day PK, vascular_age)
oura_rest_mode(id PK, start_day, end_day, start_time, end_time)
oura_tags(id PK, start_day, end_day, start_time, end_time, tag_type_code, comment, custom_name)
oura_workouts(id PK, day, activity, calories, distance, start_datetime, end_datetime, intensity, label, source)
Row D semantics: mf_daily = food logged/weigh-in on D; oura_sleep.day = wake-up date (night ending morning of D). Join intake to the following night with oura.day = date(mf.date, '+1 day'). Use json_extract() for JSON columns.`;

const FORBIDDEN = /\b(attach|detach|pragma|insert|update|delete|drop|alter|create|vacuum|reindex|begin|commit|rollback|savepoint|release|load_extension)\b/i;

export class QueryError extends Error {
  override readonly name = "QueryError";
}

/** Read-only enforcement in code (D-010): one SELECT/WITH statement, no forbidden verbs, wrapped with a row cap. */
export function guardSql(sql: string, cap: number): string {
  let s = sql.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/--[^\n]*/g, " ").trim();
  if (s.endsWith(";")) s = s.slice(0, -1).trim();
  if (s.includes(";")) throw new QueryError("One statement only");
  if (!/^(select|with)\b/i.test(s)) throw new QueryError("Only SELECT (or WITH ... SELECT) is allowed");
  const bad = FORBIDDEN.exec(s);
  if (bad) throw new QueryError(`Not allowed in a read-only query: ${bad[1]}`);
  return `SELECT * FROM (${s}) LIMIT ${cap + 1}`;
}
