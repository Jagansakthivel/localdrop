export type TransferPath = 'rtc' | 'relay';
export interface TransferAttempt { id: string; path: TransferPath; generation: number }
/** Only a loss of the pinned path can abort this attempt. */
export function affectedByPathLoss(attempt: TransferAttempt | null, path: TransferPath, generation: number): boolean {
  return attempt !== null && attempt.path === path && attempt.generation === generation;
}
export function clearMatching<T extends {transferId?: string}>(current: T | null, id: string): T | null {
  return current?.transferId === id ? null : current;
}
/** Reserve before asynchronous storage open; release only by object identity. */
export class ReceiverSlot {
  private active: (TransferAttempt & {controller: AbortController}) | null = null;
  get current() { return this.active; }
  reserve(attempt: TransferAttempt) {
    if (this.active) throw new Error('Receiver busy');
    const lease = {...attempt, controller: new AbortController()};
    this.active = lease;
    return lease;
  }
  valid(lease: NonNullable<ReceiverSlot['current']>): boolean {
    return this.active === lease && !lease.controller.signal.aborted;
  }
  release(lease: NonNullable<ReceiverSlot['current']>): boolean {
    if (this.active !== lease) return false;
    this.active = null; return true;
  }
  cancel(id: string, reason: unknown = new Error('Transfer cancelled')): boolean {
    const lease = this.active;
    if (!lease || lease.id !== id) return false;
    // Retain the reservation until asynchronous sink open/abort or receiver drain completes.
    lease.controller.abort(reason); return true;
  }
}
/** Reset a stall deadline only on real forward progress, not timer ticks. */
export class ProgressDeadline {
  private best: number;
  private lastProgress: number;
  private readonly stallMs: number;
  private readonly direction: 'up'|'down';
  constructor(initial: number, stallMs: number, now: number, direction: 'up'|'down') {
    if (!(stallMs > 0) || !Number.isFinite(initial)) throw new Error('Invalid deadline');
    this.stallMs=stallMs; this.direction=direction; this.best=initial; this.lastProgress=now;
  }
  observe(value: number, now: number): void {
    if (!Number.isFinite(value)) return;
    if (this.direction === 'up' ? value > this.best : value < this.best) {this.best=value; this.lastProgress=now;}
  }
  expired(now: number): boolean {return now-this.lastProgress>=this.stallMs;}
}
