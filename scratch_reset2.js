const db = require('./database/index');
db.prepare("UPDATE resources SET content_hash = NULL").run();
console.log('Resource hashes reset');
