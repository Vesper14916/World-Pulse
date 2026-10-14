import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve } from 'node:path';

export const AI_ENV_KEYS = [
  'LLM_API_URL',
  'LLM_MODEL',
  'LLM_API_KEY',
  'LLM_INPUT_PRICE_PER_MILLION',
  'LLM_OUTPUT_PRICE_PER_MILLION',
] as const;

export interface PublicAIConfig {
  apiUrl: string;
  model: string;
  inputPricePerMillion: number | null;
  outputPricePerMillion: number | null;
  keyConfigured: boolean;
}

export function validChatCompletionsUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) return undefined;
  try {
    const url = new URL(value.trim());
    if (url.username || url.password || url.hash) return undefined;
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname)))
      return undefined;
    if (!url.pathname.replace(/\/+$/, '').toLowerCase().endsWith('/chat/completions'))
      return undefined;
    for (const key of url.searchParams.keys())
      if (/(?:api.?key|token|secret|password|authorization|credential)/i.test(key))
        return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

function isLoopback(hostname: string): boolean {
  return ['localhost', '127.0.0.1', '[::1]'].includes(hostname.toLowerCase());
}

export function parseTokenPrice(value: unknown): number | null {
  if (value === undefined || value === null || value === '') return null;
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= 100_000 ? parsed : null;
}

export function aiConfigFromEnv(env: Record<string, string | undefined>): PublicAIConfig {
  return {
    apiUrl: validChatCompletionsUrl(env.LLM_API_URL) ?? '',
    model: env.LLM_MODEL?.trim() ?? '',
    inputPricePerMillion: parseTokenPrice(env.LLM_INPUT_PRICE_PER_MILLION),
    outputPricePerMillion: parseTokenPrice(env.LLM_OUTPUT_PRICE_PER_MILLION),
    keyConfigured: !!env.LLM_API_KEY?.trim(),
  };
}

/** Update only the AI keys in .env.local while preserving every unrelated local setting. */
export function writeLocalAIEnvironment(
  directory: string,
  env: Record<string, string | undefined>,
): void {
  const target = resolve(directory, '.env.local');
  if (existsSync(target)) {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink())
      throw new Error('The local environment file must be a regular file.');
  }
  let previous = '';
  try {
    previous = readFileSync(target, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const keys = new Set<string>(AI_ENV_KEYS);
  const lines = previous.split(/\r?\n/).filter((line) => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    return !match || !keys.has(match[1]!);
  });
  while (lines.length && lines.at(-1) === '') lines.pop();
  for (const key of AI_ENV_KEYS) {
    const value = env[key]?.trim();
    if (value) lines.push(`${key}=${JSON.stringify(value)}`);
  }
  const content = `${lines.join('\n')}\n`;
  const temporary = `${target}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporary, 'wx', 0o600);
    writeFileSync(descriptor, content, 'utf8');
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, target);
    chmodSync(target, 0o600);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporary);
    } catch {
      /* No temporary file was created. */
    }
    throw error;
  }
}
