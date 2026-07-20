const db = require('../database');
const diff = require('diff');

function reviewFix() {
  const artifactId = process.argv[2];
  if (!artifactId) {
    console.error("Usage: node fixer/review.js <artifactId>");
    process.exit(1);
  }

  const fixRow = db.prepare(`
    SELECT * FROM generated_fixes 
    WHERE artifact_id = ? AND applied = 0 
    ORDER BY generated_at DESC 
    LIMIT 1
  `).get(artifactId);

  if (!fixRow) {
    console.error(`[INFO] No pending fixes found for ${artifactId}.`);
    process.exit(0);
  }

  console.log(`\n=============================================================`);
  console.log(` FIX PROPOSAL FOR: ${artifactId}`);
  console.log(`=============================================================`);
  console.log(`Confidence: ${fixRow.confidence_level}`);
  console.log(`Explanation:\n${fixRow.explanation}\n`);
  
  console.log(`Diff:`);
  console.log(`-------------------------------------------------------------`);
  
  if (fixRow.fix_type === 'xml_value') {
    console.log(`[XML Value Fix]`);
    console.log(`Element Path : ${fixRow.element_path}`);
    console.log(`Attribute    : ${fixRow.attribute_name}\n`);
  }
  
  const originalFileName = fixRow.fix_type === 'xml_value' ? 'original.iflw' : 'original.groovy';
  const proposedFileName = fixRow.fix_type === 'xml_value' ? 'proposed.iflw' : 'proposed.groovy';

  const patch = diff.createTwoFilesPatch(
    originalFileName, 
    proposedFileName, 
    fixRow.original_content, 
    fixRow.proposed_content
  );
  
  console.log(patch);
  console.log(`-------------------------------------------------------------`);
  console.log(`\nNext step: If you approve, run 'node fixer/apply.js ${artifactId}'`);
}

reviewFix();
