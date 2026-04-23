import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { TranscriptParseError } from './errors.js';

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

/**
 * Stream a JSONL file line by line, yielding parsed events.
 * Malformed lines throw TranscriptParseError with file+line context so
 * the caller can decide whether to skip or halt.
 */
export async function* parseJsonl(
  filePath: string,
): AsyncGenerator<ParsedLine, void, void> {
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
      throw new TranscriptParseError(
        `Invalid JSON: ${(e as Error).message}`,
        filePath,
        lineNo,
      );
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
