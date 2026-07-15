require('./database/schema');
const db = require('./database/index');
const { processArtifactDownload } = require('./downloader/index');
const { runParser } = require('./parser/index');

async function forceRun() {
  const artifacts = db.prepare("SELECT * FROM artifacts WHERE type IN ('IFlow', 'ValueMapping') AND deleted_at IS NULL").all();
  
  // Reset hash in DB so download doesn't skip extraction
  db.prepare("UPDATE artifacts SET content_hash = NULL WHERE type IN ('IFlow', 'ValueMapping')").run();

  for (const art of artifacts) {
     console.log(`Downloading ${art.type}: ${art.source_id}`);
     await processArtifactDownload(art);
  }
  
  runParser();
}

forceRun().catch(console.error);
