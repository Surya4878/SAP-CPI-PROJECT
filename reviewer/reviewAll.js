const db = require('../database/index');
const { assembleContext } = require('./context');
const { runReview } = require('./llm');

async function main() {
  console.log('Initiating ReviewAll over deployed artifacts...\n');

  const deployed = db.prepare(`
    SELECT artifact_id 
    FROM runtime_status 
    WHERE status = 'STARTED'
  `).all();

  if (deployed.length === 0) {
    console.log('No artifacts are currently deployed.');
    return;
  }

  const results = [];

  for (const { artifact_id } of deployed) {
    console.log(`Analyzing [${artifact_id}]...`);
    try {
      const context = await assembleContext(artifact_id);
      if (!context) continue;

      const review = await runReview(context.contextBundleString, context.contentHash, artifact_id);
      results.push({
        id: artifact_id,
        verdict: review.verdict,
        issueCount: review.issues.length,
        summary: review.summary
      });
    } catch (err) {
      console.error(`  Error analyzing ${artifact_id}: ${err.message}`);
    }
  }

  // Sort HIGH_RISK first, then NEEDS_ATTENTION, then OK
  const rank = { 'HIGH_RISK': 1, 'NEEDS_ATTENTION': 2, 'OK': 3 };
  results.sort((a, b) => {
    return rank[a.verdict] - rank[b.verdict] || b.issueCount - a.issueCount;
  });

  console.log(`\n=== Fleet Review Summary (${results.length} Artifacts) ===\n`);
  for (const r of results) {
    const symbol = r.verdict === 'HIGH_RISK' ? '🚨' : r.verdict === 'NEEDS_ATTENTION' ? '⚠️' : '✅';
    console.log(`${symbol} [${r.verdict}] ${r.id} | ${r.issueCount} issue(s)`);
    console.log(`   ${r.summary}\n`);
  }
}

main();
