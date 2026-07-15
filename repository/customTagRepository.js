const BaseRepository = require('./baseRepository');
const db = require('../database');

class CustomTagRepository extends BaseRepository {
  constructor() {
    super('custom_tags');
  }

  upsertTag(data) {
    const existing = this.findBySourceId(data.source_id);
    
    if (!existing) {
      data.last_synced_at = new Date().toISOString();
      this.insert(data);
      return 'new';
    }

    if (existing.content_hash === data.content_hash) {
      // Unchanged
      db.prepare(`UPDATE custom_tags SET last_synced_at = CURRENT_TIMESTAMP WHERE id = ?`).run(existing.id);
      return 'unchanged';
    } else {
      // Changed
      const keys = Object.keys(data);
      const setClause = keys.map(k => `${k} = ?`).join(', ');
      const values = Object.values(data);
      
      db.prepare(`
        UPDATE custom_tags 
        SET ${setClause}, 
            sync_version = sync_version + 1, 
            last_synced_at = CURRENT_TIMESTAMP
        WHERE id = ?
      `).run(...values, existing.id);
      
      return 'changed';
    }
  }

  markMissingAsDeleted(foundSourceIds) {
    let deletedCount = 0;
    
    const activeTags = this.findAll();
    
    const deleteTx = db.transaction(() => {
      for (const tag of activeTags) {
        if (!foundSourceIds.includes(tag.source_id)) {
          this.softDelete(tag.id);
          deletedCount++;
        }
      }
    });
    
    deleteTx();
    
    return deletedCount;
  }
}

module.exports = new CustomTagRepository();
