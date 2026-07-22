const db = require('./database/index');

const artifactRow = db.prepare("SELECT * FROM artifacts WHERE source_id = 'SFTP_and_poll_enricher'").get();
const errorLog = db.prepare("SELECT error_log FROM error_logs WHERE artifact_id = 'SFTP_and_poll_enricher' ORDER BY captured_at DESC LIMIT 1").get();

console.log('Artifact:', artifactRow);
console.log('Error Log:', errorLog);
