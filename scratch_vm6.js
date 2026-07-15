const db = require('./database/index');
const rows = db.prepare("SELECT artifact_id, content FROM resources WHERE path LIKE '%.iflw'").all();
rows.forEach(r => {
    if(r.content && r.content.includes('ValueMapping')) {
        console.log(`Found ValueMapping in iflow: ${r.artifact_id}`);
    }
});
