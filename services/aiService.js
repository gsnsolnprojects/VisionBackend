const { askOllama } = require('./ollamaService');
const { askGemini } = require('./geminiService');

/**
 * AI Service Router
 *
 * Provides a single entry point for asking AI, and routes
 * the request to the selected provider (ollama or gemini).
 */

/**
 * Ask AI using selected provider.
 *
 * @param {string} provider - 'ollama' | 'gemini'
 * @param {string} question - User question
 * @param {object} context - Read-only context snapshot
 * @param {string} source - 'training_details' | 'training_config'
 * @returns {Promise<{success: boolean, answer: string, provider: string}>}
 */
async function askAI(provider, question, context, source) {
  const selectedProvider = provider || process.env.AI_DEFAULT_PROVIDER || 'ollama';

  try {
    let answer;

    if (selectedProvider === 'ollama') {
      answer = await askOllama(question, context, source);
    } else if (selectedProvider === 'gemini') {
      answer = await askGemini(question, context, source);
    } else {
      throw new Error(`Invalid provider: ${selectedProvider}. Must be 'ollama' or 'gemini'.`);
    }

    return {
      success: true,
      answer,
      provider: selectedProvider
    };
  } catch (error) {
    console.error('AI provider error:', {
      provider: selectedProvider,
      message: error.message || error
    });

    const safeProvider = selectedProvider || 'unknown';

    const tookTooLong = String(error.message || '').startsWith('The AI took too long');
    return {
      success: false,
      answer: tookTooLong
        ? error.message
        : `The AI assistant (${safeProvider}) is currently unavailable. Please try again later.`,
      provider: safeProvider
    };
  }
}

module.exports = {
  askAI
};

