const crypto = require('crypto');
const queue = require('../queue');
const packageRepo = require('../repository/packageRepository');
const artifactRepo = require('../repository/artifactRepository');
const syncRunRepo = require('../repository/syncRunRepository');

const ARTIFACT_TYPES = [
  { endpointSuffix: 'IntegrationDesigntimeArtifacts', type: 'IFlow' },
  { endpointSuffix: 'ValueMappingDesigntimeArtifacts', type: 'ValueMapping' },
  { endpointSuffix: 'MessageMappingDesigntimeArtifacts', type: 'MessageMapping' },
  { endpointSuffix: 'ScriptCollectionDesigntimeArtifacts', type: 'ScriptCollection' },
  { endpointSuffix: 'ServiceInterfaceDesigntimeArtifacts', type: 'ServiceInterface' },
  { endpointSuffix: 'MessageTypeDesigntimeArtifacts', type: 'MessageType' },
  { endpointSuffix: 'DataTypeDesigntimeArtifacts', type: 'DataType' },
  { endpointSuffix: 'FaultMessageTypeDesigntimeArtifacts', type: 'FaultMessageType' }
];

function hashObject(obj) {
  return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
}

function extractSourceId(item) {
  return item.Id || item.Name || item.Key || item.TagKey || hashObject(item);
}

function parseODataDate(dateString) {
  if (!dateString) return null;
  try {
    const match = dateString.match(/\/Date\((.*?)\)\//);
    if (match && match[1]) {
      return new Date(parseInt(match[1], 10)).toISOString();
    }
    if (/^\d+$/.test(dateString)) {
      return new Date(parseInt(dateString, 10)).toISOString();
    }
    return new Date(dateString).toISOString();
  } catch (err) {
    console.warn(`[Discovery] Warning: Could not parse date '${dateString}'`);
    return null;
  }
}

async function fetchAll(endpoint, filter = null) {
  const results = [];
  const top = 100;
  let skip = 0;
  
  while (true) {
    let url = `${endpoint}?$top=${top}&$skip=${skip}`;
    if (filter) {
      url += `&$filter=${filter}`;
    }
    url += url.includes('?') ? '&$format=json' : '?$format=json';

    const response = await queue.get(url, { headers: { 'Accept': 'application/json' } });
    const items = response.data?.d?.results || [];
    results.push(...items);
    
    if (items.length < top) {
      break;
    }
    skip += top;
  }
  
  return results;
}

async function fetchCustomTags() {
  const url = `/CustomTagConfigurations('CustomTags')/$value`;
  try {
    const response = await queue.get(url, { headers: { 'Accept': 'application/json' } });
    return response.data?.d?.results || response.data || [];
  } catch (err) {
    if (err.response && (err.response.status === 404 || err.response.status === 403)) {
      console.log(`[Discovery] CustomTagConfigurations endpoint returned ${err.response.status}. Tenant might not support it or lacks permissions.`);
      return [];
    }
    throw err;
  }
}

async function fetchPackages() {
  return fetchAll('/IntegrationPackages');
}

async function fetchArtifactType(packageId, artifactConfig) {
  const url = `/IntegrationPackages('${packageId}')/${artifactConfig.endpointSuffix}`;
  let useFilter = true;
  let results = [];
  
  try {
    results = await fetchAll(url, "Version eq 'active'");
  } catch (err) {
    if (err.response && (err.response.status === 400 || err.response.status === 501)) {
      console.log(`[Discovery] Filter rejected for ${artifactConfig.type} on pkg ${packageId}. Retrying without filter...`);
      useFilter = false;
      results = await fetchAll(url);
    } else {
      throw err;
    }
  }

  if (!useFilter && results.length > 0) {
    const deduped = {};
    for (const item of results) {
       const id = extractSourceId(item);
       
       if (!deduped[id]) {
         deduped[id] = item;
       } else {
         const isItemActive = JSON.stringify(item).toLowerCase().includes('active');
         const isExistingActive = JSON.stringify(deduped[id]).toLowerCase().includes('active');
         
         if (isItemActive && !isExistingActive) {
           deduped[id] = item;
         }
       }
    }
    results = Object.values(deduped);
  }

  return results;
}

async function runDiscovery() {
  const runId = syncRunRepo.startRun('discovery');
  const counts = {
    packages_new: 0, packages_changed: 0, packages_deleted: 0,
    artifacts_new: 0, artifacts_changed: 0, artifacts_deleted: 0
  };
  const changedArtifactsForDownload = [];

  try {
    console.log('[Discovery] Fetching all packages...');
    const packages = await fetchPackages();
    console.log(`[Discovery] Fetched ${packages.length} packages from tenant.`);
    
    const foundPackageIds = [];
    for (const pkg of packages) {
      foundPackageIds.push(pkg.Id);
      const pkgData = {
        source_id: pkg.Id, version: pkg.Version, name: pkg.Name,
        vendor: pkg.Vendor, mode: pkg.Mode, modified_by: pkg.ModifiedBy,
        last_modified_at: parseODataDate(pkg.ModifiedDate), content_hash: null
      };

      const status = packageRepo.upsertPackage(pkgData);
      if (status === 'new') counts.packages_new++;
      if (status === 'changed') counts.packages_changed++;
    }

    const pkgDelStats = packageRepo.markMissingAsDeleted(foundPackageIds);
    counts.packages_deleted += pkgDelStats.deletedPackagesCount;
    counts.artifacts_deleted += pkgDelStats.deletedArtifactsCount; 
    console.log(`[Discovery] Marked ${pkgDelStats.deletedPackagesCount} packages and ${pkgDelStats.deletedArtifactsCount} cascaded artifacts as deleted.`);

    const activePackages = packageRepo.findAll();
    console.log(`[Discovery] Processing ${ARTIFACT_TYPES.length} artifact types for ${activePackages.length} active packages...`);
    
    const loggedTypes = new Set();
    const typeErrors = [];

    const artifactPromises = activePackages.map(async (pkg) => {
      // Execute 10 concurrent fetches per package
      const typePromises = ARTIFACT_TYPES.map(async (artifactConfig) => {
        const artifacts = await fetchArtifactType(pkg.source_id, artifactConfig);
        
        if (artifacts.length > 0 && !loggedTypes.has(artifactConfig.type)) {
           loggedTypes.add(artifactConfig.type);
           console.log(`[Discovery] [Verify] Payload shape for ${artifactConfig.type}:`, Object.keys(artifacts[0]));
        }
        
        const foundArtifactIds = [];
        let p_art_new = 0, p_art_changed = 0;
        
        for (const art of artifacts) {
          const sourceId = extractSourceId(art);
          foundArtifactIds.push(sourceId);
          
          const artData = {
            source_id: sourceId,
            package_id: pkg.source_id,
            version: art.Version || null,
            name: art.Name || art.Key || sourceId,
            type: artifactConfig.type,
            content_hash: art.Version ? null : hashObject(art)
          };
          
          const status = artifactRepo.upsertArtifact(artData);
          if (status === 'new') p_art_new++;
          if (status === 'changed') p_art_changed++;
          
          if (status === 'new' || status === 'changed') {
            changedArtifactsForDownload.push({
              source_id: sourceId,
              package_id: pkg.source_id,
              type: artifactConfig.type,
              version: art.Version || null
            });
          }
        }
        
        const deletedArtifactsCount = artifactRepo.markMissingAsDeleted(pkg.source_id, artifactConfig.type, foundArtifactIds);
        
        return {
          type: artifactConfig.type,
          new: p_art_new, changed: p_art_changed, deleted: deletedArtifactsCount
        };
      });

      const typeResults = await Promise.allSettled(typePromises);
      
      let pkg_new = 0, pkg_changed = 0, pkg_deleted = 0;
      for (const res of typeResults) {
        if (res.status === 'fulfilled') {
          pkg_new += res.value.new;
          pkg_changed += res.value.changed;
          pkg_deleted += res.value.deleted;
        } else {
          console.error(`[Discovery] Error fetching a type for package ${pkg.source_id}:`, res.reason.message);
          typeErrors.push(`Pkg ${pkg.source_id}: ${res.reason.message}`);
        }
      }
      return { new: pkg_new, changed: pkg_changed, deleted: pkg_deleted };
    });

    // We process packages concurrently as well (or wait, the user said Promise.allSettled per-package artifacts).
    // The artifactPromises maps over packages, which launches packages * 10 promises total.
    // The queue will rate limit this correctly.
    const pkgResults = await Promise.allSettled(artifactPromises);
    for (const res of pkgResults) {
      if (res.status === 'fulfilled') {
        counts.artifacts_new += res.value.new;
        counts.artifacts_changed += res.value.changed;
        counts.artifacts_deleted += res.value.deleted;
      }
    }

    // Process CustomTags singleton
    console.log('[Discovery] Fetching tenant CustomTags...');
    const customTagsRepo = require('../repository/customTagRepository');
    const tags = await fetchCustomTags();
    const tagIds = [];
    const tagsArr = Array.isArray(tags) ? tags : [tags];
    for (const tag of tagsArr) {
      if (!tag.Name) continue;
      const tagId = tag.Name;
      tagIds.push(tagId);
      customTagsRepo.upsertTag({
        source_id: tagId,
        name: tag.Name,
        value: tag.Value,
        content_hash: hashObject(tag)
      });
    }
    customTagsRepo.markMissingAsDeleted(tagIds);

    console.log(`\n[Discovery] Sync Complete!`);
    console.log(`[Discovery] Packages: ${counts.packages_new} new, ${counts.packages_changed} changed, ${counts.packages_deleted} deleted.`);
    console.log(`[Discovery] Artifacts: ${counts.artifacts_new} new, ${counts.artifacts_changed} changed, ${counts.artifacts_deleted} deleted.`);

    const errorMsg = typeErrors.length > 0 ? `Encountered ${typeErrors.length} type fetch errors. First: ${typeErrors[0]}` : null;
    syncRunRepo.finishRun(runId, counts, errorMsg);
    
    return { runId, changedArtifacts: changedArtifactsForDownload };
  } catch (err) {
    console.error('[Discovery] Sync Run Failed:', err);
    syncRunRepo.finishRun(runId, counts, err.message || err.toString());
    throw err;
  }
}

module.exports = {
  runDiscovery,
  ARTIFACT_TYPES
};
