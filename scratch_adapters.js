require('dotenv').config();
const db = require('./database');
const queue = require('./queue');
const AdmZip = require('adm-zip');

async function findAdapters() {
  const artifacts = db.prepare(`SELECT source_id, version FROM artifacts WHERE type = 'IFlow' AND deleted_at IS NULL`).all();
  const adaptersFound = new Set();
  const stepsFound = new Set();
  
  console.log(`Checking ${artifacts.length} IFlows...`);
  for (const art of artifacts) {
    try {
      const url = `/IntegrationDesigntimeArtifacts(Id='${art.source_id}',Version='${art.version}')/$value`;
      const response = await queue.get(url, { responseType: 'arraybuffer' });
      const zip = new AdmZip(Buffer.from(response.data));
      const zipEntries = zip.getEntries();
      for (const entry of zipEntries) {
        if (!entry.isDirectory && entry.entryName.endsWith('.iflw')) {
          const xmlStr = entry.getData().toString('utf8');
          // Find ComponentType
          const compMatches = [...xmlStr.matchAll(/<key>ComponentType<\/key>\s*<value>([^<]+)<\/value>/g)];
          for (const match of compMatches) {
            adaptersFound.add(match[1]);
          }
          // Find activityType for steps
          const stepMatches = [...xmlStr.matchAll(/<key>activityType<\/key>\s*<value>([^<]+)<\/value>/g)];
          for (const match of stepMatches) {
            stepsFound.add(match[1]);
          }
        }
      }
    } catch (e) {
      console.error(`Failed to download ${art.source_id}: ${e.message}`);
    }
  }
  console.log('--- Adapters Found ---');
  for (const a of adaptersFound) {
    console.log(a);
  }
  console.log('--- Steps Found ---');
  for (const s of stepsFound) {
    console.log(s);
  }
}

findAdapters().catch(console.error);
