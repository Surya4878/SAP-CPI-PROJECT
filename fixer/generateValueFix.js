const { fetchFromLLMWithRetry } = require('../reviewer/llm');
const { NeedsStructuralReviewError, GenerationFailedError } = require('../orchestrator/errors');
const { validateStructuralIntegrity } = require('./validateStructuralIntegrity');

/**
 * Attempts to generate a targeted value-level fix for an .iflw XML file based on an error log.
 * @param {string} originalXml The raw XML of the .iflw file
 * @param {string} issueContext The error string to provide to the LLM
 * @param {string} parsedMetaText Stringified parsed metadata JSON
 * @param {string} reviewsText Prior review findings
 * @param {string} adapterContextText Pre-formatted list of known adapter endpoints (optional)
 * @returns {object} { proposedContent, currentValue, proposedValue, targetPattern, targetReplacement, explanation, confidenceLevel, elementPath, attributeName }
 * @throws {NeedsStructuralReviewError} if it cannot uniquely identify the value or if the LLM proposes a structural change
 * @throws {GenerationFailedError} if LLM generation fails entirely
 */
async function generateValueFixForXml(originalXml, issueContext, parsedMetaText, reviewsText, adapterContextText) {
  const prompt = `You are an expert SAP CPI XML configuration fixer.
The following XML (either an .iflw integration flow or a value_mapping.xml) is failing in production.

Error Log:
${issueContext}

${adapterContextText ? `=== KNOWN ADAPTER ENDPOINTS (Cross-reference these against the error) ===\n${adapterContextText}\n` : ''}
Surrounding Artifact Context (Parsed Metadata):
${parsedMetaText || 'Not available'}

Prior Review Findings for this Artifact:
${reviewsText || 'Not available'}

Original XML:
${originalXml}

Instructions:
1. Identify the SINGLE attribute value or text node in the XML that is likely incorrect based on the error.
2. In an .iflw file, this might be an adapter address, a Content Modifier property, header, or exchange property. In a value_mapping.xml, it might be a mapping value or agency name.
3. IMPORTANT: If the error mentions a hostname or URL (like "api.coinbase.m"), look at the === KNOWN ADAPTER ENDPOINTS === section above — the wrong URL is likely listed there.
4. IMPORTANT: If the error is a generic deployment error (like "CAMEL_CONTEXT_NOT_STARTED" or "InstanceError"), this usually means SAP CPI is hiding a syntax error. You MUST thoroughly scan the XML for obvious typos or malformed expressions (e.g., misspelled dynamic properties like \${dat:now} instead of \${date:now}, or \${property.ate} instead of \${property.date}, or unclosed brackets). The currentValue must be the exact text to replace.
5. Provide a dot-separated elementPath corresponding to the parsed JSON structure for display purposes (e.g., bpmn2:definitions.bpmn2:process.bpmn2:sendTask.0).
6. Provide the attributeName that needs changing (use "_text" if it's the inner text of an element like <value>).
7. Provide the exact currentValue of that attribute as it appears in the XML.
8. Provide the proposedValue to fix the error.

You must respond with ONLY a valid JSON object matching this exact schema, with absolutely no markdown formatting or extra text:
{
  "elementPath": "string",
  "attributeName": "string",
  "currentValue": "string",
  "proposedValue": "string",
  "errorSummary": "Plain-English 1-2 sentence explanation of what went wrong and why, suitable for a non-developer.",
  "fixSummary": "Plain-English 1-2 sentence explanation of exactly what will be changed and why it fixes the problem.",
  "manualSteps": [],
  "explanation": "brief technical explanation",
  "confidenceLevel": "HIGH"
}`;

  let jsonResult = null;
  let attempts = 0;
  
  while (attempts < 2 && !jsonResult) {
    attempts++;
    console.log(`[INFO] XML Value Fix LLM Attempt ${attempts}...`);
    try {
      const messages = [{ role: 'user', content: prompt }];
      const rawResponse = await fetchFromLLMWithRetry(messages, 2, 4);
      const cleanResponse = rawResponse.replace(/```json/g, '').replace(/```/g, '').trim();
      jsonResult = JSON.parse(cleanResponse);
      
      if (!jsonResult.attributeName || !jsonResult.currentValue || !jsonResult.proposedValue) {
        throw new Error("Missing required fields in LLM response.");
      }
    } catch (err) {
      console.warn(`[WARN] XML Value Fix LLM Attempt ${attempts} failed to produce valid JSON:`, err.message);
      if (attempts >= 2) {
        throw new GenerationFailedError(`Failed to generate a valid XML fix after 2 attempts.`);
      }
    }
  }

  const { attributeName, currentValue, proposedValue, elementPath, explanation, confidenceLevel } = jsonResult;
  
  if (currentValue === undefined || currentValue === null || currentValue.trim() === '') {
    throw new NeedsStructuralReviewError(`Cannot safely apply value fix. The LLM provided an empty currentValue, which cannot be safely targeted via string replacement.`);
  }

  console.log(`[INFO] LLM Output: attributeName="${attributeName}", currentValue="${currentValue}", proposedValue="${proposedValue}"`);

  let targetPattern = "";
  let targetReplacement = "";
  let matchCount = 0;

  // Sometimes the LLM says attributeName="value" for <value>content</value>
  if (attributeName === '_text' || !attributeName || attributeName === 'value') {
    const textPattern = `>${currentValue}<`;
    const textCount = originalXml.split(textPattern).length - 1;
    
    if (textCount === 1) {
      targetPattern = textPattern;
      targetReplacement = `>${proposedValue}<`;
      matchCount = textCount;
    }
  }
  
  if (matchCount === 0 && attributeName && attributeName !== '_text' && attributeName !== 'value') {
    const searchPattern1 = `${attributeName}="${currentValue}"`;
    const searchPattern2 = `${attributeName}='${currentValue}'`;
    
    const count1 = originalXml.split(searchPattern1).length - 1;
    const count2 = originalXml.split(searchPattern2).length - 1;
    
    if (count1 === 1) {
      targetPattern = searchPattern1;
      targetReplacement = `${attributeName}="${proposedValue}"`;
      matchCount = count1;
    } else if (count2 === 1) {
      targetPattern = searchPattern2;
      targetReplacement = `${attributeName}='${proposedValue}'`;
      matchCount = count2;
    }
  }

  // Fallback: the LLM might have named the 'key' (like 'httpAddressWithoutQuery') as the attributeName,
  // while the actual value is stored in a <value> tag. If we haven't found a match yet,
  // let's just see if >currentValue< is globally unique in the file.
  if (matchCount === 0) {
    const fallbackPatterns = [
      { p: `>${currentValue}<`, r: `>${proposedValue}<` },
      { p: `>"${currentValue}"<`, r: `>"${proposedValue}"<` },
      { p: `>'${currentValue}'<`, r: `>'${proposedValue}'<` }
    ];
    
    for (const { p, r } of fallbackPatterns) {
      const count = originalXml.split(p).length - 1;
      if (count === 1) {
        targetPattern = p;
        targetReplacement = r;
        matchCount = 1;
        break;
      }
    }

    if (matchCount === 0) {
      const rawCount = originalXml.split(currentValue).length - 1;
      if (rawCount === 1) {
        targetPattern = currentValue;
        targetReplacement = proposedValue;
        matchCount = 1;
      }
    }
  }
  
  if (matchCount !== 1) {
    throw new NeedsStructuralReviewError(`Cannot safely apply value fix. The pattern for value "${currentValue}" (attr: ${attributeName}) matched ${matchCount} times.`);
  }
  
  if (targetPattern === '><') {
    throw new NeedsStructuralReviewError(`Cannot safely apply value fix. The target pattern resolved to '><', which is structurally unsafe for replacement.`);
  }
  
  const proposedContent = originalXml.replace(targetPattern, targetReplacement);
  
  // Verify structural integrity mechanically at generation time
  if (!validateStructuralIntegrity(originalXml, proposedContent)) {
    throw new NeedsStructuralReviewError(`The proposed XML value fix failed structural validation.`);
  }

  return {
    proposedContent,
    // Return the precise patch pair so apply.js can safely re-derive against fresh content
    currentValue,
    proposedValue,
    targetPattern,     // exact string that was replaced in the XML
    targetReplacement, // exact string it was replaced with
    explanation,
    confidenceLevel,
    elementPath,
    attributeName: attributeName || '_text',
    errorSummary: jsonResult.errorSummary || null,
    fixSummary: jsonResult.fixSummary || explanation,
    manualSteps: jsonResult.manualSteps || []
  };
}

module.exports = {
  generateValueFixForXml
};
