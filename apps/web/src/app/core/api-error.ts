export const SERVER_UNREACHABLE_MESSAGE =
  'Server is not reachable. Check your connection and try again.';

export function errorMessage(err: unknown, fallback = 'Something went wrong.'): string {
  if (isHttpErrorLike(err)) {
    if (err.status === 0) return SERVER_UNREACHABLE_MESSAGE;

    const bodyMessage = bodyErrorMessage(err.error);
    if (bodyMessage) return bodyMessage;

    if (err.status) {
      return `Request failed (${err.status}${err.statusText ? ` ${err.statusText}` : ''}).`;
    }
  }

  if (isRecord(err)) {
    const nestedMessage = bodyErrorMessage(err['error']);
    if (nestedMessage) return nestedMessage;

    const message = firstString(err['message'], err['error']);
    if (message) return normalizeNetworkMessage(message);

    return fallback;
  }

  if (typeof err === 'string') return normalizeNetworkMessage(err);
  if (err instanceof Error) return normalizeNetworkMessage(err.message);

  return fallback;
}

function bodyErrorMessage(body: unknown): string | null {
  if (typeof body === 'string') return normalizeNetworkMessage(body);
  if (!isRecord(body)) return null;

  const direct = firstString(body['message'], body['error'], body['detail'], body['title']);
  if (direct) return normalizeNetworkMessage(direct);

  return bodyErrorMessage(body['error']);
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) return value;
  }
  return null;
}

function normalizeNetworkMessage(message: string): string {
  const normalized = message.trim();
  if (/failed to fetch|load failed|networkerror|unknown error/i.test(normalized)) {
    return SERVER_UNREACHABLE_MESSAGE;
  }
  return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isHttpErrorLike(
  value: unknown,
): value is { status: number; statusText?: string; error?: unknown } {
  return isRecord(value) && typeof value['status'] === 'number';
}
