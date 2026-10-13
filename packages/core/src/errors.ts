export type ErrorCode =
  | 'NOT_FOUND'
  | 'INVALID_PARAMS'
  | 'NOT_SUPPORTED'
  | 'DEVICE_OFFLINE'
  | 'TIMEOUT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'CONFLICT'
  | 'ACTION_FAILED'
  | 'INTERNAL';

const httpStatus: Record<ErrorCode, number> = {
  NOT_FOUND: 404,
  INVALID_PARAMS: 400,
  NOT_SUPPORTED: 400,
  DEVICE_OFFLINE: 503,
  TIMEOUT: 504,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  CONFLICT: 409,
  ACTION_FAILED: 422,
  INTERNAL: 500,
};

export class LivynqError extends Error {
  readonly code: ErrorCode;
  readonly hint: string | undefined;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.name = 'LivynqError';
    this.code = code;
    this.hint = hint;
  }

  get status(): number {
    return httpStatus[this.code];
  }

  toJSON() {
    return { code: this.code, message: this.message, ...(this.hint ? { hint: this.hint } : {}) };
  }
}
