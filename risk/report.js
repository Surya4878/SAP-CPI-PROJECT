require('dotenv').config();
const db = require('../database/index');
const { computeRiskScore, RANK } = require('./index');

async function main() {
  console.log('Generating Risk Assessment Report...\n');

  const activeArtifacts = db.prepare(`
    SELECT artifact_id, version 
    FROM runtime_status 
    WHERE status = 'STARTED'
  `).all();

  if (activeArtifacts.length === 0) {
    console.log('No active (STARTED) artifacts found in runtime_status.');
    process.exit(0);
  }

  const results = [];

  for (const artifact of activeArtifacts) {
    const { artifact_id } = artifact;
    const { score, reviewSummary, cached } = await computeRiskScore(artifact_id);

    let topFactor = 'None';
    try {
      const factors = JSON.parse(score.contributing_factors_json);
      // Find the factor that matches the composite risk string
      const matchedFactor = factors.find(f => f.includes(score.composite_risk));
      if (matchedFactor) {
        topFactor = matchedFactor.split('->')[0].trim();
      } else if (factors.length > 0) {
        topFactor = factors[0].split('->')[0].trim();
      }
    } catch (e) {
      // ignore
    }

    results.push({
      'Artifact Name': artifact_id,
      'Composite Risk': score.composite_risk,
      'Top Factor': topFactor,
      'Review Summary': reviewSummary ? (reviewSummary.substring(0, 60) + (reviewSummary.length > 60 ? '...' : '')) : 'N/A',
      '_rank': RANK[score.composite_risk] || 0
    });
  }

  // Sort descending by rank
  results.sort((a, b) => b._rank - a._rank);

  // Remove the hidden sorting rank from output
  const displayResults = results.map(r => {
    const { _rank, ...rest } = r;
    return rest;
  });

  console.table(displayResults);
}

main().catch(err => {
  console.error('Error generating risk report:', err);
  process.exit(1);
});
