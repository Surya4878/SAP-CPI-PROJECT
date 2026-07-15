const db = require('../database');

class SyncRunRepository {
  startRun(mode) {
    const stmt = db.prepare(`
      INSERT INTO sync_runs (mode) 
      VALUES (?)
    `);
    const result = stmt.run(mode);
    return result.lastInsertRowid;
  }

  finishRun(id, counts, errorMsg = null) {
    const stmt = db.prepare(`
      UPDATE sync_runs 
      SET completed_at = CURRENT_TIMESTAMP,
          packages_new = ?,
          packages_changed = ?,
          packages_deleted = ?,
          artifacts_new = ?,
          artifacts_changed = ?,
          artifacts_deleted = ?,
          error = ?
      WHERE id = ?
    `);
    
    stmt.run(
      counts.packages_new || 0,
      counts.packages_changed || 0,
      counts.packages_deleted || 0,
      counts.artifacts_new || 0,
      counts.artifacts_changed || 0,
      counts.artifacts_deleted || 0,
      errorMsg,
      id
    );
  }
}

module.exports = new SyncRunRepository();
