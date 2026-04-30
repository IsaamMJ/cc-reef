import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Tiny .env loader — keeps reef's zero-runtime-deps property. Reads each
 * `KEY=VALUE` line from the file, ignores blanks/comments, strips surrounding
 * quotes from values. Existing process.env values are NEVER overridden, so
 * shell exports always win over the file.
 */
export function loadDotEnv(filePath?: string): void {
  const candidates = filePath
    ? [filePath]
    : [
        join(process.cwd(), '.env'),
        // Fall back to the package directory (handy when reef runs from
        // an installed location and the user dropped .env beside the binary).
        join(process.env.REEF_HOME ?? '', '.env'),
      ].filter(Boolean);

  for (const path of candidates) {
    if (!path || !existsSync(path)) continue;
    try {
      const raw = readFileSync(path, 'utf8');
      for (const rawLine of raw.split('\n')) {
        const line = rawLine.trim();
        if (!line || line.startsWith('#')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        if (!key || /[^A-Za-z0-9_]/.test(key)) continue;
        let value = line.slice(eq + 1).trim();
        // Strip trailing inline comment (only when '#' is preceded by whitespace),
        // so paste-with-comment lines don't smuggle the comment into the value.
        const inlineCommentMatch = value.match(/\s+#.*$/);
        if (inlineCommentMatch) value = value.slice(0, value.length - inlineCommentMatch[0].length).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1);
        }
        // Real shell env wins — only fill in unset keys.
        if (process.env[key] === undefined) {
          process.env[key] = value;
        }
      }
    } catch {
      // Swallow — a broken .env should never crash reef.
    }
  }
}
