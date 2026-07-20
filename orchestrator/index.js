const db = require('../database');
const { getRecentStatus, getFailureDetails } = require('../logs');
const { generateFixForArtifact } = require('../fixer/generate');
const { NeedsStructuralReviewError, GenerationFailedError } = require('./errors');

const DEFAULT_STALE_FIX_DAYS = parseInt(process.env.STALE_FIX_DAYS || '7', 10);

/**
 * Sweep generated_fixes for rows older than STALE_FIX_DAYS that are still unapplied.
 * For each: re-check if the artifact is still actively failing with the same error.
 *   - Still failing same signature → STALE_BUT_STILL_FAILING (🔴 condition)
 *   - No longer failing            → STALE (issue resolved externally)
 */
async function runStalenessSweep(staleFixDays) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - staleFixDays);
  const cutoffStr = cutoff.toISOString();

  const oldFixes = db.prepare(`
    SELECT id, artifact_id, error_signature, generated_at
    FROM generated_fixes
    WHERE applied = 0 AND outcome IS NULL AND generated_at < ?
  `).all(cutoffStr);

  let staleMarked = 0;
  const staleUrgent = [];

  for (const fix of oldFixes) {
    try {
      const status = await getRecentStatus(fix.artifact_id, { sinceDeployment: true });
      let outcome = 'STALE';

      if (status.failure_count > 0) {
        // Re-check failure details to confirm same error signature still present
        const details = await getFailureDetails(fix.artifact_id, { sinceDeployment: true, limit: 3 });
        const stillSameError = details.some(d => {
          const sig = d.error.split('\n')[0].trim().substring(0, 255);
          return sig === fix.error_signature;
        });
        if (stillSameError) {
          outcome = 'STALE_BUT_STILL_FAILING';
          staleUrgent.push(fix.artifact_id);
        }
      }

      db.prepare(`UPDATE generated_fixes SET outcome = ? WHERE id = ?`).run(outcome, fix.id);
      staleMarked++;
      console.log(`[Orchestrator] Fix ${fix.id} for ${fix.artifact_id} TTL-expired → ${outcome}`);
    } catch (err) {
      console.error(`[Orchestrator] Error in staleness sweep for fix ${fix.id}: ${err.message}`);
    }
  }

  return { staleMarked, staleUrgent };
}

/**
 * Upsert a structural flag for an artifact+error_signature.
 * On reopen (was resolved), clears resolved_at, snoozed_until, acknowledged_at —
 * a recurrence after resolution invalidates the prior acknowledgement.
 */
function upsertStructuralFlag(artifactId, errorSignature) {
  const existing = db.prepare(`
    SELECT id, resolved_at FROM structural_flags
    WHERE artifact_id = ? AND error_signature = ?
  `).get(artifactId, errorSignature);

  if (existing) {
    if (existing.resolved_at) {
      // Reopening after resolution — clear snooze too (recurrence invalidates prior acknowledgement)
      db.prepare(`
        UPDATE structural_flags
        SET last_flagged_at = CURRENT_TIMESTAMP,
            recurrence_count = recurrence_count + 1,
            resolved_at = NULL,
            snoozed_until = NULL,
            acknowledged_at = NULL
        WHERE id = ?
      `).run(existing.id);
    } else {
      // Still open — just update last_flagged and count
      db.prepare(`
        UPDATE structural_flags
        SET last_flagged_at = CURRENT_TIMESTAMP,
            recurrence_count = recurrence_count + 1
        WHERE id = ?
      `).run(existing.id);
    }
  } else {
    db.prepare(`
      INSERT INTO structural_flags (artifact_id, error_signature)
      VALUES (?, ?)
    `).run(artifactId, errorSignature);
  }
}

/**
 * After scanning all artifacts, resolve any structural flags whose artifact
 * did NOT raise a flag this cycle (issue went quiet).
 * Preserves snoozed_until / acknowledged_at on clean resolution.
 */
function resolveStaleStructuralFlags(flaggedThisCycle) {
  const openFlags = db.prepare(`
    SELECT id, artifact_id FROM structural_flags WHERE resolved_at IS NULL
  `).all();

  for (const flag of openFlags) {
    if (!flaggedThisCycle.has(flag.artifact_id)) {
      db.prepare(`
        UPDATE structural_flags SET resolved_at = CURRENT_TIMESTAMP WHERE id = ?
      `).run(flag.id);
      console.log(`[Orchestrator] Structural flag for ${flag.artifact_id} resolved (no longer failing this cycle).`);
    }
  }
}

async function runHealingCycle(options = {}) {
  const windowHours = options.hours || 720;
  const isUnattended = options.unattended === true;
  const maxFixes = isUnattended ? (options.maxFixes || parseInt(process.env.MAX_FIXES_PER_CYCLE || '2', 10)) : Infinity;
  const staleFixDays = options.staleFixDays || DEFAULT_STALE_FIX_DAYS;

  console.log(`[Orchestrator] Starting Healing Cycle (Lookback: ${windowHours}h, Unattended: ${isUnattended}, MaxFixes: ${isUnattended ? maxFixes : 'unlimited'})`);

  const cycle = {
    started_at: new Date().toISOString(),
    artifacts_scanned: 0,
    failures_found: 0,
    fixes_generated: 0,
    structural_flags_raised: 0,
    structural_flags_list: [],
    duplicates_skipped: 0,
    errors: 0,
    capped_failures: [],
    stale_marked: 0,
    stale_urgent: []
  };

  // === PHASE 1: Staleness Sweep ===
  console.log(`[Orchestrator] Running staleness sweep (TTL: ${staleFixDays} days)...`);
  const { staleMarked, staleUrgent } = await runStalenessSweep(staleFixDays);
  cycle.stale_marked = staleMarked;
  cycle.stale_urgent = staleUrgent;

  // === PHASE 2: Scan Active Artifacts for New Failures ===
  const activeArtifacts = db.prepare(`SELECT artifact_id FROM runtime_status WHERE status = 'STARTED'`).all();
  cycle.artifacts_scanned = activeArtifacts.length;

  const flaggedThisCycle = new Set();

  for (const { artifact_id } of activeArtifacts) {
    try {
      console.log(`[Orchestrator] Checking artifact: ${artifact_id}`);

      // Check for recent failures (post-deployment only)
      const failureDetails = await getFailureDetails(artifact_id, { hours: windowHours, details: true, sinceDeployment: true });
      if (!failureDetails || failureDetails.length === 0) {
        continue;
      }

      cycle.failures_found++;
      const firstFailure = failureDetails[0].error;
      const errorSignature = firstFailure.split('\n')[0].trim().substring(0, 255);

      // Duplicate check
      const row = db.prepare(`SELECT content_hash FROM artifact_versions WHERE artifact_id = ? ORDER BY saved_at DESC LIMIT 1`).get(artifact_id);
      const contentHash = row ? row.content_hash : 'UNKNOWN';

      const existingFix = db.prepare(`
        SELECT id, outcome, applied
        FROM generated_fixes
        WHERE artifact_id = ? AND original_content_hash = ? AND error_signature = ?
      `).get(artifact_id, contentHash, errorSignature);

      if (existingFix) {
        console.log(`[Orchestrator] Skipped duplicate fix for ${artifact_id}.`);
        cycle.duplicates_skipped++;
        continue;
      }

      // Cost cap check
      if (cycle.fixes_generated >= maxFixes) {
        console.log(`[Orchestrator] Cap reached (${maxFixes}). Deferring ${artifact_id} to next cycle.`);
        cycle.capped_failures.push(artifact_id);
        continue;
      }

      // Generate fix
      console.log(`[Orchestrator] Generating new fix for ${artifact_id} due to: ${errorSignature}`);
      await generateFixForArtifact(artifact_id, failureDetails);
      cycle.fixes_generated++;
      console.log(`[Orchestrator] Fix generated and queued for human review for ${artifact_id}.`);

    } catch (err) {
      if (err instanceof NeedsStructuralReviewError) {
        const errorSignature = err.message.substring(0, 255);
        console.log(`[Orchestrator] Structural flag raised for ${artifact_id}: ${err.message}`);
        cycle.structural_flags_raised++;
        cycle.structural_flags_list.push(artifact_id);
        flaggedThisCycle.add(artifact_id);
        upsertStructuralFlag(artifact_id, errorSignature);
      } else {
        console.error(`[Orchestrator] Error processing ${artifact_id}: ${err.message}`);
        cycle.errors++;
      }
    }
  }

  // === PHASE 3: Resolve Structural Flags That Went Quiet ===
  resolveStaleStructuralFlags(flaggedThisCycle);

  // === PHASE 4: Outcome Tracking for Previously-Applied Fixes ===
  console.log(`[Orchestrator] Checking outcome of previously applied fixes...`);
  const pendingOutcomes = db.prepare(`
    SELECT id, artifact_id, applied_at, error_signature
    FROM generated_fixes
    WHERE applied = 1 AND outcome IS NULL
  `).all();

  for (const fix of pendingOutcomes) {
    try {
      const appliedTime = new Date(fix.applied_at).getTime();
      const now = Date.now();
      const hoursSinceApplied = Math.max(1, Math.ceil((now - appliedTime) / (1000 * 60 * 60)));

      const recentDetails = await getFailureDetails(fix.artifact_id, { hours: hoursSinceApplied, details: true });

      let outcome = 'RESOLVED';
      for (const fail of recentDetails) {
        const signature = fail.error.split('\n')[0].trim().substring(0, 255);
        if (signature === fix.error_signature) {
          outcome = 'FIX_FAILED';
          break;
        }
      }

      db.prepare(`UPDATE generated_fixes SET outcome = ? WHERE id = ?`).run(outcome, fix.id);
      console.log(`[Orchestrator] Fix ${fix.id} for ${fix.artifact_id} outcome: ${outcome}`);

    } catch (err) {
      console.error(`[Orchestrator] Error evaluating outcome for fix ${fix.id}: ${err.message}`);
    }
  }

  cycle.completed_at = new Date().toISOString();

  // === PHASE 5: Persist Cycle Record ===
  db.prepare(`
    INSERT INTO healing_cycles (
      started_at, completed_at, artifacts_scanned, failures_found,
      fixes_generated, structural_flags_raised, structural_flags_json,
      duplicates_skipped, errors, capped_failures
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    cycle.started_at, cycle.completed_at, cycle.artifacts_scanned, cycle.failures_found,
    cycle.fixes_generated, cycle.structural_flags_raised, JSON.stringify(cycle.structural_flags_list),
    cycle.duplicates_skipped, cycle.errors, cycle.capped_failures.length
  );

  return cycle;
}

module.exports = { runHealingCycle };

