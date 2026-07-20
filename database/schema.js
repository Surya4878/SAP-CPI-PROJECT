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

  db.exec(`
    CREATE TABLE IF NOT EXISTS log_queries (
      artifact_id TEXT NOT NULL,
      queried_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      window_hours INTEGER NOT NULL,
      run_count INTEGER DEFAULT 0,
      failure_count INTEGER DEFAULT 0,
      success_count INTEGER DEFAULT 0,
      cached_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (artifact_id, window_hours)
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS reviews (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      reviewed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      model_used TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      verdict TEXT NOT NULL,
      issues_json TEXT NOT NULL,
      summary TEXT,
      review_version INTEGER DEFAULT 1
    );
    CREATE INDEX IF NOT EXISTS idx_reviews_artifact_id ON reviews(artifact_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS risk_scores (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      structural_risk TEXT NOT NULL,
      runtime_risk TEXT NOT NULL,
      reviewer_risk TEXT NOT NULL,
      composite_risk TEXT NOT NULL,
      contributing_factors_json TEXT NOT NULL,
      review_id INTEGER,
      blast_radius_snapshot_hash TEXT NOT NULL,
      FOREIGN KEY(review_id) REFERENCES reviews(id)
    );
    CREATE INDEX IF NOT EXISTS idx_risk_scores_artifact_id ON risk_scores(artifact_id);
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      initiated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      confirmed_by TEXT,
      content_hash_verified BOOLEAN,
      task_id TEXT,
      polling_status TEXT,
      final_result TEXT,
      completed_at DATETIME,
      error_detail TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_deployments_artifact_id ON deployments(artifact_id);
  `);

  // NOTE: This table currently stores full artifact ZIPs indefinitely.
  // Pruning logic (e.g., retaining only the last N versions per artifact) 
  // should be added later to prevent unbounded growth as syncs scale.
  db.exec(`
    CREATE TABLE IF NOT EXISTS artifact_versions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      cpi_version TEXT,
      content_hash TEXT NOT NULL,
      metadata_hash TEXT,
      inner_content_hash TEXT,
      zip_content BLOB NOT NULL,
      saved_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_versions_artifact_id ON artifact_versions(artifact_id);

    CREATE TABLE IF NOT EXISTS generated_fixes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      issue_context TEXT NOT NULL,
      error_signature TEXT NOT NULL,
      original_content_hash TEXT NOT NULL,
      original_content TEXT NOT NULL,
      proposed_content TEXT NOT NULL,
      explanation TEXT,
      confidence_level TEXT,
      generated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      applied BOOLEAN DEFAULT 0,
      applied_at DATETIME,
      outcome TEXT,
      fix_type TEXT DEFAULT 'groovy',
      element_path TEXT,
      attribute_name TEXT,
      error_summary TEXT,
      fix_summary TEXT,
      manual_steps TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_generated_fixes_artifact_id ON generated_fixes(artifact_id);

    CREATE TABLE IF NOT EXISTS healing_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed_at DATETIME,
      artifacts_scanned INTEGER DEFAULT 0,
      failures_found INTEGER DEFAULT 0,
      fixes_generated INTEGER DEFAULT 0,
      structural_flags_raised INTEGER DEFAULT 0,
      structural_flags_json TEXT,
      duplicates_skipped INTEGER DEFAULT 0,
      errors INTEGER DEFAULT 0,
      capped_failures INTEGER DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS structural_flags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      error_signature TEXT NOT NULL,
      first_flagged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      last_flagged_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      recurrence_count INTEGER DEFAULT 1,
      snoozed_until DATETIME,
      acknowledged_at DATETIME,
      resolved_at DATETIME,
      UNIQUE(artifact_id, error_signature)
    );
    CREATE INDEX IF NOT EXISTS idx_structural_flags_artifact_id ON structural_flags(artifact_id);
  `);

  // Migrations: add columns to existing tables that predate this schema version.
  // Using try/catch since ALTER TABLE fails silently if column already exists in some SQLite builds,
  // but throws in others — safer than checking information_schema which SQLite doesn't have.
  const migrations = [
    `ALTER TABLE healing_cycles ADD COLUMN capped_failures INTEGER DEFAULT 0`,
    `ALTER TABLE deployments ADD COLUMN triggered_via TEXT DEFAULT 'cli'`,
    `ALTER TABLE generated_fixes ADD COLUMN triggered_via TEXT DEFAULT 'cli'`,
    `ALTER TABLE structural_flags ADD COLUMN triggered_via TEXT DEFAULT 'cli'`,
    `ALTER TABLE generated_fixes ADD COLUMN fix_type TEXT DEFAULT 'groovy'`,
    `ALTER TABLE generated_fixes ADD COLUMN element_path TEXT`,
    `ALTER TABLE generated_fixes ADD COLUMN attribute_name TEXT`,
    `ALTER TABLE artifact_versions ADD COLUMN cpi_version TEXT`,
    `ALTER TABLE generated_fixes ADD COLUMN error_summary TEXT`,
    `ALTER TABLE generated_fixes ADD COLUMN fix_summary TEXT`,
    `ALTER TABLE generated_fixes ADD COLUMN manual_steps TEXT`
  ];
  for (const sql of migrations) {
    try { db.exec(sql); } catch (e) { /* column already exists — safe to ignore */ }
  }
};

module.exports = initSchema;
