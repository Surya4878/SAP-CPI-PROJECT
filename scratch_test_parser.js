const db = require('./database/index');
const { parseIFlow } = require('./parser/iflowParser');
const row = db.prepare("SELECT content FROM resources WHERE path LIKE '%.iflw' AND artifact_id = 'Assignment_HTTP_Request_Reply_with_Exception_Handling'").get();
const parsed = parseIFlow(row.content);
console.log(JSON.stringify(parsed, null, 2));
