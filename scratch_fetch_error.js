const queue = require('./queue');

async function run() {
  try {
    const res = await queue.get("/IntegrationRuntimeArtifacts('dateanddatatypes')/ErrorInformation/$value");
    console.log("ERROR LOG:");
    console.log(res.data);
  } catch (err) {
    console.error(err);
  }
}
run();
