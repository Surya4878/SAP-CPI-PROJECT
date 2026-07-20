require('dotenv').config();
const axios = require('axios');
const db = require('../database/index');

// Lightweight retry wrapper for the OpenRouter call
// max429Retries: separate budget for rate-limit retries (free tier 429s are common)
// maxRetries: budget for other transient errors
async function fetchFromLLMWithRetry(messages, maxRetries = 2, max429Retries = 4) {
  const modelName = (process.env.MODEL_NAME || 'meta/llama-3.3-70b-instruct').trim();
  const apiKey = (process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
  const apiUrl = (process.env.LLM_API_URL || 'https://integrate.api.nvidia.com/v1/chat/completions').trim();
  
  let attempt = 0;
  let attempt429 = 0;

  while (true) {
    try {
      const response = await axios.post(
        apiUrl,
        {
          model: modelName,
          messages: messages,
          temperature: 0.1,
          max_tokens: 2000
        },
        {
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          timeout: 120000 // 120s timeout
        }
      );

      const content = response.data.choices[0].message.content;
      return content;
    } catch (err) {
      if (err.response && err.response.status === 429) {
        attempt429++;
        if (attempt429 > max429Retries) {
          throw new Error(`LLM API rate-limited after ${max429Retries} retries (429). Try again later.`);
        }
        const waitSecs = attempt429 * 5;
        console.warn(`[Reviewer] LLM API 429 Too Many Requests. Retrying in ${waitSecs}s... (attempt ${attempt429}/${max429Retries})`);
        await new Promise(resolve => setTimeout(resolve, waitSecs * 1000));
        continue;
      }
      attempt++;
      if (attempt > maxRetries) {
        throw new Error(`LLM API failed after ${maxRetries} retries: ${err.message}`);
      }
      console.warn(`[Reviewer] LLM API error: ${err.message}. Retrying (${attempt}/${maxRetries})...`);
    }
  }
}

async function runReview(contextBundleString, contentHash, artifactId) {
  const apiKey = (process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '').trim();
  const modelName = (process.env.MODEL_NAME || 'meta/llama-3.3-70b-instruct').trim();

  if (!apiKey) {
    throw new Error('LLM_API_KEY (or OPENROUTER_API_KEY) is missing from .env');
  }

  // 1. Check Cache
  const cached = db.prepare(`
    SELECT verdict, issues_json, summary, model_used 
    FROM reviews 
    WHERE artifact_id = ? AND content_hash = ?
  `).get(artifactId, contentHash);

  if (cached) {
    return {
      verdict: cached.verdict,
      issues: JSON.parse(cached.issues_json),
      summary: cached.summary,
      modelUsed: cached.model_used,
      fromCache: true
    };
  }

  // 2. Prepare prompt
  const systemPrompt = `You are an expert SAP CPI architecture reviewer. Your task is to analyze the structural metadata and runtime status of an iFlow and identify architectural or operational risks.

CRITICAL CONSTRAINTS:
1. You do not have the source code. You are reviewing structural metadata (adapters, steps) and runtime logs. Do not suggest fixing code lines.
2. You MUST return ONLY valid JSON matching this exact schema. No markdown fences like \`\`\`json. No preamble.
{
  "verdict": "OK" | "NEEDS_ATTENTION" | "HIGH_RISK",
  "issues": [
    { "category": "string", "severity": "LOW"|"MEDIUM"|"HIGH", "description": "string", "suggestedAction": "string" }
  ],
  "summary": "string"
}

REVIEW CATEGORIES TO FOCUS ON:
- Error Handling: Missing Exception Subprocess on external calls.
- Security: Adapters with no apparent authentication configuration (e.g. basic, oauth2).
- Blast Radius: High downstream caller count without safeguards.
- Loops: Self-referential loops or JMS cyclic chains without visible termination conditions.
- Runtime Failures: If the context includes recent failure logs (e.g. NullPointerException), you MUST explicitly address the actual error text in an issue and relate it to the structural metadata. Do not give generic advice like "add error handling" if you have a real stacktrace. Point out where the NPE likely originated based on the steps provided.`;

  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Context bundle for iFlow ${artifactId}:\n${contextBundleString}` }
  ];

  // 3. Make LLM Call & JSON Retry Logic
  let rawContent;
  let parsedJson;
  let parseSuccess = false;
  let jsonAttempt = 0;

  while (jsonAttempt < 2 && !parseSuccess) {
    rawContent = await fetchFromLLMWithRetry(messages);
    
    // Clean up potential markdown fences if the model still outputs them despite instructions
    let cleanedContent = rawContent.trim();
    if (cleanedContent.startsWith('```json')) cleanedContent = cleanedContent.slice(7);
    if (cleanedContent.startsWith('```')) cleanedContent = cleanedContent.slice(3);
    if (cleanedContent.endsWith('```')) cleanedContent = cleanedContent.slice(0, -3);
    cleanedContent = cleanedContent.trim();

    try {
      parsedJson = JSON.parse(cleanedContent);
      if (!parsedJson.verdict || !Array.isArray(parsedJson.issues) || typeof parsedJson.summary !== 'string') {
        throw new Error('JSON missing required schema keys');
      }
      parseSuccess = true;
    } catch (err) {
      jsonAttempt++;
      if (jsonAttempt < 2) {
        console.warn(`[Reviewer] Model returned malformed JSON, retrying. (Error: ${err.message})`);
        messages.push({ role: 'assistant', content: rawContent });
        messages.push({ role: 'user', content: 'You failed to return valid JSON matching the schema. Do not include markdown fences, preambles, or conversational text. Return ONLY a valid JSON object matching the exact schema provided.' });
      } else {
        console.error(`[Reviewer] Failed to parse LLM output after retry. Raw output:\n${rawContent}`);
        throw new Error(`Failed to parse valid JSON from model ${modelName}`);
      }
    }
  }

  // 4. Save to Cache
  db.prepare(`
    INSERT INTO reviews (artifact_id, model_used, content_hash, verdict, issues_json, summary)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(artifactId, modelName, contentHash, parsedJson.verdict, JSON.stringify(parsedJson.issues), parsedJson.summary);

  return {
    verdict: parsedJson.verdict,
    issues: parsedJson.issues,
    summary: parsedJson.summary,
    modelUsed: modelName,
    fromCache: false
  };
}

async function generateExplanation(contextBundleString, artifactId) {
  const systemPrompt = `You are an expert SAP Cloud Integration (CPI) architect explaining an integration flow to a technical team lead. Write in clear, fluent natural language — avoid jargon dumps and bullet-only lists.

STRUCTURE YOUR EXPLANATION LIKE THIS:
## What This Flow Does
One or two plain-English sentences describing the business purpose of the flow.

## How It Works (Step by Step)
Walk through the main processing steps in the order they execute. Use a numbered list and describe each step in plain English — what data it receives, what transformation or action it performs, and what it passes on.

## Systems Involved
List the source system(s) and target system(s) the flow connects. Include adapter types (HTTP, SFTP, JMS, JDBC, etc.) and any external APIs.

## Notable Design Patterns
Highlight anything interesting or complex: Groovy scripts (describe what they do), splitters/aggregators, looping process calls, exception subprocesses, or value mappings.

## Current Health Status
Based on the runtime logs and error info in the context, describe in plain English what is currently going wrong (if anything), or confirm the flow is healthy.

CRITICAL RULES:
- Write in natural narrative sentences, not raw bullet dumps.
- If runtime errors are present, translate the technical stack trace into a plain-English sentence that a non-developer could understand.
- Keep total length under 500 words.
- Your response should be ONLY the Markdown text. No preamble, no code fences.`;

  const messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Artifact Context Bundle:\n${contextBundleString}` }
  ];

  console.log(`[Explain] Requesting explanation for ${artifactId} from LLM...`);
  const explanation = await fetchFromLLMWithRetry(messages);
  console.log(`[Explain] Explanation generated successfully.`);
  
  return explanation;
}

module.exports = {
  runReview,
  fetchFromLLMWithRetry,
  generateExplanation
};
