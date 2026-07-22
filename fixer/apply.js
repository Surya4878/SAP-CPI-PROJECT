const db = require('../database');
require('dotenv').config();
const AdmZip = require('adm-zip');
const queue = require('../queue');
const { deployArtifact } = require('../deploy/index');
const { getCSRFCredentials } = require('../auth/csrf');
const readline = require('readline');

async function applyFixForArtifact(artifactId, confirmedArtifactName, triggeredVia = 'cli') {
  if (!artifactId) {
    throw new Error('Artifact ID is required.');
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

  // --- Step 1: Fetch fresh active ZIP via queue (OAuth Bearer token) ---
  console.log('[INFO] Confirmation accepted. Fetching fresh ZIP from live tenant...');
  let rawZipBuffer;
  try {
    const res = await queue.get(
      `/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')/$value`,
      { responseType: 'arraybuffer' }
    );
    rawZipBuffer = Buffer.from(res.data);
  } catch (err) {
    throw new Error(`Failed to fetch active zip for ${artifactId}: ${err.message}`);
  }

  // --- Step 2: Patch the ZIP with the proposed fix ---
  const zip = new AdmZip(rawZipBuffer);
  let targetFilePath = fixRow.target_file_path;

  if (!targetFilePath) {
    console.log(`[WARN] Legacy fix without target_file_path. Falling back to extension search.`);
    if (fixRow.fix_type === 'xml_value') {
      for (const entry of zip.getEntries()) {
        if (entry.entryName.endsWith('.iflw')) {
          targetFilePath = entry.entryName;
          break;
        }
      }
      if (!targetFilePath) {
        throw new Error('No .iflw XML file found in the fresh ZIP.');
      }
    } else {
      for (const entry of zip.getEntries()) {
        if (entry.entryName.endsWith('.groovy')) {
          targetFilePath = entry.entryName;
          break;
        }
      }
      if (!targetFilePath) {
        throw new Error('No .groovy script found in the fresh ZIP.');
      }
    }
  } else {
    // Verify the explicit target file actually exists in the zip
    const entry = zip.getEntry(targetFilePath);
    if (!entry) {
      throw new Error(`Target file ${targetFilePath} not found in the fresh ZIP.`);
    }
  }

  console.log(`[INFO] Applying fix to ${targetFilePath}...`);
  zip.updateFile(targetFilePath, Buffer.from(fixRow.proposed_content, 'utf8'));
  const newZipBuffer = zip.toBuffer();
  const base64Content = newZipBuffer.toString('base64');

  // --- Step 3: Fetch fresh CSRF token (always force refresh before writes) ---
  console.log('[INFO] Fetching CSRF token...');
  let csrfToken, cookies;
  try {
    const creds = await getCSRFCredentials(true);
    csrfToken = creds.csrfToken;
    cookies = creds.cookies;
    console.log('[INFO] CSRF token obtained successfully.');
  } catch (err) {
    throw new Error(`CSRF fetch failed: ${err.message}`);
  }

  // --- Step 4: PUT the updated ZIP back to SAP CPI ---
  // NOTE: SAP CPI returns 400 "Cannot update the artifact as it is locked"
  // if the artifact is currently open in the SAP Integration Suite browser UI.
  // The fix: close the artifact editor tab in SAP UI before clicking Apply Fix.
  console.log('[INFO] Uploading fixed zip via PUT...');
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
    console.log('[SUCCESS] Uploaded fixed zip.');
  } catch (err) {
    const responseBody = err.response ? JSON.stringify(err.response.data) : '';
    const isLocked = responseBody.includes('locked') || responseBody.includes('locked');
    if (isLocked) {
      throw new Error(
        `The artifact "${artifactId}" is locked by an open editing session in the SAP Integration Suite browser UI.\n\n` +
        `FIX: Go to the SAP Integration Suite tab in your browser, click "Cancel" or close the artifact editor, then try Apply Fix again.`
      );
    }
    throw new Error(`Failed to PUT fixed zip: ${err.message} | Response: ${responseBody}`);
  }

  // --- Step 5: Deploy ---
  console.log(`[INFO] Deploying fixed artifact ${artifactId}...`);
  await deployArtifact(artifactId, triggeredVia === 'dashboard' ? 'DASHBOARD_FIX' : 'CLI_FIX');

  // --- Step 5.5: Save local version snapshot with description ---
  const { createHash } = require('crypto');
  const zipHash = createHash('sha256').update(newZipBuffer).digest('hex');
  
  // Calculate inner_content_hash to prevent duplicate issues later
  const innerHashes = [];
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory && entry.entryName !== 'META-INF/MANIFEST.MF') {
      const entryHash = createHash('sha256').update(entry.getData()).digest('hex');
      innerHashes.push(`${entry.entryName}:${entryHash}`);
    }
  }
  innerHashes.sort();
  const innerContentHash = createHash('sha256').update(Buffer.from(innerHashes.join('\n'))).digest('hex');

  const truncatedExplanation = fixRow.explanation ? fixRow.explanation.substring(0, 100) : 'No explanation provided';
  const autoDescription = `Auto-fix: ${truncatedExplanation}..., applied ${new Date().toISOString()}, fix_type: ${fixRow.fix_type}`;

  db.prepare(`
    INSERT INTO artifact_versions (artifact_id, cpi_version, content_hash, metadata_hash, inner_content_hash, zip_content, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(artifactId, 'active', zipHash, 'autofix', innerContentHash, newZipBuffer, autoDescription);

  // --- Step 6: Mark fix as applied ---
  db.prepare('UPDATE generated_fixes SET applied = 1, applied_at = CURRENT_TIMESTAMP, triggered_via = ? WHERE id = ?')
    .run(triggeredVia, fixRow.id);

  console.log('\n[SUCCESS] Fix applied and deployed successfully.');
  return { success: true, artifactId };
}

if (require.main === module) {
  const artifactId = process.argv[2];
  if (!artifactId) {
    console.error('Usage: node fixer/apply.js <artifactId>');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(`\nYou are about to apply a fix to ${artifactId}.\nType '${artifactId}' to confirm: `, async (answer) => {
    rl.close();
    try {
      await applyFixForArtifact(artifactId, answer.trim(), 'cli');
      console.log(`\nTo verify the fix worked, wait a moment then run:\n  node logs/query.js ${artifactId} --limit 10`);
    } catch (err) {
      console.error(`[ABORT] ${err.message}`);
      process.exit(1);
    }
  });
}

module.exports = { applyFixForArtifact };
