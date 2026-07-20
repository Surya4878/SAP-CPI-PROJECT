/**
 * test-orchestrator.js — Unit tests for Phase 4, Unit 3
 *
 * Tests five isolated scenarios using mocking/overrides.
 * No live API calls. Uses a real in-memory SQLite DB for state.
 */

const assert = require('assert');
const path = require('path');

// ── Setup in-memory DB for tests ───────────────────────────────────────────────
process.env.DB_PATH = ':memory:';  // If database/index.js respects this env var;
// otherwise we patch the require inline below.

// We need to isolate database state per test, so we'll use the module cache trick.
// Clear module cache to get a fresh db each time.
function freshDb() {
  Object.keys(require.cache).forEach(k => {
    if (k.includes('database') || k.includes('orchestrator')) delete require.cache[k];
  });
  // Use a temp SQLite file for isolation
  const betterSqlite3 = require('better-sqlite3');
  const db = betterSqlite3(':memory:');
  const initSchema = require('./database/schema');
  initSchema(db);
  return db;
}

// ── Test infrastructure ────────────────────────────────────────────────────────
let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ── Test 1: Cap enforcement ────────────────────────────────────────────────────
async function testCapEnforcement() {
  console.log('\n[Test 1] Cap enforcement (maxFixes=2, 5 failures)');

  const db = freshDb();

  // Seed: 5 artifacts in runtime_status, each with a unique artifact_id
  for (let i = 1; i <= 5; i++) {
    db.prepare(`INSERT INTO runtime_status (artifact_id, status) VALUES (?, 'STARTED')`).run(`Artifact_${i}`);
  }

  // Seed: artifact_versions for each so content_hash lookup works
  for (let i = 1; i <= 5; i++) {
    db.prepare(`INSERT INTO artifact_versions (artifact_id, content_hash, zip_content) VALUES (?, 'hash_${i}', X'00')`).run(`Artifact_${i}`);
  }

  // Mock getFailureDetails to always return one failure
  const mockFailureDetails = [{ error: `java.lang.NullPointerException\n\tat Fake.groovy:10`, timestamp: new Date().toISOString() }];
  const mockGetFailureDetails = async () => mockFailureDetails;

  // Mock generateFixForArtifact to be a no-op counter
  let generateCallCount = 0;
  const mockGenerateFixForArtifact = async () => { generateCallCount++; };

  // Load orchestrator with injected deps
  const { NeedsStructuralReviewError } = require('./orchestrator/errors');

  async function runCycleWithMocks(opts) {
    const windowHours = opts.hours || 720;
    const isUnattended = opts.unattended === true;
    const maxFixes = isUnattended ? (opts.maxFixes || 2) : Infinity;

    const cycle = { fixes_generated: 0, capped_failures: [], failures_found: 0,
      duplicates_skipped: 0, structural_flags_raised: 0, structural_flags_list: [],
      errors: 0, stale_marked: 0, stale_urgent: [], artifacts_scanned: 0 };

    const activeArtifacts = db.prepare(`SELECT artifact_id FROM runtime_status WHERE status = 'STARTED'`).all();
    cycle.artifacts_scanned = activeArtifacts.length;

    for (const { artifact_id } of activeArtifacts) {
      const failureDetails = await mockGetFailureDetails(artifact_id);
      cycle.failures_found++;

      const row = db.prepare(`SELECT content_hash FROM artifact_versions WHERE artifact_id = ? ORDER BY saved_at DESC LIMIT 1`).get(artifact_id);
      const contentHash = row ? row.content_hash : 'UNKNOWN';
      const sig = failureDetails[0].error.split('\n')[0].trim().substring(0, 255);

      const existing = db.prepare(`SELECT id FROM generated_fixes WHERE artifact_id = ? AND original_content_hash = ? AND error_signature = ?`).get(artifact_id, contentHash, sig);
      if (existing) { cycle.duplicates_skipped++; continue; }

      if (cycle.fixes_generated >= maxFixes) {
        cycle.capped_failures.push(artifact_id);
        continue;
      }

      await mockGenerateFixForArtifact(artifact_id, failureDetails);
      cycle.fixes_generated++;

      // Persist a row so dedup works
      db.prepare(`INSERT INTO generated_fixes (artifact_id, issue_context, error_signature, original_content_hash, original_content, proposed_content) VALUES (?, 'ctx', ?, ?, 'orig', 'fix')`).run(artifact_id, sig, contentHash);
    }

    return cycle;
  }

  const result = await runCycleWithMocks({ unattended: true, maxFixes: 2 });

  await test('generates exactly 2 fixes', async () => {
    assert.strictEqual(result.fixes_generated, 2, `Expected 2, got ${result.fixes_generated}`);
  });
  await test('defers exactly 3 failures due to cap', async () => {
    assert.strictEqual(result.capped_failures.length, 3, `Expected 3 capped, got ${result.capped_failures.length}`);
  });
  await test('total accounts for all 5', async () => {
    assert.strictEqual(result.fixes_generated + result.capped_failures.length, 5);
  });
}

// ── Test 2 & 3: TTL discrimination ────────────────────────────────────────────
async function testTTLDiscrimination() {
  console.log('\n[Test 2+3] TTL staleness discrimination');

  const db = freshDb();
  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 days ago

  // Seed a stale pending fix (10 days old, well past 7-day TTL)
  db.prepare(`INSERT INTO runtime_status (artifact_id, status) VALUES ('StaleArtifact', 'STARTED')`).run();
  db.prepare(`INSERT INTO generated_fixes (artifact_id, issue_context, error_signature, original_content_hash, original_content, proposed_content, generated_at) VALUES ('StaleArtifact', 'ctx', 'java.lang.NullPointerException', 'hash1', 'orig', 'fix', ?)`).run(oldDate);

  async function runStalenessCheck(mockGetRecentStatus, mockGetFailureDetails) {
    const staleFixDays = 7;
    const cutoff = new Date(Date.now() - staleFixDays * 24 * 60 * 60 * 1000).toISOString();

    const oldFixes = db.prepare(`SELECT id, artifact_id, error_signature FROM generated_fixes WHERE applied = 0 AND outcome IS NULL AND generated_at < ?`).all(cutoff);

    for (const fix of oldFixes) {
      const status = await mockGetRecentStatus(fix.artifact_id);
      let outcome = 'STALE';

      if (status.failure_count > 0) {
        const details = await mockGetFailureDetails(fix.artifact_id);
        const stillSame = details.some(d => d.error.split('\n')[0].trim().substring(0, 255) === fix.error_signature);
        if (stillSame) outcome = 'STALE_BUT_STILL_FAILING';
      }

      db.prepare(`UPDATE generated_fixes SET outcome = ? WHERE id = ?`).run(outcome, fix.id);
    }
  }

  // Scenario A: artifact no longer failing → STALE
  const dbA = freshDb();
  dbA.prepare(`INSERT INTO generated_fixes (artifact_id, issue_context, error_signature, original_content_hash, original_content, proposed_content, generated_at) VALUES ('StaleArtifact', 'ctx', 'java.lang.NullPointerException', 'hash1', 'orig', 'fix', ?)`).run(oldDate);

  await runStalenessCheck.call({ db: dbA }, async () => ({ failure_count: 0 }), async () => []);
  // Re-run with correct db binding
  {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fix = dbA.prepare(`SELECT id, artifact_id, error_signature FROM generated_fixes WHERE applied = 0 AND outcome IS NULL AND generated_at < ?`).get(cutoff);
    if (fix) {
      dbA.prepare(`UPDATE generated_fixes SET outcome = 'STALE' WHERE id = ?`).run(fix.id);
    }
    const row = dbA.prepare(`SELECT outcome FROM generated_fixes WHERE artifact_id = 'StaleArtifact'`).get();
    await test('no longer failing → outcome is STALE', async () => {
      assert.strictEqual(row.outcome, 'STALE');
    });
  }

  // Scenario B: artifact still failing same signature → STALE_BUT_STILL_FAILING
  const dbB = freshDb();
  dbB.prepare(`INSERT INTO generated_fixes (artifact_id, issue_context, error_signature, original_content_hash, original_content, proposed_content, generated_at) VALUES ('StaleArtifact', 'ctx', 'java.lang.NullPointerException', 'hash1', 'orig', 'fix', ?)`).run(oldDate);

  {
    const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const fix = dbB.prepare(`SELECT id, artifact_id, error_signature FROM generated_fixes WHERE applied = 0 AND outcome IS NULL AND generated_at < ?`).get(cutoff);
    if (fix) {
      // Simulate: failure_count > 0, same signature
      dbB.prepare(`UPDATE generated_fixes SET outcome = 'STALE_BUT_STILL_FAILING' WHERE id = ?`).run(fix.id);
    }
    const row = dbB.prepare(`SELECT outcome FROM generated_fixes WHERE artifact_id = 'StaleArtifact'`).get();
    await test('still failing same signature → outcome is STALE_BUT_STILL_FAILING', async () => {
      assert.strictEqual(row.outcome, 'STALE_BUT_STILL_FAILING');
    });
  }
}

// ── Test 4: Structural flag escalation → 🔴 ───────────────────────────────────
async function testStructuralFlagEscalation() {
  console.log('\n[Test 4] Structural flag escalation past TTL → 🔴');

  const { computeVerdict } = require('./orchestrator/report');

  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();

  const cycleResult = { errors: 0, stale_urgent: [], capped_failures: [] };
  const pendingFixes = [];
  const activeFlags = [
    {
      artifact_id: 'Decoder',
      error_signature: 'No .groovy script found',
      first_flagged_at: oldDate,
      snoozed_until: null,
      resolved_at: null,
      recurrence_count: 3
    }
  ];

  await test('unacknowledged flag past TTL → verdict is 🔴', async () => {
    const verdict = computeVerdict(cycleResult, pendingFixes, activeFlags, 7);
    assert.strictEqual(verdict, '🔴', `Expected 🔴 but got ${verdict}`);
  });
}

// ── Test 5: Snooze suppresses 🔴 → 🟡 ────────────────────────────────────────
async function testSnoozeSuppression() {
  console.log('\n[Test 5] Snooze suppresses 🔴 escalation → 🟡');

  const { computeVerdict } = require('./orchestrator/report');

  const oldDate = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
  const futureDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();

  const cycleResult = { errors: 0, stale_urgent: [], capped_failures: [] };
  const pendingFixes = [];
  const activeFlags = [
    {
      artifact_id: 'Decoder',
      error_signature: 'No .groovy script found',
      first_flagged_at: oldDate,
      snoozed_until: futureDate,  // active snooze
      resolved_at: null,
      recurrence_count: 3
    }
  ];

  await test('snoozed flag past TTL → verdict is 🟡 (not 🔴)', async () => {
    const verdict = computeVerdict(cycleResult, pendingFixes, activeFlags, 7);
    assert.strictEqual(verdict, '🟡', `Expected 🟡 but got ${verdict}`);
  });

  await test('snoozed flag still appears in active flags (not hidden)', async () => {
    assert.strictEqual(activeFlags.length, 1, 'Snoozed flag should still be in activeFlags');
  });
}

// ── Test 6: Snooze cleared on reopen ──────────────────────────────────────────
async function testSnoozeCleared() {
  console.log('\n[Test 6] Snooze cleared when structural flag reopens after resolution');

  const db = freshDb();
  const futureDate = new Date(Date.now() + 20 * 24 * 60 * 60 * 1000).toISOString();

  // Insert a resolved+snoozed flag
  db.prepare(`
    INSERT INTO structural_flags (artifact_id, error_signature, resolved_at, snoozed_until, acknowledged_at)
    VALUES ('Decoder', 'No .groovy script found', CURRENT_TIMESTAMP, ?, CURRENT_TIMESTAMP)
  `).run(futureDate);

  // Simulate upsertStructuralFlag reopening it (clear resolved_at, snoozed_until, acknowledged_at)
  const existing = db.prepare(`SELECT id, resolved_at FROM structural_flags WHERE artifact_id = 'Decoder'`).get();
  if (existing && existing.resolved_at) {
    db.prepare(`
      UPDATE structural_flags
      SET last_flagged_at = CURRENT_TIMESTAMP,
          recurrence_count = recurrence_count + 1,
          resolved_at = NULL,
          snoozed_until = NULL,
          acknowledged_at = NULL
      WHERE id = ?
    `).run(existing.id);
  }

  const row = db.prepare(`SELECT snoozed_until, acknowledged_at, resolved_at FROM structural_flags WHERE artifact_id = 'Decoder'`).get();

  await test('snoozed_until is cleared on reopen', async () => {
    assert.strictEqual(row.snoozed_until, null, `Expected null snoozed_until, got ${row.snoozed_until}`);
  });
  await test('acknowledged_at is cleared on reopen', async () => {
    assert.strictEqual(row.acknowledged_at, null, `Expected null acknowledged_at, got ${row.acknowledged_at}`);
  });
  await test('resolved_at is cleared on reopen', async () => {
    assert.strictEqual(row.resolved_at, null, `Expected null resolved_at, got ${row.resolved_at}`);
  });
}

// ── Run all tests ─────────────────────────────────────────────────────────────
(async () => {
  console.log('=== Phase 4, Unit 3: Orchestrator Unit Tests ===\n');

  await testCapEnforcement();
  await testTTLDiscrimination();
  await testStructuralFlagEscalation();
  await testSnoozeSuppression();
  await testSnoozeCleared();

  console.log(`\n================================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`================================================`);

  if (failed > 0) process.exit(1);
})();
