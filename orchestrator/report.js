const fs = require('fs');
const path = require('path');
const db = require('../database');

const REPORTS_DIR = path.join(__dirname, '..', 'reports');

/**
 * Compute the verdict for a cycle result.
 * 🔴 RED    — errors, STALE_BUT_STILL_FAILING fixes, or unacknowledged structural flags past TTL
 * 🟡 YELLOW — pending fixes, snoozed/active structural flags, capped failures
 * 🟢 GREEN  — everything clean
 */
function computeVerdict(cycleResult, pendingFixes, activeStructuralFlags, staleFlagDays) {
  const now = Date.now();
  const ttlMs = staleFlagDays * 24 * 60 * 60 * 1000;

  // 🔴 conditions
  if (cycleResult.errors > 0) return '🔴';
  if (cycleResult.stale_urgent && cycleResult.stale_urgent.length > 0) return '🔴';

  // Structural flags past TTL with no active snooze → 🔴
  const escalatedFlags = activeStructuralFlags.filter(f => {
    const age = now - new Date(f.first_flagged_at).getTime();
    const isSnoozed = f.snoozed_until && new Date(f.snoozed_until).getTime() > now;
    return age > ttlMs && !isSnoozed && !f.resolved_at;
  });
  if (escalatedFlags.length > 0) return '🔴';

  // 🟡 conditions
  if (pendingFixes.length > 0) return '🟡';
  if (activeStructuralFlags.length > 0) return '🟡';
  if (cycleResult.capped_failures && cycleResult.capped_failures.length > 0) return '🟡';

  return '🟢';
}

function generateReport(cycleResult, options = {}) {
  const staleFlagDays = options.staleFixDays || parseInt(process.env.STALE_FIX_DAYS || '7', 10);
  const now = Date.now();
  const ttlMs = staleFlagDays * 24 * 60 * 60 * 1000;

  // --- Query live DB state ---
  const pendingFixes = db.prepare(`
    SELECT id, artifact_id, generated_at, error_signature, outcome
    FROM generated_fixes
    WHERE applied = 0 AND (outcome IS NULL OR outcome = 'STALE_BUT_STILL_FAILING')
    ORDER BY generated_at ASC
  `).all();

  const activeStructuralFlags = db.prepare(`
    SELECT artifact_id, error_signature, first_flagged_at, last_flagged_at,
           recurrence_count, snoozed_until, acknowledged_at, resolved_at
    FROM structural_flags
    WHERE resolved_at IS NULL
    ORDER BY first_flagged_at ASC
  `).all();

  const verdict = computeVerdict(cycleResult, pendingFixes, activeStructuralFlags, staleFlagDays);
  const ts = cycleResult.started_at || new Date().toISOString();

  // --- Verdict summary line ---
  let verdictSummary;
  if (verdict === '🟢') {
    verdictSummary = `🟢 All clear — nothing needs attention`;
  } else if (verdict === '🟡') {
    const parts = [];
    if (pendingFixes.length > 0) parts.push(`${pendingFixes.length} fix(es) pending review`);
    if (activeStructuralFlags.length > 0) parts.push(`${activeStructuralFlags.length} structural flag(s)`);
    if (cycleResult.capped_failures && cycleResult.capped_failures.length > 0) parts.push(`${cycleResult.capped_failures.length} deferred by cap`);
    verdictSummary = `🟡 ${parts.join(', ')} — run \`node orchestrator/run.js --pending\` for details`;
  } else {
    const parts = [];
    if (cycleResult.errors > 0) parts.push(`${cycleResult.errors} cycle error(s)`);
    if (cycleResult.stale_urgent && cycleResult.stale_urgent.length > 0) parts.push(`${cycleResult.stale_urgent.length} stale fix(es) still failing`);
    const escalated = activeStructuralFlags.filter(f => {
      const age = now - new Date(f.first_flagged_at).getTime();
      const isSnoozed = f.snoozed_until && new Date(f.snoozed_until).getTime() > now;
      return age > ttlMs && !isSnoozed;
    });
    if (escalated.length > 0) parts.push(`${escalated.length} structural flag(s) past ${staleFlagDays}-day TTL`);
    verdictSummary = `🔴 ACTION REQUIRED — ${parts.join(', ')}`;
  }

  // --- Fixes generated this cycle ---
  let fixesThisCycleSection = `## Fixes Generated This Cycle\n`;
  if (cycleResult.fixes_generated > 0) {
    const recentlyGenerated = db.prepare(`
      SELECT artifact_id, error_signature FROM generated_fixes
      WHERE applied = 0 AND outcome IS NULL
      ORDER BY generated_at DESC LIMIT ?
    `).all(cycleResult.fixes_generated);
    fixesThisCycleSection += recentlyGenerated.map(f =>
      `- **[${f.artifact_id}]** — ${f.error_signature.substring(0, 80)}...`
    ).join('\n') + '\n';
  } else {
    fixesThisCycleSection += `_(none)_\n`;
  }

  // --- Pending queue ---
  let pendingSection = `## Fixes Pending Review\n`;
  if (pendingFixes.length === 0) {
    pendingSection += `_(none)_\n`;
  } else {
    for (const fix of pendingFixes) {
      const ageDays = Math.floor((now - new Date(fix.generated_at).getTime()) / (1000 * 60 * 60 * 24));
      const urgentTag = fix.outcome === 'STALE_BUT_STILL_FAILING' ? ' **⚠ STILL FAILING**' : '';
      pendingSection += `- **[${fix.artifact_id}]** (ID: ${fix.id}) | Age: ${ageDays}d${urgentTag} | Error: ${fix.error_signature.substring(0, 70)}...\n`;
    }
    pendingSection += `\n_Run \`node fixer/review.js <artifactId>\` to review, \`node fixer/apply.js <artifactId>\` to deploy._\n`;
  }

  // --- Structural flags ---
  let flagsSection = `## Structural Flags (Needs Manual Review)\n`;
  if (activeStructuralFlags.length === 0) {
    flagsSection += `_(none)_\n`;
  } else {
    for (const f of activeStructuralFlags) {
      const ageDays = Math.floor((now - new Date(f.first_flagged_at).getTime()) / (1000 * 60 * 60 * 24));
      const isSnoozed = f.snoozed_until && new Date(f.snoozed_until).getTime() > now;
      const isEscalated = (now - new Date(f.first_flagged_at).getTime()) > ttlMs && !isSnoozed;
      const snoozeNote = isSnoozed ? ` 🟡 _(snoozed until ${f.snoozed_until.split('T')[0]})_` : '';
      const escalatedNote = isEscalated ? ` 🔴 _(past ${staleFlagDays}-day TTL)_` : '';
      flagsSection += `- **[${f.artifact_id}]** — first flagged ${ageDays}d ago (${f.recurrence_count}× seen)${escalatedNote}${snoozeNote}\n`;
      flagsSection += `  _${f.error_signature.substring(0, 100)}_\n`;
    }
    flagsSection += `\n_Run \`node orchestrator/run.js --acknowledge-flag <artifactId> --days 30\` to snooze._\n`;
  }

  // --- Urgent stale fixes ---
  let urgentSection = '';
  if (cycleResult.stale_urgent && cycleResult.stale_urgent.length > 0) {
    urgentSection = `## ⚠ Urgent: Still-Failing Stale Fixes\n`;
    for (const artifactId of cycleResult.stale_urgent) {
      urgentSection += `- **[${artifactId}]** — fix pending for over ${staleFlagDays} days; original error is **still actively occurring**. Review immediately.\n`;
    }
    urgentSection += '\n';
  }

  // --- Capped failures ---
  let cappedSection = '';
  if (cycleResult.capped_failures && cycleResult.capped_failures.length > 0) {
    cappedSection = `## Deferred — Cost Cap Reached (MAX_FIXES_PER_CYCLE)\n`;
    for (const artifactId of cycleResult.capped_failures) {
      cappedSection += `- **[${artifactId}]** — failure detected but not processed this cycle; will retry next cycle.\n`;
    }
    cappedSection += '\n';
  }

  // --- Errors ---
  const errorsSection = `## Cycle Errors\n` + (
    cycleResult.errors > 0
      ? `⚠ ${cycleResult.errors} error(s) occurred. Check console output for details.\n`
      : `_(none)_\n`
  );

  // --- Assemble ---
  const report = [
    `# SAP-CPI Healing Cycle Report`,
    `> ${verdictSummary}`,
    ``,
    `**Cycle:** ${ts}`,
    `**Scanned:** ${cycleResult.artifacts_scanned} | **Failures:** ${cycleResult.failures_found} | **Generated:** ${cycleResult.fixes_generated} | **Skipped:** ${cycleResult.duplicates_skipped}`,
    ``,
    `---`,
    ``,
    fixesThisCycleSection,
    pendingSection,
    flagsSection,
    urgentSection,
    cappedSection,
    errorsSection,
  ].join('\n');

  // Write reports/latest.md
  if (!fs.existsSync(REPORTS_DIR)) {
    fs.mkdirSync(REPORTS_DIR, { recursive: true });
  }
  fs.writeFileSync(path.join(REPORTS_DIR, 'latest.md'), report, 'utf8');

  // Append one line to reports/history.log
  const historyLine = [
    ts,
    verdict,
    `scanned=${cycleResult.artifacts_scanned}`,
    `failures=${cycleResult.failures_found}`,
    `generated=${cycleResult.fixes_generated}`,
    `pending=${pendingFixes.length}`,
    `flags=${activeStructuralFlags.length}`,
    `stale_urgent=${(cycleResult.stale_urgent || []).length}`,
    `capped=${(cycleResult.capped_failures || []).length}`,
    `errors=${cycleResult.errors}`,
  ].join('  ');
  fs.appendFileSync(path.join(REPORTS_DIR, 'history.log'), historyLine + '\n', 'utf8');

  return { verdict, reportPath: path.join(REPORTS_DIR, 'latest.md') };
}

module.exports = { generateReport, computeVerdict };
