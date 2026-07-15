const { runDiscovery } = require('./index');
const { runDownloader } = require('../downloader');
const { runParser } = require('../parser/index');
const { runRelationshipEngine } = require('../engine/relationshipEngine');
const { runRuntimeDiscovery } = require('./runtimeDiscovery');

async function main() {
  console.log('Starting Manual Discovery Run...');
  try {
    const { runId, changedArtifacts } = await runDiscovery();
    
    if (changedArtifacts && changedArtifacts.length > 0) {
      await runDownloader(changedArtifacts);
    }
    
    runParser();
    
    console.log('\\n--- Step 6: Relationship Engine ---');
    const relStats = runRelationshipEngine(runId);
    
    console.log('\\n--- Step 7: Runtime Discovery ---');
    const runtimeStats = await runRuntimeDiscovery(runId);
    
    console.log('\\nFinished.');
    process.exit(0);
  } catch (err) {
    console.error('Failed.', err);
    process.exit(1);
  }
}

main();
