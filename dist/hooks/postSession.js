import { basename, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { scan } from '../scan.js';
import { closeDb } from '../db.js';
import { loadConfig, getGroupForProject } from '../groups.js';
import { suggestDecisionsForSession } from '../decisionSuggest.js';
import { llmAvailable } from '../llm.js';
import { log } from '../log.js';
/**
 * Stop hook. Runs an incremental scan to keep the DB fresh, then (if an LLM
 * provider is configured) asks the LLM to propose decisions from the session
 * transcript. Suggestions sit in pending-decisions.json until the user accepts.
 */
export async function postSession(input) {
    try {
        const summary = await scan({ force: false });
        log.info('post-session scan', {
            scanned: summary.filesScanned,
            skipped: summary.filesSkipped,
            ms: summary.durationMs,
        });
    }
    catch (e) {
        log.warn('post-session scan failed', { err: e.message });
    }
    if (llmAvailable() && input.transcript_path && input.session_id) {
        try {
            const transcriptPath = input.transcript_path;
            if (existsSync(transcriptPath)) {
                const project = basename(dirname(transcriptPath));
                const cfg = loadConfig();
                const group = getGroupForProject(cfg, project);
                if (group) {
                    await suggestDecisionsForSession({
                        group,
                        sessionId: input.session_id,
                        transcriptPath,
                    });
                }
            }
        }
        catch (e) {
            log.warn('post-session: decision suggest failed', { err: e.message });
        }
    }
    closeDb();
    return {};
}
//# sourceMappingURL=postSession.js.map