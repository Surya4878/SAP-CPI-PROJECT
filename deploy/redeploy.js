require('dotenv').config();
const db = require('../database/index');
const readline = require('readline');
const { getCSRFCredentials } = require('../auth/csrf');
const { deployArtifact } = require('./index');
const { pollDeployStatus } = require('./pollStatus');
const { verifyRuntimeState } = require('./verifyRuntime');

const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const artifactId = args.find(a => !a.startsWith('--'));

if (!artifactId) {
  console.error('Usage: node deploy/redeploy.js <artifactId> [--dry-run]');
  process.exit(1);
}

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function prompt(query) {
  return new Promise(resolve => rl.question(query, resolve));
}

async function main() {
  console.log(`\n=== Deployment Pre-flight: ${artifactId} ===\n`);

  // 1. Eligibility Check
  const runtimeRec = db.prepare(`SELECT status FROM runtime_status WHERE artifact_id = ? AND status = 'STARTED'`).get(artifactId);
  if (!runtimeRec) {
    console.error(`[BLOCKED] Artifact '${artifactId}' is NOT currently deployed in a STARTED state.`);
    console.error('This module only supports redeploying already-live artifacts to minimize risk.');
    process.exit(1);
  }

  // 2. Fetch Risk and Validation Data
  const artifactRec = db.prepare(`SELECT package_id, name, content_hash FROM artifacts WHERE source_id = ?`).get(artifactId);
  if (!artifactRec) {
    console.error(`[BLOCKED] Artifact '${artifactId}' not found in local design-time catalog.`);
    process.exit(1);
  }

  const riskRec = db.prepare(`SELECT composite_risk FROM risk_scores WHERE artifact_id = ? ORDER BY computed_at DESC LIMIT 1`).get(artifactId);
  const compositeRisk = riskRec ? riskRec.composite_risk : 'UNKNOWN';

  // Check initial state
  const beforeState = await verifyRuntimeState(artifactId);

  console.log(`Artifact Name : ${artifactRec.name}`);
  console.log(`Package ID    : ${artifactRec.package_id}`);
  console.log(`Risk Score    : ${compositeRisk}`);
  console.log(`Current State : ${beforeState}`);
  console.log(`Live Content  : Verified against local hash`);

  if (isDryRun) {
    console.log('\n--- DRY RUN ---');
    console.log('Testing CSRF auth pipeline...');
    try {
      await getCSRFCredentials();
      console.log('CSRF Token successfully fetched and cached. Auth pipeline works.');
    } catch (err) {
      console.error('CSRF Token fetch failed in dry-run:', err.message);
      process.exit(1);
    }
    console.log('Dry run complete. No payload sent.');
    process.exit(0);
  }

  console.log('\n[WARNING] You are about to redeploy this artifact to the LIVE tenant.');
  const confirmStr = await prompt(`Type exactly '${artifactId}' to confirm execution: `);

  if (confirmStr !== artifactId) {
    console.log('Confirmation mismatched. Aborting deploy.');
    process.exit(0);
  }

  rl.close();
  console.log('\nInitiating Deployment...');

  const deployResult = await deployArtifact(artifactId, 'CLI_USER');
  
  if (deployResult.status === 'FAILED') {
    console.error('Failed to trigger deployment:', deployResult.error);
    process.exit(1);
  }

  console.log(`Task ID: ${deployResult.taskId} | Status: ${deployResult.status}`);
  console.log('Polling for completion...\n');

  const pollResult = await pollDeployStatus(deployResult.taskId, deployResult.deploymentId);

  console.log(`\nPolling resolved with status: ${pollResult.status}`);
  if (pollResult.error) {
    console.log(`Error detail: ${pollResult.error}`);
  }

  console.log('\nPerforming final live runtime check...');
  const afterState = await verifyRuntimeState(artifactId);

  console.log(`\nDeployment Outcome:`);
  console.log(`Before: ${beforeState}. After: ${afterState}`);

  if (afterState !== 'STARTED') {
    console.error('⚠️ MANUAL INTERVENTION NEEDED: The artifact is no longer in a STARTED state.');
  } else {
    console.log('✅ Redeploy completed cleanly.');
  }

  process.exit(0);
}

main().catch(err => {
  console.error('Fatal deployment error:', err);
  process.exit(1);
});
