const BaseRepository = require('./baseRepository');
const db = require('../database');

class ArtifactRepository extends BaseRepository {
  constructor() {
    super('artifacts');
  }

  upsertArtifact(data) {
    const existing = db.prepare('SELECT id, metadata_hash FROM artifacts WHERE source_id = ? AND deleted_at IS NULL').get(data.source_id);

    if (!existing) {
      db.prepare(`
        INSERT INTO artifacts (source_id, package_id, version, name, type, metadata_hash)
        VALUES (?, ?, ?, ?, ?, ?)
      `).run(data.source_id, data.package_id, data.version, data.name, data.type, data.metadata_hash);
      return 'new';
    }

    // Change detection strategy: active drafts share the same version string, so ALWAYS compare metadata_hash
    const hasChanged = existing.metadata_hash !== data.metadata_hash;

    if (!hasChanged) {
      // Unchanged -> UPDATE last_synced_at only
      db.prepare(`UPDATE artifacts SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
      return 'unchanged';
    } else {
      // Changed -> UPDATE record in place, increment sync_version
      db.prepare(`
        UPDATE artifacts 
        SET package_id = ?, version = ?, name = ?, type = ?, metadata_hash = ?, sync_version = sync_version + 1, last_synced_at = CURRENT_TIMESTAMP 
        WHERE source_id = ? AND deleted_at IS NULL
      `).run(data.package_id, data.version, data.name, data.type, data.metadata_hash, data.source_id);
      return 'changed';
    }
  }

  markMissingAsDeleted(packageId, type, foundSourceIds) {
    let deletedCount = 0;
    
    // Find all active artifacts for this package AND TYPE
    const stmt = db.prepare(`SELECT * FROM artifacts WHERE package_id = ? AND type = ? AND deleted_at IS NULL`);
    const activeArtifacts = stmt.all(packageId, type);
    
    const deleteTx = db.transaction(() => {
      for (const artifact of activeArtifacts) {
        if (!foundSourceIds.includes(artifact.source_id)) {
          this.softDelete(artifact.id);
          deletedCount++;
          
          // Cascade to active resources
          db.prepare(`
            UPDATE resources 
            SET deleted_at = CURRENT_TIMESTAMP 
            WHERE artifact_id = ? AND deleted_at IS NULL
          `).run(artifact.source_id);
        }
      }
    });
    
    deleteTx();
    
    return deletedCount;
  }
}

module.exports = new ArtifactRepository();
