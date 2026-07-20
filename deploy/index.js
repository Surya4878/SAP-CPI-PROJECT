const db = require('../database/index');
const queue = require('../queue/index');
const { getCSRFCredentials } = require('../auth/csrf');

/**
 * Triggers a redeployment of an existing artifact and records the attempt.
 * Does not check validation itself; relies on the CLI to do pre-flight checks.
 */
async function deployArtifact(artifactId, confirmedBy) {
  // Log the initial attempt
  const info = db.prepare(`
    INSERT INTO deployments (
      artifact_id, 
      confirmed_by,
      polling_status
    ) VALUES (?, ?, 'INITIATED')
  `).run(artifactId, confirmedBy);
  const deploymentId = info.lastInsertRowid;

  let taskId = null;
  let finalStatus = 'INITIATED';
  let errorDetail = null;

  try {
    // 1. Fetch CSRF credentials
    const { csrfToken, cookies } = await getCSRFCredentials();

    // 2. Trigger Deploy
    const deployUrl = `/DeployIntegrationDesigntimeArtifact?Id='${artifactId}'&Version='active'`;
    const res = await queue.post(deployUrl, null, {
      headers: {
        'X-CSRF-Token': csrfToken,
        'Cookie': cookies,
        'Accept': 'application/json'
      }
    });

    if (res.status === 202) {
      // The task ID is returned as a raw string in the response body (e.g. "2b68...")
      // We trim quotes just in case.
      taskId = typeof res.data === 'string' ? res.data.replace(/^"|"$/g, '') : JSON.stringify(res.data);
      finalStatus = 'POLLING';
    } else {
      finalStatus = 'FAILED';
      errorDetail = `Unexpected HTTP ${res.status}`;
    }

  } catch (err) {
    finalStatus = 'FAILED';
    errorDetail = err.response && err.response.data 
      ? JSON.stringify(err.response.data) 
      : err.message;
  }

  // Update audit log
  db.prepare(`
    UPDATE deployments 
    SET task_id = ?, polling_status = ?, error_detail = ?
    WHERE id = ?
  `).run(taskId, finalStatus, errorDetail, deploymentId);

  return {
    deploymentId,
    taskId,
    status: finalStatus,
    error: errorDetail
  };
}

/**
 * Triggers an undeployment of an artifact and records the attempt.
 */
async function undeployArtifact(artifactId, confirmedBy) {
  const info = db.prepare(`
    INSERT INTO deployments (
      artifact_id, 
      confirmed_by,
      polling_status
    ) VALUES (?, ?, 'UNDEPLOY_INITIATED')
  `).run(artifactId, confirmedBy);
  const deploymentId = info.lastInsertRowid;

  let taskId = null;
  let finalStatus = 'UNDEPLOY_INITIATED';
  let errorDetail = null;

  try {
    const { csrfToken, cookies } = await getCSRFCredentials();

    const deleteUrl = `/IntegrationRuntimeArtifacts('${artifactId}')`;
    const res = await queue.delete(deleteUrl, {
      headers: {
        'X-CSRF-Token': csrfToken,
        'Cookie': cookies,
        'Accept': 'application/json'
      }
    });

    if (res.status === 202) {
      taskId = typeof res.data === 'string' ? res.data.replace(/^"|"$/g, '') : JSON.stringify(res.data);
      finalStatus = 'POLLING';
    } else if (res.status === 200 || res.status === 204) {
      finalStatus = 'SUCCESS';
    } else {
      finalStatus = 'FAILED';
      errorDetail = `Unexpected HTTP ${res.status}`;
    }

  } catch (err) {
    finalStatus = 'FAILED';
    errorDetail = err.response && err.response.data 
      ? JSON.stringify(err.response.data) 
      : err.message;
  }

  db.prepare(`
    UPDATE deployments 
    SET task_id = ?, polling_status = ?, error_detail = ?
    WHERE id = ?
  `).run(taskId, finalStatus, errorDetail, deploymentId);

  return {
    deploymentId,
    taskId,
    status: finalStatus,
    error: errorDetail
  };
}

module.exports = {
  deployArtifact,
  undeployArtifact
};
