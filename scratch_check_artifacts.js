const db = require('./database/index');

function checkArtifact(id) {
  const meta = db.prepare(`SELECT parsed_json FROM parsed_metadata WHERE artifact_id = ?`).get(id);
  if (!meta) {
    console.log(`No parsed metadata found for ${id}`);
    return;
  }
  const data = JSON.parse(meta.parsed_json);
  
  console.log(`\n=== Analysis for ${id} ===`);
  const timers = data.events?.filter(e => e.type === 'StartTimerEvent');
  console.log(`Timers: ${timers?.length ? 'YES' : 'NO'}`);
  
  const receivers = data.receivers || [];
  const transmitters = data.transmitters || [];
  
  console.log(`Receivers (Inbound): ${receivers.length}`);
  receivers.forEach(r => console.log(`  - ${r.adapterType}`));
  
  console.log(`Transmitters (Outbound): ${transmitters.length}`);
  transmitters.forEach(t => console.log(`  - ${t.adapterType} to ${t.system}`));
}

checkArtifact('HTTPS');
checkArtifact('Router');
