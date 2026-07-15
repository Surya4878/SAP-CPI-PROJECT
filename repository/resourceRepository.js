const BaseRepository = require('./baseRepository');
const db = require('../database');

class ResourceRepository extends BaseRepository {
  constructor() {
    super('resources');
  }

  upsertResource(data) {
    // Identity is (artifact_id, path)
    const stmt = db.prepare(`SELECT * FROM resources WHERE artifact_id = ? AND path = ? AND deleted_at IS NULL`);
    const existing = stmt.get(data.artifact_id, data.path);
    
    if (!existing) {
      data.last_synced_at = new Date().toISOString();
      this.insert(data);
      return 'new';
    }

    // Change detection is content_hash
    if (existing.content_hash === data.content_hash) {
      // Unchanged
      db.prepare(`UPDATE resources SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
      return 'unchanged';
    } else {
      // Changed
      const keys = Object.keys(data);
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = Object.values(data);
      
      db.prepare(`
        UPDATE resources 
        SET ${setClause}, 
            sync_version = sync_version + 1, 
            last_synced_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(...values, existing.id);
      
      return 'changed';
    }
  }

  markMissingAsDeleted(artifactId, foundPaths) {
    let deletedCount = 0;
    
    // Find all active resources for this artifact
    const stmt = db.prepare(`SELECT * FROM resources WHERE artifact_id = ? AND deleted_at IS NULL`);
    const activeResources = stmt.all(artifactId);
    
    const deleteTx = db.transaction(() => {
      for (const resource of activeResources) {
        if (!foundPaths.includes(resource.path)) {
          this.softDelete(resource.id);
          deletedCount++;
        }
      }
    });
    
    deleteTx();
    
    return deletedCount;
  }
}

module.exports = new ResourceRepository();
