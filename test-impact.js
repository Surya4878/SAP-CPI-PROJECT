const Database = require('better-sqlite3');
const { getDownstreamImpact, getUpstreamDependencies, getBlastRadius } = require('./impact/index');

function runTest() {
  const db = new Database(':memory:');
  
  db.exec(`
    CREATE TABLE relationships (
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
    CREATE TABLE parsed_metadata (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      parser_version INTEGER NOT NULL DEFAULT 1,
      parsed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      parsed_json TEXT,
      UNIQUE(artifact_id, type)
    );
  `);

  // Fixture:
  // A calls B via ProcessDirect
  // B calls C via JMS
  // B calls A via ProcessDirect (cycle)
  
  const insertRel = db.prepare(`
    INSERT INTO relationships (source_type, source_id, target_type, target_id, relationship_type, metadata)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  insertRel.run('IFlow', 'A', 'IFlow', 'B', 'calls_via_processdirect', JSON.stringify({ address: '/to_B' }));
  insertRel.run('IFlow', 'B', 'IFlow', 'C', 'calls_via_jms', JSON.stringify({ address: 'Queue_C' }));
  insertRel.run('IFlow', 'B', 'IFlow', 'A', 'calls_via_processdirect', JSON.stringify({ address: '/to_A' }));

  // Test Downstream Impact of C
  // Who depends on C? B depends on C (since B calls C). And A depends on B (since A calls B).
  console.log('--- Testing Downstream Impact of C ---');
  const impactC = getDownstreamImpact(db, 'C');
  console.log(JSON.stringify(impactC, null, 2));
  
  let passed = true;
  if (!impactC.find(x => x.id === 'B' && x.depth === 1)) {
    console.error('FAIL: Expected B to depend on C at depth 1');
    passed = false;
  }
  if (!impactC.find(x => x.id === 'A' && x.depth === 2)) {
    console.error('FAIL: Expected A to depend on C at depth 2 (via B)');
    passed = false;
  }

  // Test cycle handling for A's upstream dependencies (A -> B -> A -> B ...)
  console.log('\\n--- Testing Cycle Handling for getUpstreamDependencies(A) ---');
  const upA = getUpstreamDependencies(db, 'A');
  console.log(JSON.stringify(upA, null, 2));

  // Should have B at depth 1, C at depth 2, A at depth 2 (since B calls A)
  // Max depth is 3, but the cycle check should break the A->B->A recursion
  
  if (!upA.find(x => x.id === 'B' && x.depth === 1)) {
    console.error('FAIL: Expected B at depth 1');
    passed = false;
  }
  if (!upA.find(x => x.id === 'C' && x.depth === 2)) {
    console.error('FAIL: Expected C at depth 2');
    passed = false;
  }
  if (!upA.find(x => x.id === 'A' && x.depth === 2)) {
    console.error('FAIL: Expected A at depth 2');
    passed = false;
  }

  if (passed) {
    console.log('\\nALL TESTS PASSED');
  } else {
    console.log('\\nSOME TESTS FAILED');
  }
}

runTest();
