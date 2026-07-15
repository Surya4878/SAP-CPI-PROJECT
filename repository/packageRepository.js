const BaseRepository = require('./baseRepository');
const db = require('../database');

class PackageRepository extends BaseRepository {
  constructor() {
    super('packages');
  }

  upsertPackage(data) {
    const existing = this.findBySourceId(data.source_id);
    
    if (!existing) {
      data.last_synced_at = new Date().toISOString();
      this.insert(data);
      return 'new';
    }

    if (existing.version === data.version) {
      // Unchanged -> UPDATE last_synced_at only
      db.prepare(`UPDATE packages SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
      return 'unchanged';
    } else {
      // Changed -> UPDATE record in place, increment sync_version
      const keys = Object.keys(data);
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = Object.values(data);
      
      db.prepare(`
        UPDATE packages 
        SET ${setClause}, 
            sync_version = sync_version + 1, 
            last_synced_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(...values, existing.id);
      
      return 'changed';
    }
  }

  markMissingAsDeleted(foundSourceIds) {
    let deletedPackagesCount = 0;
    let deletedArtifactsCount = 0;
    
    const activePackages = this.findAll();
    
    const deleteTx = db.transaction(() => {
      for (const pkg of activePackages) {
        if (!foundSourceIds.includes(pkg.source_id)) {
          // Soft delete package
          this.softDelete(pkg.id);
          deletedPackagesCount++;
          
          // Cascade to active artifacts
          const result = db.prepare(`
            UPDATE artifacts 
            SET deleted_at = CURRENT_TIMESTAMP 
            WHERE package_id = ? AND deleted_at IS NULL
          `).run(pkg.source_id);
          
          // Cascade to active resources via artifacts
          db.prepare(`
            UPDATE resources
            SET deleted_at = CURRENT_TIMESTAMP
            WHERE artifact_id IN (
              SELECT source_id FROM artifacts WHERE package_id = ?
            ) AND deleted_at IS NULL
          `).run(pkg.source_id);
          
          deletedArtifactsCount += result.changes;
        }
      }
    });
    
    deleteTx();
    
    return { deletedPackagesCount, deletedArtifactsCount };
  }
}

module.exports = new PackageRepository();
