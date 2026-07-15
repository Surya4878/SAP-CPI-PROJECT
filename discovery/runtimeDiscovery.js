const queue = require('../queue');
const db = require('../database');

async function fetchRuntimeArtifacts(syncRunId) {
  let skip = 0;
  const top = 100;
  let hasMore = true;
  let totalFound = 0;
  let totalErrors = 0;

  const insertStmt = db.prepare(`
    INSERT INTO runtime_status (artifact_id, status, version, type, deployed_on, error_info, sync_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  while (hasMore) {
    const response = await queue.get(`/IntegrationRuntimeArtifacts?$top=${top}&$skip=${skip}&$format=json`);
    
    if (!response || !response.data || !response.data.d || !response.data.d.results || response.data.d.results.length === 0) {
      hasMore = false;
      break;
    }

    const results = response.data.d.results;
    
    for (const item of results) {
      let errorInfo = null;
      if (item.Status === 'ERROR' || item.Status === 'FAILED') {
        try {
          const errRes = await queue.get(`/IntegrationRuntimeArtifacts('${item.Id}')/ErrorInformation/$value`, { responseType: 'text' });
          if (errRes && typeof errRes === 'string') {
            errorInfo = errRes;
          } else if (errRes && errRes.data) { // axios might put it in data
            errorInfo = errRes.data;
          }
        } catch (err) {
          console.warn(`[RuntimeDiscovery] Failed to fetch ErrorInformation for ${item.Id}: ${err.message}`);
        }
        totalErrors++;
      }

      let deployedOn = null;
      if (item.DeployedOn) {
        // extract datetime if it's like "/Date(123456789)/"
        const match = item.DeployedOn.match(new RegExp('/Date\\\\((\\\\d+)\\\\)/'));
        if (match) {
          deployedOn = new Date(parseInt(match[1], 10)).toISOString();
        } else {
          deployedOn = item.DeployedOn;
        }
      }

      insertStmt.run(
        item.Id,
        item.Status || null,
        item.Version || null,
        item.Type || null,
        deployedOn,
        errorInfo,
        syncRunId
      );
      totalFound++;
    }

    if (results.length < top) {
      hasMore = false;
    } else {
      skip += top;
    }
  }

  return { totalFound, totalErrors };
}

async function fetchServiceEndpoints(syncRunId) {
  let skip = 0;
  const top = 100;
  let hasMore = true;
  let totalEndpoints = 0;

  const insertStmt = db.prepare(`
    INSERT INTO service_endpoints (artifact_id, endpoint_url, raw_metadata, sync_run_id)
    VALUES (?, ?, ?, ?)
  `);

  // Log the raw shape on first fetch
  let firstLog = true;

  while (hasMore) {
    const response = await queue.get(`/ServiceEndpoints?$top=${top}&$skip=${skip}&$format=json`);
    
    if (!response || !response.data || !response.data.d || !response.data.d.results || response.data.d.results.length === 0) {
      hasMore = false;
      break;
    }

    const results = response.data.d.results;
    
    for (const item of results) {
      if (firstLog) {
        console.log('[RuntimeDiscovery] [Verify] Payload shape for ServiceEndpoint:', Object.keys(item));
        firstLog = false;
      }
      
      const artifactId = item.Id || item.ArtifactId || item.Name || 'UNKNOWN';
      const endpointUrl = item.Url || item.EndpointUrl || item.Address || 'UNKNOWN';

      insertStmt.run(
        artifactId,
        endpointUrl,
        JSON.stringify(item),
        syncRunId
      );
      totalEndpoints++;
    }

    if (results.length < top) {
      hasMore = false;
    } else {
      skip += top;
    }
  }

  return { totalEndpoints };
}

async function runRuntimeDiscovery(syncRunId) {
  console.log(`\n[RuntimeDiscovery] Starting runtime discovery for syncRunId: ${syncRunId}`);
  
  // Truncate and rebuild
  db.prepare('DELETE FROM runtime_status').run();
  db.prepare('DELETE FROM service_endpoints').run();

  const { totalFound, totalErrors } = await fetchRuntimeArtifacts(syncRunId);
  const { totalEndpoints } = await fetchServiceEndpoints(syncRunId);

  // Cross-reference check
  const danglingQuery = db.prepare(`
    SELECT r.artifact_id 
    FROM runtime_status r 
    LEFT JOIN artifacts a ON r.artifact_id = a.source_id 
    WHERE a.source_id IS NULL
  `).all();

  console.log(`[RuntimeDiscovery] Complete! Runtime Artifacts: ${totalFound}, Errors: ${totalErrors}, Service Endpoints: ${totalEndpoints}`);
  
  if (danglingQuery.length > 0) {
    const danglingIds = danglingQuery.map(row => row.artifact_id);
    console.warn(`[RuntimeDiscovery] Found ${danglingIds.length} Runtime Artifacts with no matching design-time IFlow! First 5: ${danglingIds.slice(0, 5).join(', ')}`);
  } else {
    console.log('[RuntimeDiscovery] All Runtime Artifacts perfectly matched known design-time IFlows!');
  }

  return {
    totalFound,
    totalErrors,
    totalEndpoints,
    danglingCount: danglingQuery.length
  };
}

module.exports = {
  runRuntimeDiscovery
};
