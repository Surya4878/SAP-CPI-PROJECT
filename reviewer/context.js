const crypto = require('crypto');
const db = require('../database/index');
const { getBlastRadius } = require('../impact/index');
const { getFailureDetails } = require('../logs/index');

async function assembleContext(artifactId, options = {}) {
  const requireStarted = options.requireStarted !== undefined ? options.requireStarted : true;

  // 1. Verify deployed status
  const statusRecord = db.prepare(`
    SELECT status, version, deployed_on, error_info 
    FROM runtime_status 
    WHERE artifact_id = ?
  `).get(artifactId);

  if (requireStarted && (!statusRecord || statusRecord.status !== 'STARTED')) {
    return null; // Not deployed or not running
  }

  // 2. Fetch parsed metadata
  const parsedData = db.prepare(`
    SELECT parsed_json 
    FROM parsed_metadata 
    WHERE artifact_id = ? AND type = 'IFlow'
  `).get(artifactId);

  let metadata = {};
  if (parsedData && parsedData.parsed_json) {
    metadata = JSON.parse(parsedData.parsed_json);
  }

  // 3. Get blast radius & recent errors (using a wider window for CPI logs, e.g. 720h)
  const windowHours = parseInt(process.env.REVIEW_WINDOW_HOURS || '720', 10);
  const blastRadius = await getBlastRadius(db, artifactId, { includeRecentErrors: true, hours: windowHours });
  
  let failureDetails = [];
  if (blastRadius.recent_status && blastRadius.recent_status.failure_count > 0) {
    // 4. Fetch specific error texts (cap at 5 to keep context bundle small)
    failureDetails = await getFailureDetails(artifactId, { hours: windowHours, limit: 5 });
  }

  // 5. Query resources (filenames and hashes only)
  const resources = db.prepare(`
    SELECT path, name, type, size, content_hash 
    FROM resources 
    WHERE artifact_id = ?
  `).all(artifactId);

  // Assemble the bundle
  const contextBundle = {
    _NOTICE: "You are reviewing structural metadata, dependencies, and recent logs. You DO NOT have the full source code (Groovy scripts, XSLT, etc.). Make recommendations based only on the structure, adapters, exception handling patterns, and runtime errors provided below.",
    artifactId,
    deploymentStatus: statusRecord,
    parsedMetadata: metadata,
    impactAndRisk: blastRadius,
    recentFailureDetails: failureDetails,
    resources: resources
  };

  const contextBundleString = JSON.stringify(contextBundle, null, 2);
  const contentHash = crypto.createHash('sha256').update(contextBundleString).digest('hex');

  return {
    contextBundleString,
    contentHash,
    contextBundle
  };
}

module.exports = {
  assembleContext
};
