require('dotenv').config();
const queue = require('./queue/index');

async function testCSRF() {
  console.log('Fetching CSRF Token...');
  
  try {
    // 1. Fetch CSRF token
    const res = await queue.get('/$metadata', {
      headers: {
        'X-CSRF-Token': 'Fetch'
      }
    });

    const csrfToken = res.headers['x-csrf-token'];
    const cookies = res.headers['set-cookie'];

    console.log(`CSRF Token: ${csrfToken}`);
    console.log(`Set-Cookie: ${JSON.stringify(cookies)}`);

    if (!csrfToken) {
      console.log('Failed to fetch CSRF token!');
      return;
    }

    // 2. Test Deploy endpoint with Decoder
    console.log('\nTesting Deploy Trigger POST...');
    try {
      const deployRes = await queue.post('/DeployIntegrationDesigntimeArtifact?Id=\'Decoder\'&Version=\'active\'', null, {
        headers: {
          'X-CSRF-Token': csrfToken,
          'Cookie': cookies ? cookies.join('; ') : '',
          'Accept': 'application/json'
        }
      });
      
      console.log(`Deploy Response Status: ${deployRes.status}`);
      console.log(`Deploy Response Headers: ${JSON.stringify(deployRes.headers)}`);
      console.log(`Deploy Response Body: ${JSON.stringify(deployRes.data)}`);
    } catch (deployErr) {
      console.log(`Deploy Trigger Failed with Status: ${deployErr.response ? deployErr.response.status : 'UNKNOWN'}`);
      console.log(`Error Body: ${JSON.stringify(deployErr.response ? deployErr.response.data : deployErr.message)}`);
    }

  } catch (err) {
    console.error('CSRF Fetch failed:', err.message);
    if (err.response) {
      console.error(err.response.data);
    }
  }
}

testCSRF();
