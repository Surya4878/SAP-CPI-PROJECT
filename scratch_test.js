const { getCSRFCredentials } = require('./auth/csrf');
const queue = require('./queue/index');

async function testDescriptionPut() {
  const artifactId = 'Groovy_script_simple_logic'; // Safe test artifact

  console.log('[Test] Fetching CSRF token...');
  const { csrfToken, cookies } = await getCSRFCredentials();

  console.log(`[Test] Fetching current ArtifactContent for ${artifactId}...`);
  const getRes = await queue.get(`/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')/$value`, {
    headers: { 'Cookie': cookies },
    responseType: 'arraybuffer'
  });
  
  const zipBase64 = Buffer.from(getRes.data).toString('base64');

  console.log(`[Test] Attempting PUT with a Description field...`);
  
  const payload = {
    Id: artifactId,
    Name: artifactId, 
    Description: 'Automated test description from Antigravity',
    Comment: 'Automated test comment from Antigravity',
    ArtifactContent: zipBase64
  };

  try {
    const putRes = await queue.put(`/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')`, payload, {
      headers: {
        'x-csrf-token': csrfToken,
        'Cookie': cookies,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      }
    });
    console.log(`[Test] PUT response status:`, putRes.status);
    
    console.log(`[Test] Re-fetching artifact metadata to check if Description stuck...`);
    const checkRes = await queue.get(`/IntegrationDesigntimeArtifacts(Id='${artifactId}',Version='active')`, {
      headers: { 'Cookie': cookies, 'Accept': 'application/json' }
    });
    
    console.log(`[Test] Fetched Description:`, checkRes.data.d.Description);
    console.log(`[Test] Fetched Comment:`, checkRes.data.d.Comment);
    if (checkRes.data.d.Description === 'Automated test description from Antigravity' || checkRes.data.d.Comment === 'Automated test comment from Antigravity') {
      console.log(`[SUCCESS] Description or Comment is writable!`);
    } else {
      console.log(`[FAILURE] Neither field stuck. Original data:`, checkRes.data.d);
    }

  } catch (err) {
    console.error(`[Test] PUT request failed!`);
    if (err.response) {
      console.error(err.response.status, err.response.data);
    } else {
      console.error(err.message);
    }
  }
}

testDescriptionPut();
