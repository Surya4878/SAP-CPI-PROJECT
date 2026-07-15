const db = require('../database');

class BaseRepository {
  constructor(tableName) {
    this.tableName = tableName;
  }

  /**
   * Helper to ensure we always filter out soft-deleted records on reads.
   * This is enforced for all queries made via the base repository.
   */
  get activeCondition() {
    return `deleted_at IS NULL`;
  }

  /**
   * Find a single record by its internal ID (ignoring deleted)
   */
  findById(id) {
    const stmt = db.prepare(`SELECT * FROM ${this.tableName} WHERE id = ? AND ${this.activeCondition}`);
    return stmt.get(id);
  }

  /**
   * Find a single record by its source tenant ID (ignoring deleted)
   */
  findBySourceId(sourceId) {
    const stmt = db.prepare(`SELECT * FROM ${this.tableName} WHERE source_id = ? AND ${this.activeCondition}`);
    return stmt.get(sourceId);
  }

  /**
   * Get all active records
   */
  findAll() {
    const stmt = db.prepare(`SELECT * FROM ${this.tableName} WHERE ${this.activeCondition}`);
    return stmt.all();
  }

  /**
   * Insert a new record
   */
  insert(data) {
    const keys = Object.keys(data);
    const placeholders = keys.map(() => '?').join(', ');
    const values = Object.values(data);
    
    const stmt = db.prepare(`
      INSERT INTO ${this.tableName} (${keys.join(', ')})
      VALUES (${placeholders})
    `);
    
    const result = stmt.run(...values);
    return result.lastInsertRowid;
  }

  /**
   * Soft delete a record by ID
   */
  softDelete(id) {
    const stmt = db.prepare(`
      UPDATE ${this.tableName} 
      SET deleted_at = CURRENT_TIMESTAMP 
      WHERE id = ? AND ${this.activeCondition}
    `);
    return stmt.run(id);
  }
}

module.exports = BaseRepository;
