const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const initSchema = require('./schema');

const dbPath = path.resolve(__dirname, '../data/cpi_metadata.db');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(dbPath);

// Enable WAL mode for better concurrency and performance
db.pragma('journal_mode = WAL');

// Initialize schema
initSchema(db);

module.exports = db;
