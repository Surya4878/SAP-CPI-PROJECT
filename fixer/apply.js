const db = require('../database');
require('dotenv').config();
const AdmZip = require('adm-zip');
const queue = require('../queue');
const axios = require('axios');
const { deployArtifact } = require('../deploy/index');
const { getCSRFCredentials } = require('../auth/csrf');
const { execSync } = require('child_process');
const readline = require('readline');

async function applyFixForArtifact(artifactId, confirmedArtifactName, triggeredVia = 'cli') {
  if (!artifactId) {
    throw new Error("Artifact ID is required.");
  }
  if (artifactId !== confirmedArtifactName) {
    throw new Error(`Confirmation string "${confirmedArtifactName}" did not match "${artifactId}". Aborting apply.`);
  }

  const fixRow = db.prepare(`
    SELECT * FROM generated_fixes 
    WHERE artifact_id = ? AND applied = 0 
    ORDER BY generated_at DESC 
    LIMIT 1
  `).get(artifactId);

  if (!fixRow) {
    throw new Error(`No pending fixes found for ${artifactId}.`);
  }

  console.log(`[INFO] Confirmation accepted. Fetching fresh ZIP from live tenant...`);

  // 2. Fetch fresh active zip from live tenant to ensure no staleness
  let rawZipBuffer;
  try {
    const { csrfToken, cookies } = await getCSRFCredentials();
    const res = await axios.get(
      `${process.env.API_HOST}/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')/$value`,
      {
        auth: { username: process.env.CLIENT_ID, password: process.env.CLIENT_SECRET },
        responseType: 'arraybuffer'
      }
    );
    rawZipBuffer = Buffer.from(res.data);
  } catch (err) {
    throw new Error(`Failed to fetch active zip for ${artifactId}: ${err.message}`);
  }

  // 3. Update the groovy script
  const zip = new AdmZip(rawZipBuffer);
  let targetScriptPath = null;
  let originalFound = false;

  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith('.groovy')) {
      targetScriptPath = entry.entryName;
      const content = zip.readAsText(entry);
      if (content.replace(/\s/g, '') === fixRow.original_content.replace(/\s/g, '')) {
        originalFound = true;
      }
      break; 
    }
  }

  if (!targetScriptPath) {
    throw new Error(`No .groovy script found in the fresh ZIP.`);
  }

  if (!originalFound) {
    console.warn(`[WARN] The live script content differs from what the LLM generated a fix for! Proceeding anyway, but this implies the live tenant changed since the fix was generated.`);
  }

  console.log(`[INFO] Applying fix to ${targetScriptPath}...`);
  zip.updateFile(targetScriptPath, Buffer.from(fixRow.proposed_content, 'utf8'));
  const newZipBuffer = zip.toBuffer();
  const base64Content = newZipBuffer.toString('base64');

  // 4. PUT updated ZIP
  console.log(`[INFO] Uploading fixed zip via PUT...`);
  let csrfToken, cookies;
  try {
    const creds = await getCSRFCredentials();
    csrfToken = creds.csrfToken;
    cookies = creds.cookies;
  } catch (err) {
    throw new Error(`CSRF fetch failed: ${err.message}`);
  }

  try {
    await queue.put(
      `/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')`,
      {
        Id: artifactId,
        Name: artifactId,
        ArtifactContent: base64Content
      },
      {
        headers: {
          'X-CSRF-Token': csrfToken,
          'Cookie': cookies,
          'Content-Type': 'application/json',
          'Accept': 'application/json'
        }
      }
    );
    console.log(`[SUCCESS] Uploaded fixed zip.`);
  } catch (err) {
    throw new Error(`Failed to PUT fixed zip: ${err.message}`);
  }

  // 5. Deploy
  console.log(`[INFO] Deploying fixed artifact ${artifactId}...`);
  await deployArtifact(artifactId);

  // 6. Mark as applied, including triggered_via
  db.prepare(`UPDATE generated_fixes SET applied = 1, applied_at = CURRENT_TIMESTAMP, triggered_via = ? WHERE id = ?`).run(triggeredVia, fixRow.id);

  // 7. Force Discovery Resync
  console.log(`[INFO] Forcing discovery/run.js to capture the newly fixed baseline in artifact_versions...`);
  execSync('node discovery/run.js', { stdio: 'inherit' });

  console.log(`\n[SUCCESS] Fix applied and deployed successfully.`);
  return { success: true, artifactId };
}

if (require.main === module) {
  const artifactId = process.argv[2];
  if (!artifactId) {
    console.error("Usage: node fixer/apply.js <artifactId>");
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  rl.question(`\nYou are about to apply a fix to ${artifactId}.\nType '${artifactId}' to confirm deployment to the live tenant: `, async (answer) => {
    rl.close();
    try {
      await applyFixForArtifact(artifactId, answer.trim(), 'cli');
      console.log(`If the fix fails or causes worse issues, you can roll it back immediately by running:`);
      console.log(`  node deploy/rollback.js ${artifactId}`);
      console.log(`\nTo verify the fix worked, wait a minute for the runtime to execute it, then run:`);
      console.log(`  node logs/query.js ${artifactId} --limit 10`);
    } catch (err) {
      console.error(`[ABORT] ${err.message}`);
      process.exit(1);
    }
  });
}

module.exports = { applyFixForArtifact };
