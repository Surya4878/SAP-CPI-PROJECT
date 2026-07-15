const fs = require('fs');
const db = require('./database/index');
const row = db.prepare("SELECT content FROM resources WHERE path LIKE '%.iflw' AND content IS NOT NULL LIMIT 1").get();
fs.writeFileSync('scratch_xml.xml', row.content);
console.log('Saved to scratch_xml.xml');
