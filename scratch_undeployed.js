const db = require('./database/index');

const undeployed = db.prepare(`
  SELECT source_id, name 
  FROM artifacts 
  WHERE source_id NOT IN (SELECT artifact_id FROM runtime_status)
`).all();

console.log('Undeployed Artifacts:');
console.table(undeployed);
