const db = require('../database');
require('dotenv').config();
const AdmZip = require('adm-zip');
const { createHash } = require('crypto');
const queue = require('../queue');
const { deployArtifact } = require('../deploy/index');
const { getCSRFCredentials } = require('../auth/csrf');
const { validateStructuralIntegrity } = require('./validateStructuralIntegrity');
const readline = require('readline');

/**
 * Computes inner_content_hash from a loaded AdmZip object.
 * Must match the algorithm in apply.js and downloader.
 */
function computeInnerHash(zip) {
  const innerHashes = [];
  for (const entry of zip.getEntries()) {
    if (!entry.isDirectory) {
      const path = entry.entryName;
      if (path === '.project' || path === 'META-INF/MANIFEST.MF' || path === '.classpath') {
        continue;
      }
      let contentBuffer = entry.getData();
      
      if (path.endsWith('.prop')) {
        const text = contentBuffer.toString('utf8');
        const cleanText = text.split(/[\r\n]+/).filter(l => !l.trim().startsWith('#')).join('\n');
        contentBuffer = Buffer.from(cleanText, 'utf8');
      }

      const entryHash = createHash('sha256').update(contentBuffer).digest('hex');
      innerHashes.push(`${path}:${entryHash}`);
    }
  }
  innerHashes.sort();
  return createHash('sha256').update(Buffer.from(innerHashes.join('\n'))).digest('hex');
}

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

  // --- Step 2: Resolve the target file path ---
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

  // --- Step 3: Content-hash gate (abort if artifact changed since fix was generated) ---
  console.log('[INFO] Verifying artifact has not changed since fix was generated...');
  const freshInnerHash = computeInnerHash(zip);

  if (freshInnerHash !== fixRow.original_content_hash) {
    throw new Error(
      `STALE FIX DETECTED: The artifact "${artifactId}" has changed since this fix was generated.\n\n` +
      `The fix was generated against content hash: ${fixRow.original_content_hash}\n` +
      `The current live content hash is:           ${freshInnerHash}\n\n` +
      `This means what the human approved in the diff is no longer what would be applied. ` +
      `Click "Generate Fix" again to create a fresh fix against the current version.`
    );
  }
  console.log('[INFO] Content hash verified — artifact is unchanged.');

  // --- Step 4: Derive the patched content ---
  console.log(`[INFO] Applying fix to ${targetFilePath}...`);
  const freshFileContent = zip.readAsText(targetFilePath);
  let patchedContent;

  if (fixRow.fix_type === 'xml_value' && fixRow.current_value && fixRow.proposed_value) {
    // --- xml_value fix: surgically re-derive the patch against the fresh file ---
    // The currentValue/proposedValue pair is the ground truth the human reviewed.
    // We locate it in the fresh file (which we've just hash-verified is identical)
    // and apply a single-occurrence string replacement.
    console.log(`[INFO] Re-deriving xml_value patch: "${fixRow.current_value}" → "${fixRow.proposed_value}"`);

    let targetPattern = null;
    let targetReplacement = null;

    const fallbackPatterns = [
      { p: `>${fixRow.current_value}<`, r: `>${fixRow.proposed_value}<` },
      { p: `>"${fixRow.current_value}"<`, r: `>"${fixRow.proposed_value}"<` },
      { p: `>'${fixRow.current_value}'<`, r: `>'${fixRow.proposed_value}'<` }
    ];

    for (const { p, r } of fallbackPatterns) {
      const count = freshFileContent.split(p).length - 1;
      if (count === 1) {
        targetPattern = p;
        targetReplacement = r;
        break;
      }
    }

    if (!targetPattern) {
      // Fallback to attribute checks if it wasn't a text element
      const attrPattern1 = `${fixRow.attribute_name}="${fixRow.current_value}"`;
      const attrPattern2 = `${fixRow.attribute_name}='${fixRow.current_value}'`;
      const attrCount1 = (fixRow.attribute_name && fixRow.attribute_name !== '_text' && fixRow.attribute_name !== 'value')
        ? freshFileContent.split(attrPattern1).length - 1 : 0;
      const attrCount2 = (fixRow.attribute_name && fixRow.attribute_name !== '_text' && fixRow.attribute_name !== 'value')
        ? freshFileContent.split(attrPattern2).length - 1 : 0;

      if (attrCount1 === 1) {
        targetPattern = attrPattern1;
        targetReplacement = `${fixRow.attribute_name}="${fixRow.proposed_value}"`;
      } else if (attrCount2 === 1) {
        targetPattern = attrPattern2;
        targetReplacement = `${fixRow.attribute_name}='${fixRow.proposed_value}'`;
      }
    }
    
    if (!targetPattern) {
      const rawCount = freshFileContent.split(fixRow.current_value).length - 1;
      if (rawCount === 1) {
        targetPattern = fixRow.current_value;
        targetReplacement = fixRow.proposed_value;
      }
    }

    if (!targetPattern) {
      throw new Error(
        `Cannot safely re-apply fix. The pattern for currentValue "${fixRow.current_value}" could not be uniquely matched in the fresh file. ` +
        `Click "Generate Fix" to create a fresh fix.`
      );
    }

    patchedContent = freshFileContent.replace(targetPattern, targetReplacement);
    console.log('[INFO] Re-derive successful via pattern:', targetPattern.substring(0, 60));

  } else {
    // --- groovy fix (or legacy xml_value without current_value): apply proposed_content as full-file replace ---
    // Hash gate above already confirmed the file hasn't changed, so this is safe.
    console.log(`[INFO] Applying full proposed_content (fix_type: ${fixRow.fix_type}).`);
    patchedContent = fixRow.proposed_content;
  }

  // --- Step 5: Structural re-validation on freshly-patched content (before the PUT) ---
  if (fixRow.fix_type === 'xml_value' && freshFileContent && patchedContent) {
    console.log('[INFO] Running structural integrity validation on patched content...');
    if (!validateStructuralIntegrity(freshFileContent, patchedContent)) {
      throw new Error(
        `The patched content failed structural validation against the fresh file. ` +
        `The fix would corrupt the XML structure. Click "Generate Fix" to create a fresh fix.`
      );
    }
    console.log('[INFO] Structural validation passed.');
  }

  // --- Step 6: Write patched content back into ZIP ---
  zip.updateFile(targetFilePath, Buffer.from(patchedContent, 'utf8'));
  const newZipBuffer = zip.toBuffer();
  const base64Content = newZipBuffer.toString('base64');

  // --- Step 7: Fetch fresh CSRF token (always force refresh before writes) ---
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

  // --- Step 8: PUT the updated ZIP back to SAP CPI ---
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
    const isLocked = responseBody.includes('locked');
    if (isLocked) {
      throw new Error(
        `The artifact "${artifactId}" is locked by an open editing session in the SAP Integration Suite browser UI.\n\n` +
        `FIX: Go to the SAP Integration Suite tab in your browser, click "Cancel" or close the artifact editor, then try Apply Fix again.`
      );
    }
    throw new Error(`Failed to PUT fixed zip: ${err.message} | Response: ${responseBody}`);
  }

  // --- Step 8.5: Save Version before deploying ---
  console.log(`[INFO] Saving active version of artifact ${artifactId}...`);
  try {
    await queue.post(
      `/IntegrationDesigntimeArtifactSaveAsVersion?Id='${artifactId}'&SaveAsVersion='true'`,
      null,
      {
        headers: {
          'X-CSRF-Token': csrfToken,
          'Cookie': cookies,
          'Accept': 'application/json'
        }
      }
    );
    console.log(`[SUCCESS] Saved active version.`);
  } catch (err) {
    // Some tenants use a different endpoint or might not support it; fallback to ignoring.
    console.warn(`[WARN] Failed to save active version before deploying: ${err.message}. Proceeding anyway.`);
  }

  // --- Step 9: Deploy ---
  console.log(`[INFO] Deploying fixed artifact ${artifactId}...`);
  await deployArtifact(artifactId, triggeredVia === 'dashboard' ? 'DASHBOARD_FIX' : 'CLI_FIX');

  // --- Step 10: Save local version snapshot with description ---
  const zipHash = createHash('sha256').update(newZipBuffer).digest('hex');
  const newInnerHash = computeInnerHash(zip);
  const truncatedExplanation = fixRow.explanation ? fixRow.explanation.substring(0, 100) : 'No explanation provided';
  const autoDescription = `Auto-fix: ${truncatedExplanation}..., applied ${new Date().toISOString()}, fix_type: ${fixRow.fix_type}`;

  db.prepare(`
    INSERT INTO artifact_versions (artifact_id, cpi_version, content_hash, metadata_hash, inner_content_hash, zip_content, description)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(artifactId, 'active', zipHash, 'autofix', newInnerHash, newZipBuffer, autoDescription);

  // --- Step 11: Mark fix as applied ---
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
