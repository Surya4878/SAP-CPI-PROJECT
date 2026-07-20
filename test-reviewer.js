const nock = require('nock');
const { runReview } = require('./reviewer/llm');
const db = require('./database/index');
require('dotenv').config();
process.env.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || 'dummy_test_key';

async function runTests() {
  console.log('--- Unit 4: Reviewer Module Tests ---');
  db.exec("DELETE FROM reviews WHERE artifact_id = 'TestReviewIFlow'");

  const fakeContextBundle = JSON.stringify({ artifactId: 'TestReviewIFlow', foo: 'bar' });
  const fakeHash = 'testhash12345';
  
  // Clean up any existing mocks
  nock.cleanAll();

  // Test 1: Malformed JSON recovery logic
  console.log('\\n[Test 1] Malformed JSON -> Retry -> Success');
  
  // First response is malformed (missing quotes, missing summary, unclosed brace)
  nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, {
      choices: [{ message: { content: '{ verdict: "OK", issues: []' } }]
    });

  // Second response (retry) is valid
  nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, {
      choices: [{ message: { content: '{ "verdict": "OK", "issues": [], "summary": "Looks good" }' } }]
    });

  try {
    const review1 = await runReview(fakeContextBundle, fakeHash, 'TestReviewIFlow');
    if (review1.verdict === 'OK' && review1.summary === 'Looks good') {
      console.log('✅ Test 1 Passed (Successfully recovered from malformed JSON)');
    } else {
      console.error('❌ Test 1 Failed: Unexpected result shape', review1);
    }
  } catch (err) {
    console.error('❌ Test 1 Failed to recover', err);
  }

  // Test 2: Cache Hit
  console.log('\\n[Test 2] Cache Hit -> Skip LLM');
  // No nock setup here. If it hits the LLM, nock will throw because no mocks are left.
  try {
    const review2 = await runReview(fakeContextBundle, fakeHash, 'TestReviewIFlow');
    if (review2.fromCache === true && review2.verdict === 'OK') {
      console.log('✅ Test 2 Passed (Skipped LLM)');
    } else {
      console.error('❌ Test 2 Failed: Did not return from cache', review2);
    }
  } catch (err) {
    console.error('❌ Test 2 Failed with error', err);
  }

  // Test 3: Total Failure (2 bad JSONs)
  console.log('\\n[Test 3] Double Malformed -> Graceful Failure');
  const fakeHash2 = 'testhash_fail';
  nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, {
      choices: [{ message: { content: 'This is not JSON at all' } }]
    });

  nock('https://openrouter.ai')
    .post('/api/v1/chat/completions')
    .reply(200, {
      choices: [{ message: { content: 'Still not JSON' } }]
    });

  try {
    await runReview(fakeContextBundle, fakeHash2, 'TestReviewIFlow');
    console.error('❌ Test 3 Failed (Should have thrown an error)');
  } catch (err) {
    if (err.message.includes('Failed to parse valid JSON')) {
      console.log('✅ Test 3 Passed (Failed gracefully after retry)');
    } else {
      console.error('❌ Test 3 Failed (Threw wrong error):', err.message);
    }
  }

  console.log('\\n--- Tests Complete ---');
}

runTests();
