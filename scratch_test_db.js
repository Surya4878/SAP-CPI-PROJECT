const db = require('./database/index');

const countContent = db.prepare("SELECT count(*) as c FROM resources WHERE content IS NOT NULL").get();
console.log("Resources with content:", countContent.c);

const firstIflw = db.prepare("SELECT artifact_id, path FROM resources WHERE path LIKE '%.iflw' LIMIT 1").get();
console.log("first iflw:", firstIflw);

const firstVm = db.prepare("SELECT artifact_id, path FROM resources WHERE path LIKE '%value_mapping.xml' LIMIT 1").get();
console.log("first vm:", firstVm);

// Check if parser finds anything manually
const IFLOW_VER = 1;
const iflowResources = db.prepare(`
    SELECT r.artifact_id, r.path
    FROM resources r
    LEFT JOIN parsed_metadata p ON r.artifact_id = p.artifact_id AND p.type = 'IFlow'
    WHERE r.path LIKE '%.iflw'
      AND r.deleted_at IS NULL
      AND (p.id IS NULL OR p.parser_version < ?)
  `).all(IFLOW_VER);
console.log("iflowResources to parse:", iflowResources.length);
