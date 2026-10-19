/**
 * Public LLM utilities module.
 *
 * Provides:
 * - OpenAI-compatible Chat Completions client with vision, queuing, and retries
 * - Structured JSON extraction, fence stripping, Zod decoding, and repair turns
 * - Gateway connectivity and curl diagnostic testing
 */

export * from './types.js';
export * from './client.js';
export * from './json.js';
export * from './json-chat.js';
export * from './verify.js';
