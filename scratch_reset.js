require('./database/schema');
const db = require('./database/index');
db.prepare("UPDATE artifacts SET content_hash = NULL WHERE type IN ('IFlow', 'ValueMapping')").run();
console.log("Hashes reset. Ready for live run.");
