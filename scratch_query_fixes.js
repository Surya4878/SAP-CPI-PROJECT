const db = require('./database/index');

const row = db.prepare("SELECT id, artifact_id, generated_at, proposed_content, error_summary, fix_summary, fix_type, element_path, attribute_name FROM generated_fixes WHERE artifact_id = 'SFTP_and_poll_enricher' ORDER BY generated_at DESC LIMIT 1").get();

console.log(JSON.stringify(row, null, 2));
