const db = require('../database/index');
const { getBlastRadius, getExternalSystemImpact } = require('./index');

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('Usage:');
  console.log('  node impact/query.js <artifactId> [--errors]');
  console.log('  node impact/query.js --system <host>');
  process.exit(1);
}

(async () => {
  if (args[0] === '--system') {
    const host = args[1];
    const results = getExternalSystemImpact(db, host);
    console.log(`\n=== External System Impact: ${host} ===`);
    if (results.length === 0) {
      console.log('No iFlows interact with this system.');
    } else {
      results.forEach(r => {
        console.log(`- [${r.id}] via ${r.relationshipType} (${JSON.stringify(r.metadata)})`);
      });
    }
  } else {
    // Blast radius for a specific artifact
    const target = args[0];
    const includeErrors = args.includes('--errors');
    const radius = await getBlastRadius(db, target, { includeRecentErrors: includeErrors });
    
    console.log(`\n=== Blast Radius Report: ${target} ===\n`);
    
    console.log('RISK FACTORS:');
    if (radius.riskFactors.length === 0) {
      console.log('  None identified.');
    } else {
      radius.riskFactors.forEach(rf => console.log(`  ! ${rf}`));
    }

    console.log('\nDIRECT CALLERS (Downstream):');
    if (radius.directCallers.length === 0) {
      console.log('  None.');
    } else {
      radius.directCallers.forEach(c => {
        console.log(`  - [${c.id}] via ${c.relationshipType} (${JSON.stringify(c.metadata)})`);
      });
    }

    console.log('\nTRANSITIVE CALLERS (Downstream > 1):');
    if (radius.transitiveCallers.length === 0) {
      console.log('  None.');
    } else {
      radius.transitiveCallers.forEach(c => {
        console.log(`  - [${c.id}] (Depth ${c.depth}) via chain:`);
        c.chain.forEach(link => {
          console.log(`      ${link.from} -> ${link.to} [${link.type}] (${JSON.stringify(link.metadata)})`);
        });
      });
    }

    console.log('\nEXTERNAL SYSTEMS USED (Upstream):');
    if (radius.externalSystemsUsed.length === 0) {
      console.log('  None.');
    } else {
      radius.externalSystemsUsed.forEach(u => {
        console.log(`  - [${u.id}] via ${u.relationshipType} (${JSON.stringify(u.metadata)})`);
      });
    }

    console.log('\nDEPENDS ON IFLOWS (Upstream):');
    if (radius.dependsOnIflows.length === 0) {
      console.log('  None.');
    } else {
      radius.dependsOnIflows.forEach(u => {
        if (u.depth === 1) {
          console.log(`  - [${u.id}] via ${u.relationshipType} (${JSON.stringify(u.metadata)})`);
        } else {
          console.log(`  - [${u.id}] (Depth ${u.depth}) via chain:`);
          u.chain.forEach(link => {
            console.log(`      ${link.from} -> ${link.to} [${link.type}] (${JSON.stringify(link.metadata)})`);
          });
        }
      });
    }

    if (radius.recent_status) {
      console.log('\nRECENT RUNTIME STATUS:');
      console.log(`  Runs: ${radius.recent_status.run_count} | Failures: ${radius.recent_status.failure_count} | Successes: ${radius.recent_status.success_count}`);
    }

    console.log('\n');
  }
})();
