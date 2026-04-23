import { homedir } from 'node:os';
import { join } from 'node:path';

export const CLAUDE_HOME = join(homedir(), '.claude');
export const CLAUDE_PROJECTS = join(CLAUDE_HOME, 'projects');
export const CLAUDE_SETTINGS = join(CLAUDE_HOME, 'settings.json');

export const REEF_HOME = join(homedir(), '.cc-reef');
export const REEF_DB = join(REEF_HOME, 'data.db');
export const REEF_LOGS = join(REEF_HOME, 'logs');
export const REEF_LOG_FILE = join(REEF_LOGS, 'reef.log');
export const REEF_REPORTS = join(REEF_HOME, 'reports');
export const REEF_CONFIG = join(REEF_HOME, 'config.json');
