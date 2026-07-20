const { assembleContext } = require('./context');
const { runReview } = require('./llm');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: node reviewer/query.js <artifactId>

Analyzes an SAP CPI iFlow using an LLM based on its metadata and recent runtime health.
    `);
    process.exit(0);
  }

  const artifactId = args[0];

  try {
    console.log(`Assembling context for '${artifactId}'...`);
    const context = await assembleContext(artifactId);

    if (!context) {
      console.log(`Skipping: '${artifactId}' is not currently deployed (no STARTED status in runtime_status).`);
      process.exit(0);
    }

    console.log(`Context assembled. Content Hash: ${context.contentHash.substring(0, 8)}...`);
    console.log(`Initiating LLM Review...`);
    
    const review = await runReview(context.contextBundleString, context.contentHash, artifactId);

    console.log(`\n=== Reviewer Verdict for ${artifactId} ===`);
    console.log(`Verdict: ${review.verdict} (Cached: ${review.fromCache ? 'YES' : 'NO'})`);
    console.log(`Model: ${review.modelUsed}\n`);
    
    console.log(`Summary: ${review.summary}\n`);

    if (review.issues && review.issues.length > 0) {
      console.log('ISSUES FOUND:');
      review.issues.forEach((issue, idx) => {
        console.log(`  ${idx + 1}. [${issue.severity}] ${issue.category}`);
        console.log(`     Description: ${issue.description}`);
        console.log(`     Suggested Action: ${issue.suggestedAction}\n`);
      });
    } else {
      console.log('No issues identified.');
    }

  } catch (err) {
    console.error(`Error during review:`, err.message);
  }
}

main();
