require('dotenv').config();
const queue = require('./queue/index');
const { getCSRFCredentials } = require('./auth/csrf');

async function testUndeploy() {
  console.log('Testing Undeploy endpoint formats (dry run/investigation)...');
  try {
    const { csrfToken, cookies } = await getCSRFCredentials();
    
    // We don't want to actually undeploy anything if we can avoid it, 
    // but maybe we can trigger a deliberate 404 or see the error format.
    // Let's try to undeploy a fake ID.
    const fakeId = 'FakeNonExistentArtifact';
    
    try {
      const res = await queue.post(`/UndeployIntegrationRuntimeArtifact?Id='${fakeId}'`, null, {
        headers: {
          'X-CSRF-Token': csrfToken,
          'Cookie': cookies,
          'Accept': 'application/json'
        }
      });
      console.log('Format 1 Response:', res.status, res.data);
    } catch (err) {
      console.log('Format 1 Failed:', err.response ? err.response.status : err.message);
      if (err.response && err.response.data) console.log(JSON.stringify(err.response.data));
    }

    try {
      const res2 = await queue.delete(`/IntegrationRuntimeArtifacts('${fakeId}')`, {
        headers: {
          'X-CSRF-Token': csrfToken,
          'Cookie': cookies,
          'Accept': 'application/json'
        }
      });
      console.log('Format 2 Response:', res2.status, res2.data);
    } catch (err) {
      console.log('Format 2 Failed:', err.response ? err.response.status : err.message);
      if (err.response && err.response.data) console.log(JSON.stringify(err.response.data));
    }

  } catch (err) {
    console.error('Fatal error in investigation:', err);
  }
}

testUndeploy();
