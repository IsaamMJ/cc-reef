import { readdirSync, existsSync } from 'node:fs';
import { CLAUDE_PROJECTS } from './paths.js';
/**
 * List all top-level project folders under ~/.claude/projects/.
 * Returns an empty array if the Claude home does not exist yet.
 */
export function listProjectFolders() {
    if (!existsSync(CLAUDE_PROJECTS))
        return [];
    return readdirSync(CLAUDE_PROJECTS, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort();
}
//# sourceMappingURL=projects.js.map