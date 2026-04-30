import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { log } from './log.js';

/**
 * Shape of events we care about in Claude Code JSONL transcripts.
 * We keep this narrow on purpose — the raw JSONL has ~10 event types but
 * only `assistant` carries the model/usage/tool data we aggregate.
 */
export interface TranscriptUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface RawEvent {
  type?: string;
  timestamp?: string;
  sessionId?: string;
  message?: {
    model?: string;
    stop_reason?: string | null;
    usage?: TranscriptUsage;
    content?: Array<{ type?: string; name?: string } | unknown>;
  };
  [key: string]: unknown;
}

export interface ParsedLine {
  lineNo: number;
  event: RawEvent;
}

export interface ParseFailure {
  lineNo: number;
  parseError: string;
}

export type ParserYield = ParsedLine | ParseFailure;

export function isParseFailure(y: ParserYield): y is ParseFailure {
  return (y as ParseFailure).parseError !== undefined;
}

/**
 * Stream a JSONL file line by line, yielding parsed events.
 * One bad line cannot halt iteration — malformed lines yield a `ParseFailure`
 * (with file+line context) and the loop continues. The caller decides what
 * to do with parse failures (count them, log, etc.).
 */
export async function* parseJsonl(
  filePath: string,
): AsyncGenerator<ParserYield, void, void> {
  const rl = createInterface({
    input: createReadStream(filePath, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let lineNo = 0;
  for await (const line of rl) {
    lineNo++;
    if (!line.trim()) continue;
    try {
      yield { lineNo, event: JSON.parse(line) as RawEvent };
    } catch (e) {
      const msg = (e as Error).message;
      log.warn('parser: bad line skipped', { filePath, lineNo, err: msg });
      yield { lineNo, parseError: msg };
    }
  }
}

/**
 * Extract tool_use names from an assistant event's content array.
 * Returns [] for non-assistant events or when content is missing.
 */
export function extractToolNames(event: RawEvent): string[] {
  const content = event.message?.content;
  if (!Array.isArray(content)) return [];
  const names: string[] = [];
  for (const block of content) {
    if (
      block &&
      typeof block === 'object' &&
      'type' in block &&
      (block as { type?: unknown }).type === 'tool_use'
    ) {
      const name = (block as { name?: unknown }).name;
      if (typeof name === 'string') names.push(name);
    }
  }
  return names;
}
