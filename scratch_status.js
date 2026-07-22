const queue = require('./queue');

async function check() {
  try {
    const res = await queue.get("/IntegrationRuntimeArtifacts('SFTP_and_poll_enricher')");
    console.log(JSON.stringify(res.data, null, 2));
  } catch (err) {
    console.error(err);
  }
}
check();
