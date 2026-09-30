# Health Data MCP — Spec (Oura + MacroFactor)

Sep 29, 2026 · @Daniel Larsson

## How to read this spec

This spec mixes three kinds of content, and they carry different weight. Claude, the server's consumer, drafted it with Daniel; the implementer is expected to use its own judgment wherever the spec proposes rather than requires.

| Kind | What it covers | How to treat it |
| --- | --- | --- |
| Requirements | The Purpose questions; read-only; no plan logic in the server; the apps' own numbers; explicit gaps and freshness; what row D means (Dates and time zones); exports overriding snapshots; working in Claude Desktop and iOS; private repo with publishable history; no unofficial MacroFactor API | Change only with Daniel's OK |
| Proposals | Tool names, count, and parameters; output format details; baseline windows and thresholds; the split-night rule; the Cloudflare stack; Oura as the login; endpoint paths; the 23:55 run time; the build order | Use your own judgment. If something looks wrong, change it and log the reason in `DECISIONS.md` in the repo |
| Unverified facts | Oura endpoint names (written from memory); Claude's OAuth callback details; the Cloudflare OAuth library; xlsx parsing in Workers; whether Health reads fail while the iPhone is locked | Check against current docs or a real test before relying on them |

The acceptance test in the Fitness Journey project (build order, step 5) is the arbiter: a deviation that passes it is fine, and `DECISIONS.md` tells Claude what changed before the test runs.

## Purpose

Build one read-only MCP server, added as a Claude custom connector, so Claude can answer the Fitness Journey plan's recurring questions from Oura and MacroFactor without Daniel pasting numbers. The consumer is Claude in the Fitness Journey project, on Claude Desktop and iOS. The plan the data is judged against lives in the project (`Current_Plan.md`, `DEXA_History.md`), not in this server.

Each question below should take one or two tool calls.

| Question Claude needs to answer | Data it needs |
| --- | --- |
| Is the bulk on rate, and is the surplus where MacroFactor thinks it is? | Trend weight, intake, expenditure, daily targets, by check-in week |
| Why did MacroFactor move my calories at this check-in? | Expenditure series, intake vs target, missed weigh-ins |
| Was that scale jump sodium, alcohol, or travel? | Daily sodium, alcohol, scale vs trend weight, timezone |
| How recovered am I going into a training block or coming out of a deload? | Readiness, HRV, resting HR, sleep, temperature deviation, daily and weekly |
| Did last night's alcohol or late meal show up in sleep? | Intake on day D joined to the night after D |
| Is the step floor holding? | Daily steps |
| Cut phase: have I felt very depleted for a full week, objectively? | Readiness, HRV and resting HR vs personal baseline, sleep, rate of loss |
| DEXA prep: what did the three days before the scan look like? | Sodium, intake, sleep for an exact date window |
| Travel and deloads (Greece Oct 9–17, Sweden Dec 20–Jan 3): what did they cost? | All of the above around a date window, with timezone visible |

## Before building

Do these before the first Claude Code session; real samples make the parsers right the first time.

- [ ] Export this spec as Markdown into the repo, e.g. `SPEC.md`.
- [ ] Add three real samples, git-ignored even though the repo starts private, since they are health data: a Quick Export (last 14 days), a Granular Export (All Time, every box, plus the Food Log), and one Get Nutrition State output saved to Files by a throwaway Shortcut.
- [ ] Confirm or replace the proposed stack (see Proposed stack and build order).

The repo starts private but may go public later, so keep its history publishable from the first commit. Samples, raw exports, and payloads stay git-ignored. Daniel's Oura user ID, the Oura client secret, and the upload token live in Worker secrets, never in code or committed config. Going public should then be a visibility toggle, not a history rewrite.

## Design principles

The server returns data and neutral aggregates; Claude does the interpreting against the plan.

- **Read-only.** No writes to Oura or MacroFactor, ever. MacroFactor's check-in adjustments are accepted, not overridden, so there is nothing to write.
- **No plan logic in the server.** No 0.25%/week, 20% ceiling, step floor, or tripwires baked in. The plan changes every phase and lives in the project. Thresholds, where a tool needs one, are parameters.
- **Use the apps' own numbers.** Take MacroFactor's trend weight and expenditure and Oura's scores as exported. Never re-implement either algorithm.
- **Few tools, rich parameters.** About seven tools. Claude picks tools by their descriptions, so each description states what it returns, the date semantics, and the units.
- **Compact tables by default.** One row per day or week, units in column headers, stable column names and order. Nested JSON only via a `format` parameter. Token cost matters in long chats on the phone.
- **Gaps are explicit.** Every day in the requested range gets a row. Missing values are null, never interpolated, carried forward, or dropped. A header lists missing days per source.
- **Freshness on every response.** A header line per source: data-through date and last sync or export time. MacroFactor lags its last export, and Claude must see by how much.
- **Self-contained.** Apple Health on iOS already carries steps, nutrition totals, scale weight, and Oura's sleep, HRV and resting HR, but not readiness, Oura's scores, temperature deviation, trend weight, expenditure, or targets, and not on desktop. The server covers everything itself so joins take one call on either device.
- **Units.** Pounds, kcal, grams, minutes, bpm, ms, and °C for Oura's temperature deviation (a delta, as Oura reports it). Local clock times as `HH:MM`.
- **Long ranges downsample.** Over \~120 days, default to weekly rows unless the caller asks for `granularity=day`.

## Tool surface

`get_daily` is the workhorse; most questions should end there or at `get_weekly`. Every range tool takes `start` and `end` (ISO dates, inclusive) or `last_n_days`.

| Tool | Key parameters | Returns | Priority |
| --- | --- | --- | --- |
| `get_status` | none | Per source: coverage start/end, data-through date, last Oura sync, MacroFactor export timestamp, missing days in the last 30, current MacroFactor goal settings if exported | v1 |
| `get_daily` | range, `sources` (`mf`, `oura`, `both`), `fields` (optional subset), `align` (see Dates), `include_derived` | Joined table, one row per local day: the MacroFactor and Oura must-have fields below, plus derived columns on request | v1 |
| `get_weekly` | range, `week_start` (weekday), `sources` | One row per week of the aggregates under Derived metrics, with days-with-data counts | v1 |
| `get_sleep_detail` | range, `include_series` (single night only) | Per sleep period: type (main or nap), timing, stages, HRV, HR, breathing, efficiency, latency; optional 5-min HRV and HR series for one night | v1 |
| `get_food_log` | range, `search` (optional text) | Food entries: date, time, name, amount, kcal, protein, carbs, fat, fiber, alcohol, sodium | v1 |
| `get_checkins` | range | MacroFactor check-ins: date, expenditure, new calorie and macro targets, goal type, goal weight, rate | v1 if the export has them |
| `get_events` | range | Oura tags, rest-mode periods, and Oura-detected workouts | v2 |
| `query` | `sql` | Read-only SELECT over the normalized tables, schema in the tool description, 500-row cap | v2 |

`query` is the escape hatch: it answers one-off questions (say, HRV on nights after ≥30 g alcohol vs none) without a new tool each time.

## Dates and time zones

A row's date is a local calendar day, and effects of day D's food show up in row D+1. Getting this wrong makes every alcohol-to-HRV reading off by a day.

| Column group | What row D means |
| --- | --- |
| MacroFactor intake, targets | Food logged on D |
| MacroFactor scale and trend weight | Weigh-in on the morning of D |
| MacroFactor expenditure | The app's estimate for D |
| Oura sleep, HRV, resting HR, temperature | The main sleep that ended on the morning of D (Oura's own `day`) |
| Oura readiness | Computed the morning of D, from the night before |
| Oura activity, steps, stress | Activity during D |

- **`align` parameter.** `align=calendar` (default) returns the table above. `align=intake_to_night` shifts the Oura sleep and readiness columns back one day, so each row pairs D's intake with the night that followed it. The response header states which alignment was used.
- **No single time zone.** Use each source's own local date. Never convert everything to one zone. Include Oura's UTC offset as a column so travel days are visible (Greece, UTC+3, Oct 9–17; Sweden, UTC+1, Dec 20–Jan 3).
- **Flight days stay as they come.** Short or doubled days get a `tz_change` flag, not a fix.
- **Split nights.** If one day has two main-sleep periods, sum durations and stages, take the minimum lowest HR, and weight HRV by duration. Flag the row.
- **Weeks.** `get_weekly` weeks start on `week_start`, default from a config value set to the MacroFactor check-in weekday, so weekly rows line up with what the app reports.

## MacroFactor fields

Trend weight, expenditure, and targets are the three that nothing else carries; everything the plan steers by starts there. Quick Export confirms expenditure, weight trend, scale weight, calories, macros, micros, daily nutrition targets, and the food log; steps and body metrics are only in Granular Export. Parse one real file of each before building, map by header name, and list any field below that is missing.

| Field | Unit | Priority | Why |
| --- | --- | --- | --- |
| Trend weight | lb | Must | The rate check (%/week) and every phase end condition |
| Scale weight | lb, null if no weigh-in | Must | Spikes vs trend explain sodium, alcohol, travel |
| Expenditure | kcal | Must | Surplus sizing; why check-ins moved |
| Calories | kcal | Must | Intake vs expenditure and target |
| Protein, carbs, fat | g | Must | Protein floor; carbs are the flex macro. Carbs are total carbs, logged without fiber subtraction: never compute net carbs |
| Fiber | g | Must | Context for carbs as logged |
| Alcohol | g ethanol | Must | Logged in MacroFactor's dedicated field; the main HRV and scale confounder |
| Calorie and macro targets for the day | kcal, g | Must | Adherence without guessing which target applied |
| Sodium | mg | Must | Scale spikes and scan-window checks |
| Steps, if MacroFactor stores them | count | Should | See the steps question under Open questions |
| Food entries: time, name, amount, kcal, macros, alcohol, sodium | as above | Should | Meal timing, pre-training carbs, shake use, late meals vs sleep |
| Check-ins: date, expenditure, targets set, goal type, goal weight, rate | as above | Should | The history of what the app decided and when |
| Body metrics, if logged (waist) | in | Could | The plan's waist guardrails |

Logging conventions the parser should not "fix": restaurant meals are Quick Add entries with no food name, and high-sodium or high-intake days keep their weigh-ins.

## Oura fields

Readiness, main-night HRV and lowest HR, sleep duration, and temperature deviation are the recovery signal; the rest is context. Endpoint names are approximate, written from memory; confirm them against Oura's v2 API docs.

| Field | Oura v2 source | Priority | Why |
| --- | --- | --- | --- |
| Readiness score and all contributors (HRV balance, resting HR, body temperature, recovery index, sleep balance, previous night, previous-day activity, activity balance) | `daily_readiness` | Must | Day-to-day intensity calls; not available in Apple Health |
| Temperature deviation and trend deviation | `daily_readiness` | Must | Illness, alcohol, and travel signal |
| Main sleep: total sleep, time in bed, efficiency, latency, deep, REM, light, awake, bedtime start and end | `sleep` (main-sleep type) | Must | Recovery; late nights vs training quality |
| Main sleep: average HRV (ms), lowest HR, average HR, average breathing rate | `sleep` | Must | The most objective recovery markers |
| Sleep score and contributors | `daily_sleep` | Must | Oura's own summary, for comparison |
| Steps, active kcal, activity score, high and medium activity minutes, sedentary minutes | `daily_activity` | Must | Step floor; activity context. Oura's total kcal is not needed; MacroFactor expenditure is the energy number |
| Stress-high and recovery-high minutes, resilience level | `daily_stress`, `daily_resilience` | Should | Load outside the gym, e.g. travel and work weeks |
| Naps: timing and duration | `sleep` (nap types) | Should | Kept separate so they don't distort main-night numbers |
| Tags (alcohol, late meal, sick, travel, and custom) | `enhanced_tag` | Should | Context for alcohol, late meals, and illness, if tagged |
| Rest-mode periods | `rest_mode_period` | Should | Marks sick days so baselines can exclude them |
| SpO2 average, breathing disturbance index | `daily_spo2` | Could | Sleep quality context |
| VO2 max, cardiovascular age | `vO2_max`, `daily_cardiovascular_age` | Could | Slow cardio-health trend |
| Oura-detected workouts | `workout` | Could | Dial is the training record; Oura's copy is only a fallback |
| 5-minute HRV and HR during sleep | `sleep` series | On request | One-night deep dives only, via `get_sleep_detail` |
| Daytime heart rate stream | `heartrate` | Not needed | High volume, low value for these questions |

## Derived metrics

The server computes only arithmetic Claude would otherwise redo every call: rolling means, baselines, rates, and weekly sums. Nulls are skipped and every aggregate reports its `n`.

| Metric | Definition | Where |
| --- | --- | --- |
| Energy balance | Calories − expenditure, kcal | Daily, weekly mean |
| Trend rate | (trend weight D − trend weight D−7) ÷ trend weight D−7 × 100, %/week | Daily, weekly |
| Weekly trend change | Trend weight at week end − at week start, lb and %/week | Weekly |
| HRV 7-day mean and 30-day baseline | Main-night average HRV; % deviation of 7-day vs baseline | Daily (`include_derived`), weekly |
| Lowest-HR 7-day mean and 30-day baseline | Same method as HRV | Daily (`include_derived`), weekly |
| Sleep 7-day mean | Total main sleep, minutes | Daily (`include_derived`) |
| Intake means | Calories, protein, carbs, fat, fiber, sodium | Weekly |
| Alcohol | Total g ethanol and number of drinking days | Weekly |
| Target adherence | Mean calorie target, mean deviation (kcal and %), days over and under | Weekly |
| Logging coverage | Days logged, weigh-ins, nights with Oura data | Weekly |
| Recovery means | Readiness (mean and minimum), sleep efficiency, temperature deviation | Weekly |
| Steps | Mean, minimum, and days ≥ `steps_threshold` when that parameter is passed | Weekly |

Baselines exclude rest-mode days and return null with fewer than 14 valid days in the 30-day window.

## Operational requirements

One always-on, single-user server on public HTTPS, with Oura synced on a schedule and MacroFactor ingested from exports.

- **Reachability.** Claude connects to custom connectors from Anthropic's cloud on every client, including Desktop and iOS, so the server must be reachable over the public internet ([Anthropic](https://support.claude.com/en/articles/11175166-get-started-with-custom-connectors-using-remote-mcp)). Proposed host: Cloudflare Workers (see Proposed stack and build order).
- **Transport.** Streamable HTTP. Tools only; no resources or prompts needed.
- **Connector auth.** OAuth, single user, with token refresh, using Oura as the login: connecting in Claude runs Oura's consent screen, which both authorizes the connector and stores the Oura tokens. Only Daniel's Oura user ID is accepted. The connector form accepts a custom OAuth client ID and secret under Advanced settings. Claude's hosted OAuth callback is `https://claude.ai/api/mcp/auth_callback`; confirm it, and whether `claude.com` also needs allowlisting, in [Anthropic's building guide](https://claude.com/docs/connectors/building). No authless secret-in-URL: this is health data.
- **Read-only annotation.** Mark every tool `readOnlyHint: true`, so choosing "Allow always" in the app is a safe default.
- **Oura.** Daniel's own OAuth app at cloud.ouraring.com, requesting only the read scopes the fields above need. Store refresh tokens encrypted and handle rotation. Follow pagination (`next_token`). Backfill all history once, then sync nightly. Re-fetch the last 3 days on every sync, because Oura revises recent days after the ring syncs. Also sync on demand when a request touches the last 3 days. Use Oura's sandbox data for test fixtures, if the API still offers it.
- **MacroFactor.** Pushed from the phone in three feeds (see MacroFactor ingestion below), through an upload endpoint rather than a watched Google Drive folder; parsing and precedence rules are in that section, and unknown layouts fail loudly in `get_status` rather than misparse.
- **Storage.** Normalized tables per source, keyed by local date. These are also what `query` reads.
- **Errors.** A range past coverage returns the covered part plus a note, not an error. Messages say what is stale and the fix, e.g. "MacroFactor data ends Oct 4; last export Oct 5 08:12 — export again for newer days."
- **Privacy.** No request or response payload logging. Secrets in the host's secret store. A single command that wipes all stored data.

## MacroFactor ingestion

Three feeds, all pushed from the phone: a one-time backfill, a weekly export for MacroFactor's computed numbers, and an automatic daily snapshot so recent days are never more than a day stale.

| Feed | When | What it carries | How it arrives |
| --- | --- | --- | --- |
| Backfill | Once | Granular Export, All Time, every box, plus the Food Log on All Time: full history including steps and body metrics | Share sheet → upload Shortcut → `POST /ingest/export` |
| Weekly export | Check-in day | Quick Export, last 14 days: expenditure, trend and scale weight, intake, micros, daily targets, food log | Share sheet → upload Shortcut → `POST /ingest/export` |
| Daily snapshot | Personal automation at \~23:55 local, run without confirmation | Get Nutrition State JSON (today's consumption and goals, macros and micros), plus Apple Health scale weight and summed steps via Find Health Samples | Shortcut → `POST /ingest/daily` |

- **Precedence.** Exports are authoritative. Snapshots are provisional, and any export covering a date overwrites them. `get_daily` flags snapshot-only rows `provisional`; `get_status` reports each feed's freshness separately.
- **Why 23:55.** Get Nutrition State returns today only, with no date parameter. Entries added after the run wait for the weekly export; the 14-day window guarantees they arrive.
- **What the snapshot can't carry.** Trend weight and expenditure come only from exports. The server never estimates them from snapshot data.
- **Upload auth.** Both ingest endpoints are write-only, so a static bearer token stored in the Shortcuts is acceptable there. The MCP read side keeps OAuth.
- **Confirmation.** Each ingest returns one line for the Shortcut to show as a notification, e.g. "Ingested Sep 16–29 (export), data through Sep 29."
- **Test with the phone locked.** iOS restricts Health data while the iPhone is locked, so Find Health Samples may fail at 23:55. Accept partial payloads (nutrition without weight or steps) and record which fields were missing.
- **Parsing.** Workbooks by header name, JSON by key. An unknown layout fails loudly in `get_status` instead of misparsing. Keep every raw workbook and payload for reprocessing.

## Proposed stack and build order

Cloudflare is proposed, not decided: every piece the spec needs has a managed equivalent there, and nothing runs on Daniel's machines.

| Need | Proposed piece |
| --- | --- |
| MCP server over Streamable HTTP | Workers |
| Connector OAuth, with Oura as the upstream login | Cloudflare's OAuth provider library for Workers (check the current package) |
| Normalized tables, and what `query` reads | D1 (SQLite) |
| Raw workbooks and payloads | R2 |
| Nightly Oura sync | Cron Trigger |
| Oura client secret, upload token | Worker secrets |
| Workbook parsing | A JavaScript xlsx parser that runs in Workers (check bundle size and compatibility) |

Build in this order, so something usable exists after step 1:

1. Connector auth with Oura as the login, Oura backfill and nightly sync, `get_status`, and an Oura-only `get_daily`. Done when Claude Desktop and the iOS app can both call it.
2. Export ingestion (`POST /ingest/export` and the share-sheet Shortcut), MacroFactor columns in `get_daily`, `get_food_log`, and `get_checkins` if the export has check-ins.
3. The daily snapshot (`POST /ingest/daily` and the 23:55 automation), with provisional flags and export precedence.
4. `get_weekly`, derived metrics, and `get_sleep_detail`; then the v2 tools, `get_events` and `query`.
5. Acceptance test: in the Fitness Journey project, have Claude run every question in the Purpose table against the live connector, and fix whatever it trips on.

## Out of scope

- **Any write**: food logging, weight entries, Oura tags.
- **MacroFactor's unofficial API** via stored username and password: a terms-of-service gray area, it breaks on app updates, and it holds credentials.
- **Verdicts**: "on track", "recovered", "over budget". Claude judges against the plan.
- **Recomputing** MacroFactor's trend and expenditure or Oura's scores.
- **Training data from Oura.** Dial is the training record.
- **Multi-user support.**

## Open questions and next source

Five answers change defaults or whether a tool exists; settle them before building those parts.

- [ ] Which weekday is the MacroFactor check-in? Sets the `week_start` default.
- [ ] Does Quick Export include check-in history, and does Get Nutrition State's JSON include alcohol? The first decides whether `get_checkins` ships in v1; if the second is no, alcohol arrives only with the weekly export. Targets, food entries, and micros are confirmed.
- [ ] Which step count is the plan's source of truth: Oura, the iPhone via Apple Health (recently \~6k/day), or MacroFactor's import? They will differ. Pick one for the floor and expose the others.
- [ ] Where are waist measurements logged? The bulk's waist guardrail and the cut's arm and waist tripwires need them. If nowhere in these sources, add a tiny manual table here.
- [ ] Are Oura tags used? If not, `get_events` stays v2.

**Next source: Dial, after v1.** v1 ships without Dial. Adding it later puts the cut's main tripwire (indicator-lift e1RM down more than 5% for two weeks) and block labels (familiarization, Block 1, deloads) beside recovery and intake. Keep one table set per source now, so Dial later adds tables and `get_daily` columns without changing existing ones.

Proposed approach: Dial is on-device only, so it exposes an App Intent that returns its training data as JSON from a `since` date. The nightly 23:55 Shortcut calls it and sends the result along with the MacroFactor and Health data, so Dial never knows the server exists. Each night sends a rolling 14-day window that the server replaces wholesale, which carries edits and deletions; the same intent, run once by hand, does the backfill. The server stores Dial's own e1RM rather than recomputing it. Not through iCloud: the server can't read Dial's private CloudKit data, and it would tie the server to Dial's persistence internals.
