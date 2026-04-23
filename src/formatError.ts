import { AbortError } from './errors.js';

const MAX_ERROR_LENGTH = 10_000;
const HALF = 5_000;

export function formatError(error: unknown): string {
  if (error instanceof AbortError) {
    return error.message || 'Aborted';
  }
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts: string[] = [error.message];
  if ('stderr' in error && typeof error.stderr === 'string') {
    parts.push(error.stderr);
  }
  if ('stdout' in error && typeof error.stdout === 'string') {
    parts.push(error.stdout);
  }

  const full = parts.filter(Boolean).join('\n').trim() || 'Unknown error';
  if (full.length <= MAX_ERROR_LENGTH) return full;

  return (
    full.slice(0, HALF) +
    `\n\n... [${full.length - MAX_ERROR_LENGTH} characters truncated] ...\n\n` +
    full.slice(-HALF)
  );
}
