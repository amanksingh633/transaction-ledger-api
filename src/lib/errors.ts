import type { ErrorRequestHandler, RequestHandler } from 'express';

export type ErrorCode =
  | 'INVALID_JSON'
  | 'INVALID_REQUEST_BODY'
  | 'INVALID_ACCOUNT_ID'
  | 'INVALID_TRANSACTION_TYPE'
  | 'INVALID_AMOUNT'
  | 'INVALID_PAGINATION'
  | 'SAME_ACCOUNT_TRANSFER'
  | 'ACCOUNT_NOT_FOUND'
  | 'NOT_FOUND'
  | 'METHOD_NOT_ALLOWED'
  | 'DUPLICATE_TRANSACTION'
  | 'DUPLICATE_TRANSFER'
  | 'PAYLOAD_TOO_LARGE'
  | 'INSUFFICIENT_BALANCE'
  | 'INTERNAL_ERROR';

/** An error we expect and can describe to the client. Every error response has the same shape. */
export class AppError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: ErrorCode,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
  }
}

export const accountNotFound = (accountId: string) =>
  new AppError(404, 'ACCOUNT_NOT_FOUND', `Account ${accountId} was not found`, { account_id: accountId });

export const insufficientBalance = (accountId: string, balance: number, requested: number) =>
  new AppError(
    422,
    'INSUFFICIENT_BALANCE',
    `Insufficient balance: account has ${balance}, debit needs ${requested}`,
    { account_id: accountId, balance, requested },
  );

export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new AppError(404, 'NOT_FOUND', `Route ${req.method} ${req.path} does not exist`));
};

export const errorHandler: ErrorRequestHandler = (err, _req, res, _next) => {
  const appError = toAppError(err);
  if (appError.status >= 500) console.error(err);
  res.status(appError.status).json({
    error: {
      code: appError.code,
      message: appError.message,
      ...(appError.details !== undefined && { details: appError.details }),
    },
  });
};

function toAppError(err: unknown): AppError {
  if (err instanceof AppError) return err;

  const e = err as { type?: string; code?: string; constraint?: string };

  // Thrown by express.json()
  if (e.type === 'entity.parse.failed') {
    return new AppError(400, 'INVALID_JSON', 'Request body is not valid JSON');
  }
  if (e.type === 'entity.too.large') {
    return new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large');
  }

  // Database constraint backstops. The services check these rules first; the
  // constraints catch anything that slips past them (e.g. a bug or a race).
  if (e.code === '23505') {
    return e.constraint === 'transfers_from_reference_unique'
      ? new AppError(409, 'DUPLICATE_TRANSFER', 'A transfer with this reference_id already exists')
      : new AppError(409, 'DUPLICATE_TRANSACTION', 'A transaction with this reference_id already exists for this account');
  }
  if (e.code === '23514' && e.constraint === 'accounts_balance_check') {
    return new AppError(422, 'INSUFFICIENT_BALANCE', 'Insufficient balance');
  }

  return new AppError(500, 'INTERNAL_ERROR', 'Something went wrong. Please try again.');
}
