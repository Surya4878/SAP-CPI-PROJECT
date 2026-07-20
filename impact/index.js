/**
 * Given an iFlow's source_id, traverse `relationships` to find everything that depends on it
 * transitively: callers of callers, up to a configurable depth (default 3).
 */
function getDownstreamImpact(db, artifactId, maxDepth = 3) {
  const result = [];
  const visited = new Set();
  
  // BFS queue stores { id, depth, chain }
  const queue = [{ id: artifactId, depth: 1, chain: [] }];
  
  const stmt = db.prepare(`
    SELECT source_id as caller_id, relationship_type, metadata 
    FROM relationships 
    WHERE target_id = ? AND target_type = 'IFlow'
  `);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth > maxDepth) continue;

    const callers = stmt.all(current.id);
    for (const caller of callers) {
      const cycleKey = `${caller.caller_id}->${current.id}`;
      if (visited.has(cycleKey)) continue; // avoid infinite loops
      visited.add(cycleKey);
      
      const newChain = [...current.chain, { 
        from: caller.caller_id, 
        to: current.id, 
        type: caller.relationship_type, 
        metadata: caller.metadata ? JSON.parse(caller.metadata) : {}
      }];

      result.push({
        id: caller.caller_id,
        relationshipType: caller.relationship_type,
        metadata: caller.metadata ? JSON.parse(caller.metadata) : {},
        depth: current.depth,
        chain: newChain
      });

      queue.push({
        id: caller.caller_id,
        depth: current.depth + 1,
        chain: newChain
      });
    }
  }

  return result;
}

/**
 * Inverse of downstream: what does this iFlow depend ON — its own ExternalSystem targets, 
 * and any iFlow it calls via ProcessDirect/JMS.
 */
function getUpstreamDependencies(db, artifactId, maxDepth = 3) {
  const result = [];
  const visited = new Set();
  
  const queue = [{ id: artifactId, depth: 1, chain: [] }];
  
  const stmt = db.prepare(`
    SELECT target_id, target_type, relationship_type, metadata 
    FROM relationships 
    WHERE source_id = ?
  `);

  while (queue.length > 0) {
    const current = queue.shift();
    if (current.depth > maxDepth) continue;

    const dependencies = stmt.all(current.id);
    for (const dep of dependencies) {
      const cycleKey = `${current.id}->${dep.target_id}`;
      if (visited.has(cycleKey)) continue;
      visited.add(cycleKey);

      const newChain = [...current.chain, {
        from: current.id,
        to: dep.target_id,
        type: dep.relationship_type,
        metadata: dep.metadata ? JSON.parse(dep.metadata) : {}
      }];

      result.push({
        id: dep.target_id,
        type: dep.target_type,
        relationshipType: dep.relationship_type,
        metadata: dep.metadata ? JSON.parse(dep.metadata) : {},
        depth: current.depth,
        chain: newChain
      });

      // Recurse only if the target is an IFlow. External Systems have no downstream logic.
      if (dep.target_type === 'IFlow') {
        queue.push({
          id: dep.target_id,
          depth: current.depth + 1,
          chain: newChain
        });
      }
    }
  }

  return result;
}

/**
 * Given a normalized ExternalSystem identity, return every iFlow that sends_to or receives_from it.
 */
function getExternalSystemImpact(db, systemHost) {
  const stmt = db.prepare(`
    SELECT source_id, relationship_type, metadata
    FROM relationships
    WHERE target_id = ? AND target_type = 'ExternalSystem'
  `);
  
  const results = stmt.all(systemHost);
  return results.map(r => ({
    id: r.source_id,
    relationshipType: r.relationship_type,
    metadata: r.metadata ? JSON.parse(r.metadata) : {}
  }));
}

/**
 * Single summary object combining directCallers, transitiveCallers, externalSystemsUsed, 
 * dependsOnIflows, and riskFactors.
 */
async function getBlastRadius(db, artifactId, options = {}) {
  const downstream = getDownstreamImpact(db, artifactId);
  const upstream = getUpstreamDependencies(db, artifactId);

  const directCallers = downstream.filter(d => d.depth === 1);
  const transitiveCallers = downstream.filter(d => d.depth > 1);

  const externalSystemsUsed = upstream.filter(u => u.type === 'ExternalSystem');
  const dependsOnIflows = upstream.filter(u => u.type === 'IFlow');

  // Risk Factors extraction
  const riskFactors = [];
  if (directCallers.length > 0) {
    riskFactors.push(`Called by ${directCallers.length} other iFlows`);
  }
  if (transitiveCallers.length > 0) {
    riskFactors.push(`Has ${transitiveCallers.length} transitive downstream callers`);
  }
  if (externalSystemsUsed.length > 0) {
    riskFactors.push(`Depends on ${externalSystemsUsed.length} external systems`);
  }

  const parsedStmt = db.prepare(`
    SELECT parsed_json FROM parsed_metadata WHERE artifact_id = ? AND type = 'IFlow'
  `);
  const parsedData = parsedStmt.get(artifactId);
  
  if (parsedData && parsedData.parsed_json) {
    const jsonStr = parsedData.parsed_json;
    if (jsonStr.includes('Exception Subprocess') || jsonStr.includes('Error Start Event')) {
      riskFactors.push('Contains Exception Subprocess (custom error handling)');
    }
  }

  let recent_status = null;
  if (options.includeRecentErrors) {
    const logs = require('../logs/index');
    recent_status = await logs.getRecentStatus(artifactId, { hours: options.hours || 24 });
    if (recent_status.failure_count > 0) {
      riskFactors.push(`Has failed in the last ${options.hours || 24} hours`);
    }
  }

  return {
    directCallers,
    transitiveCallers,
    externalSystemsUsed,
    dependsOnIflows,
    riskFactors,
    recent_status
  };
}

module.exports = {
  getDownstreamImpact,
  getUpstreamDependencies,
  getExternalSystemImpact,
  getBlastRadius
};
