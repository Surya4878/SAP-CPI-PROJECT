const db = require('better-sqlite3')('./data/cpi_metadata.db');
const tables = [
  'packages', 'artifacts', 'resources', 'parsed_metadata',
  'relationships', 'runtime_status', 'service_endpoints',
  'custom_tags', 'sync_runs'
];
const counts = {};
for (const t of tables) {
  counts[t] = db.prepare('SELECT COUNT(*) as c FROM ' + t).get().c;
}
console.log(JSON.stringify(counts, null, 2));

const lastRun = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
console.log('Last sync run:', lastRun);
