const db = require('../database');
const { parseValueMapping, PARSER_VERSION: VM_VER } = require('./valueMappingParser');
const { parseIFlow, PARSER_VERSION: IFLOW_VER } = require('./iflowParser');

function runParser() {
  console.log(`[Parser] Starting extraction of normalized metadata...`);
  let parsedCount = 0;
  let partialCount = 0;
  let errorCount = 0;

  // 1. ValueMappings
  // Find all ValueMapping resources that are value_mapping.xml and need parsing
  // Condition: parsed_metadata missing, or parser_version < current, or content changed (which triggers delete of old parsed_metadata if cascade worked, but here we can just do an UPSERT)
  const vmResources = db.prepare(`
    SELECT r.artifact_id, r.content 
    FROM resources r
    LEFT JOIN parsed_metadata p ON r.artifact_id = p.artifact_id AND p.type = 'ValueMapping'
    WHERE r.path LIKE '%value_mapping.xml'
      AND r.deleted_at IS NULL
      AND (p.id IS NULL OR p.parser_version < ?)
  `).all(VM_VER);

  for (const res of vmResources) {
    if (!res.content) continue; // Skip if no content extracted
    try {
      const parsedData = parseValueMapping(res.content);
      
      // Upsert parsed metadata
      db.prepare(`
        INSERT INTO parsed_metadata (artifact_id, type, parser_version, parsed_json)
        VALUES (?, 'ValueMapping', ?, ?)
        ON CONFLICT(artifact_id, type) DO UPDATE SET
          parser_version = excluded.parser_version,
          parsed_json = excluded.parsed_json,
          parsed_at = CURRENT_TIMESTAMP
      `).run(res.artifact_id, VM_VER, JSON.stringify(parsedData));
      
      parsedCount++;
    } catch(err) {
      console.error(`[Parser] Error parsing ValueMapping ${res.artifact_id}:`, err.message);
      errorCount++;
    }
  }

  // 2. IFlows
  const iflowResources = db.prepare(`
    SELECT r.artifact_id, r.content 
    FROM resources r
    LEFT JOIN parsed_metadata p ON r.artifact_id = p.artifact_id AND p.type = 'IFlow'
    WHERE r.path LIKE '%.iflw'
      AND r.deleted_at IS NULL
      AND (p.id IS NULL OR p.parser_version < ?)
  `).all(IFLOW_VER);

  for (const res of iflowResources) {
    if (!res.content) continue;
    try {
      const parsedData = parseIFlow(res.content);
      
      // Check for partials (Unknown adapters)
      const hasUnknownAdapter = parsedData.adapters.some(a => a.type === 'Unknown');
      if (hasUnknownAdapter) {
        partialCount++;
        // console.warn(`[Parser] IFlow ${res.artifact_id} contains unknown adapters (Partial Parse)`);
      } else {
        parsedCount++;
      }

      db.prepare(`
        INSERT INTO parsed_metadata (artifact_id, type, parser_version, parsed_json)
        VALUES (?, 'IFlow', ?, ?)
        ON CONFLICT(artifact_id, type) DO UPDATE SET
          parser_version = excluded.parser_version,
          parsed_json = excluded.parsed_json,
          parsed_at = CURRENT_TIMESTAMP
      `).run(res.artifact_id, IFLOW_VER, JSON.stringify(parsedData));

    } catch (err) {
      console.error(`[Parser] Error parsing IFlow ${res.artifact_id}:`, err.message);
      errorCount++;
    }
  }

  console.log(`[Parser] Complete! Parsed: ${parsedCount}, Partial: ${partialCount}, Errors: ${errorCount}`);
  
  return { parsed: parsedCount, partial: partialCount, errors: errorCount };
}

module.exports = {
  runParser
};
