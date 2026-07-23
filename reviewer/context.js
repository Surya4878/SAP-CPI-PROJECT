const crypto = require('crypto');
const db = require('../database/index');
const { getBlastRadius } = require('../impact/index');
const { getFailureDetails } = require('../logs/index');

async function assembleContext(artifactId, options = {}) {
  const requireStarted = options.requireStarted !== undefined ? options.requireStarted : true;
  // contextFlags: caller declares what additional context it will append AFTER this call.
  // This is used to generate an honest _context_included block for the LLM.
  // e.g. { rawSourceFiles: true } when the Explain endpoint appends the live ZIP
  const contextFlags = options.contextFlags || {};

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

  // Assemble the bundle — _context_included tells the LLM exactly what it has.
  // This is generated dynamically per call so it's always truthful.
  // Callers that append raw source files (like the Explain endpoint) pass contextFlags: { rawSourceFiles: true }.
  const contextBundle = {
    _context_included: {
      structuredMetadata: true,          // always: parsed steps, adapters, references
      parsedAdapterConfig: metadata.adapters && metadata.adapters.length > 0,
      rawSourceFiles: !!contextFlags.rawSourceFiles,  // true only when caller appends live ZIP content
      recentErrors: failureDetails.length > 0
    },
    _instructions: contextFlags.rawSourceFiles
      ? "You have BOTH structured metadata AND raw source files (XML, Groovy, etc.) in this bundle. Use the structured metadata as a table of contents, but cross-reference with the raw source files for ground truth values (exact addresses, property values, script logic). Do not say 'details are unknown' if the details exist in the raw source files."
      : "You have structural metadata and runtime logs. You do NOT have the raw source files (Groovy scripts, full XML). Make recommendations based only on the structure, adapters, exception handling patterns, and runtime errors provided.",
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
