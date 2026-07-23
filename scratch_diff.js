const db = require('./database');
const AdmZip = require('adm-zip');
const { createHash } = require('crypto');
const queue = require('./queue');

async function run() {
  const artifactId = 'dateanddatatypes';
  
  const row = db.prepare(`SELECT zip_content FROM artifact_versions WHERE artifact_id = ? AND cpi_version = 'active' ORDER BY saved_at DESC LIMIT 1`).get(artifactId);
  const zipDB = new AdmZip(row.zip_content);
  
  const res = await queue.get(`/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')/$value`, { responseType: 'arraybuffer' });
  const zipLive = new AdmZip(Buffer.from(res.data, 'binary'));
  
  for (const k of ['src/main/resources/parameters.prop', 'metainfo.prop']) {
      const dbData = zipDB.getEntry(k)?.getData().toString() || 'MISSING';
      const liveData = zipLive.getEntry(k)?.getData().toString() || 'MISSING';
      console.log(`--- ${k} ---`);
      console.log(`DB:\n${dbData}`);
      console.log(`Live:\n${liveData}`);
  }
}
run();
