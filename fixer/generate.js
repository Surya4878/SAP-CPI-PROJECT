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

  const issueContext = failureDetails.slice(0, 3).map((f, i) => `Error ${i + 1} [${f.guid}]:\n${f.error}`).join('\n\n');
  console.log(`[INFO] Found error logs:\n${issueContext.substring(0, 200)}...\n`);

  console.log(`[INFO] Syncing latest active version of ${artifactId} from CPI before fixing...`);
  try {
    const artifactMeta = db.prepare('SELECT type, version FROM artifacts WHERE source_id = ? AND deleted_at IS NULL').get(artifactId);
    if (artifactMeta && artifactMeta.type) {
      console.log(`[INFO] Force downloading version active (type: ${artifactMeta.type}) to ensure fix applies to latest code...`);
      await processArtifactDownload({ type: artifactMeta.type, source_id: artifactId, version: 'active' });
    } else {
      console.warn(`[WARN] No version found in DB for ${artifactId}, skipping pre-download.`);
    }
  } catch (err) {
    console.warn(`[WARN] Failed to download artifact before fixing (will use cached):`, err.message);
  }

  console.log(`[INFO] Fetching latest active content for ${artifactId} from artifact_versions...`);
  const row = db.prepare(`
    SELECT zip_content, inner_content_hash 
    FROM artifact_versions 
    WHERE artifact_id = ? 
    ORDER BY saved_at DESC 
    LIMIT 1
  `).get(artifactId);

  if (!row) {
    throw new GenerationFailedError(`No artifact versions found for ${artifactId}.`);
  }

  const errorSignature = failureDetails[0].error.split('\n')[0].trim().substring(0, 255);

  // 1. Check cache for an existing unapplied fix for THIS exact error on THIS exact code
  // CACHE DISABLED: Users need to be able to regenerate if the LLM guesses wrong.
  // const cachedFix = db.prepare(`
  //   SELECT * FROM generated_fixes 
  //   WHERE artifact_id = ? AND error_signature = ? AND original_content_hash = ? AND applied = 0
  //   ORDER BY generated_at DESC LIMIT 1
  // `).get(artifactId, errorSignature, row.inner_content_hash);

  // if (cachedFix) {
  //   console.log(`[INFO] Serving cached generated fix for ${artifactId} (instantly)`);
  //   return {
  //     fixId: cachedFix.id,
  //     artifactId,
  //     fixType: cachedFix.fix_type,
  //     explanation: cachedFix.explanation
  //   };
  // }

  const zip = new AdmZip(row.zip_content);
  let targetScriptPath = null;
  let originalScript = null;
  let iflwPath = null;
  let originalIflw = null;

  let valueMappingPath = null;
  let originalValueMapping = null;

  for (const entry of zip.getEntries()) {
    if (entry.entryName.endsWith('.groovy')) {
      targetScriptPath = entry.entryName;
      originalScript = zip.readAsText(entry);
    }
    if (entry.entryName.endsWith('.iflw')) {
      iflwPath = entry.entryName;
      originalIflw = zip.readAsText(entry);
    }
    if (entry.entryName.endsWith('value_mapping.xml')) {
      valueMappingPath = entry.entryName;
      originalValueMapping = zip.readAsText(entry);
    }
  }

  if (!targetScriptPath && !iflwPath && !valueMappingPath) {
    throw new NeedsStructuralReviewError(`No .groovy, .iflw, or value_mapping.xml found in the artifact.`);
  }

  let finalOriginalContent, finalProposedContent, finalExplanation, finalConfidenceLevel;
  let finalErrorSummary = null, finalFixSummary = null, finalManualSteps = [];
  let fixType = 'groovy';
  let elementPath = null;
  let attributeName = null;

  // Decide which file to fix based on explicit heuristics
  const isGroovyError = targetScriptPath && (
    issueContext.includes('ScriptException') || 
    issueContext.includes('.groovy') || 
    issueContext.includes('MultipleCompilationErrorsException') ||
    (!iflwPath && !valueMappingPath) // Fallback if NO xml files exist
  );

  const isValueMappingError = valueMappingPath && !isGroovyError && (
    issueContext.includes('value mapping') || 
    issueContext.includes('ValueMapping') ||
    (!iflwPath) // If there is no iflw, it must be the value mapping
  );

  // Fetch enriched context
  const parsedMetaRow = db.prepare(`SELECT parsed_json FROM parsed_metadata WHERE artifact_id = ? ORDER BY parsed_at DESC LIMIT 1`).get(artifactId);
  const parsedMetaText = parsedMetaRow ? parsedMetaRow.parsed_json : "No parsed metadata available.";
  
  const reviewsRow = db.prepare(`SELECT summary, issues_json FROM reviews WHERE artifact_id = ? ORDER BY reviewed_at DESC LIMIT 1`).get(artifactId);
  const reviewsText = reviewsRow ? `Summary: ${reviewsRow.summary}\nIssues: ${reviewsRow.issues_json}` : "No prior review findings available.";

  // Build a plaintext summary of all known adapter addresses from parsed metadata.
  // This is highlighted at the top of the LLM prompt so the model can cross-reference the error hostname
  // against the exact value in the XML without digging through 26k characters.
  let adapterContextText = '';
  try {
    if (parsedMetaRow && parsedMetaRow.parsed_json) {
      const meta = JSON.parse(parsedMetaRow.parsed_json);
      if (meta.adapters && meta.adapters.length > 0) {
        const lines = meta.adapters
          .filter(a => a.type || a.address)
          .map(a => {
            let line = `- ${a.type || 'Unknown'} (${a.direction || 'Unknown'})`;
            if (a.address) line += `: ${a.address}`;
            if (a.config && a.config.method) line += ` [${a.config.method}]`;
            if (a.config && a.config.auth) line += ` auth: ${a.config.auth}`;
            return line;
          });
        adapterContextText = lines.join('\n');
      }
    }
  } catch (e) {
    console.warn('[WARN] Failed to build adapter context text:', e.message);
  }

  let finalCurrentValue = null;
  let finalProposedValue = null;

  if (isGroovyError) {
    console.log(`[INFO] Error appears to be in Groovy script: ${targetScriptPath}. Requesting Groovy fix from LLM...`);

    const prompt = `You are an expert Groovy script fixer for SAP CPI.
The following Groovy script is causing an error in production.

Error Log:
${issueContext}

Surrounding Artifact Context (Parsed Metadata):
${parsedMetaText}

Prior Review Findings for this Artifact:
${reviewsText}

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
    fixType = 'groovy';
    // Groovy: no currentValue/proposedValue (full-file replace, not value substitution)

  } else if (isValueMappingError) {
    console.log(`[INFO] Error appears to be related to Value Mapping. Target: ${valueMappingPath}. Requesting XML value fix from LLM...`);
    const xmlFixResult = await generateValueFixForXml(originalValueMapping, issueContext, parsedMetaText, reviewsText, adapterContextText);
    
    finalOriginalContent = originalValueMapping;
    finalProposedContent = xmlFixResult.proposedContent;
    finalExplanation = xmlFixResult.explanation;
    finalConfidenceLevel = xmlFixResult.confidenceLevel;
    finalErrorSummary = xmlFixResult.errorSummary || 'A configuration value error was detected in the value mapping XML.';
    finalFixSummary = xmlFixResult.fixSummary || finalExplanation;
    finalManualSteps = xmlFixResult.manualSteps || [];
    fixType = 'xml_value';
    elementPath = xmlFixResult.elementPath;
    attributeName = xmlFixResult.attributeName;
    targetScriptPath = valueMappingPath;
    finalCurrentValue = xmlFixResult.currentValue;
    finalProposedValue = xmlFixResult.proposedValue;

  } else if (iflwPath) {
    console.log(`[INFO] Error appears to be XML-related. Target: ${iflwPath}. Requesting XML value fix from LLM...`);
    const xmlFixResult = await generateValueFixForXml(originalIflw, issueContext, parsedMetaText, reviewsText, adapterContextText);
    
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
    targetScriptPath = iflwPath;
    finalCurrentValue = xmlFixResult.currentValue;
    finalProposedValue = xmlFixResult.proposedValue;

  } else {
    throw new NeedsStructuralReviewError(`Cannot determine a valid file to fix (.groovy or .iflw missing).`);
  }

  console.log(`[SUCCESS] Fix generated with ${finalConfidenceLevel} confidence.`);
  
  // Save to database
  const insertStmt = db.prepare(`
    INSERT INTO generated_fixes (
      artifact_id, issue_context, error_signature, original_content_hash, original_content, proposed_content, explanation, confidence_level, fix_type, element_path, attribute_name, error_summary, fix_summary, manual_steps, target_file_path, current_value, proposed_value
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  insertStmt.run(
    artifactId,
    issueContext,
    errorSignature,
    row.inner_content_hash,
    finalOriginalContent,
    finalProposedContent,
    finalExplanation,
    finalConfidenceLevel,
    fixType,
    elementPath,
    attributeName,
    finalErrorSummary,
    finalFixSummary,
    JSON.stringify(finalManualSteps || []),
    targetScriptPath,
    finalCurrentValue,
    finalProposedValue
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
