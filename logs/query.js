const { getRecentStatus, getFailureDetails } = require('./index');

async function main() {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes('--help')) {
    console.log(`
Usage: node logs/query.js <artifactId> [--hours 24] [--details] [--limit 10]

Options:
  --hours   Time window to check logs (default: 24)
  --details Fetch detailed error messages for failed runs
  --limit   Max number of error details to fetch (default: 10)
    `);
    process.exit(0);
  }

  const artifactId = args[0];
  let hours = 24;
  let details = false;
  let limit = 10;

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--hours' && args[i+1]) {
      hours = parseInt(args[i+1], 10);
      i++;
    } else if (args[i] === '--details') {
      details = true;
    } else if (args[i] === '--limit' && args[i+1]) {
      limit = parseInt(args[i+1], 10);
      i++;
    }
  }

  try {
    console.log(`\nFetching recent status for '${artifactId}' (last ${hours} hours)...`);
    const status = await getRecentStatus(artifactId, { hours });
    console.log(`  Runs: ${status.run_count} | Failures: ${status.failure_count} | Successes: ${status.success_count}`);
    console.log(`  (Data from cache: ${status.from_cache ? 'YES' : 'NO'})\n`);

    if (details && status.failure_count > 0) {
      console.log(`Fetching failure details for up to ${limit} failed runs...`);
      const errDetails = await getFailureDetails(artifactId, { hours, limit });
      if (errDetails.length === 0) {
        console.log(`  No failure details found.`);
      } else {
        errDetails.forEach((err, idx) => {
          console.log(`\n--- Failure ${idx + 1} (${err.guid}) @ ${err.timestamp} ---`);
          console.log(err.error);
        });
        console.log(`\nFetched ${errDetails.length} error detail(s).`);
      }
    } else if (details) {
       console.log(`No failures found to fetch details for.`);
    }

  } catch (err) {
    console.error(`Error:`, err.message);
  }
}

main();
