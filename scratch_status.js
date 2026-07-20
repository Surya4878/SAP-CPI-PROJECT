require('dotenv').config();
const queue = require('./queue/index');

async function testStatus() {
  console.log('Fetching status for task 2b68e784-8b08-4bbb-53e8-54042ce54912...');
  
  try {
    const res = await queue.get('/BuildAndDeployStatus?taskId=\'2b68e784-8b08-4bbb-53e8-54042ce54912\'');
    console.log(`Status Body: ${JSON.stringify(res.data, null, 2)}`);
  } catch (err) {
    console.error('Status fetch failed (format 1):', err.message);
    if (err.response) {
      console.error(err.response.data);
    }
    
    // Fallback format
    try {
      const res2 = await queue.get('/BuildAndDeployStatus(\'2b68e784-8b08-4bbb-53e8-54042ce54912\')');
      console.log(`Status Body (format 2): ${JSON.stringify(res2.data, null, 2)}`);
    } catch (err2) {
      console.error('Status fetch failed (format 2):', err2.message);
      if (err2.response) {
        console.error(err2.response.data);
      }
    }
  }
}

testStatus();
