const db = require('./database/index');
const rows = db.prepare("SELECT artifact_id, parsed_json FROM parsed_metadata WHERE type = 'IFlow'").all();
rows.forEach(r => {
    const json = JSON.parse(r.parsed_json);
    if(json.references && json.references.length > 0) {
        console.log(r.artifact_id, json.references);
    }
});
