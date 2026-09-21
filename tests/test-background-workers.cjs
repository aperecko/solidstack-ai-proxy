
"use strict";
const path = require("path"), assert = require("assert"), fs = require("fs");
const BASE = path.join(__dirname, "..", "src");
let passed = 0, failed = 0;
function test(name, fn) { try { fn(); console.log("  \u2713 " + name); passed++; } catch(e) { console.error("  \u2717 " + name + ": " + e.message); failed++; } }

console.log("\n\u2500\u2500\u2500 test-background-workers \u2500\u2500\u2500\n");

console.log("1: File presence");
["utils/omniroute-db.js","utils/token-refresh-circuit-breaker.js",
 "background/quota-rollup-worker.js","background/migration-tracker.js",
 "background/parallel-limits-sync.js"].forEach(f =>
  test("exists: src/"+f, () => assert.ok(fs.existsSync(path.join(BASE,f)), "Missing: "+f)));

console.log("2: Token circuit breaker (Area 1)");
test("30-min guard + guardedRefresh + getCircuitState", () => {
  const s = fs.readFileSync(path.join(BASE,"utils/token-refresh-circuit-breaker.js"),"utf8");
  assert.ok(s.includes("REFRESH_GUARD_MS"), "no REFRESH_GUARD_MS");
  assert.ok(s.includes("30 * 60 * 1000"), "no 30 min constant");
  assert.ok(s.includes("guardedRefresh"), "no guardedRefresh");
  assert.ok(s.includes("getCircuitState"), "no getCircuitState");
});
test("fleet trip threshold + 5-min reset", () => {
  const s = fs.readFileSync(path.join(BASE,"utils/token-refresh-circuit-breaker.js"),"utf8");
  assert.ok(s.includes("FLEET_TRIP_THRESHOLD"), "no FLEET_TRIP_THRESHOLD");
  assert.ok(s.includes("RESET_AFTER_MS"), "no RESET_AFTER_MS");
  assert.ok(s.includes("5 * 60 * 1000"), "no 5-min reset");
});

console.log("3: Parallel limits sync (Area 2)");
test("runParallelLimitsSync + invalidateQuota + isInvalidated + failedIds", () => {
  const s = fs.readFileSync(path.join(BASE,"background/parallel-limits-sync.js"),"utf8");
  assert.ok(s.includes("runParallelLimitsSync"), "no runParallelLimitsSync");
  assert.ok(s.includes("invalidateQuota"), "no invalidateQuota");
  assert.ok(s.includes("isInvalidated"), "no isInvalidated");
  assert.ok(s.includes("failedIds"), "no failedIds per-connection reporting");
  assert.ok(s.includes("WORKER_CONCURRENCY"), "no WORKER_CONCURRENCY");
});

console.log("4: Quota rollup worker (Area 3)");
test("5 rollup exports", () => {
  const s = fs.readFileSync(path.join(BASE,"background/quota-rollup-worker.js"),"utf8");
  ["runHourlyRollup","runDailyRollup","runQuotaStateSeed","runSnapshotPrune","registerRollupJobs"]
    .forEach(fn => assert.ok(s.includes(fn), "Missing export: "+fn));
});
test("ON CONFLICT upserts (idempotent)", () => {
  const s = fs.readFileSync(path.join(BASE,"background/quota-rollup-worker.js"),"utf8");
  assert.ok(s.includes("ON CONFLICT"), "no ON CONFLICT upsert");
});
test("provider_quota_state seeded via ROW_NUMBER", () => {
  const s = fs.readFileSync(path.join(BASE,"background/quota-rollup-worker.js"),"utf8");
  assert.ok(s.includes("provider_quota_state"), "no provider_quota_state");
  assert.ok(s.includes("ROW_NUMBER"), "no ROW_NUMBER latest-per-connection");
});
test("7-day snapshot retention", () => {
  const s = fs.readFileSync(path.join(BASE,"background/quota-rollup-worker.js"),"utf8");
  assert.ok(s.includes("-7 days"), "no 7-day prune");
});

console.log("5: Migration tracker (Areas 3+4)");
test("runMigrations + listMigrations exported", () => {
  const s = fs.readFileSync(path.join(BASE,"background/migration-tracker.js"),"utf8");
  assert.ok(s.includes("runMigrations"), "no runMigrations");
  assert.ok(s.includes("listMigrations"), "no listMigrations");
  assert.ok(s.includes("CREATE TABLE IF NOT EXISTS _omniroute_migrations"), "no migrations table");
});
test("migration 004 backfills quota thresholds (warn:20 critical:5)", () => {
  const s = fs.readFileSync(path.join(BASE,"background/migration-tracker.js"),"utf8");
  assert.ok(s.includes("quota_window_thresholds_json"), "no threshold column");
  assert.ok(s.includes("NULL"), "should patch NULL rows only");
  assert.ok(s.includes("warn") && (s.includes(": 20") || s.includes(":20")), "no warn:20");
  assert.ok(s.includes("critical") && (s.includes(": 5") || s.includes(":5")), "no critical:5");
});
test("migrations 001-005 all registered", () => {
  const s = fs.readFileSync(path.join(BASE,"background/migration-tracker.js"),"utf8");
  ["001_","002_","003_","004_","005_"].forEach(id => assert.ok(s.includes(id), "Missing: "+id));
});

console.log("6: server.js wiring");
test("imports migration-tracker", () => assert.ok(
  fs.readFileSync(path.join(BASE,"server.js"),"utf8").includes("migration-tracker"),"not found"));
test("imports quota-rollup-worker", () => assert.ok(
  fs.readFileSync(path.join(BASE,"server.js"),"utf8").includes("quota-rollup-worker"),"not found"));
test("imports token-refresh-circuit-breaker", () => assert.ok(
  fs.readFileSync(path.join(BASE,"server.js"),"utf8").includes("token-refresh-circuit-breaker"),"not found"));
test("calls runMigrations() at startup", () => assert.ok(
  fs.readFileSync(path.join(BASE,"server.js"),"utf8").includes("runMigrations()"),"not found"));
test("calls registerRollupJobs() at startup", () => assert.ok(
  fs.readFileSync(path.join(BASE,"server.js"),"utf8").includes("registerRollupJobs()"),"not found"));

console.log("\n" + "-".repeat(44));
console.log("Results: " + passed + " passed, " + failed + " failed");
if (failed === 0) { console.log("\u2705 All tests passed\n"); process.exit(0); }
else { console.log("\u274c Some tests failed\n"); process.exit(1); }
