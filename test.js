require('dotenv').config();
const nock = require('nock');
const config = require('./config');
const auth = require('./auth');
const queue = require('./queue');
const BaseRepository = require('./repository/baseRepository');

// Setup Nock for the Auth endpoint
nock(config.tokenUrl)
  .persist() // keep it alive for multiple refresh calls if needed
  .post('/oauth/token')
  .reply(200, function() {
    // Generate a new token each time it's called
    const rnd = Math.floor(Math.random() * 1000);
    return {
      access_token: `mock-token-${rnd}`,
      expires_in: 3600
    };
  });

const apiNock = nock(config.apiHost).persist();

// 1. One endpoint that returns 401 first, then 200
let secureDummyCount = 0;
apiNock.get('/secure-dummy').reply(function() {
  secureDummyCount++;
  if (secureDummyCount === 1) {
    return [401, 'Unauthorized'];
  }
  return [200, { ok: true, attempt: secureDummyCount }];
});

// 2. One endpoint for the rapid requests that returns some 429s randomly
// We will simulate 3 specific requests returning 429 on their first attempt
let dummy429Count = 0;
apiNock.get('/dummy').reply(function() {
  dummy429Count++;
  // Return 429 for the 3rd, 7th, and 12th requests to test backoff interleaved with normal traffic
  if (dummy429Count === 3 || dummy429Count === 7 || dummy429Count === 12) {
    return [429, 'Too Many Requests'];
  }
  return [200, { ok: true }];
});


async function runTests() {
  console.log('--- Starting Phase 1 Unit 1 Verification ---');

  // ==========================================
  // Test 1: Database & Repository
  // ==========================================
  console.log('\n[1] Testing Database Repository (deleted_at filtering)');
  const repo = new BaseRepository('packages');
  
  const pkgId = repo.insert({
    source_id: 'TestPkg-001',
    version: '1.0.0',
    content_hash: 'hash-abc',
  });
  console.log(` -> Inserted package with ID: ${pkgId}`);
  
  let record = repo.findById(pkgId);
  console.log(` -> Retrieved active package: ${record ? 'YES' : 'NO'} (Expected YES)`);
  
  repo.softDelete(pkgId);
  console.log(` -> Soft deleted package ${pkgId}`);
  
  record = repo.findById(pkgId);
  console.log(` -> Retrieved package after soft delete: ${record ? 'YES' : 'NO'} (Expected NO)`);

  // ==========================================
  // Test 2: Auth and Queue (401 Refresh)
  // ==========================================
  console.log('\n[2] Testing Auth Token & 401 Refresh Mechanism');
  
  const token1 = await auth.getToken();
  console.log(` -> Initial token acquired: ${token1}`);

  console.log(` -> Sending request to /secure-dummy (will return 401 on first try)`);
  await queue.get('/secure-dummy');
  console.log(` -> Request succeeded. Current token: ${auth.token} (Should be different from initial)`);

  // ==========================================
  // Test 3: Queue Rate Limiting & 429 Backoff
  // ==========================================
  console.log('\n[3] Testing Rate Limits & 429 Backoff');
  console.log(` -> Firing 20 concurrent requests at ${config.rateLimit} req/sec...`);
  
  const startTime = Date.now();
  const promises = [];
  
  // Fire 20 requests at the same time
  for (let i = 0; i < 20; i++) {
    promises.push(
      queue.get('/dummy').then(r => r.status).catch(e => e.message)
    );
  }
  
  await Promise.all(promises);
  const duration = Date.now() - startTime;
  
  console.log(` -> All 20 requests completed in ${duration}ms`);
  
  // At 5 req/sec, 20 requests should take at least ~3800ms
  // Plus retries for the 429s
  const minExpectedTime = ((20 - 1) * (1000 / config.rateLimit));
  console.log(` -> Expected minimum duration: ~${minExpectedTime}ms`);
  
  if (duration >= minExpectedTime) {
    console.log(' -> Rate limiting SUCCESS: requests were correctly throttled.');
  } else {
    console.log(' -> Rate limiting FAILED: completed too quickly.');
  }

  console.log('\n--- Verification Complete ---');
}

runTests().catch(err => {
  console.error('Test failed:', err);
});
