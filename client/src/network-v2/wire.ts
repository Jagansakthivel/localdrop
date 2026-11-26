export const HEADER = 8;
export const DATA = 1;
export const EOF = 2;
export const ABORT = 4;
export const CREDIT = 6;
export const WINDOW = 4 * 1024 * 1024;
export const HIGH = 6 * 1024 * 1024;
export const LOW = 2 * 1024 * 1024;
export const MAX_FRAME = 256 * 1024;
export const VERSION = 2;
export interface FileMeta { transferId: string; fileId: number; name: string; mime: string; size: number; chunkSize: number }
export function chunkSize(pc?: RTCPeerConnection): number {
  const max = pc?.sctp?.maxMessageSize ?? 65536;
  const cap = max === 0 || max === Infinity ? MAX_FRAME : Math.min(MAX_FRAME, max);
  if (!Number.isSafeInteger(cap) || cap <= HEADER) throw new Error('Invalid SCTP maxMessageSize');
  return cap - HEADER;
}
export function validateMeta(m: FileMeta): number {
  if (!m.transferId || m.transferId.length > 128 || !Number.isInteger(m.fileId) || m.fileId < 0 || m.fileId > 65535 || !Number.isSafeInteger(m.size) || m.size < 0 || !Number.isInteger(m.chunkSize) || m.chunkSize < 1 || m.chunkSize > MAX_FRAME - HEADER) throw new Error('Invalid file metadata');
  const count = Math.ceil(m.size / m.chunkSize);
  if (count > 0x100000000) throw new Error('Too many chunks');
  return count;
}
export function encode(id: number, index: number, flag: number, payload: Uint8Array): ArrayBuffer {
  if (!Number.isInteger(id) || id < 0 || id > 65535 || !Number.isInteger(index) || index < 0 || index > 0xffffffff || ![DATA, EOF, ABORT].includes(flag) || payload.byteLength > MAX_FRAME - HEADER || (flag === ABORT && payload.byteLength !== 0)) throw new Error('Invalid binary frame');
  const out = new ArrayBuffer(HEADER + payload.byteLength), view = new DataView(out);
  view.setUint16(0, id, true); view.setUint32(2, index, true); view.setUint8(6, flag);
  new Uint8Array(out, HEADER).set(payload); return out;
}
export function decode(frame: ArrayBuffer) {
  if (frame.byteLength < HEADER || frame.byteLength > MAX_FRAME) throw new Error('Invalid frame length');
  const view = new DataView(frame), flag = view.getUint8(6);
  if (view.getUint8(7) !== 0 || ![DATA, EOF, ABORT].includes(flag) || (flag === ABORT && frame.byteLength !== HEADER)) throw new Error('Invalid frame flags');
  return { id: view.getUint16(0, true), index: view.getUint32(2, true), flag, payload: new Uint8Array(frame, HEADER) };
}
export function creditFrame(bytes: number): ArrayBuffer {
  if (!Number.isInteger(bytes) || bytes <= 0 || bytes > WINDOW) throw new Error('Invalid credit');
  const out = new ArrayBuffer(5); const v = new DataView(out); v.setUint8(0, CREDIT); v.setUint32(1, bytes, true); return out;
}
export function readCredit(frame: ArrayBuffer): number {
  if (frame.byteLength !== 5 || new DataView(frame).getUint8(0) !== CREDIT) throw new Error('Invalid credit frame');
  const bytes = new DataView(frame).getUint32(1, true);
  if (!bytes || bytes > WINDOW) throw new Error('Invalid credit amount'); return bytes;
}
export function checkAbort(signal: AbortSignal): void { if (signal.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError'); }
