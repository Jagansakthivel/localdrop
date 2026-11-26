export type TransferStatus = 'active' | 'complete' | 'failed' | 'cancelled';
export type TransferDirection = 'send' | 'receive';
export type MotionPhase = 'sending' | 'receiving' | 'approval' | 'finalizing' | 'complete' | 'failed' | 'cancelled' | 'paused';
export function clampProgress(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}
export function motionPhase(status: TransferStatus, direction: TransferDirection, progress: number, awaitingApproval = false, paused = false): MotionPhase {
  if (status !== 'active') return status;
  if (awaitingApproval) return 'approval';
  if (paused) return 'paused';
  if (clampProgress(progress) >= 100) return 'finalizing';
  return direction === 'send' ? 'sending' : 'receiving';
}
export function canAnimatePackets(phase: MotionPhase, visible: boolean, reduced: boolean, advancing: boolean): boolean {
  return (phase === 'sending' || phase === 'receiving') && visible && !reduced && advancing;
}
export const phaseLabel: Record<MotionPhase, string> = {
  sending:'Sending', receiving:'Receiving', approval:'Waiting for acceptance', finalizing:'Finalizing', complete:'Complete', failed:'Failed', cancelled:'Cancelled', paused:'Transfer paused',
};
