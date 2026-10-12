export class CliError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly exitCode: 1 | 2 = 1,
    public readonly details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function argumentError(message: string): never {
  throw new CliError("INVALID_ARGUMENT", message, 2);
}
