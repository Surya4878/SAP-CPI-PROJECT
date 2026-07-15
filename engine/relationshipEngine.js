const db = require('../database');

function normalizeAddress(address) {
  if (!address) return null;
  
  // Check if it looks like a full URL with scheme
  if (address.includes('://')) {
    try {
      const url = new URL(address);
      let host = url.hostname.toLowerCase();
      let port = url.port;
      
      if (url.protocol === 'https:' && port === '443') port = '';
      if (url.protocol === 'http:' && port === '80') port = '';
      if (url.protocol === 'sftp:' && port === '22') port = '';
      if (url.protocol === 'ftp:' && port === '21') port = '';
      
      return `${url.protocol}//${host}${port ? ':' + port : ''}`;
    } catch (e) {
      // Fallback below
    }
  }

  // Fallback if it's not a standard parsable URL
  // e.g. JDBC strings, dynamic ${header.url}, plain host:port, etc.
  // Strip everything after ? and lowercase
  let cleaned = address.split('?')[0];
  // Strip trailing slashes
  if (cleaned.endsWith('/')) cleaned = cleaned.slice(0, -1);
  
  // Manually strip trailing standard ports if present to catch non-HTTP URLs
  if (cleaned.endsWith(':443')) cleaned = cleaned.replace(/:443$/, '');
  if (cleaned.endsWith(':80')) cleaned = cleaned.replace(/:80$/, '');
  if (cleaned.endsWith(':22')) cleaned = cleaned.replace(/:22$/, '');
  if (cleaned.endsWith(':21')) cleaned = cleaned.replace(/:21$/, '');
  if (cleaned.endsWith(':587')) cleaned = cleaned.replace(/:587$/, '');
  
  return cleaned.toLowerCase();
}

function runRelationshipEngine(syncRunId) {
  console.log(`[RelationshipEngine] Starting run for syncRunId: ${syncRunId}`);
  
  // Fully recompute - wipe existing relationships
  db.prepare('DELETE FROM relationships').run();

  const iflows = db.prepare("SELECT artifact_id, parsed_json FROM parsed_metadata WHERE type = 'IFlow'").all();
  
  let totalExternalSystems = 0;
  let processDirectChains = 0;
  let jmsChains = 0;
  let valueMappingLinks = 0;

  const externalSystemSet = new Set();
  const processDirectMap = { sender: {}, receiver: {} };
  const jmsMap = { sender: {}, receiver: {} };

  const insertStmt = db.prepare(`
    INSERT INTO relationships (source_type, source_id, target_type, target_id, relationship_type, metadata, sync_run_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  for (const row of iflows) {
    const artifactId = row.artifact_id;
    let json;
    try {
      json = JSON.parse(row.parsed_json);
    } catch(e) {
      continue;
    }
    
    // 1. External Systems & Routing Collect
    for (const adapter of json.adapters) {
      if (['ProcessDirect', 'JMS'].includes(adapter.type)) {
        // Collect for later matching
        const map = adapter.type === 'ProcessDirect' ? processDirectMap : jmsMap;
        const address = adapter.address || 'UNKNOWN';
        const direction = adapter.direction; // Sender or Receiver
        
        if (direction === 'Sender') {
          if (!map.sender[address]) map.sender[address] = [];
          map.sender[address].push(artifactId);
        } else if (direction === 'Receiver') {
          if (!map.receiver[address]) map.receiver[address] = [];
          map.receiver[address].push(artifactId);
        }
      } else {
        // External System
        if (adapter.address) {
          const normAddr = normalizeAddress(adapter.address);
          if (normAddr) {
            externalSystemSet.add(normAddr);
            
            const relType = adapter.direction === 'Sender' ? 'receives_from' : 'sends_to';
            insertStmt.run(
              'IFlow', artifactId,
              'ExternalSystem', normAddr,
              relType,
              JSON.stringify({ adapterType: adapter.type, originalAddress: adapter.address }),
              syncRunId
            );
          }
        }
      }
    }

    // 2. ValueMapping References
    for (const ref of json.references) {
      if (ref.type === 'ValueMapping' && ref.path) {
        insertStmt.run(
          'IFlow', artifactId,
          'ValueMapping', ref.path,
          'references_valuemapping',
          JSON.stringify({}),
          syncRunId
        );
        valueMappingLinks++;
      }
    }
  }

  // 3. Match ProcessDirect
  for (const [address, senders] of Object.entries(processDirectMap.sender)) {
    const receivers = processDirectMap.receiver[address];
    if (receivers && receivers.length > 0) {
      for (const sender of senders) {
        for (const receiver of receivers) {
          // sender iFlow is triggered by the ProcessDirect address.
          // meaning receiver iFlow CALLS this sender iFlow.
          // So receiver iFlow -> calls_via_processdirect -> sender iFlow.
          insertStmt.run(
            'IFlow', receiver,
            'IFlow', sender,
            'calls_via_processdirect',
            JSON.stringify({ address }),
            syncRunId
          );
          processDirectChains++;
        }
      }
    } else {
      console.warn(`[RelationshipEngine] Orphaned ProcessDirect Sender: Address '${address}' used in [${senders.join(', ')}] has no matching Receiver.`);
    }
  }
  for (const [address, receivers] of Object.entries(processDirectMap.receiver)) {
    if (!processDirectMap.sender[address] || processDirectMap.sender[address].length === 0) {
      console.warn(`[RelationshipEngine] Orphaned ProcessDirect Receiver: Address '${address}' used in [${receivers.join(', ')}] has no matching Sender.`);
    }
  }

  // 4. Match JMS
  for (const [queue, senders] of Object.entries(jmsMap.sender)) {
    // In JMS, Sender adapter means the iFlow is triggered by the queue (consumes from queue).
    // Receiver adapter means the iFlow sends to the queue (produces to queue).
    const receivers = jmsMap.receiver[queue];
    
    if (receivers && receivers.length > 0) {
      for (const sender of senders) {
        for (const receiver of receivers) {
          // receiver IFlow produces to queue, sender IFlow consumes from queue
          // So receiver IFlow -> sends_via_jms -> sender IFlow
          insertStmt.run(
            'IFlow', receiver,
            'IFlow', sender,
            'calls_via_jms',
            JSON.stringify({ queue }),
            syncRunId
          );
          jmsChains++;
        }
      }
    } else {
      console.warn(`[RelationshipEngine] Orphaned JMS Consumer (Sender adapter): Queue '${queue}' used in [${senders.join(', ')}] has no matching Producer.`);
    }
  }
  
  for (const [queue, receivers] of Object.entries(jmsMap.receiver)) {
    if (!jmsMap.sender[queue] || jmsMap.sender[queue].length === 0) {
      console.warn(`[RelationshipEngine] Orphaned JMS Producer (Receiver adapter): Queue '${queue}' used in [${receivers.join(', ')}] has no matching Consumer.`);
    }
  }

  totalExternalSystems = externalSystemSet.size;

  console.log(`[RelationshipEngine] Complete! External Systems: ${totalExternalSystems}, ProcessDirect Chains: ${processDirectChains}, JMS Chains: ${jmsChains}, ValueMapping Links: ${valueMappingLinks}`);
  
  return {
    externalSystems: totalExternalSystems,
    processDirectChains,
    jmsChains,
    valueMappingLinks
  };
}

module.exports = {
  runRelationshipEngine
};
