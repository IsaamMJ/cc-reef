export class ReefError extends Error {
    constructor(message) {
        super(message);
        this.name = this.constructor.name;
    }
}
export class TranscriptParseError extends ReefError {
    filePath;
    lineNumber;
    constructor(message, filePath, lineNumber) {
        super(message);
        this.filePath = filePath;
        this.lineNumber = lineNumber;
    }
}
export class HookInstallError extends ReefError {
    settingsPath;
    constructor(message, settingsPath) {
        super(message);
        this.settingsPath = settingsPath;
    }
}
export class DBError extends ReefError {
}
export class ConfigError extends ReefError {
    configPath;
    constructor(message, configPath) {
        super(message);
        this.configPath = configPath;
    }
}
export class AbortError extends ReefError {
    constructor(message) {
        super(message ?? 'Aborted');
        // minified builds mangle class names; set name explicitly so isAbortError
        // can still classify via e.name when instanceof fails across module boundaries.
        this.name = 'AbortError';
    }
}
export function isAbortError(e) {
    return (e instanceof AbortError ||
        (e instanceof Error && e.name === 'AbortError'));
}
export function isParseError(e) {
    return e instanceof TranscriptParseError;
}
//# sourceMappingURL=errors.js.map