const db = require('./database/index');
const rows = db.prepare("SELECT parsed_json FROM parsed_metadata WHERE type = 'IFlow'").all();
rows.forEach(r => {
    const json = JSON.parse(r.parsed_json);
    if(json.steps && json.steps.length > 0) {
        json.steps.forEach(step => {
           if(step.type && step.type.toLowerCase().includes('value')) console.log(step);
        });
    }
});
