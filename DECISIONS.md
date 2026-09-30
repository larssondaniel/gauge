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
**Decision:** Main sleep = records with `type = long_sleep`. `sleep`, `late_nap`, and `rest` go to the naps table; `deleted` records are dropped. When two `long_sleep` records share a `day`: durations and stages summed, lowest HR = minimum, HRV and average HR duration-weighted, efficiency time-in-bed-weighted, `bedtime_start` = earliest, `bedtime_end` = latest, latency from the first period, row flagged `split_night`. How Oura assigns a sleep record's `day` is not documented (the spec only says "day that the sleep belongs to"); the backfill will compare `day` with the local date of `bedtime_end` and the result gets logged here.
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
