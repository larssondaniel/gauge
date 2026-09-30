#!/usr/bin/env node
/**
 * Wipes every stored record (SPEC "Privacy"): all D1 rows, all raw uploads and
 * Oura tokens in DATA_KV, and all OAuth grants/tokens in OAUTH_KV. The schema
 * and the Worker stay; reconnecting the connector and re-ingesting rebuilds
 * everything. Requires `--yes`.
 *
 *   node scripts/wipe.mjs --yes
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

if (!process.argv.includes("--yes")) {
  console.error("This deletes all stored health data, tokens, and grants. Re-run with --yes to proceed.");
  process.exit(1);
}
const cfg = readFileSync("wrangler.jsonc", "utf8");
const db = /"database_name":\s*"([^"]+)"/.exec(cfg)[1];
const kvIds = [...cfg.matchAll(/"binding":\s*"(OAUTH_KV|DATA_KV)",\s*"id":\s*"([0-9a-f]+)"/g)].map((m) => ({ name: m[1], id: m[2] }));
const run = (args, input) => execFileSync("npx", ["wrangler", ...args], { encoding: "utf8", input, stdio: ["pipe", "pipe", "inherit"] });

const tables = JSON.parse(run(["d1", "execute", db, "--remote", "--json", "--command", "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name != 'd1_migrations'"]))[0].results.map((r) => r.name);
run(["d1", "execute", db, "--remote", "--command", tables.map((t) => `DELETE FROM ${t};`).join(" ")]);
console.log(`D1: emptied ${tables.length} tables`);

for (const kv of kvIds) {
  const keys = JSON.parse(run(["kv", "key", "list", "--namespace-id", kv.id])).map((k) => k.name);
  if (keys.length) run(["kv", "bulk", "delete", "--namespace-id", kv.id, "--force", "/dev/stdin"], JSON.stringify(keys));
  console.log(`${kv.name}: deleted ${keys.length} keys`);
}
console.log("Done. Reconnect the Gauge connector in Claude to sign in again, then re-ingest exports.");
