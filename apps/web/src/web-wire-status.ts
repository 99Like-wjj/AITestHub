/** A transport denial remains an HTTP failure; only our gated Web adapter maps it. */
export function webWireStatus(
  response: Pick<Response, 'status' | 'headers'>,
): number {
  return response.status === 419 &&
    response.headers?.get('X-AITestHub-Web-Status') === '401'
    ? 401
    : response.status;
}
