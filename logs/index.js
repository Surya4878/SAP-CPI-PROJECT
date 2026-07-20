const queue = require('../queue');
const db = require('../database');

/**
 * Helper to get an ISO string timestamp for a given number of hours ago
 */
function getTimestampHoursAgo(hours) {
  const d = new Date();
  d.setHours(d.getHours() - hours);
  // OData requires the format datetime'YYYY-MM-DDTHH:MM:SS'
  return d.toISOString().split('.')[0];
}

/**
 * Helper to get the most recent deployment timestamp for an artifact
 */
function getLastDeploymentTimestamp(artifactId) {
  // Check deployments table for the most recent SUCCESS
  const deploy = db.prepare(`
    SELECT completed_at 
    FROM deployments 
    WHERE artifact_id = ? AND final_result = 'SUCCESS' 
    ORDER BY completed_at DESC LIMIT 1
  `).get(artifactId);
  
  if (deploy && deploy.completed_at) {
    return deploy.completed_at;
  }
  
  // Fallback to runtime_status deployed_on
  const rt = db.prepare(`
    SELECT deployed_on 
    FROM runtime_status 
    WHERE artifact_id = ?
  `).get(artifactId);
  
  if (rt && rt.deployed_on) {
    return rt.deployed_on;
  }
  
  return null;
}

/**
 * Get recent run statuses. Checks local short-TTL cache first.
 */
async function getRecentStatus(artifactId, options = {}) {
  const windowHours = options.hours || 24;

  // 1. Check Cache (TTL 5 minutes)
  const cached = db.prepare(`
    SELECT run_count, failure_count, success_count 
    FROM log_queries 
    WHERE artifact_id = ? AND window_hours = ? AND cached_at >= datetime('now', '-5 minutes')
  `).get(artifactId, windowHours);

  if (cached && !options.sinceDeployment && !options.bypassCache) {
    return {
      run_count: cached.run_count,
      failure_count: cached.failure_count,
      success_count: cached.success_count,
      from_cache: true
    };
  }

  // 2. Cache Miss - Fetch from API
  let timestamp = getTimestampHoursAgo(windowHours);
  
  if (options.sinceDeployment) {
    const lastDeploy = getLastDeploymentTimestamp(artifactId);
    if (lastDeploy) {
      const formattedDeploy = new Date(lastDeploy).toISOString().split('.')[0];
      if (formattedDeploy > timestamp) {
        timestamp = formattedDeploy;
      }
    } else {
      console.warn(`[WARN] sinceDeployment requested for ${artifactId} but no deployment record found. Falling back to windowHours.`);
    }
  }
  
  // OData filter for MessageProcessingLogs
  const filter = `IntegrationFlowName eq '${artifactId}' and LogStart ge datetime'${timestamp}'`;
  
  // Use $top=1000 since we can't reliably get the full count without fetching
  const url = `/MessageProcessingLogs?$filter=${encodeURIComponent(filter)}&$top=1000&$select=MessageGuid,Status,LogStart&$format=json`;

  try {
    const response = await queue.get(url);
    const results = response.data && response.data.d && response.data.d.results ? response.data.d.results : [];

    let run_count = results.length;
    let failure_count = 0;
    let success_count = 0;

    for (const res of results) {
      if (res.Status === 'FAILED') failure_count++;
      else if (res.Status === 'COMPLETED') success_count++;
      // other statuses: PROCESSING, CANCELLED, ESCALATED, etc.
    }

    // 3. Upsert Cache (only if not sinceDeployment to keep caching logic simple)
    if (!options.sinceDeployment) {
      db.prepare(`
        INSERT INTO log_queries (artifact_id, window_hours, run_count, failure_count, success_count, cached_at)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(artifact_id, window_hours) DO UPDATE SET
          run_count = excluded.run_count,
          failure_count = excluded.failure_count,
          success_count = excluded.success_count,
          cached_at = excluded.cached_at
      `).run(artifactId, windowHours, run_count, failure_count, success_count);
    }

    return {
      run_count,
      failure_count,
      success_count,
      from_cache: false
    };
  } catch (err) {
    throw new Error(`Failed to fetch MessageProcessingLogs for ${artifactId}: ${err.message}`);
  }
}

/**
 * Get the actual string error details for failed logs.
 * Does a live lookup on /MessageProcessingLogs with Status eq 'FAILED'.
 * Capped by the limit option.
 */
async function getFailureDetails(artifactId, options = {}) {
  const windowHours = options.hours || 24;
  const limit = options.limit || 10;
  
  let timestamp = getTimestampHoursAgo(windowHours);
  
  if (options.sinceDeployment) {
    const lastDeploy = getLastDeploymentTimestamp(artifactId);
    if (lastDeploy) {
      const formattedDeploy = new Date(lastDeploy).toISOString().split('.')[0];
      if (formattedDeploy > timestamp) {
        timestamp = formattedDeploy;
      }
    } else {
      console.warn(`[WARN] sinceDeployment requested for ${artifactId} but no deployment record found. Falling back to windowHours.`);
    }
  }
  
  const filter = `IntegrationFlowName eq '${artifactId}' and Status eq 'FAILED' and LogStart ge datetime'${timestamp}'`;
  const url = `/MessageProcessingLogs?$filter=${encodeURIComponent(filter)}&$top=${limit}&$select=MessageGuid,LogStart&$format=json`;

  let results = [];
  try {
    const response = await queue.get(url);
    results = response.data && response.data.d && response.data.d.results ? response.data.d.results : [];
  } catch (err) {
    throw new Error(`Failed to fetch FAILED MessageProcessingLogs for ${artifactId}: ${err.message}`);
  }

  if (results.length === 0) {
    return [];
  }

  const details = [];

  for (const res of results) {
    const guid = res.MessageGuid;
    try {
      const errRes = await queue.get(`/MessageProcessingLogs('${guid}')/ErrorInformation/$value`, {
        // If it's plain text, we don't want axios to parse it as JSON
        responseType: 'text'
      });
      // The $value endpoint returns the raw string
      details.push({
        guid,
        timestamp: res.LogStart,
        error: errRes.data
      });
    } catch (err) {
      details.push({
        guid,
        timestamp: res.LogStart,
        error: `Could not fetch error detail: ${err.message}`
      });
    }
  }

  return details;
}

module.exports = {
  getRecentStatus,
  getFailureDetails
};

