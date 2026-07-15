const Database = require('better-sqlite3');
const db = new Database('./data/cpi_metadata.db');

const rows = db.prepare("SELECT source_id, type FROM artifacts WHERE source_id = 'JMS'").all();
console.log('Artifacts named JMS:', rows);

const iflows = db.prepare("SELECT artifact_id, parsed_json FROM parsed_metadata WHERE type = 'IFlow'").all();
iflows.forEach(r => {
  const json = JSON.parse(r.parsed_json);
  json.adapters.forEach(a => {
     if (a.address && (a.address.includes('smtp') || a.address.includes('sftp'))) {
        console.log(r.artifact_id, a.type, '->', a.address);
     }
  });
});
