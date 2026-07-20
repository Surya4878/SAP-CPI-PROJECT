const fs = require('fs');
const db = require('../database');
const AdmZip = require('adm-zip');
const { getFailureDetails } = require('../logs/index');
const { fetchFromLLMWithRetry } = require('../reviewer/llm');
const { NeedsStructuralReviewError, GenerationFailedError } = require('../orchestrator/errors');
const { generateValueFixForXml } = require('./generateValueFix');
const queue = require('../queue');
const { processArtifactDownload } = require('../downloader/index');

async function generateFixForArtifact(artifactId, failureDetails = null) {
  if (!failureDetails) {
    console.log(`[INFO] Fetching real failure logs for ${artifactId}...`);
    failureDetails = await getFailureDetails(artifactId, { hours: 720, details: true, bypassCache: true });
  }
  
  if (!failureDetails || failureDetails.length === 0) {
    throw new GenerationFailedError(`No recent failure logs found for ${artifactId}.`);
  }

  const issueContext = failureDetails[0].error;
  console.log(`[INFO] Found error log:\n${issueContext.substring(0, 200)}...\n`);

  console.log(`[INFO] Syncing latest active version of ${artifactId} from CPI before fixing...`);
  try {
    const artifactMeta = db.prepare('SELECT type, version FROM artifacts WHERE source_id = ? AND deleted_at IS NULL').get(artifactId);
    if (artifactMeta && artifactMeta.version) {
      console.log(`[INFO] Force downloading version ${artifactMeta.version} (type: ${artifactMeta.type}) to ensure fix applies to latest code...`);
      await processArtifactDownload({ type: artifactMeta.type, source_id: artifactId, version: artifactMeta.version });
    } else {
      console.warn(`[WARN] No version found in DB for ${artifactId}, skipping pre-download.`);
    }
  } catch (err) {
    console.warn(`[WARN] Failed to download artifact before fixing (will use cached):`, err.message);
  }

  console.log(`[INFO] Fetching latest active content for ${artifactId} from artifact_versions...`);
  const row = db.prepare(`
    SELECT zip_content, content_hash 
    FROM artifact_versions 
    WHERE artifact_id = ? 
    ORDER BY saved_at DESC 
    LIMIT 1
  `).get(artifactId);

  if (!row) {
    throw new GenerationFailedError(`No artifact versions found for ${artifactId}.`);
  }

  const zip = new AdmZip(row.zip_content);
  let targetScriptPath = null;
  let originalScript = null;
  let iflwPath = null;
  let originalIflw = null;

  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith('.groovy')) {
      targetScriptPath = entry.entryName;
      originalScript = zip.readAsText(entry);
    }
    if (entry.entryName.endsWith('.iflw')) {
      iflwPath = entry.entryName;
      originalIflw = zip.readAsText(entry);
    }
  }

  if (!targetScriptPath && !iflwPath) {
    throw new NeedsStructuralReviewError(`No .groovy script or .iflw XML found in the artifact.`);
  }

  let finalOriginalContent, finalProposedContent, finalExplanation, finalConfidenceLevel;
  let finalErrorSummary = null, finalFixSummary = null, finalManualSteps = [];
  let fixType = 'groovy';
  let elementPath = null;
  let attributeName = null;

  if (targetScriptPath) {
    console.log(`[INFO] Found script: ${targetScriptPath}. Requesting Groovy fix from LLM...`);

  const prompt = `You are an expert Groovy script fixer for SAP CPI.
The following Groovy script is causing an error in production.

Error Log:
${issueContext}

Original Script:
${originalScript}

You must respond with ONLY a valid JSON object matching this exact schema, with absolutely no markdown formatting, no backticks, and no extra text outside the JSON:
{
  "originalContent": "the exact original script content provided above",
  "proposedContent": "the full new groovy script content with the fix applied",
  "errorSummary": "Plain-English 1-2 sentence explanation of what went wrong and why, suitable for a non-developer.",
  "fixSummary": "Plain-English 1-2 sentence explanation of exactly what you changed and why it fixes the problem.",
  "manualSteps": [],
  "explanation": "brief technical explanation of the bug and your fix",
  "confidenceLevel": "HIGH"
}`;

  let jsonResult = null;
  let attempts = 0;
  
  while (attempts < 2 && !jsonResult) {
    attempts++;
    console.log(`[INFO] LLM Attempt ${attempts}...`);
    try {
      const messages = [{ role: 'user', content: prompt }];
      const rawResponse = await fetchFromLLMWithRetry(messages, 2, 4);
      const cleanResponse = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      jsonResult = JSON.parse(cleanResponse);
      
      // Basic validation
      if (!jsonResult.proposedContent || !jsonResult.originalContent) {
        throw new Error("Missing required fields in LLM response.");
      }
    } catch (err) {
      console.warn(`[WARN] LLM Attempt ${attempts} failed to produce valid JSON:`, err.message);
      if (attempts >= 2) {
        throw new GenerationFailedError(`Failed to generate a valid fix after 2 attempts.`);
      }
    }
  }

    finalOriginalContent = originalScript;
    finalProposedContent = jsonResult.proposedContent;
    finalExplanation = jsonResult.explanation;
    finalConfidenceLevel = jsonResult.confidenceLevel;
    finalErrorSummary = jsonResult.errorSummary || 'A Groovy script error was detected.';
    finalFixSummary = jsonResult.fixSummary || finalExplanation;
    finalManualSteps = jsonResult.manualSteps || [];

  } else if (iflwPath) {
    console.log(`[INFO] No Groovy script found. Found XML: ${iflwPath}. Requesting XML value fix from LLM...`);
    
    // Will throw NeedsStructuralReviewError if structural change or not 1 exact match
    const xmlFixResult = await generateValueFixForXml(originalIflw, issueContext);
    
    finalOriginalContent = originalIflw;
    finalProposedContent = xmlFixResult.proposedContent;
    finalExplanation = xmlFixResult.explanation;
    finalConfidenceLevel = xmlFixResult.confidenceLevel;
    finalErrorSummary = xmlFixResult.errorSummary || 'A configuration value error was detected in the integration flow XML.';
    finalFixSummary = xmlFixResult.fixSummary || finalExplanation;
    finalManualSteps = xmlFixResult.manualSteps || [];
    fixType = 'xml_value';
    elementPath = xmlFixResult.elementPath;
    attributeName = xmlFixResult.attributeName;
  }

  console.log(`[SUCCESS] Fix generated with ${finalConfidenceLevel} confidence.`);
  
  // Save to database
  const insertStmt = db.prepare(`
    INSERT INTO generated_fixes (
      artifact_id, issue_context, error_signature, original_content_hash, original_content, proposed_content, explanation, confidence_level, fix_type, element_path, attribute_name, error_summary, fix_summary, manual_steps
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const errorSignature = issueContext.split('\n')[0].trim().substring(0, 255);

  insertStmt.run(
    artifactId,
    issueContext,
    errorSignature,
    row.content_hash,
    finalOriginalContent,
    finalProposedContent,
    finalExplanation,
    finalConfidenceLevel,
    fixType,
    elementPath,
    attributeName,
    finalErrorSummary,
    finalFixSummary,
    JSON.stringify(finalManualSteps || [])
  );

  console.log(`[INFO] Fix saved to database.`);
  console.log(`Next step: Run 'node fixer/review.js ${artifactId}' to view the diff.`);
  
  return {
    success: true,
    fixType,
    confidenceLevel: finalConfidenceLevel,
    errorSummary: finalErrorSummary,
    fixSummary: finalFixSummary,
    manualSteps: finalManualSteps,
    elementPath,
    attributeName
  };
}

if (require.main === module) {
  const artifactId = process.argv[2];
  if (!artifactId) {
    console.error("Usage: node fixer/generate.js <artifactId>");
    process.exit(1);
  }
  generateFixForArtifact(artifactId).catch(err => {
    if (err instanceof NeedsStructuralReviewError) {
      console.error(`[ABORT] ${err.message}`);
    } else {
      console.error(`[ERROR] ${err.message}`);
    }
    process.exit(1);
  });
}

module.exports = {
  generateFixForArtifact
};
