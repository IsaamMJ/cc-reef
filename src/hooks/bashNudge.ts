import { log } from '../log.js';

interface BashNudgeInput {
  tool_name?: string;
  tool_input?: {
    command?: string;
  };
}

interface NudgeRule {
  pattern: RegExp;
  message: string;
}

// Patterns where a native CC tool is strictly better than shelling out:
// Grep/Glob/Read return trimmed, structured results and avoid shell escaping bugs.
const RULES: NudgeRule[] = [
  {
    pattern: /(^|\s|\|)\s*(rg|grep)\b/,
    message: 'Use the Grep tool instead of rg/grep — faster and returns structured matches.',
  },
  {
    pattern: /(^|\s|\|)\s*find\b/,
    message: 'Use the Glob tool instead of `find` — simpler and respects .gitignore.',
  },
  {
    pattern: /(^|\s|\|)\s*(cat|head|tail)\b/,
    message: 'Use the Read tool for files — it handles offsets, truncation, and binary safely.',
  },
  {
    pattern: /(^|\s|\|)\s*sed\b/,
    message: 'Use the Edit tool for file edits — sed is brittle and error-prone on Windows.',
  },
];

export async function bashNudge(input: BashNudgeInput): Promise<unknown> {
  if (input.tool_name !== 'Bash') return {};
  const cmd = input.tool_input?.command;
  if (typeof cmd !== 'string' || cmd.length === 0) return {};

  for (const rule of RULES) {
    if (rule.pattern.test(cmd)) {
      log.info('bash nudge fired', { rule: rule.message });
      return {
        hookSpecificOutput: {
          hookEventName: 'PreToolUse',
          additionalContext: `[reef] ${rule.message}`,
        },
      };
    }
  }
  return {};
}
