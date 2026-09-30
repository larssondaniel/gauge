# Decisions

Where the implementation departs from a proposal in `SPEC.md`, the entry below says what changed and why. Requirements are never changed here; those need Daniel's OK in the spec itself. Newest entries at the bottom. Status is `proposed` until Daniel has reviewed it, then `accepted` or `rejected`.

Format: ID, date, spec section, what the spec proposed, what we do instead, why.

---

## D-001 · 2026-09-29 · Proposed stack: MCP transport library

**Spec:** Workers, with Cloudflare's remote-MCP pattern (which at spec time meant `McpAgent` on a Durable Object).
**Decision:** Use `createMcpHandler` from `agents/mcp/server` (stateless Streamable HTTP at `/mcp`, no Durable Object). Fall back to the MCP SDK v2 `WebStandardStreamableHTTPServerTransport` directly if the `agents` dependency proves awkward.
**Why:** Cloudflare's docs now say `McpAgent` is deprecated and feature-frozen. A stateless handler is also simpler and cheaper: no Durable Object binding, nothing to hibernate. Anthropic's quickstart runs a sessionless server, but no page states that claude.ai itself connects to one, so step 1's exit test (Desktop and iOS both call the server) is where this gets confirmed.
**Status:** accepted (Daniel, 2026-09-30)

## D-002 · 2026-09-29 · Connector auth: Oura as the login is now the only option, plus where the Oura tokens live

**Spec:** Oura as the upstream login (proposal).
**Decision:** Keep it, and treat it as settled. Store the Oura refresh token outside the OAuth grant, in KV encrypted with a Worker secret, so the scheduled sync can use it without a Claude session. Oura refresh tokens are single-use, so refreshes are serialized (one in flight) and a failed refresh flips `get_status` to "reconnect the connector in Claude" instead of retrying blindly.
**Why:** Oura deprecated Personal Access Tokens in December 2025, so OAuth is the only way to read Oura data; using that same consent as the connector login costs nothing extra. Grant props in the OAuth library are only reachable during a Claude request, and the nightly cron has none.
**Status:** accepted (Daniel, 2026-09-30)

## D-003 · 2026-09-29 · Storage: KV for raw workbooks and payloads instead of R2

**Spec:** R2 for raw workbooks and payloads.
**Decision:** Store raw uploads in KV (one key per upload, value ≤ 25 MiB) alongside the `OAUTH_KV` namespace the OAuth library already requires. D1 stays the normalized store. Drop R2 from the stack.
**Why:** R2 needs a separate subscription checkout, and community reports say a card is required even at zero usage. KV is on the free plan, the library already forces a KV binding, and a single user's exports are a few MB a week. Fewer products, same "keep every raw file" guarantee.
**Status:** accepted (Daniel, 2026-09-30)

## D-004 · 2026-09-29 · Oura sync: every 2 hours, not nightly

**Spec:** Nightly cron plus on-demand sync when a request touches the last 3 days.
**Decision:** Cron every 2 hours, re-fetching the last 3 days each run. On-demand sync stays, with a 10-minute debounce so a burst of tool calls does not hit Oura repeatedly. Oura webhooks (which exist for every type we use) are noted as a v2 option, not built now.
**Why:** Oura data lands whenever the ring syncs with the phone, not at night, so a single nightly run leaves the morning readiness score stale until the next day. Cron Triggers are free, Oura's limit is 5,000 requests per 5 minutes, and a 2-hour cadence uses about a dozen requests each run.
**Status:** accepted (Daniel, 2026-09-30)

## D-005 · 2026-09-29 · Daily snapshot: date-stamped partial payloads, merged per field, from up to two automations

**Spec:** One 23:55 automation sending Get Nutrition State plus Apple Health scale weight and steps in one payload.
**Decision:** `POST /ingest/daily` accepts `{ date, nutrition?, health? }`. Any subset may be present; the server merges per field with last-write-wins per date and records which fields each post carried. Two phone automations feed it:
1. 23:55 local: nutrition only (MacroFactor's Shortcut action, no HealthKit).
2. A morning trigger that fires when the phone is unlocked (proposed: "when MacroFactor is opened", or Oura): yesterday's steps and today's weigh-in from Health.
`get_daily` keeps the single `provisional` flag; `get_status` reports the latest nutrition and health snapshot separately.
**Why:** Apple's HealthKit docs are explicit that the store is encrypted while the device is locked and reads fail with `errorDatabaseInaccessible`; only writes are queued. At 23:55 the phone is usually locked, so the Health half of a single payload would fail most nights. Splitting the feeds keeps the nutrition snapshot reliable and lets the Health part run when it can succeed. Steps for day D are only final after D ends, so a morning fetch of D's steps is the right time anyway. Whether MacroFactor's action itself runs while locked is unknown; the 23:55 automation is the test.
**Status:** accepted (Daniel, 2026-09-30; phone is normally locked at 23:55)

## D-006 · 2026-09-29 · Weekly export window: widest preset MacroFactor offers, 14 days minimum

**Spec:** Quick Export, last 14 days.
**Decision:** Use the widest time-frame preset MacroFactor's Quick Export offers that is still one tap (30 days if it exists), never less than 14. The server treats every export as authoritative for every date it covers, so a wider window just carries more revisions.
**Why:** MacroFactor revises recent trend weight and expenditure as new data arrives. A wider export brings those revisions in for free; the cost is a few extra rows.
**Status:** accepted. Presets are Last 7 Days, Last 14 Days, Last 30 Days, This Month, Last Month; the weekly export uses **Last 30 Days**.

## D-007 · 2026-09-29 · Output format: CSV block by default

**Spec:** Compact tables, format details open.
**Decision:** Default `format=csv`: header lines prefixed `#` (freshness per source, alignment used, missing days), then one CSV block with a header row, units in column names (`trend_weight_lb`, `sleep_total_min`), ISO dates, empty cell for null. `format=json` returns the same rows as an array of objects. No markdown tables.
**Why:** Markdown tables spend roughly twice the tokens of CSV on pipes and padding, and the reader is Claude, not a human. Claude parses CSV reliably, and the `#` header lines keep the freshness notes visible without a second structure.
**Status:** accepted (Daniel, 2026-09-30)

## D-008 · 2026-09-29 · Baselines: the recent window is excluded from the baseline, and both windows are parameters

**Spec:** 7-day mean vs 30-day baseline; null under 14 valid days.
**Decision:** Baseline is the `baseline_days` (default 30) ending the day before the `recent_days` (default 7) window, so the two do not overlap. Both are parameters on `get_daily` and `get_weekly`. The 14-valid-day floor and the rest-mode exclusion stay.
**Why:** With the 7 days inside the 30, a real deviation is damped by about a quarter before Claude sees it. Making the windows parameters follows the spec's own rule that thresholds are parameters, not constants.
**Status:** accepted (Daniel, 2026-09-30)

## D-009 · 2026-09-29 · Main sleep is Oura's `long_sleep`; the split-night rule gets the missing details

**Spec:** Main sleep from `sleep` (main-sleep type); split nights summed with min lowest HR and duration-weighted HRV.
**Decision:** Main sleep = records with `type = long_sleep`. `sleep`, `late_nap`, and `rest` go to the naps table; `deleted` records are dropped. When two `long_sleep` records share a `day`: durations and stages summed, lowest HR = minimum, HRV and average HR duration-weighted, efficiency time-in-bed-weighted, `bedtime_start` = earliest, `bedtime_end` = latest, latency from the first period, row flagged `split_night`. How Oura assigns a sleep record's `day` is not documented (the spec only says "day that the sleep belongs to"); the backfill will compare `day` with the local date of `bedtime_end` and the result gets logged here. **Result (2026-09-30, 812 main sleeps since 2022):** `day` equals the local date of `bedtime_end` in every record, so Oura's day is the wake-up date. Row D's sleep is the night that ended on the morning of D, as the spec assumed.
**Why:** Using Oura's own classification follows "use the apps' own numbers". The spec's rule left efficiency, average HR, and timing unspecified.
**Status:** accepted (Daniel, 2026-09-30)

## D-010 · 2026-09-29 · `query`: read-only is enforced in code

**Spec:** Read-only SELECT over the normalized tables, 500-row cap.
**Decision:** D1 has no read-only mode (no `PRAGMA query_only`, and read-replica sessions forward writes to the primary), so the server allowlists: exactly one statement, starting with `SELECT` or `WITH` after stripping comments, no semicolons, no `ATTACH`/`PRAGMA`/`VACUUM`, then wrapped as `SELECT * FROM (…) LIMIT 500`. Still v2.
**Why:** The only enforcement available; OAuth and the single-user scope make it acceptable.
**Status:** accepted (Daniel, 2026-09-30)

## D-011 · 2026-09-29 · Build order gets a step 0: parse the samples locally first

**Spec:** Build order 1–5.
**Decision:** Step 0, before any Worker code: pure parsing modules for the Quick Export, Granular Export, and nutrition-state JSON, with unit tests against the three samples (which never enter git), producing the header-to-field map and the list of spec fields the exports lack. Steps 1–5 unchanged.
**Why:** The samples exist before the first line of code, the parsers are the part most likely to be subtly wrong, and they need no Cloudflare account to test.
**Status:** accepted (Daniel, 2026-09-30)

## D-012 · 2026-09-29 · Ingest failures are loud at upload time as well

**Spec:** Unknown layouts fail loudly in `get_status`.
**Decision:** An unrecognised workbook or JSON layout also returns a 4xx with a one-line reason, which the Shortcut shows as its notification. `get_status` records it too. The raw file is kept either way.
**Why:** The person holding the phone is the one who can re-export; telling only Claude, hours later, wastes a day.
**Status:** accepted (Daniel, 2026-09-30)

## D-013 · 2026-09-29 · Privacy defaults on Cloudflare

**Spec:** No request or response payload logging; a single wipe command.
**Decision:** `observability.enabled = false` in the Wrangler config (it is on by default for new Workers and in Cloudflare's OAuth template), no `console.log` of bodies, and no Logpush. The wipe is an npm script that empties the D1 tables and both KV namespaces, not an MCP tool.
**Why:** The spec's privacy requirement; the wipe cannot be a tool because every tool is read-only.
**Status:** accepted (Daniel, 2026-09-30)

## D-014 · 2026-09-29 · Workbook parser: SheetJS 0.20.3 from the SheetJS CDN

**Spec:** A JavaScript xlsx parser that runs in Workers; check size and compatibility.
**Decision:** SheetJS Community Edition 0.20.3 installed from `https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz` (npm's `xlsx` is frozen at 0.18.5).
**Why:** Tested on 2026-09-29: a Worker under `wrangler dev` parsed a generated workbook in 9 ms without `nodejs_compat`. The ESM build is about 1 MB unminified; the Workers bundle limit is now 64 MiB uncompressed on all plans, so size is not a concern.
**Status:** accepted (verified by test)

## D-015 · 2026-09-30 · Step floor: Oura steps are the source of truth

**Spec:** Open question; pick one for the floor and expose the others.
**Decision:** `steps` in `get_daily` and the weekly step aggregates come from Oura `daily_activity`. The iPhone's Health steps (`steps_health`, via the morning snapshot) and MacroFactor's imported steps (`steps_mf`, Granular Export) are separate columns, never merged.
**Why:** The ring is worn all day while the phone is not always carried, so Health undercounts on exactly the days that matter. Oura steps arrive through the 2-hour sync with no phone automation in the path, so the floor check never depends on the snapshot succeeding. Oura's own activity score is computed from the same number.
**Status:** accepted (Daniel, 2026-09-30)

## D-016 · 2026-09-30 · Week start is Monday; `get_events` stays v2

**Decision:** `WEEK_START` config defaults to Monday, the MacroFactor check-in day from now on. Daniel does not use Oura tags, so `get_events` stays in v2; rest-mode periods are still synced from the start because baselines exclude them.
**Status:** accepted (Daniel, 2026-09-30)

## D-017 · 2026-09-30 · Oura backfill finds its own start date

**Spec:** Backfill all history once.
**Decision:** The backfill first probes `daily_activity` one year at a time from 2015 forward until the first non-empty year, then fetches every endpoint in 3-month chunks from the start of that year to today, pacing well under Oura's 5,000-per-5-minute limit.
**Why:** Daniel has worn the ring for "a few years at least" and cannot pin the date; a dozen probe requests beat guessing. Oura's FAQ suggests 1–3 month windows.
**Status:** accepted (Daniel, 2026-09-30)

## Confirmed since the fact checks · 2026-09-30

- MacroFactor's read-only action is named **Get Nutrition State** ("Returns today's consumption and progress to goal(s)"). It takes optional Nutrient and Calculation parameters and an optional JSON input; the sample will show what it returns with those left empty.
- Quick Export has two boxes: MacroFactor Data (expenditure, weight trend, scale weight, calories, macros, micros, primary nutrition targets, food log) and MacroFactor Workouts Data. The workouts box is irrelevant here (Dial is the training record); the parser ignores unknown sheets.
- Get Nutrition State options (seen 2026-09-30): Nutrient covers Calories, Protein, Fat, Carbs, Alcohol, Caffeine, Water, Cholesterol, Choline, amino acids, Fiber, Net Carbs (Non-Fiber), Starch, Sugars, Sugars Added, fat subtypes, vitamins, and minerals including Sodium. Calculation is one of Consumed, Remaining to Minimum, Remaining to Goal, Remaining to Maximum. The output is a single Number. The snapshot uses "Carbs" (total), never "Net Carbs".
- Get Nutrition State behaviour (tested 2026-09-30): Sodium Remaining to Goal returned -1228.28 (mg, goal exceeded); Alcohol Remaining to Goal returned nothing, so no-goal nutrients become null. The action is `com.sbs.diet.GetNutritionStateAppIntent` with parameters `calculation` (`remainingToTarget` seen; `consumed` and the min/max variants to confirm) and `target.value` = nutrient identifier using USDA nutrient numbers (Sodium = 307; so Energy 208, Protein 203, Fat 204, Carbs 205, Fiber 291, Alcohol 221, to be confirmed when the generated shortcut is first opened). The structure-only plist is kept at `shortcuts/templates/get-nutrition-state.xml`.
- Oura OAuth app created with scopes personal, daily, heartrate, tag, workout, spo2, stress, heart_health; redirect `https://gauge.broken-water-22ee.workers.dev/callback`.

## D-018 · 2026-09-30 · Nightly nutrition snapshot is assembled by the Shortcut, one action call per value

**Spec:** Get Nutrition State JSON (today's consumption and goals) pushed to `POST /ingest/daily`.
**Decision:** MacroFactor's Get Nutrition State action returns a single Number per (Nutrient, Calculation) pair; the JSON summary is emitted only by its logging actions, which this project never uses. So the 23:55 Shortcut calls Get Nutrition State once per needed value (calories, protein, carbs, fat, fiber, alcohol, sodium × Consumed and Remaining to Goal, about 14 calls), assembles a Dictionary with the local date, and posts it as JSON. The server derives `target = consumed + remaining_to_goal` per nutrient and stores null where the action returns nothing. The Shortcut is generated on the Mac from a plist template and signed with `shortcuts sign --mode anyone`, so it can be rebuilt when the field list changes instead of hand-edited on the phone. The Food Log export is CSV, so `/ingest/export` accepts CSV as well as xlsx.
**Why:** Read-only is a requirement, and a snapshot that depends on a logging action would violate it. Fourteen local action calls cost nothing at 23:55.
**Status:** accepted (Daniel, 2026-09-30)

## D-019 · 2026-09-30 · What the real exports carry (step 0 result)

**Decision:** Parsers are header-mapped and tested against the three samples (`npm test`; sample tests skip when `samples/` is absent). Findings that shape steps 1–3:
- Quick Export (30 days) carries every daily must-have: expenditure, trend and scale weight, calories, protein, carbs, fat, fiber, alcohol, sodium, the four daily targets, steps, plus 45 other nutrient columns kept in a `micros` map. It also carries the 30-day Food Log sheet. Nothing from the spec's daily list is missing.
- Granular Export (All Time) carries the same daily fields spread over sheets, merged by date; it lacks daily targets (its "Micronutrient Goals" sheet is empty) but has "Nutrition Program Settings": one row per weekday per check-in (441 rows since 2025-03-11) with calories, macros, expenditure, and trend weight at the check-in. The importer will derive the historical daily target for day D from the check-in active on D and D's weekday, so backfilled days get targets without inventing numbers. `get_checkins` ships in v1 from this sheet plus "Weight Goals" (goal type, weight, rate, dates).
- Body Metrics has one row (2025-08-06) with chest and bicep only; waist is empty. The bulk's waist guardrail therefore has no source yet; a manual entry path is left for a later decision.
- Food Log arrives as CSV with a UTF-8 BOM, times as "hh:mm AM/PM", quick-adds named "Quick Add". `/ingest/export` accepts both xlsx and CSV.
- Dates are Excel serials in most sheets but "M/D/YYYY" strings in four sheets; the parser accepts both and fails loudly on anything else.
- "Fasting" and "Partial Logging" per-day flags exist and are kept on the daily row so under-logged days are visible.
- The "User Profile" sheet (name, email, birthday) is never read.
**Status:** accepted (verified by tests)

## D-020 · 2026-09-30 · Grants from a second Claude account are not revoked

**Decision:** `revokeExistingGrants: false` in the connector's OAuth provider. Daniel has two Claude accounts (the Fitness Journey project lives on one); the library's default revokes an earlier grant when the same client re-authorizes from the same callback, which would silently disconnect the other account. Grants still expire after 90 idle days.
**Status:** accepted

## D-021 · 2026-09-30 · Backfill ran on the Workers Free plan

**Decision:** Stay on the Free plan until something actually hits a limit. The full Oura backfill (2022-01 to today, 19 chunks of 92 days, 12 endpoints each) ran through the admin endpoint with no CPU-limit or subrequest errors. `get_status` and `get_daily` are well under the limits. Revisit if MacroFactor ingestion of the all-time Granular Export (1,700 daily rows plus 5,000 food entries in one request) fails; the fallback is to upgrade rather than to split the file.
**Status:** accepted

## D-022 · 2026-09-30 · Step 2 as built: ingestion precedence, food-log windows, check-in targets

**Decision:**
- `POST /ingest/export` takes the raw file body (or one multipart file), bearer `UPLOAD_TOKEN`, keeps the bytes in KV under `mf:upload:<time>:<name>`, and replies with one plain-text line. Unknown layouts answer 422 with the reason (D-012).
- Daily rows are upserted per column for the columns the layout carries: a Granular Export never overwrites the Quick Export's daily targets, and any export marks its rows `source=export`, which is how snapshot rows get replaced (step 3).
- The food log is replaced inside the file's own date window (Quick Export: its 30 days; Food Log CSV: the span of its entries) so edits and deletions carry over.
- Check-ins, weight goals, and body metrics are all-time lists and are replaced wholesale.
- Targets for days without export targets are filled from the check-in active that weekday (`targets_source=checkin`), never touching `targets_source=export` rows.
- The share-sheet Shortcut is generated and signed by `scripts/build-shortcuts.mjs` (files in git-ignored `shortcuts/build/`, since they embed the token).
- Verified on the Free plan with the real samples: Granular (1,712 days, 63 check-ins) 2.3 s, Food Log (5,325 entries) 3.7 s, Quick Export 1.2 s, no limit errors.
**Status:** accepted

## D-023 · 2026-09-30 · The export day itself stays provisional

**Decision:** Rows for the day an export was taken (and the day before, to absorb time-zone differences between the phone and UTC) are stored as `export_partial`. The nightly snapshot may overwrite them; the next export replaces them. `provisional=1` in `get_daily` covers both snapshot-only and export-partial days.
**Why:** Found on the first live run: a Quick Export made at breakfast wrote "7 kcal" for that day as authoritative, which would have blocked the 23:55 snapshot for the same day.
**Status:** accepted

## D-024 · 2026-09-30 · Step 3 live: what the first real snapshots showed

- Gauge Nightly ran by hand at 08:18 local: date and offset (-04:00) parsed from the ISO 8601 date, 7/7 nutrients, targets reconstructed to the export's values (2,536 kcal). MacroFactor's nutrient identifiers guessed from USDA numbers were wrong for Carbs, Fat, Fiber, Alcohol; Daniel re-picked them in the editor (real identifiers still to be read from the shared shortcut).
- Gauge Morning: Health weight arrives in pounds (180.80 lb, equal to the export's scale weight); Health steps for 2026-09-29 were 9,879 against Oura's 5,121, so Health likely sums phone and ring samples. Confirms D-015: Oura is the floor's source, `steps_health` is shown but never merged.
- Template-authored "Custom" date formats render as empty strings on the phone; the generator now uses ISO 8601 with time and the server derives the offset from it.
**Status:** accepted

## D-025 · 2026-09-30 · Shortcut generator corrected from the phone-built copy

MacroFactor nutrient identifiers: Calories `k`, Protein `p`, Carbs `c`, Fat `f`, Fiber `291`, Alcohol `221`, Sodium `307`; calculations `consumed` and `remainingToTarget`. Format Date takes its input in `WFDate` (a text token with the date attachment), and the ISO 8601 style with `WFISO8601IncludeTime` is what the phone writes. `scripts/build-shortcuts.mjs` now matches, so a rebuilt Gauge Nightly needs no edits on the phone.
**Status:** accepted

## D-026 · 2026-09-30 · Step 4 as built

- `get_daily include_derived=true` adds energy balance, trend rate, 7-day means and 30-day baselines with n and % deviation for HRV and lowest HR, and the 7-day sleep mean; `recent_days` and `baseline_days` are parameters (D-008).
- `get_weekly`: one row per week with the spec's aggregates; `week_start` overrides the config; `steps_source` (oura|health) and `steps_threshold` are parameters so the step floor's source can change without code (see D-015 and the pending Health comparison).
- `get_sleep_detail`: every sleep period, with the 5-minute HRV/HR series for a single main sleep on request.
- `get_events`: tags, rest-mode periods, and Oura-detected workouts.
- `query`: one SELECT, guarded in code (D-010), 500-row cap. Verified live with the spec's own example (HRV after ≥30 g alcohol vs none).
- `npm run wipe -- --yes` empties every D1 table and both KV namespaces (the spec's single wipe command).
**Status:** accepted

## D-027 · 2026-09-30 · Acceptance test result and two label fixes

All nine Purpose questions plus the SQL example were answered by Claude in the Fitness Journey project from the live connector (Desktop and iOS). Two defects surfaced, both in `get_checkins` labels:
- The check-in sheet's "Weight (lb)" is the scale reading at the check-in, not trend weight. Column renamed `scale_weight_lb_at_checkin`; trend comes from `get_daily`.
- "Goal Rate per Week (%)" in the Granular Export holds about 2.2× the percentage shown in the app (0.56 for a 0.25 %/week goal). The server never converts it; the column is now `rate_as_exported` with a note. Kept verbatim per "use the apps' own numbers".
Also seen in the answers: restaurant Quick Adds carry no sodium (a logging convention the spec says not to fix), and Health's merged step total vs Oura remains under observation (D-015).
**Status:** accepted

---

## Fact checks · 2026-09-29

Against current docs unless noted. Items the spec listed as unverified:

- **Oura endpoint names:** all correct as written, including `vO2_max` casing. `tag` is deprecated in favour of `enhanced_tag`. Extra endpoints exist (`session`, `sleep_time`, `ring_configuration`, `ring_battery_level`). Awake time is `awake_time`. Sleep `type` values: `deleted`, `sleep`, `long_sleep`, `late_nap`, `rest`. Series intervals are given in the record (`interval`), not fixed at 5 minutes. No hard max date range; Oura suggests 1–3 months per request. `end_date` behaved as exclusive in the sandbox; to be confirmed on real data. Rate limit 5,000 requests per 5 minutes.
- **Oura OAuth:** authorize `https://cloud.ouraring.com/oauth/authorize`, token `https://api.ouraring.com/oauth/token`, PKCE S256 recommended. Scopes: `email personal daily heartrate workout tag session spo2` plus `heart_health` (in the OpenAPI spec only). Access-token lifetime is whatever `expires_in` says. Refresh tokens rotate and are single-use; their lifetime is undocumented. **PATs deprecated December 2025.** Sandbox still exists (any bearer string accepted; no `personal_info`). Not verified: per-endpoint scopes for `sleep`, `daily_stress`, `daily_resilience`, `rest_mode_period`, `vO2_max`, `daily_cardiovascular_age`.
- **Claude's OAuth callback:** `https://claude.ai/api/mcp/auth_callback` is the documented one for web, Desktop, and mobile. `claude.com` is not in current docs; DCR makes the point moot because Claude registers its own redirect URI. Claude Code uses a loopback `http://localhost:<port>/callback`. Claude supports DCR, CIMD, and a manual client ID; sends PKCE S256; needs RFC 9728 protected-resource metadata behind a 401 and RFC 8414 auth-server metadata; refreshes tokens and expects `invalid_grant` on a dead refresh token. Tool results cap at about 150,000 characters; tool calls time out at 240 s. `readOnlyHint` and `destructiveHint` are expected on every tool and drive auto-permissions.
- **Cloudflare OAuth library:** `@cloudflare/workers-oauth-provider` 1.2.1 (2026-09-28), maintained, requires an `OAUTH_KV` binding, supports DCR, PKCE, refresh tokens, and the upstream-login pattern. `McpAgent` is deprecated (see D-001).
- **xlsx in Workers:** verified by test (see D-014).
- **Health reads while locked:** verified from Apple's docs. Reads fail with `errorDatabaseInaccessible` while locked; writes are queued (see D-005).
- **MacroFactor Shortcuts:** the official repo documents actions that return a `MacroFactorTodaySummary` with `consumed` and `remaining` (min/target/max) per nutrient, including `alcohol`, `sodium`, and `fiber`; targets are `consumed + remaining.target`. The exact action name "Get Nutrition State" was not found in the repo; the sample JSON settles it.
