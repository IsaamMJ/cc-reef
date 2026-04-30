import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { log } from './log.js';
export function isParseFailure(y) {
    return y.parseError !== undefined;
}
/**
 * Stream a JSONL file line by line, yielding parsed events.
 * One bad line cannot halt iteration — malformed lines yield a `ParseFailure`
 * (with file+line context) and the loop continues. The caller decides what
 * to do with parse failures (count them, log, etc.).
 */
export async function* parseJsonl(filePath) {
    const rl = createInterface({
        input: createReadStream(filePath, { encoding: 'utf8' }),
        crlfDelay: Infinity,
    });
    let lineNo = 0;
    for await (const line of rl) {
        lineNo++;
        if (!line.trim())
            continue;
        try {
            yield { lineNo, event: JSON.parse(line) };
        }
        catch (e) {
            const msg = e.message;
            log.warn('parser: bad line skipped', { filePath, lineNo, err: msg });
            yield { lineNo, parseError: msg };
        }
    }
}
/**
 * Extract tool_use names from an assistant event's content array.
 * Returns [] for non-assistant events or when content is missing.
 */
export function extractToolNames(event) {
    const content = event.message?.content;
    if (!Array.isArray(content))
        return [];
    const names = [];
    for (const block of content) {
        if (block &&
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_use') {
            const name = block.name;
            if (typeof name === 'string')
                names.push(name);
        }
    }
    return names;
}
//# sourceMappingURL=parser.js.map