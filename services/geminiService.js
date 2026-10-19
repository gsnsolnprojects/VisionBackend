const { GoogleGenerativeAI } = require('@google/generative-ai');

/**
 * Gemini Service
 *
 * Talks to Google Gemini API to generate answers.
 * Exposes a unified interface:
 *   askGemini(question, context, source) -> Promise<string>
 */

const API_KEY = process.env.GEMINI_API_KEY;
const MODEL_NAME = process.env.GEMINI_MODEL || 'gemini-pro';
const TEMPERATURE = parseFloat(process.env.GEMINI_TEMPERATURE || '0.2');
// Answers are short explanations; a large limit only makes slow answers that the live
// setup (CloudFront, 60 s per request) cuts off. Capped whatever GEMINI_MAX_TOKENS says.
const MAX_TOKENS = Math.min(parseInt(process.env.GEMINI_MAX_TOKENS || '2048', 10) || 2048, 4096);
// Give up before CloudFront's 60 s limit so the user gets a clear message instead of a timeout
const GEMINI_TIMEOUT_MS = 45000;

let genAI = null;
if (API_KEY) {
  try {
    genAI = new GoogleGenerativeAI(API_KEY);
  } catch (error) {
    console.error('Failed to initialize Gemini client:', error.message || error);
  }
}

function buildPrompt(source, question, context) {
  const safeQuestion = (question || '').trim();

  const commonInstructions = [
    'You are an AI assistant helping a non-technical user.',
    'Explain concepts in simple, clear language.',
    'Do NOT suggest code changes or API calls.',
    'Do NOT modify any system state.',
    'Answer in plain text only (no markdown, no code blocks).'
  ].join(' ');

  if (source === 'training_details') {
    const {
      epochs,
      batchSize,
      imageSize,
      mAP,
      precision,
      recall,
      loss,
      device,
      numClasses
    } = context || {};

    return [
      commonInstructions,
      '',
      'Context about the trained model (read-only):',
      `- Epochs: ${epochs ?? 'unknown'}`,
      `- Batch Size: ${batchSize ?? 'unknown'}`,
      `- Image Size: ${imageSize ?? 'unknown'}`,
      `- mAP: ${mAP ?? 'unknown'}`,
      `- Precision: ${precision ?? 'unknown'}`,
      `- Recall: ${recall ?? 'unknown'}`,
      `- Loss: ${loss ?? 'unknown'}`,
      `- Device: ${device ?? 'unknown'}`,
      `- Number of Classes: ${numClasses ?? 'unknown'}`,
      '',
      'User question:',
      safeQuestion
    ].join('\n');
  }

  if (source === 'training_config') {
    const {
      datasetSize,
      numClasses,
      avgImageResolution,
      hardware
    } = context || {};

    return [
      commonInstructions,
      '',
      'Context about the dataset and hardware (read-only):',
      `- Dataset Size: ${datasetSize ?? 'unknown'}`,
      `- Number of Classes: ${numClasses ?? 'unknown'}`,
      `- Average Image Resolution: ${avgImageResolution ?? 'unknown'}`,
      `- Hardware: ${hardware ?? 'unknown'}`,
      '',
      'User question:',
      safeQuestion
    ].join('\n');
  }

  // Fallback: generic prompt
  return [
    commonInstructions,
    '',
    'Context (raw JSON):',
    JSON.stringify(context || {}, null, 2),
    '',
    'User question:',
    safeQuestion
  ].join('\n');
}

function filterResponse(text) {
  if (!text || typeof text !== 'string') {
    return 'The AI response was empty or invalid.';
  }

  let cleaned = text;

  // Remove common markdown/code fencing
  cleaned = cleaned.replace(/```[\s\S]*?```/g, '');
  cleaned = cleaned.replace(/`/g, '');

  cleaned = cleaned.replace(/\s+\n/g, '\n').trim();

  const MAX_CHARS = 60000;
  if (cleaned.length > MAX_CHARS) {
    cleaned = cleaned.slice(0, MAX_CHARS) + '...';
  }

  return cleaned;
}

/**
 * Ask Gemini a question with context.
 *
 * @param {string} question - User question
 * @param {object} context - Read-only context object
 * @param {string} source - "training_details" | "training_config" | other
 * @returns {Promise<string>} - Answer text
 */
async function askGemini(question, context, source) {
  if (!API_KEY || !genAI) {
    throw new Error('Gemini API is not configured. Please set GEMINI_API_KEY.');
  }

  const prompt = buildPrompt(source, question, context);

  try {
    const model = genAI.getGenerativeModel({ model: MODEL_NAME });

    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout')), GEMINI_TIMEOUT_MS);
    });
    const result = await Promise.race([
      model.generateContent({
        contents: [
          {
            role: 'user',
            parts: [{ text: prompt }]
          }
        ],
        generationConfig: {
          temperature: TEMPERATURE,
          maxOutputTokens: MAX_TOKENS
        }
      }),
      timeout,
    ]).finally(() => clearTimeout(timer));

    const text = result?.response?.text?.() || '';
    return filterResponse(text);
  } catch (error) {
    console.error('Error calling Gemini:', error.message || error);
    if (error.message === 'timeout') {
      throw new Error('The AI took too long to answer. Please try again.');
    }
    throw new Error('Gemini is not available right now.');
  }
}

module.exports = {
  askGemini
};

