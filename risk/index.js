const crypto = require('crypto');
const db = require('../database/index');
const { getBlastRadius } = require('../impact/index');

const RANK = {
  OK: 0,
  LOW: 1,
  MEDIUM: 2,
  NOT_REVIEWED: 3,
  HIGH: 4
};

function getRankString(rankValue) {
  return Object.keys(RANK).find(key => RANK[key] === rankValue) || 'UNKNOWN';
}

function computeStructuralRisk(blastRadius, factors) {
  let rank = RANK.OK;
  
  if (blastRadius.directCallers && blastRadius.directCallers.length > 0) {
    rank = Math.max(rank, RANK.LOW);
    if (blastRadius.directCallers.length > 2) rank = Math.max(rank, RANK.MEDIUM);
    if (blastRadius.directCallers.length > 5) rank = Math.max(rank, RANK.HIGH);
    factors.push(`Structural: ${blastRadius.directCallers.length} direct callers -> ${getRankString(rank)}`);
  }
  
  if (blastRadius.externalSystemsUsed && blastRadius.externalSystemsUsed.length > 0) {
    let externalRank = RANK.LOW;
    if (blastRadius.externalSystemsUsed.length > 2) externalRank = RANK.MEDIUM;
    rank = Math.max(rank, externalRank);
    factors.push(`Structural: ${blastRadius.externalSystemsUsed.length} external systems -> ${getRankString(externalRank)}`);
  }

  // Check for cyclic/self loops manually or transitives
  if (blastRadius.transitiveCallers && blastRadius.transitiveCallers.length > 10) {
    rank = Math.max(rank, RANK.HIGH);
    factors.push(`Structural: High transitive depth/volume -> HIGH`);
  }

  return getRankString(rank);
}

function computeRuntimeRisk(blastRadius, factors) {
  if (!blastRadius.recent_status) {
    factors.push('Runtime: No recent status available -> OK');
    return 'OK';
  }

  const { failure_count, run_count } = blastRadius.recent_status;
  if (failure_count === 0) {
    factors.push(`Runtime: 0 failures -> OK`);
    return 'OK';
  }

  // Calculate rate
  const total = run_count > 0 ? run_count : failure_count; // fallback if run_count is somehow 0
  const rate = failure_count / total;
  
  if (rate < 0.10) {
    factors.push(`Runtime: Failure rate ${(rate * 100).toFixed(1)}% (< 10%) -> MEDIUM`);
    return 'MEDIUM';
  } else {
    factors.push(`Runtime: Failure rate ${(rate * 100).toFixed(1)}% (>= 10%) -> HIGH`);
    return 'HIGH';
  }
}

function computeReviewerRisk(reviewRecord, factors) {
  if (!reviewRecord) {
    factors.push('Reviewer: No review on file -> NOT_REVIEWED');
    return 'NOT_REVIEWED';
  }

  let rank = RANK.OK;
  const verdict = reviewRecord.verdict;

  if (verdict === 'NEEDS_ATTENTION') {
    rank = RANK.MEDIUM;
    factors.push('Reviewer: LLM Verdict is NEEDS_ATTENTION -> MEDIUM');
  } else if (verdict === 'HIGH_RISK') {
    rank = RANK.HIGH;
    factors.push('Reviewer: LLM Verdict is HIGH_RISK -> HIGH');
  } else if (verdict === 'OK') {
    factors.push('Reviewer: LLM Verdict is OK -> OK');
  } else {
    factors.push(`Reviewer: Unrecognized verdict (${verdict}) -> OK`);
  }

  let issues = [];
  try {
    issues = JSON.parse(reviewRecord.issues_json);
  } catch (e) {
    // ignore parse error
  }

  if (Array.isArray(issues)) {
    const highIssuesCount = issues.filter(i => i.severity && i.severity.toUpperCase() === 'HIGH').length;
    if (highIssuesCount > 0) {
      rank = RANK.HIGH;
      factors.push(`Reviewer: Override due to ${highIssuesCount} HIGH severity issue(s) -> HIGH`);
    }
  }

  return getRankString(rank);
}

async function computeRiskScore(artifactId) {
  const windowHours = parseInt(process.env.REVIEW_WINDOW_HOURS || '720', 10);
  const blastRadius = await getBlastRadius(db, artifactId, { includeRecentErrors: true, hours: windowHours });
  
  // Create a stable snapshot string to hash
  const blastRadiusSnapshotString = JSON.stringify({
    directCallers: blastRadius.directCallers.length,
    transitiveCallers: blastRadius.transitiveCallers.length,
    externalSystemsUsed: blastRadius.externalSystemsUsed.length,
    dependsOnIflows: blastRadius.dependsOnIflows.length,
    riskFactors: blastRadius.riskFactors,
    recent_status: blastRadius.recent_status
  });
  
  const snapshotHash = crypto.createHash('sha256').update(blastRadiusSnapshotString).digest('hex');

  const reviewRecord = db.prepare(`
    SELECT id, verdict, issues_json, summary 
    FROM reviews 
    WHERE artifact_id = ? 
    ORDER BY reviewed_at DESC LIMIT 1
  `).get(artifactId);

  const reviewId = reviewRecord ? reviewRecord.id : null;

  // Cache Check
  const cached = db.prepare(`
    SELECT * FROM risk_scores 
    WHERE artifact_id = ?
    ORDER BY computed_at DESC LIMIT 1
  `).get(artifactId);

  if (cached && cached.blast_radius_snapshot_hash === snapshotHash && cached.review_id === reviewId) {
    return {
      cached: true,
      score: cached,
      reviewSummary: reviewRecord ? reviewRecord.summary : null
    };
  }

  // Compute
  const contributingFactors = [];
  const structuralRisk = computeStructuralRisk(blastRadius, contributingFactors);
  const runtimeRisk = computeRuntimeRisk(blastRadius, contributingFactors);
  const reviewerRisk = computeReviewerRisk(reviewRecord, contributingFactors);

  const compositeRank = Math.max(
    RANK[structuralRisk], 
    RANK[runtimeRisk], 
    RANK[reviewerRisk]
  );
  
  const compositeRisk = getRankString(compositeRank);
  const factorsJson = JSON.stringify(contributingFactors);

  const stmt = db.prepare(`
    INSERT INTO risk_scores (
      artifact_id, 
      structural_risk, 
      runtime_risk, 
      reviewer_risk, 
      composite_risk, 
      contributing_factors_json, 
      review_id, 
      blast_radius_snapshot_hash
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const info = stmt.run(
    artifactId,
    structuralRisk,
    runtimeRisk,
    reviewerRisk,
    compositeRisk,
    factorsJson,
    reviewId,
    snapshotHash
  );

  const newScore = db.prepare('SELECT * FROM risk_scores WHERE id = ?').get(info.lastInsertRowid);

  return {
    cached: false,
    score: newScore,
    reviewSummary: reviewRecord ? reviewRecord.summary : null
  };
}

module.exports = {
  computeRiskScore,
  RANK
};
