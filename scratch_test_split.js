const db = require('./database/index.js');
const AdmZip = require('adm-zip');
const row = db.prepare('SELECT zip_content FROM artifact_versions WHERE artifact_id = ? ORDER BY saved_at DESC LIMIT 1').get('dateanddatatypes');
const zip = new AdmZip(row.zip_content);
const iflw = zip.getEntries().find(e => e.entryName.endsWith('.iflw'));
const content = zip.readAsText(iflw);
const lines = content.split('\n');
const val = '${dat:now:ddMMyyyy}}';
lines.forEach((l, i) => {
  if (l.includes(val)) {
    console.log(`Line ${i + 1}: ${l}`);
  }
});
