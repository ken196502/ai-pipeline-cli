import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const EnvConfigSchema = z.object({
  baseUrl: z.string().url(),
  apiKey: z.string().min(1),
  llmModel: z.string().min(1),
  vlModel: z.string().min(1),
  vlFallbackModel: z.string().optional(),
  imageModel: z.string().default('sensenova-u1-fast'),
  /** Text-protocol for LLM calls: OpenAI chat completions (default) or Responses API. */
  apiStyle: z.enum(['chat', 'responses']).default('chat'),
  /** Responses API reasoning effort (ignored on the chat path). */
  reasoningEffort: z.enum(['minimal', 'low', 'medium', 'high']).default('minimal'),
});
export type EnvConfig = z.infer<typeof EnvConfigSchema>;

/**
 * Parses simple key=value pairs from a .env file content
 */
function parseEnvFile(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eqIdx = trimmed.indexOf('=');
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    result[key] = value;
  }
  return result;
}

/**
 * Resolves candidate .env file locations (local, module root, or shared sibling VideoGen).
 */
function resolveEnvCandidates(): string[] {
  const candidates: string[] = [
    path.resolve(process.cwd(), '.env'),
  ];
  try {
    const dir = typeof __dirname !== 'undefined' ? __dirname : path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(dir, '../../.env'));
    candidates.push(path.resolve(dir, '../.env'));
  } catch {}
  candidates.push(path.resolve(process.cwd(), '../VideoGen/.env'));
  return candidates;
}

/**
 * Loads .env file into process.env if present
 */
export function loadEnvFile(specifiedPath?: string): void {
  try {
    const pathsToTry = specifiedPath ? [specifiedPath] : resolveEnvCandidates();
    for (const envPath of pathsToTry) {
      if (fs.existsSync(envPath)) {
        const content = fs.readFileSync(envPath, 'utf-8');
        const parsed = parseEnvFile(content);
        for (const [key, value] of Object.entries(parsed)) {
          if (!process.env[key]) {
            process.env[key] = value;
          }
        }
        break;
      }
    }
  } catch {
    // Ignore if unreadable
  }
}

/**
 * Gets and validates current environment configuration
 */
export function getEnvConfig(): EnvConfig {
  loadEnvFile();

  return EnvConfigSchema.parse({
    baseUrl: process.env.BASE_URL || 'https://ai.reluv.xyz/v1',
    apiKey: process.env.API_KEY || '',
    llmModel: process.env.LLM_MODEL || 'gemini-3.6-flash',
    vlModel: process.env.VL_MODEL || 'gemini-3.6-flash',
    vlFallbackModel: process.env.VL_FALLBACK_MODEL || undefined,
    imageModel: process.env.IMAGE_MODEL || 'sensenova-u1-fast',
    apiStyle: (process.env.LLM_API_STYLE as 'chat' | 'responses' | undefined) || 'chat',
    reasoningEffort: (process.env.LLM_REASONING_EFFORT as 'minimal' | 'low' | 'medium' | 'high' | undefined) || 'minimal',
  });
}
