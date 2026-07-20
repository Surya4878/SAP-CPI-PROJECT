const { fetchFromLLMWithRetry } = require('../reviewer/llm');
const { NeedsStructuralReviewError, GenerationFailedError } = require('../orchestrator/errors');
const { validateStructuralIntegrity } = require('./validateStructuralIntegrity');

/**
 * Attempts to generate a targeted value-level fix for an .iflw XML file based on an error log.
 * @param {string} originalXml The raw XML of the .iflw file
 * @param {string} issueContext The error string to provide to the LLM
 * @returns {object} { proposedContent, explanation, confidenceLevel, elementPath, attributeName }
 * @throws {NeedsStructuralReviewError} if it cannot uniquely identify the value or if the LLM proposes a structural change
 * @throws {GenerationFailedError} if LLM generation fails entirely
 */
async function generateValueFixForXml(originalXml, issueContext) {
  const prompt = `You are an expert SAP CPI integration flow (.iflw XML) fixer.
The following integration flow is failing in production.

Error Log:
${issueContext}

Original .iflw XML:
${originalXml}

Instructions:
1. Identify the SINGLE attribute value in the XML that is likely incorrect based on the error.
2. Provide a dot-separated elementPath corresponding to the parsed JSON structure for display purposes (e.g., bpmn2:definitions.bpmn2:process.bpmn2:sendTask.0).
3. Provide the attributeName that needs changing.
4. Provide the exact currentValue of that attribute as it appears in the XML.
5. Provide the proposedValue to fix the error.

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
  
  console.log(`[INFO] LLM Output: attributeName="${attributeName}", currentValue="${currentValue}", proposedValue="${proposedValue}"`);

  let targetPattern = "";
  let targetReplacement = "";
  let matchCount = 0;

  // Sometimes the LLM says attributeName="value" for <value>content</value>
  if (attributeName === '_text' || !attributeName || attributeName === 'value') {
    // Check if it's text content inside <value> or just any text content
    const textPattern = `>${currentValue}<`;
    const textCount = originalXml.split(textPattern).length - 1;
    
    if (textCount === 1) {
      targetPattern = textPattern;
      targetReplacement = `>${proposedValue}<`;
      matchCount = textCount;
    }
  }
  
  if (matchCount === 0 && attributeName && attributeName !== '_text' && attributeName !== 'value') {
    // Check as attribute
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
    const textPattern = `>${currentValue}<`;
    const textCount = originalXml.split(textPattern).length - 1;
    if (textCount === 1) {
      targetPattern = textPattern;
      targetReplacement = `>${proposedValue}<`;
      matchCount = textCount;
    }
  }
  
  if (matchCount !== 1) {
    throw new NeedsStructuralReviewError(`Cannot safely apply value fix. The pattern for value "${currentValue}" (attr: ${attributeName}) matched ${matchCount} times.`);
  }
  
  const proposedContent = originalXml.replace(targetPattern, targetReplacement);
  
  // Verify structural integrity mechanically
  if (!validateStructuralIntegrity(originalXml, proposedContent)) {
    throw new NeedsStructuralReviewError(`The proposed XML value fix failed structural validation.`);
  }

  return {
    proposedContent,
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
