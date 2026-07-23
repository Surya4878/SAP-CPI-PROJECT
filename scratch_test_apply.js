const db = require('./database/index.js');
const { generateFixForArtifact } = require('./fixer/generate');
const { applyFixForArtifact } = require('./fixer/apply');

async function test() {
  try {
    console.log('Generating fix...');
    const generateResult = await generateFixForArtifact('dateanddatatypes');
    console.log('Generate Result:', JSON.stringify(generateResult, null, 2));

    if (generateResult.success !== false) {
      console.log('Applying fix...');
      const applyResult = await applyFixForArtifact('dateanddatatypes', 'dateanddatatypes');
      console.log('Apply Result:', JSON.stringify(applyResult, null, 2));
    } else {
      console.log('Cannot apply fix because it needs structural review.');
    }
  } catch (err) {
    console.error('Error:', err);
  }
}

test();
