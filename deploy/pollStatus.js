const db = require('../database/index');
const queue = require('../queue/index');

function wait(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Polls the BuildAndDeployStatus endpoint for a given TaskId.
 * @param {string} taskId
 * @param {number} deploymentId
 * @param {object} options
 */
async function pollDeployStatus(taskId, deploymentId, { intervalMs = 5000, timeoutMs = 120000 } = {}) {
  const startTime = Date.now();
  let finalResult = 'UNKNOWN';
  let errorDetail = null;

  while (Date.now() - startTime < timeoutMs) {
    try {
      const res = await queue.get(`/BuildAndDeployStatus('${taskId}')`);
      const statusData = res.data.d || {};
      const status = statusData.Status; // e.g. "STARTING", "SUCCESS", "FAILED"

      console.log(`Polling task ${taskId}: ${status}`);

      if (status === 'SUCCESS') {
        finalResult = 'SUCCESS';
        break;
      } else if (status === 'FAILED' || status === 'ERROR') {
        finalResult = status;
        // Try to extract detailed error if available
        if (statusData.ErrorDetails || statusData.ErrorInformation) {
          errorDetail = statusData.ErrorDetails || statusData.ErrorInformation;
        } else {
          errorDetail = JSON.stringify(statusData);
        }
        break;
      }
    } catch (err) {
      console.warn(`Polling error: ${err.message}`);
    }

    await wait(intervalMs);
  }

  if (finalResult === 'UNKNOWN') {
    errorDetail = 'Polling timed out before a terminal state was reached.';
  }

  // Record outcome in audit table
  db.prepare(`
    UPDATE deployments 
    SET polling_status = ?, final_result = ?, completed_at = CURRENT_TIMESTAMP, error_detail = ?
    WHERE id = ?
  `).run('COMPLETED', finalResult, errorDetail, deploymentId);

  return {
    status: finalResult,
    error: errorDetail
  };
}

module.exports = {
  pollDeployStatus
};
