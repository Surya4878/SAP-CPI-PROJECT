require('dotenv').config();
const nock = require('nock');
const AdmZip = require('adm-zip');
const config = require('./config');
const db = require('./database');
const { runDiscovery } = require('./discovery');
const { runDownloader } = require('./downloader');

// Mock Auth
nock(config.tokenUrl)
  .persist()
  .post('/oauth/token')
  .reply(200, {
    access_token: 'mock-token',
    expires_in: 3600
  });

const api = nock(config.apiHost).persist();

let runNumber = 1;

// Define test data
const packagesRun1 = [
  { Id: 'Pkg1', Name: 'Package 1', Version: '1.0.0' },
  { Id: 'Pkg2', Name: 'Package 2', Version: '1.0.0' }
];

const packagesRun2 = [
  { Id: 'Pkg2', Name: 'Package 2', Version: '1.0.0' } // Pkg1 removed to test cascade delete
];

// iFlows
const iFlowsPkg1 = [{ Id: 'IFlow1', Version: '1.0.0', Name: 'IFlow 1' }];
const iFlowsPkg2 = [{ Id: 'IFlow2', Version: '1.0.0', Name: 'IFlow 2' }];
const iFlowsPkg2Run2 = [{ Id: 'IFlow2', Version: '1.1.0', Name: 'IFlow 2 Changed' }];

// ValueMappings
const vmPkg1 = [{ Id: 'VM1', Version: '1.0.0', Name: 'VM 1' }];
const vmPkg2 = [{ Id: 'VM2', Version: '1.0.0', Name: 'VM 2' }];
const vmPkg2Run2 = [{ Id: 'VM2', Version: '1.0.0', Name: 'VM 2' }]; // Unchanged

// CustomTags (singleton now)
const tagsRun1 = [{ Name: 'Tag1', Value: 'Val1' }, { Name: 'Tag2', Value: 'Val2' }];
const tagsRun2 = [{ Name: 'Tag1', Value: 'Val1' }, { Name: 'Tag2', Value: 'Val2_Changed' }];

api.get('/IntegrationPackages')
  .query(true)
  .reply(200, function(uri) {
    if (runNumber === 1) return { d: { results: packagesRun1 } };
    return { d: { results: packagesRun2 } };
  });

api.get((uri) => uri.includes('IntegrationDesigntimeArtifacts') && !uri.includes('$value'))
  .query(true)
  .reply(200, function(uri) {
    const pkgIdMatch = uri.match(/IntegrationPackages\('(.*?)'\)/);
    const pkgId = pkgIdMatch ? pkgIdMatch[1] : null;

    if (runNumber === 1) {
      if (pkgId === 'Pkg1') return { d: { results: iFlowsPkg1 } };
      if (pkgId === 'Pkg2') return { d: { results: iFlowsPkg2 } };
    } else {
      if (pkgId === 'Pkg2') return { d: { results: iFlowsPkg2Run2 } };
    }
    return { d: { results: [] } };
  });

api.get((uri) => uri.includes('ValueMappingDesigntimeArtifacts') && !uri.includes('$value'))
  .query(true)
  .reply(200, function(uri) {
    const pkgIdMatch = uri.match(/IntegrationPackages\('(.*?)'\)/);
    const pkgId = pkgIdMatch ? pkgIdMatch[1] : null;

    if (runNumber === 1) {
      if (pkgId === 'Pkg1') return { d: { results: vmPkg1 } };
      if (pkgId === 'Pkg2') return { d: { results: vmPkg2 } };
    } else {
      if (pkgId === 'Pkg2') return { d: { results: vmPkg2Run2 } };
    }
    return { d: { results: [] } };
  });

api.get((uri) => uri.includes('CustomTagConfigurations'))
  .query(true)
  .reply(200, function(uri) {
    if (runNumber === 1) return { d: { results: tagsRun1 } };
    return { d: { results: tagsRun2 } };
  });

// Simulate failure on ScriptCollection to test Promise.allSettled isolation
api.get((uri) => uri.includes('ScriptCollectionDesigntimeArtifacts'))
  .query(true)
  .reply(500, 'Internal Server Error');

// Mock $value ZIP downloader
api.get((uri) => uri.includes('$value') && !uri.includes('CustomTags'))
  .reply(200, function(uri) {
    const zip = new AdmZip();
    // Differentiate content based on version in URL to test content_hash changes
    const content = uri.includes("Version='1.1.0'") ? 'changed_content' : 'original_content';
    zip.addFile('src/main/resources/scenarioflows/integrationflow/fake.iflw', Buffer.from(`<bpmn>${content}</bpmn>`, 'utf8'));
    zip.addFile('src/main/resources/script/fake.groovy', Buffer.from(`def processData() { return '${content}'; }`, 'utf8'));
    return zip.toBuffer();
  });

// Return empty for everything else
api.get((uri) => true)
  .query(true)
  .reply(200, { d: { results: [] } });

async function main() {
  console.log('--- TEST RUN 1 ---');
  runNumber = 1;
  const changedRun1 = await runDiscovery();
  await runDownloader(changedRun1);
  
  const runsRun1 = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
  console.log('Run 1 Stats:', runsRun1);
  if (runsRun1.packages_new !== 2 || runsRun1.artifacts_new !== 4) {
    throw new Error('Run 1 stats mismatch! Expected 2 new packages, 4 new artifacts (2 iFlow, 2 VM).');
  }
  
  // Verify DB state
  const pkgs = db.prepare('SELECT * FROM packages WHERE deleted_at IS NULL').all();
  if (pkgs.length !== 2) throw new Error('Expected 2 active packages');
  
  const arts = db.prepare('SELECT * FROM artifacts WHERE deleted_at IS NULL').all();
  if (arts.length !== 4) throw new Error('Expected 4 active artifacts');

  const customTags = db.prepare('SELECT * FROM custom_tags WHERE deleted_at IS NULL').all();
  if (customTags.length !== 2) throw new Error('Expected 2 active custom tags');

  const resources = db.prepare('SELECT * FROM resources WHERE deleted_at IS NULL').all();
  // 4 artifacts downloaded * 2 files each = 8 resources total
  if (resources.length !== 8) throw new Error(`Expected 8 active resources, got ${resources.length}`);

  console.log('\n--- TEST RUN 2 ---');
  runNumber = 2;
  const changedRun2 = await runDiscovery();
  await runDownloader(changedRun2);
  
  const runsRun2 = db.prepare('SELECT * FROM sync_runs ORDER BY id DESC LIMIT 1').get();
  console.log('Run 2 Stats:', runsRun2);
  
  // Pkg1 deleted (1 package deleted, 2 cascaded artifacts deleted: IFlow1, VM1). 
  // Pkg2: IFlow changed, VM unchanged
  if (runsRun2.packages_deleted !== 1 || runsRun2.artifacts_deleted !== 2 || runsRun2.artifacts_changed !== 1) {
    throw new Error(`Run 2 stats mismatch! Expected 1 deleted pkg, 2 deleted artifacts, 1 changed artifacts. Got deleted: ${runsRun2.artifacts_deleted}, changed: ${runsRun2.artifacts_changed}`);
  }

  // Verify cascade delete on artifacts
  const pkg1Arts = db.prepare("SELECT * FROM artifacts WHERE package_id = 'Pkg1' AND deleted_at IS NULL").all();
  if (pkg1Arts.length > 0) throw new Error('Cascade delete failed: Pkg1 artifacts should be soft-deleted.');
  
  // Verify cascade delete on resources (IFlow1 resources should be deleted)
  const deletedResources = db.prepare("SELECT * FROM resources WHERE artifact_id = 'IFlow1' AND deleted_at IS NOT NULL").all();
  if (deletedResources.length !== 2) throw new Error('Cascade delete failed: IFlow1 resources should be soft-deleted.');

  const artIFlow = db.prepare("SELECT * FROM artifacts WHERE source_id = 'IFlow2'").get();
  if (artIFlow.sync_version !== 2) throw new Error('IFlow2 should have sync_version 2');
  
  const tagsRun2Data = db.prepare("SELECT * FROM custom_tags WHERE source_id = 'Tag2'").get();
  if (tagsRun2Data.sync_version !== 2) throw new Error('Tag2 should have sync_version 2 based on content_hash');
  
  console.log('\nALL TESTS PASSED SUCCESSFULLY.');
}

main().catch(e => {
  console.error('TEST FAILED:', e);
  process.exit(1);
});
