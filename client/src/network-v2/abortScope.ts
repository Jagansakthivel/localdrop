/** Browser-compatible, explicitly disposable cancellation scope. */
export function abortScope(signals: readonly AbortSignal[], timeoutMs?: number) {
  const controller = new AbortController();
  const cleanup: (() => void)[] = [];
  let disposed = false;
  const dispose = () => { if (disposed) return; disposed = true; for (const fn of cleanup.splice(0)) fn(); };
  const abort = (reason: unknown = new Error('Aborted')) => { if (!controller.signal.aborted) controller.abort(reason); dispose(); };
  for (const s of signals) {
    if (s.aborted) { abort(s.reason); break; }
    const listener = () => abort(s.reason);
    s.addEventListener('abort', listener, {once:true});
    cleanup.push(() => s.removeEventListener('abort', listener));
    if (s.aborted) { abort(s.reason); break; }
  }
  if (!disposed && timeoutMs !== undefined) {
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) { abort(new Error('Invalid deadline')); }
    else { const t = setTimeout(() => abort(new Error('Deadline exceeded')), timeoutMs); cleanup.push(() => clearTimeout(t)); }
  }
  return {signal:controller.signal,abort,dispose};
}
