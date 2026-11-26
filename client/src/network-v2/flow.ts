import { checkAbort, HIGH, LOW, WINDOW } from './wire';
export class CreditWindow {
  private available = WINDOW;
  private waiter: (() => void) | undefined;
  get outstanding() { return WINDOW - this.available; }
  add(delta: number): void {
    if (!Number.isInteger(delta) || delta <= 0 || delta > this.outstanding) throw new Error('Unexpected credit');
    this.available += delta; this.waiter?.();
  }
  async take(bytes: number, signal: AbortSignal): Promise<void> {
    if (!Number.isInteger(bytes) || bytes <= 0 || bytes > WINDOW) throw new Error('Invalid reservation');
    if (this.waiter) throw new Error('Concurrent credit reservations not allowed');
    while (this.available < bytes) {
      checkAbort(signal);
      await new Promise<void>((resolve, reject) => {
        const done = (error?: unknown) => { clearTimeout(timer); this.waiter = undefined; signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
        const abort = () => done(signal.reason ?? new Error('Aborted'));
        const timer = setTimeout(() => done(new Error('Receiver credit timeout')), 20000);
        this.waiter = () => done(); signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    checkAbort(signal); this.available -= bytes;
  }
}
export async function waitChannel(channel: RTCDataChannel, bytes: number, signal: AbortSignal): Promise<void> {
  checkAbort(signal); if (channel.readyState !== 'open') throw new Error('Data channel closed');
  channel.bufferedAmountLowThreshold = LOW;
  while (channel.bufferedAmount + bytes > HIGH) {
    await new Promise<void>((resolve, reject) => {
      const done = (error?: unknown) => { clearTimeout(timer); channel.removeEventListener('bufferedamountlow', low); channel.removeEventListener('close', close); channel.removeEventListener('error', close); signal.removeEventListener('abort', abort); error ? reject(error) : resolve(); };
      const low = () => done(); const close = () => done(new Error('Data channel lost')); const abort = () => done(signal.reason ?? new Error('Aborted'));
      const timer = setTimeout(() => done(new Error('Data channel buffer stalled')), 15000);
      channel.addEventListener('bufferedamountlow', low); channel.addEventListener('close', close); channel.addEventListener('error', close); signal.addEventListener('abort', abort, { once: true });
      if (signal.aborted) abort(); else if (channel.readyState !== 'open') close(); else if (channel.bufferedAmount <= LOW) low();
    });
    checkAbort(signal);
  }
  if (channel.readyState !== 'open') throw new Error('Data channel closed');
}
export async function waitSocket(socket: WebSocket, bytes: number, signal: AbortSignal): Promise<void> {
  let bestBuffered = socket.bufferedAmount;
  let lastProgress = performance.now();
  while (true) {
    checkAbort(signal); if (socket.readyState !== WebSocket.OPEN) throw new Error('Relay closed');
    const currentBuffered = socket.bufferedAmount;
    if (currentBuffered + bytes <= WINDOW) return;
    const now = performance.now();
    if (currentBuffered < bestBuffered) {
      bestBuffered = currentBuffered;
      lastProgress = now;
    } else if (now - lastProgress >= 15000) {
      throw new Error('Relay buffer stalled');
    }
    await new Promise<void>((resolve, reject) => {
      const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(signal.reason ?? new Error('Aborted')); };
      const timer = setTimeout(() => { signal.removeEventListener('abort', abort); resolve(); }, 15);
      signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
    });
  }
}
