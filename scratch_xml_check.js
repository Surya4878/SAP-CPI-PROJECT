const db = require('./database/index');
const row = db.prepare("SELECT content FROM resources WHERE artifact_id = 'Assignment_HTTP_Request_Reply_with_Exception_Handling' AND path LIKE '%.iflw'").get();
const xml = row.content;
const lines = xml.split('\n');
lines.forEach((line) => {
   if(line.includes('ErrorEvent') || line.includes('StartEvent') || line.includes('startEvent') || line.includes('endEvent')) console.log(line);
});
