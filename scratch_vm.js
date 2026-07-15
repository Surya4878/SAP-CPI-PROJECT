const db = require('./database/index');
const row = db.prepare("SELECT content FROM resources WHERE artifact_id = 'VALUEMAPPING__' AND path LIKE '%.iflw'").get();
const xml = row.content;
const lines = xml.split('\n');
lines.forEach((line) => {
   if(line.toLowerCase().includes('valuemapping')) console.log(line);
});
