const { getFailureDetails } = require('./logs/index');

async function check() {
  try {
    const details = await getFailureDetails('SFTP_and_poll_enricher', { hours: 720, details: true, bypassCache: true });
    console.log(JSON.stringify(details, null, 2));
  } catch (err) {
    console.error(err);
  }
}
check();
