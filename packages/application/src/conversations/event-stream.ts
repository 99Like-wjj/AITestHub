import { DomainError } from '../errors.js';

/** Transport controls carry no exception message, query, body, credential or business event sequence. */
export function taskEventStreamFailure(
  error: unknown,
):
  | { event: 'access-unavailable'; payload: { state: 'unavailable' } }
  | { event: 'transport-unavailable'; payload: { retryAfterMs: number } }
  | { event: 'protocol-unavailable'; payload: { code: 'TASK_EVENTS_ERROR' } } {
  if (error instanceof DomainError && [401, 403, 404].includes(error.status))
    return { event: 'access-unavailable', payload: { state: 'unavailable' } };
  const code =
    error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : '';
  if (
    (error instanceof DomainError && [429, 503].includes(error.status)) ||
    [
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'EPIPE',
      '57P01',
      '57P02',
      '57P03',
      '53300',
      '53400',
      '08000',
      '08001',
      '08003',
      '08006',
      '08007',
    ].includes(code)
  )
    return { event: 'transport-unavailable', payload: { retryAfterMs: 1500 } };
  return {
    event: 'protocol-unavailable',
    payload: { code: 'TASK_EVENTS_ERROR' },
  };
}
