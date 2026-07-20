const queue = require('../queue/index');

/**
 * Directly queries the live tenant API for the current runtime status of an artifact.
 * Bypasses the local database cache to provide ground truth.
 * @param {string} artifactId 
 * @returns {Promise<string>} The status string (e.g., "STARTED", "STOPPED", "ERROR", "UNKNOWN")
 */
async function verifyRuntimeState(artifactId) {
  try {
    const res = await queue.get(`/IntegrationRuntimeArtifacts('${artifactId}')`);
    if (res.data && res.data.d) {
      return res.data.d.Status || 'UNKNOWN';
    }
    return 'UNKNOWN';
  } catch (err) {
    if (err.response && err.response.status === 404) {
      return 'NOT_FOUND';
    }
    console.warn(`Failed to verify runtime state: ${err.message}`);
    return 'UNKNOWN';
  }
}

module.exports = {
  verifyRuntimeState
};
