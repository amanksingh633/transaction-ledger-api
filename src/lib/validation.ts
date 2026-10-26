import { z, ZodIssue, ZodTypeAny } from 'zod';
import { AppError, ErrorCode } from './errors';
import { hasAtMostTwoDecimals, MAX_AMOUNT_RUPEES } from './money';

// ---------- reusable fields ----------

const amount = z
  .number({ required_error: 'amount is required', invalid_type_error: 'amount must be a number' })
  .finite('amount must be a finite number')
  .positive('amount must be greater than 0')
  .max(MAX_AMOUNT_RUPEES, `amount must be at most ${MAX_AMOUNT_RUPEES}`)
  .refine(hasAtMostTwoDecimals, 'amount can have at most 2 decimal places');

const referenceId = z
  .string({ required_error: 'reference_id is required', invalid_type_error: 'reference_id must be a string' })
  .trim()
  .min(1, 'reference_id is required')
  .max(100, 'reference_id must be at most 100 characters');

const description = z
  .string({ invalid_type_error: 'description must be a string' })
  .trim()
  .max(500, 'description must be at most 500 characters')
  .nullish()
  .transform((value) => value || null);

const transactionType = z.enum(['credit', 'debit'], {
  errorMap: () => ({ message: "type must be either 'credit' or 'debit'" }),
});

export const accountId = z
  .string()
  .uuid('account id must be a valid UUID');

const pageNumber = (name: string, max: number) =>
  z
    .string({ invalid_type_error: `${name} must be a single positive integer` })
    .regex(/^\d+$/, `${name} must be a positive integer`)
    .transform(Number)
    .pipe(z.number().int().min(1, `${name} must be at least 1`).max(max, `${name} must be at most ${max}`));

// ---------- request schemas ----------

export const createAccountBody = z
  .object({
    name: z
      .string({ required_error: 'name is required', invalid_type_error: 'name must be a string' })
      .trim()
      .min(1, 'name is required')
      .max(200, 'name must be at most 200 characters'),
  })
  .strict();

export const createTransactionBody = z
  .object({ type: transactionType, amount, description, reference_id: referenceId })
  .strict();

export const createTransferBody = z
  .object({
    from_account_id: accountId,
    to_account_id: accountId,
    amount,
    description,
    // Optional: when given, a retry with the same value is recognised as a duplicate.
    reference_id: referenceId.optional(),
  })
  .strict();

export const DEFAULT_PAGE_SIZE = 10;
export const MAX_PAGE_SIZE = 100;

export const paginationQuery = z.object({
  page: pageNumber('page', 1_000_000).default('1'),
  limit: pageNumber('limit', MAX_PAGE_SIZE).default(String(DEFAULT_PAGE_SIZE)),
});

export const transactionHistoryQuery = paginationQuery.extend({
  type: transactionType.optional(),
});

export type CreateTransactionInput = z.infer<typeof createTransactionBody>;
export type CreateTransferInput = z.infer<typeof createTransferBody>;
export type Pagination = z.infer<typeof paginationQuery>;

// ---------- turning zod issues into API errors ----------

// When a specific field fails, report a specific error code for it.
const FIELD_CODES: Record<string, ErrorCode> = {
  type: 'INVALID_TRANSACTION_TYPE',
  amount: 'INVALID_AMOUNT',
  page: 'INVALID_PAGINATION',
  limit: 'INVALID_PAGINATION',
  from_account_id: 'INVALID_ACCOUNT_ID',
  to_account_id: 'INVALID_ACCOUNT_ID',
};

const SERVER_SET_FIELDS = ['id', 'balance', 'created_at'];

function describeIssue(issue: ZodIssue): { field: string; message: string } {
  if (issue.code === 'unrecognized_keys') {
    const serverSet = issue.keys.filter((k) => SERVER_SET_FIELDS.includes(k));
    const hint = serverSet.length ? ` (${serverSet.join(', ')} ${serverSet.length > 1 ? 'are' : 'is'} set by the server)` : '';
    return { field: issue.keys.join(', '), message: `Unknown field(s): ${issue.keys.join(', ')}${hint}` };
  }
  return { field: issue.path.join('.') || '(body)', message: issue.message };
}

export function parse<S extends ZodTypeAny>(
  schema: S,
  data: unknown,
  fallbackCode: ErrorCode = 'INVALID_REQUEST_BODY',
): z.output<S> {
  const result = schema.safeParse(data);
  if (result.success) return result.data;

  const issues = result.error.issues;
  const specific = issues.find((i) => FIELD_CODES[String(i.path[0])]);
  const first = specific ?? issues[0];
  const code = specific ? FIELD_CODES[String(specific.path[0])] : fallbackCode;
  throw new AppError(400, code, describeIssue(first).message, issues.map(describeIssue));
}

/** Request bodies must be JSON objects; anything else gets one clear message. */
export function parseBody<S extends ZodTypeAny>(schema: S, body: unknown): z.output<S> {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new AppError(
      400,
      'INVALID_REQUEST_BODY',
      'Request body must be a JSON object (send it with Content-Type: application/json)',
    );
  }
  return parse(schema, body);
}

export function parseAccountId(value: unknown): string {
  const result = accountId.safeParse(value);
  if (!result.success) {
    throw new AppError(400, 'INVALID_ACCOUNT_ID', `"${String(value)}" is not a valid account id (expected a UUID)`);
  }
  return result.data;
}
