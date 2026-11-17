export function recordDiagnostic(name: string, detail?: Record<string, unknown> | string): Record<string, unknown>;
export function readDiagnostics(): Array<Record<string, unknown>>;
export function clearDiagnostics(): void;
export function installDiagnostics(target?: Record<string, unknown>): void;
