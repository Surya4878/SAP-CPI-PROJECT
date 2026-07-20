const db = require('../database');
require('dotenv').config();
const AdmZip = require('adm-zip');
const queue = require('../queue');
const { deployArtifact } = require('../deploy/index');
const { getCSRFCredentials } = require('../auth/csrf');
const { execSync } = require('child_process');

async function createTestBug() {
  const artifactId = 'JSON_TO_XML';
  
  // 1. Ensure a baseline exists
  const baselineRow = db.prepare(`
    SELECT zip_content, content_hash 
    FROM artifact_versions 
    WHERE artifact_id = ? 
    ORDER BY saved_at DESC 
    LIMIT 1
  `).get(artifactId);

  if (!baselineRow) {
    console.error(`[ABORT] No clean baseline found for ${artifactId} in artifact_versions.`);
    console.error(`Please run 'node discovery/run.js' first to capture the baseline before breaking it.`);
    process.exit(1);
  }

  console.log(`[INFO] Baseline found. Target hash: ${baselineRow.content_hash}`);

  // 2. Inject the bug
  const zip = new AdmZip(baselineRow.zip_content);
  const targetScriptPath = 'src/main/resources/script/script1.groovy';
  
  const originalScript = zip.readAsText(targetScriptPath);
  if (!originalScript) {
    console.error(`[ABORT] Could not find ${targetScriptPath} in the zip.`);
    process.exit(1);
  }

  const buggyScript = `import com.sap.gateway.ip.core.customdev.util.Message
import java.util.HashMap

Message processData(Message message) {
    // Intentionally breaking this to throw NullPointerException
    String deliberateBug = null
    deliberateBug.length()
    return message
}
`;

  zip.updateFile(targetScriptPath, Buffer.from(buggyScript, 'utf8'));
  const newZipBuffer = zip.toBuffer();
  const base64Content = newZipBuffer.toString('base64');

  // 3. Upload to tenant
  console.log(`[INFO] Uploading deliberately broken zip via PUT...`);
  let csrfToken, cookies;
  try {
    const creds = await getCSRFCredentials();
    csrfToken = creds.csrfToken;
    cookies = creds.cookies;
  } catch (err) {
    console.error('CSRF fetch failed:', err.message);
    process.exit(1);
  }

  try {
    await queue.put(`/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')`,
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
    console.log(`[SUCCESS] Uploaded broken zip.`);
  } catch (err) {
    console.error(`[ERROR] Failed to PUT broken zip:`, err.message);
    process.exit(1);
  }

  // 4. Deploy
  console.log(`[INFO] Deploying broken artifact ${artifactId}...`);
  await deployArtifact(artifactId);

  // 5. Force Discovery Resync
  console.log(`[INFO] Forcing discovery/run.js to capture the newly broken baseline in artifact_versions...`);
  execSync('node discovery/run.js', { stdio: 'inherit' });

  console.log(`\n[SUCCESS] create_test_bug.js sequence complete.`);
  console.log(`The active artifact_versions row is now the broken version.`);
  console.log(`Next step: Wait for the timer to fire on CPI (may take a minute) and then run 'node fixer/generate.js ${artifactId}' to fetch the real error and generate a fix.`);
}

createTestBug().catch(console.error);
