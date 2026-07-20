require('dotenv').config();
const db = require('../database/index');
const readline = require('readline');
const { getCSRFCredentials } = require('../auth/csrf');
const { undeployArtifact } = require('./index');
const { pollDeployStatus } = require('./pollStatus');
const { verifyRuntimeState } = require('./verifyRuntime');

async function undeployArtifactAction(artifactId, confirmedArtifactName, isDryRun = false, triggeredVia = 'cli') {
  if (!artifactId) throw new Error("Artifact ID is required.");
  
  if (artifactId !== confirmedArtifactName) {
    throw new Error(`Confirmation mismatched. Expected '${artifactId}', got '${confirmedArtifactName}'. Aborting undeploy.`);
  }

  // 1. Eligibility Check
  // Check initial state from the live API
  const beforeState = await verifyRuntimeState(artifactId);
  if (beforeState === 'NOT_FOUND') {
    console.log(`Artifact '${artifactId}' is already undeployed (NOT_FOUND) on the live node.`);
    return { success: true, artifactId, beforeState: 'NOT_FOUND', afterState: 'NOT_FOUND', note: 'Already undeployed' };
  }

  console.log(`Artifact Name : ${artifactId}`);
  console.log(`Current State : ${beforeState}`);

  if (isDryRun) {
    console.log('\n--- DRY RUN ---');
    console.log('Testing CSRF auth pipeline...');
    try {
      await getCSRFCredentials();
      console.log('CSRF Token successfully fetched and cached. Auth pipeline works.');
    } catch (err) {
      throw new Error(`CSRF Token fetch failed in dry-run: ${err.message}`);
    }
    console.log('Dry run complete. No payload sent.');
    return { success: true, dryRun: true };
  }

  console.log('\nInitiating Undeployment...');

  const deployResult = await undeployArtifact(artifactId, triggeredVia === 'dashboard' ? 'DASHBOARD_UNDEPLOY' : 'CLI_UNDEPLOY');
  
  if (deployResult.status === 'FAILED') {
    throw new Error(`Failed to trigger undeployment: ${deployResult.error}`);
  }

  if (deployResult.status === 'POLLING') {
    if (deployResult.taskId && deployResult.taskId !== '""') {
      console.log(`Task ID: ${deployResult.taskId} | Status: ${deployResult.status}`);
      console.log('Polling for completion...\n');
      const pollResult = await pollDeployStatus(deployResult.taskId, deployResult.deploymentId);
      console.log(`\nPolling resolved with status: ${pollResult.status}`);
      if (pollResult.error) {
        console.log(`Error detail: ${pollResult.error}`);
      }
    } else {
      console.log(`Undeploy accepted but no TaskId returned. Polling runtime state directly...`);
      let currentState = 'STARTED';
      let attempts = 0;
      while (currentState === 'STARTED' && attempts < 20) {
        await new Promise(r => setTimeout(r, 5000));
        currentState = await verifyRuntimeState(artifactId);
        attempts++;
        console.log(`Polling state... Current: ${currentState}`);
      }
    }
  } else {
    // If it returned 200/204, it was synchronous.
    console.log(`Status: ${deployResult.status}`);
  }

  console.log('\nPerforming final live runtime check...');
  const afterState = await verifyRuntimeState(artifactId);

  console.log(`\nUndeployment Outcome:`);
  console.log(`Before: ${beforeState}. After: ${afterState}`);

  return { success: true, artifactId, beforeState, afterState };
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const isDryRun = args.includes('--dry-run');
  const artifactId = args.find(a => !a.startsWith('--'));

  if (!artifactId) {
    console.error('Usage: node deploy/undeploy.js <artifactId> [--dry-run]');
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
    console.log(`\n=== Undeployment Pre-flight: ${artifactId} ===\n`);

    if (!isDryRun) {
      console.log('\n[CRITICAL WARNING] You are about to UNDEPLOY and REMOVE this artifact from the LIVE tenant.');
    }
    const confirmStr = await prompt(`Type exactly '${artifactId}' to confirm execution: `);
    rl.close();

    try {
      const result = await undeployArtifactAction(artifactId, confirmStr.trim(), isDryRun, 'cli');
      if (!isDryRun) {
        if (result.afterState === 'NOT_FOUND' || result.afterState === 'STOPPED') {
          console.log('\n✅ Undeployment successfully verified on live node.');
        } else {
          console.error(`\n❌ Undeployment completed but artifact is still reporting as ${result.afterState}. Check tenant logs.`);
        }
      }
    } catch (err) {
      console.error(`[ABORT] ${err.message}`);
      process.exit(1);
    }
  })();
}

module.exports = { undeployArtifactAction };
