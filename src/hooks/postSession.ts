import { scan } from '../scan.js';
import { closeDb } from '../db.js';
import { log } from '../log.js';

/**
 * Runs after a Claude Code session ends (Stop / SessionEnd hook).
 * Does an incremental scan — only files whose mtime changed will be parsed,
 * so in practice this processes just the session that just ended. Fast.
 *
 * Silent: emits no additionalContext. Its only job is to keep the DB fresh
 * so the next session-start can produce a useful resume card.
 */
export async function postSession(
  _input: Record<string, unknown>,
): Promise<unknown> {
  try {
    const summary = await scan({ force: false });
    log.info('post-session scan', {
      scanned: summary.filesScanned,
      skipped: summary.filesSkipped,
      ms: summary.durationMs,
    });
  } catch (e) {
    log.warn('post-session scan failed', { err: (e as Error).message });
  } finally {
    closeDb();
  }
  return {};
}
