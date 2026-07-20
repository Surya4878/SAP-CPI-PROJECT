const fs = require('fs');
const path = require('path');
const db = require('../database');
const { runHealingCycle } = require('./index');
const { generateReport } = require('./report');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');
const SCHEDULER_LOG = path.join(REPORTS_DIR, 'scheduler.log');

/**
 * When running --unattended, tee all console output to reports/scheduler.log.
 * Uses process.stdout/stderr write interception so it works regardless of
 * how the process was launched (Task Scheduler, cron, or direct CLI).
 */
function setupSchedulerLog() {
  if (!fs.existsSync(REPORTS_DIR)) fs.mkdirSync(REPORTS_DIR, { recursive: true });

  const ts = new Date().toISOString();
  fs.appendFileSync(SCHEDULER_LOG, `\n=== SAP-CPI-Healer run: ${ts} ===\n`);

  const logStream = fs.createWriteStream(SCHEDULER_LOG, { flags: 'a' });

  const origStdoutWrite = process.stdout.write.bind(process.stdout);
  const origStderrWrite = process.stderr.write.bind(process.stderr);

  process.stdout.write = (chunk, ...args) => {
    logStream.write(chunk);
    return origStdoutWrite(chunk, ...args);
  };
  process.stderr.write = (chunk, ...args) => {
    logStream.write(chunk);
    return origStderrWrite(chunk, ...args);
  };

  // Flush exit code on close
  process.on('exit', (code) => {
    logStream.write(`=== Exit code: ${code} ===\n\n`);
    logStream.end();
  });
}

async function main() {
  const args = process.argv.slice(2);
  const isUnattended = args.includes('--unattended');
  const isReport = args.includes('--report');

  // When running unattended, self-log all output to reports/scheduler.log.
  // This is more reliable than shell redirection, which fails in Task Scheduler
  // non-interactive sessions.
  if (isUnattended) setupSchedulerLog();

  // ── --acknowledge-flag <artifactId> [--days N] ──────────────────────────────
  if (args.includes('--acknowledge-flag')) {
    const flagIdx = args.indexOf('--acknowledge-flag');
    const artifactId = args[flagIdx + 1];
    if (!artifactId || artifactId.startsWith('--')) {
      console.error(`Usage: node orchestrator/run.js --acknowledge-flag <artifactId> [--days N]`);
      process.exit(1);
    }
    const daysIdx = args.indexOf('--days');
    const snoozeDays = daysIdx !== -1 && args[daysIdx + 1] ? parseInt(args[daysIdx + 1], 10) : 30;
    const snoozeUntil = new Date(Date.now() + snoozeDays * 24 * 60 * 60 * 1000).toISOString();

    const flag = db.prepare(`
      SELECT id FROM structural_flags
      WHERE artifact_id = ? AND resolved_at IS NULL
      ORDER BY first_flagged_at ASC LIMIT 1
    `).get(artifactId);

    if (!flag) {
      console.error(`No active structural flag found for artifact: ${artifactId}`);
      process.exit(1);
    }

    db.prepare(`
      UPDATE structural_flags
      SET snoozed_until = ?, acknowledged_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `).run(snoozeUntil, flag.id);

    console.log(`[Orchestrator] [${artifactId}] snoozed until ${snoozeUntil.split('T')[0]} (${snoozeDays} days).`);
    console.log(`  This flag will still appear in reports/latest.md as 🟡 (snoozed) but will not trigger 🔴 exit codes until then.`);
    console.log(`  Note: first_flagged_at is preserved — the historical record is unchanged.`);
    process.exit(0);
  }

  // ── --pending ────────────────────────────────────────────────────────────────
  if (args.includes('--pending')) {
    console.log(`\n=== PENDING FIXES AWAITING REVIEW ===`);
    const pending = db.prepare(`
      SELECT id, artifact_id, generated_at, error_signature, outcome
      FROM generated_fixes
      WHERE applied = 0
      ORDER BY generated_at ASC
    `).all();

    if (pending.length === 0) {
      console.log(`No fixes currently pending review.`);
    } else {
      for (const row of pending) {
        const tag = row.outcome ? ` [${row.outcome}]` : '';
        console.log(`- [${row.artifact_id}] (ID: ${row.id}) | Gen: ${row.generated_at}${tag} | Error: ${row.error_signature.substring(0, 50)}...`);
      }
      console.log(`\nRun 'node fixer/review.js <artifactId>' to review and 'node fixer/apply.js <artifactId>' to deploy.`);
    }

    console.log(`\n=== STRUCTURAL FLAGS ===`);
    const flags = db.prepare(`
      SELECT artifact_id, first_flagged_at, recurrence_count, snoozed_until, resolved_at
      FROM structural_flags
      WHERE resolved_at IS NULL
      ORDER BY first_flagged_at ASC
    `).all();

    if (flags.length === 0) {
      console.log(`No active structural flags.`);
    } else {
      for (const f of flags) {
        const snooze = f.snoozed_until ? ` [snoozed until ${f.snoozed_until.split('T')[0]}]` : '';
        console.log(`- [${f.artifact_id}] — first seen: ${f.first_flagged_at} (${f.recurrence_count}×)${snooze}`);
      }
      console.log(`\nRun 'node orchestrator/run.js --acknowledge-flag <artifactId> --days 30' to snooze.`);
    }

    process.exit(0);
  }

  // ── Healing Cycle (--unattended or manual) ───────────────────────────────────
  const modeLabel = isUnattended ? 'Unattended' : 'Manual';
  console.log(`Starting ${modeLabel} Healing Cycle...`);

  const cycleOptions = {
    hours: 720,
    unattended: isUnattended
  };

  const cycleResult = await runHealingCycle(cycleOptions);

  // Print summary to console
  console.log(`\n======================================================`);
  console.log(`             HEALING CYCLE SUMMARY`);
  console.log(`======================================================`);
  console.log(`Mode           : ${modeLabel}`);
  console.log(`Started        : ${cycleResult.started_at}`);
  console.log(`Completed      : ${cycleResult.completed_at}`);
  console.log(`Artifacts Scan : ${cycleResult.artifacts_scanned}`);
  console.log(`Failures Found : ${cycleResult.failures_found}`);
  console.log(`Fixes Generated: ${cycleResult.fixes_generated}`);
  console.log(`Duplicates Skip: ${cycleResult.duplicates_skipped}`);
  console.log(`Stale Expired  : ${cycleResult.stale_marked} (${cycleResult.stale_urgent.length} still failing)`);

  if (cycleResult.structural_flags_raised > 0) {
    console.log(`Structural Flag: ${cycleResult.structural_flags_raised} (${cycleResult.structural_flags_list.join(', ')})`);
  } else {
    console.log(`Structural Flag: 0`);
  }

  if (cycleResult.capped_failures.length > 0) {
    console.log(`Cap Deferred   : ${cycleResult.capped_failures.length} (${cycleResult.capped_failures.join(', ')})`);
  }

  console.log(`Errors         : ${cycleResult.errors}`);
  console.log(`======================================================`);

  // Write report if --unattended or --report
  if (isUnattended || isReport) {
    const { verdict, reportPath } = generateReport(cycleResult);
    console.log(`\nVerdict: ${verdict}`);
    console.log(`Report : ${reportPath}`);
    console.log(`History: ${reportPath.replace('latest.md', 'history.log')}`);

    if (isUnattended && verdict === '🔴') {
      console.log(`\n[Orchestrator] Exiting with code 1 (🔴 — action required).`);
      process.exit(1);
    }
  } else {
    console.log(`\nRun 'node orchestrator/run.js --pending' to see full queue.`);
    console.log(`Tip: Use --report to also write reports/latest.md this run.`);
  }
}

main().catch(err => {
  console.error(`[Orchestrator] Fatal error: ${err.message}`);
  process.exit(1);
});

