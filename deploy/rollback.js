require('dotenv').config();
const db = require('../database/index');
const readline = require('readline');
const { getCSRFCredentials } = require('../auth/csrf');
const queue = require('../queue');
const { deployArtifact } = require('./index');
const { pollDeployStatus } = require('./pollStatus');
const { verifyRuntimeState } = require('./verifyRuntime');
const { execSync } = require('child_process');

async function rollbackArtifact(artifactId, confirmedArtifactName, targetVersionId, triggeredVia = 'cli') {
  if (!artifactId) throw new Error('Artifact ID is required.');
  if (!targetVersionId) throw new Error('Target Version ID is required.');
  
  if (artifactId !== confirmedArtifactName) {
    throw new Error(`Confirmation mismatched. Expected '${artifactId}', got '${confirmedArtifactName}'. Aborting rollback.`);
  }

  // Lookup package_id for package-scoped API (avoids locked-artifact 400 errors)
  const artifactRow = db.prepare('SELECT name, package_id FROM artifacts WHERE source_id = ? AND deleted_at IS NULL').get(artifactId);
  if (!artifactRow) {
    throw new Error(`Artifact '${artifactId}' not found in local artifacts database.`);
  }
  const artifactName = artifactRow.name || artifactId;
  const packageId = artifactRow.package_id;
  if (!packageId) throw new Error(`Package ID not found for artifact ${artifactId}. Run a sync first.`);

  const currentHash = artifactRow.content_hash || 'UNKNOWN';
  console.log(`Current DB content_hash: ${currentHash}`);

  const priorVersion = db.prepare('SELECT id, content_hash, saved_at, zip_content FROM artifact_versions WHERE id = ? AND artifact_id = ?').get(targetVersionId, artifactId);

  if (!priorVersion) {
    throw new Error(`Invalid ID selected: ${targetVersionId}`);
  }

  console.log(`Target historical content_hash: ${priorVersion.content_hash}`);
  console.log(`Version saved at: ${priorVersion.saved_at}`);

  // Check initial state from the live API
  const beforeState = await verifyRuntimeState(artifactId);
  console.log(`Current Runtime State : ${beforeState}`);

  console.log('\nInitiating Rollback...');
  console.log('\n1. Reverting Design-Time Content...');
  const base64Zip = priorVersion.zip_content.toString('base64');
  let csrfToken, cookies;
  try {
    // Always force-refresh CSRF before a write operation
    const creds = await getCSRFCredentials(true);
    csrfToken = creds.csrfToken;
    cookies = creds.cookies;
  } catch (err) {
    throw new Error(`CSRF fetch failed: ${err.message}`);
  }

  try {
    // Use the standard endpoint for PUT
    await queue.put(`/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')`, {
      Id: artifactId,
      Name: artifactName,
      ArtifactContent: base64Zip
    }, {
      headers: {
        'X-CSRF-Token': csrfToken,
        'Cookie': cookies,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    console.log(`Design-time artifact '${artifactId}' successfully reverted.`);
  } catch (err) {
    const responseBody = err.response ? JSON.stringify(err.response.data) : '';
    const isLocked = responseBody.includes('locked');
    if (isLocked) {
      throw new Error(
        `The artifact "${artifactId}" is locked. Close the artifact editor in the SAP Integration Suite browser tab, then retry.`
      );
    }
    throw new Error(`Failed to revert design-time artifact: ${err.message} | Response: ${responseBody}`);
  }

  console.log('\n2. Deploying Restored Artifact...');
  const deployResult = await deployArtifact(artifactId, triggeredVia === 'dashboard' ? 'DASHBOARD_ROLLBACK' : 'CLI_ROLLBACK');
  
  if (deployResult.status === 'FAILED') {
    throw new Error(`[MID-SEQUENCE FAILURE] Design-time was successfully reverted to ${priorVersion.content_hash}, but the runtime deploy FAILED. The tenant is now in a mixed state (old code deployed, new code in workspace). Error: ${deployResult.error}`);
  }

  if (deployResult.status === 'POLLING') {
    console.log(`Task ID: ${deployResult.taskId} | Status: ${deployResult.status}`);
    console.log('Polling for completion...\n');

    const pollResult = await pollDeployStatus(deployResult.taskId, deployResult.deploymentId);

    console.log(`\nPolling resolved with status: ${pollResult.status}`);
    if (pollResult.error) {
      throw new Error(`[MID-SEQUENCE FAILURE] Design-time was successfully reverted to ${priorVersion.content_hash}, but the runtime deploy POLLING FAILED. The tenant is now in a mixed state. Error: ${pollResult.error}`);
    }
  }

  console.log('\nPerforming final live runtime check...');
  const afterState = await verifyRuntimeState(artifactId);

  console.log(`\nRollback Outcome:`);
  console.log(`Runtime State Before: ${beforeState}. After: ${afterState}`);
  console.log(`Content Hash Before: ${currentHash}. After: ${priorVersion.content_hash}`);

  return { success: true, artifactId, restoredHash: priorVersion.content_hash };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const artifactId = args.find(a => !a.startsWith('--'));

  if (!artifactId) {
    console.error('Usage: node deploy/rollback.js <artifactId>');
    process.exit(1);
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout
  });

  function prompt(query) {
    return new Promise(resolve => rl.question(query, resolve));
  }

  (async () => {
    console.log(`\n=== Rollback Pre-flight: ${artifactId} ===\n`);

    const allVersions = db.prepare(`
      SELECT id, content_hash, metadata_hash, inner_content_hash, saved_at
      FROM artifact_versions 
      WHERE artifact_id = ? 
      ORDER BY saved_at DESC LIMIT 50
    `).all(artifactId);

    if (allVersions.length === 0) {
      console.error(`[BLOCKED] No versions found in artifact_versions for '${artifactId}'.`);
      process.exit(1);
    }

    const distinctVersions = [];
    let currentGroup = null;

    for (const v of allVersions) {
      if (!currentGroup) {
        currentGroup = { ...v, oldest_saved_at: v.saved_at };
        distinctVersions.push(currentGroup);
      } else {
        if (v.inner_content_hash && v.inner_content_hash === currentGroup.inner_content_hash) {
          currentGroup.oldest_saved_at = v.saved_at; 
        } else {
          currentGroup = { ...v, oldest_saved_at: v.saved_at };
          distinctVersions.push(currentGroup);
        }
      }
    }

    const displayVersions = distinctVersions.slice(0, 10);
    console.log(`\nAvailable distinct versions for '${artifactId}':`);
    displayVersions.forEach((v) => {
      let dateStr = v.saved_at;
      if (v.oldest_saved_at !== v.saved_at) {
        dateStr = `unchanged from ${v.oldest_saved_at} to ${v.saved_at}`;
      }
      const hashDisplay = v.inner_content_hash ? `InnerHash: ${v.inner_content_hash.substring(0,8)}...` : `ZipHash: ${v.content_hash.substring(0,8)}...`;
      const isCurrent = v.inner_content_hash ? (v.inner_content_hash === allVersions[0].inner_content_hash) : (v.content_hash === allVersions[0].content_hash);
      console.log(`[${v.id}] Saved At: ${dateStr} | ${hashDisplay} | MetaHash: ${(v.metadata_hash||'').substring(0,8)}... ${isCurrent ? '(CURRENT)' : ''}`);
    });

    const selectedIdStr = await prompt(`\nEnter the ID of the version to rollback to: `);
    const selectedId = parseInt(selectedIdStr, 10);
    
    const priorVersion = db.prepare('SELECT saved_at FROM artifact_versions WHERE id = ?').get(selectedId);
    if (!priorVersion) {
      console.error(`[BLOCKED] Invalid ID selected.`);
      process.exit(1);
    }

    console.log(`\n[CRITICAL WARNING] You are about to ROLLBACK '${artifactId}' to the version saved at ${priorVersion.saved_at}.`);
    console.log(`This will OVERWRITE the current design-time artifact and REDEPLOY it.`);
    const confirmStr = await prompt(`Type exactly '${artifactId}' to confirm execution: `);

    rl.close();

    try {
      await rollbackArtifact(artifactId, confirmStr.trim(), selectedId, 'cli');
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  })();
}

module.exports = { rollbackArtifact };
