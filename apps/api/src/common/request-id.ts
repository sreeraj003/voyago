import { randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';

const INCOMING_ID = /^[\w-]{1,64}$/;

/**
 * Assigns every request an id before anything else runs (including body parsing), so even
 * malformed-body errors carry one. A well-formed incoming `x-request-id` is reused; the id is
 * echoed in the `x-request-id` response header and in every log line and error body.
 */
export function resolveRequestId(req: IncomingMessage, res: ServerResponse): string {
  const existing = (req as { id?: unknown }).id;
  if (typeof existing === 'string') return existing;
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && INCOMING_ID.test(incoming) ? incoming : randomUUID();
  (req as { id?: string }).id = id;
  res.setHeader('x-request-id', id);
  return id;
}

export function requestIdMiddleware(
  req: IncomingMessage,
  res: ServerResponse,
  next: () => void,
): void {
  resolveRequestId(req, res);
  next();
}
