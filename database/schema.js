const initSchema = (db) => {
  // Base columns shared across all entity tables
  const baseColumns = `
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_id TEXT NOT NULL,
    version TEXT,
    content_hash TEXT,
    first_seen_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    last_synced_at DATETIME,
    last_modified_at DATETIME,
    deleted_at DATETIME,
    sync_version INTEGER DEFAULT 1
  `;

  db.exec(`
    CREATE TABLE IF NOT EXISTS packages (
      ${baseColumns},
      name TEXT,
      vendor TEXT,
      mode TEXT,
      modified_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_packages_source_id ON packages(source_id);
    CREATE INDEX IF NOT EXISTS idx_packages_deleted_at ON packages(deleted_at);

    CREATE TABLE IF NOT EXISTS artifacts (
      ${baseColumns},
      package_id TEXT NOT NULL,
      name TEXT,
      type TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_source_id ON artifacts(source_id);
    CREATE INDEX IF NOT EXISTS idx_artifacts_deleted_at ON artifacts(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_artifacts_package_id ON artifacts(package_id);

    CREATE TABLE IF NOT EXISTS resources (
      ${baseColumns},
      artifact_id TEXT NOT NULL,
      path TEXT NOT NULL,
      name TEXT NOT NULL,
      type TEXT,
      size INTEGER,
      content TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_resources_source_id ON resources(source_id);
    CREATE INDEX IF NOT EXISTS idx_resources_deleted_at ON resources(deleted_at);
    CREATE INDEX IF NOT EXISTS idx_resources_artifact_id ON resources(artifact_id);

    CREATE TABLE IF NOT EXISTS parsed_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      parser_version INTEGER NOT NULL DEFAULT 1,
      parsed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      parsed_json TEXT,
      UNIQUE(artifact_id, type)
    );
    CREATE INDEX IF NOT EXISTS idx_parsed_metadata_artifact_id ON parsed_metadata(artifact_id);

    CREATE TABLE IF NOT EXISTS custom_tags (
      ${baseColumns},
      name TEXT NOT NULL,
      value TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_custom_tags_source_id ON custom_tags(source_id);
    CREATE INDEX IF NOT EXISTS idx_custom_tags_deleted_at ON custom_tags(deleted_at);

    CREATE TABLE IF NOT EXISTS service_endpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      endpoint_url TEXT NOT NULL,
      raw_metadata TEXT,
      last_checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sync_run_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_service_endpoints_artifact_id ON service_endpoints(artifact_id);

    CREATE TABLE IF NOT EXISTS runtime_status (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      status TEXT,
      version TEXT,
      type TEXT,
      deployed_on DATETIME,
      error_info TEXT,
      last_checked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      sync_run_id INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_runtime_status_artifact_id ON runtime_status(artifact_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS sync_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      finished_at DATETIME,
      error_message TEXT,
      packages_new INTEGER DEFAULT 0,
      packages_changed INTEGER DEFAULT 0,
      packages_deleted INTEGER DEFAULT 0,
      artifacts_new INTEGER DEFAULT 0,
      artifacts_changed INTEGER DEFAULT 0,
      artifacts_deleted INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_sync_runs_started ON sync_runs(started_at);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS relationships (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL,
      source_id TEXT NOT NULL,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      relationship_type TEXT NOT NULL,
      metadata TEXT,
      sync_run_id INTEGER,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_relationships_source ON relationships(source_type, source_id);
    CREATE INDEX IF NOT EXISTS idx_relationships_target ON relationships(target_type, target_id);
  `);
};

module.exports = initSchema;
