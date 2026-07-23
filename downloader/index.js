const crypto = require('crypto');
const AdmZip = require('adm-zip');
const queue = require('../queue');
const db = require('../database');
const artifactRepo = require('../repository/artifactRepository');
const resourceRepo = require('../repository/resourceRepository');
const syncRunRepo = require('../repository/syncRunRepository');

const discovery = require('../discovery/index'); // to get ARTIFACT_TYPES

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// Ensure resource type extraction from path (e.g., .groovy, .iflw, etc.)
function getResourceType(path) {
  const match = path.match(/\.([a-z0-9]+)$/i);
  return match ? match[1].toLowerCase() : 'unknown';
}

async function processArtifactDownload(artifact) {
  const { type, source_id, version } = artifact;
  const artifactConfig = discovery.ARTIFACT_TYPES.find(t => t.type === type);
  const endpointSuffix = artifactConfig ? artifactConfig.endpointSuffix : type;
  
  // Standard url pattern for downloading $value
  const url = `/${endpointSuffix}(Id='${source_id}',Version='${version}')/$value`;
  
  let response;
  try {
    response = await queue.get(url, { responseType: 'arraybuffer' });
  } catch (err) {
    throw new Error(`Failed to download ${source_id} (${type}): ${err.message}`);
  }

  const rawZipBuffer = Buffer.from(response.data, 'binary');
  const zipHash = hashBuffer(rawZipBuffer);

  // Check if hash matches the one in DB
  const existing = artifactRepo.findBySourceId(source_id);
  if (existing && existing.content_hash === zipHash) {
    // Unchanged hash, skip extraction
    return { status: 'unchanged_hash', artifact_id: source_id };
  }

  // Update hash on the artifact
  db.prepare(`UPDATE artifacts SET content_hash = ?, last_synced_at = CURRENT_TIMESTAMP WHERE source_id = ? AND deleted_at IS NULL`).run(zipHash, source_id);

  const metadataHash = existing ? existing.metadata_hash : null;

  // Extract via adm-zip
  let zip;
  try {
    zip = new AdmZip(rawZipBuffer);
  } catch (err) {
    throw new Error(`Failed to parse ZIP for ${source_id} (${type}): ${err.message}`);
  }

  const zipEntries = zip.getEntries();
  const foundResourcePaths = [];
  const innerHashes = [];
  let res_new = 0, res_changed = 0;

  for (const entry of zipEntries) {
    if (entry.isDirectory) continue;
    
    const path = entry.entryName;
    
    // Exclude Eclipse project boilerplate
    if (path === '.project' || path === 'META-INF/MANIFEST.MF' || path === '.classpath') {
      continue;
    }

    const name = entry.name;
    const extType = getResourceType(path);
    let contentBuffer = entry.getData();
    
    // SAP CPI injects a timestamp comment (e.g., #Thu Jul 23 09:48:47 UTC 2026) into .prop files 
    // when exporting. We must strip these before hashing so innerContentHash remains stable.
    if (path.endsWith('.prop')) {
      const text = contentBuffer.toString('utf8');
      const cleanText = text.split(/[\r\n]+/).filter(l => !l.trim().startsWith('#')).join('\n');
      contentBuffer = Buffer.from(cleanText, 'utf8');
    }

    const contentHash = hashBuffer(contentBuffer);
    const size = entry.header.size;
    
    let contentStr = null;
    if (path.endsWith('.iflw') || path.endsWith('value_mapping.xml')) {
      contentStr = contentBuffer.toString('utf8');
    }

    foundResourcePaths.push(path);
    innerHashes.push(`${path}:${contentHash}`);

    const resourceData = {
      source_id: path, // Required by baseColumns
      artifact_id: source_id,
      path: path,
      name: name,
      type: extType,
      size: size,
      content_hash: contentHash,
      content: contentStr
    };

    const status = resourceRepo.upsertResource(resourceData);
    if (status === 'new') res_new++;
    if (status === 'changed') res_changed++;
  }

  innerHashes.sort();
  const innerContentHash = hashBuffer(Buffer.from(innerHashes.join('\n')));

  // Archive this version's binary zip payload
  db.prepare(`
    INSERT INTO artifact_versions (artifact_id, cpi_version, content_hash, metadata_hash, inner_content_hash, zip_content) 
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(source_id, version, zipHash, metadataHash, innerContentHash, rawZipBuffer);

  const deletedResourcesCount = resourceRepo.markMissingAsDeleted(source_id, foundResourcePaths);

  return {
    status: 'extracted',
    artifact_id: source_id,
    new: res_new,
    changed: res_changed,
    deleted: deletedResourcesCount,
    files_found: foundResourcePaths.length
  };
}

async function runDownloader(changedArtifacts) {
  if (!changedArtifacts || changedArtifacts.length === 0) {
    console.log('[Downloader] No new or changed artifacts to download.');
    return;
  }

  console.log(`[Downloader] Starting download for ${changedArtifacts.length} artifacts...`);
  
  const downloadPromises = changedArtifacts.map(async (artifact) => {
    return processArtifactDownload(artifact);
  });

  const results = await Promise.allSettled(downloadPromises);
  
  let successCount = 0, unchangedHashCount = 0, errorCount = 0;
  let totalNewRes = 0, totalChangedRes = 0, totalDeletedRes = 0;

  const errors = [];

  for (const res of results) {
    if (res.status === 'fulfilled') {
      if (res.value.status === 'unchanged_hash') {
        unchangedHashCount++;
      } else {
        successCount++;
        totalNewRes += res.value.new;
        totalChangedRes += res.value.changed;
        totalDeletedRes += res.value.deleted;
      }
    } else {
      errorCount++;
      errors.push(res.reason.message);
      console.error(`[Downloader] Error:`, res.reason.message);
    }
  }

  console.log(`\n[Downloader] Complete!`);
  console.log(`[Downloader] Extracted: ${successCount}, Skipped (unchanged hash): ${unchangedHashCount}, Failed: ${errorCount}`);
  console.log(`[Downloader] Resources: ${totalNewRes} new, ${totalChangedRes} changed, ${totalDeletedRes} deleted.`);

  // If there are errors, we might want to log them to sync_runs.
  // We can fetch the latest sync_run and append to its error field.
  if (errorCount > 0) {
    const lastRun = db.prepare('SELECT id, error FROM sync_runs ORDER BY id DESC LIMIT 1').get();
    if (lastRun) {
      const newError = lastRun.error 
        ? `${lastRun.error} | Downloader: ${errors[0]}`
        : `Downloader: ${errors[0]}`;
      db.prepare('UPDATE sync_runs SET error = ? WHERE id = ?').run(newError, lastRun.id);
    }
  }
}

module.exports = {
  runDownloader,
  processArtifactDownload
};
