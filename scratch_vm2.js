const db = require('./database/index');
const fs = require('fs');
const row = db.prepare("SELECT content FROM resources WHERE artifact_id = 'VALUEMAPPING__' AND path LIKE '%.iflw'").get();
fs.writeFileSync('valuemapping_iflow.xml', row.content);
