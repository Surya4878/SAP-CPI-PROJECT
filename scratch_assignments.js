const Database = require('better-sqlite3');
const db = new Database('./data/cpi_metadata.db');
const rows = db.prepare("SELECT source_id, target_id, relationship_type FROM relationships WHERE source_id LIKE '%Assignment%' OR target_id LIKE '%Assignment%'").all();
console.table(rows);
