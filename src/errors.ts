export class ReefError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class TranscriptParseError extends ReefError {
  constructor(
    message: string,
    public readonly filePath: string,
    public readonly lineNumber?: number,
  ) {
    super(message);
  }
}

export class HookInstallError extends ReefError {
  constructor(
    message: string,
    public readonly settingsPath: string,
  ) {
    super(message);
  }
}

export class DBError extends ReefError {}

export class ConfigError extends ReefError {
  constructor(
    message: string,
    public readonly configPath: string,
  ) {
    super(message);
  }
}

export class AbortError extends ReefError {
  constructor(message?: string) {
    super(message ?? 'Aborted');
    // minified builds mangle class names; set name explicitly so isAbortError
    // can still classify via e.name when instanceof fails across module boundaries.
    this.name = 'AbortError';
  }
}

export function isAbortError(e: unknown): boolean {
  return (
    e instanceof AbortError ||
    (e instanceof Error && e.name === 'AbortError')
  );
}

export function isParseError(e: unknown): e is TranscriptParseError {
  return e instanceof TranscriptParseError;
}
