/** Resolve a missing duplicate capability without downgrading an established peer. */
export function peerVersion(previousId: string | undefined, previousVersion: number,
  nextId: string, advertised: unknown): 1 | 2 {
  if (advertised === 2) return 2;
  if (advertised === 1) return 1;
  return previousId === nextId && previousVersion === 2 ? 2 : 1;
}
/** Server chooses framing from both room participants, never from a sender alone. */
export function roomWireVersion(senderVersion: unknown, peerVersions: readonly unknown[]): 1 | 2 | null {
  if (peerVersions.length !== 1) return null;
  return senderVersion === 2 && peerVersions[0] === 2 ? 2 : 1;
}
export function ackMatches(expectedBytes: number, actual: unknown): boolean {
  return Number.isSafeInteger(expectedBytes) && expectedBytes >= 0 &&
    typeof actual === 'number' && Number.isSafeInteger(actual) && actual === expectedBytes;
}
/** Unknown IDs never match; an unscoped relay error is scoped by the caller to an active relay transfer. */
export function matchesTransfer(activeId: string | null | undefined, errorId: unknown): boolean {
  return typeof activeId === 'string' && activeId.length > 0 &&
    (errorId === undefined || errorId === activeId);
}
export function isRelayError(code: unknown): boolean {
  return typeof code === 'string' && (code.startsWith('RELAY_') || code === 'RATE_LIMIT_EXCEEDED');
}
