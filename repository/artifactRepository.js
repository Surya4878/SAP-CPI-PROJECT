const BaseRepository = require('./baseRepository');
const db = require('../database');

class ArtifactRepository extends BaseRepository {
  constructor() {
    super('artifacts');
  }

  upsertArtifact(data) {
    const stmt = db.prepare(`SELECT * FROM artifacts WHERE source_id = ? AND package_id = ? AND type = ? AND deleted_at IS NULL`);
    const existing = stmt.get(data.source_id, data.package_id, data.type);
    
    if (!existing) {
      data.last_synced_at = new Date().toISOString();
      this.insert(data);
      return 'new';
    }

    // Change detection strategy: use version if present, fallback to content_hash
    const hasChanged = data.version 
      ? existing.version !== data.version 
      : existing.content_hash !== data.content_hash;

    if (!hasChanged) {
      // Unchanged -> UPDATE last_synced_at only
      db.prepare(`UPDATE artifacts SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
      return 'unchanged';
    } else {
      // Changed -> UPDATE record in place, increment sync_version
      const keys = Object.keys(data);
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = Object.values(data);
      
      db.prepare(`
        UPDATE artifacts 
        SET ${setClause}, 
            sync_version = sync_version + 1, 
            last_synced_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(...values, existing.id);
      
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
