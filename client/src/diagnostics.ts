import { createReceiver, type EndMessage, type ResultMessage, type TransferPath } from './network-v2/engine';
import { connectDiagnosticRelay } from './network-v2/diagnosticRelay';
import { fetchDiagnosticTurn } from './network-v2/diagnosticTurn';
import { filterTurnServers, type TurnProtocol } from './network-v2/turnCredentials';
import { createFileSink, type FileSink } from './network-v2/fileSink';
import { classifyCandidatePair, createChannels, STUN } from './network-v2/transportRace';
import { transferTiming } from './network-v2/transferTiming';
import { sendVerified, type SenderControl } from './network-v2/verifiedSend';
import { chunkSize, HEADER, MAX_FRAME, validateMeta, WINDOW, type FileMeta } from './network-v2/wire';
import { inspectPeerStats } from './utils/rtcDiagnostics';

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const button = (id: string) => element<HTMLButtonElement>(id);
const remote = element<HTMLTextAreaElement>('remote');
const local = element<HTMLTextAreaElement>('local');
const topology = element<HTMLSelectElement>('topology');
const ice = element<HTMLSelectElement>('ice');
if (import.meta.env.VITE_ENABLE_TURN !== 'true') {
  ice.querySelector('option[value="turn"]')?.remove();
  ice.querySelector('option[value="forced-turn"]')?.remove();
  element('turn-protocol').closest('label')?.setAttribute('hidden', '');
}
const relayFrame = element<HTMLSelectElement>('relay-frame');
const relayChunkSizes = [16, 64, 128, 256].map((kib) => kib * 1024 - HEADER);
const turnProtocol = element<HTMLSelectElement>('turn-protocol');
const storage = element<HTMLSelectElement>('sink');
const report = element<HTMLPreElement>('report');
const maxBytes = 128 * 1024 * 1024;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const now = () => performance.now();
const limitInput = (id: string, max: number) => Math.max(0, Math.min(input(id).valueAsNumber || 0, max));
const entries: object[] = [];

function log(event: string, details: object = {}) {
  entries.push({ ms: Math.round(now()), event, ...details });
  if (entries.length > 250) entries.shift();
  report.textContent = entries.map(entry => JSON.stringify(entry)).join('\n');
  button('download').disabled = false;
}

// Report only fixed diagnostic messages. Browser and storage errors can include
// private addresses or paths, and peer-supplied strings can contain arbitrary data.
const reportReasons = new Set([
  'Cancelled locally', 'Page closed', 'Probe disconnected', 'Data channel closed',
  'Data channel error', 'Data channel lost', 'Data channel buffer stalled',
  'Control channel closed', 'Bulk channel closed', 'Bulk channels not ready',
  'Receiver credit timeout', 'Peer acknowledgement timed out', 'Receiver transfer stalled', 'Receiver storage quota exceeded',
  'Peer cancelled', 'Peer rejected probe; see receiver report', 'SHA-256 mismatch',
  'File size mismatch', 'Invalid end message', 'Unexpected file id',
  'Invalid or duplicate chunk index', 'Invalid chunk size or flags',
  'Receiver credit window exceeded', 'Unexpected credit', 'Invalid credit amount',
  'Unverified receiver completion', 'Invalid frame length', 'Invalid frame flags',
  'File exceeds diagnostic limit', 'ICE gathering timed out',
  'Disconnect before starting a new probe', 'Create an offer first',
  'Connection description too large', 'Paste a valid connection description',
  'Wrong connection description type', 'Receiver setup failed', 'Invalid probe control message',
  'Relay closed', 'Relay socket error', 'Diagnostic peer left', 'Invalid relay control message',
  'Relay requires Network V2', 'Diagnostic peer not ready', 'Diagnostic relay rejected traffic',
  'Relay session probe limit reached', 'Invalid relay probe metadata', 'Diagnostic room unavailable',
  'Relay credit rate exceeded', 'Invalid credit frame', 'Credit exceeds outstanding data',
  'Relay bandwidth quota exceeded', 'Invalid relay ledger', 'Relay requires exactly one paired peer',
  'TURN credentials unavailable', 'Selected TURN protocol unavailable',
  'ROOM_NOT_FOUND', 'ROOM_TAKEN', 'ROOM_FULL', 'INVALID_PIN', 'TOO_MANY_ATTEMPTS',
]);
const browserErrorNames = new Set([
  'AbortError', 'InvalidAccessError', 'InvalidStateError', 'NetworkError',
  'NotAllowedError', 'NotFoundError', 'NotSupportedError', 'OperationError',
  'QuotaExceededError', 'RTCError', 'SecurityError', 'SyntaxError',
]);

function failure(error: unknown) {
  if (error instanceof DOMException && browserErrorNames.has(error.name)) return error.name;
  if (error instanceof Error && reportReasons.has(error.message)) return error.message;
  return 'Unclassified diagnostic error';
}

function saveReport() {
  const payload = JSON.stringify({ schemaVersion: 1, events: entries }, null, 2);
  const url = URL.createObjectURL(new Blob([payload], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'localdrop-diagnostics.json';
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function throughput(bytes: number, start: number) {
  const elapsedMs = Math.round(now() - start);
  return { bytes, elapsedMs, mbps: Number((bytes * 8 / Math.max(1, elapsedMs) / 1000).toFixed(2)) };
}

function createProbe(room?: { code: string; host: boolean }, configuration?: RTCConfiguration) {
  const single = topology.value === 'single';
  const hostOnly = ice.value === 'host';
  const pc = room ? null : new RTCPeerConnection(configuration ?? { iceServers: hostOnly ? [] : STUN });
  let relay: ReturnType<typeof connectDiagnosticRelay> | undefined;
  let relayReady = false;
  let sentProbes = 0;
  let receivedProbes = 0;
  const relayProbeLimit = 4;
  const scope = new AbortController();
  const channels = new Map<string, RTCDataChannel>();
  const labels = single ? ['probe'] : ['control', 'bulk-0', 'bulk-1', 'bulk-2', 'bulk-3'];
  let armed = false;
  let outgoing = false;
  let receiving = false;
  let receiver: ReturnType<typeof createReceiver> | undefined;
  let onControl: ((msg: SenderControl) => void) | undefined;
  let onCredit: ((frame: ArrayBuffer) => void) | undefined;
  let fileId = 0;

  function refresh() {
    if (probe?.signal !== scope.signal) return;
    const ready = !scope.signal.aborted && (room
      ? relayReady && relay?.socket.readyState === WebSocket.OPEN
      : labels.every((label) => channels.get(label)?.readyState === 'open'));
    button('arm').disabled = !ready || receiving || armed || outgoing || (Boolean(room) && receivedProbes >= relayProbeLimit);
    button('send').disabled = !ready || receiving || armed || outgoing || (Boolean(room) && sentProbes >= relayProbeLimit);
    if (ready && !connected) {
      connected = true;
      if (!pc) {
        log('selected-path', { kind: 'ws-relay' });
        element<HTMLOutputElement>('relay-room').textContent = `Paired in room ${room?.code}`;
        return;
      }
      void inspectPeerStats(pc).then((stats) => {
        log('selected-path', { ...classifyCandidatePair(stats.selectedPair), pair: stats.selectedPair,
          iceState: stats.iceState, dtlsState: stats.dtlsState, sctpState: stats.sctpState });
      }, () => log('path-stats-unavailable'));
    }
  }

  let connected = false;
  const control = () => channels.get(labels[0])!;
  function sendControl(packet: object) {
    if (relay) { relay.sendControl(packet); return; }
    if (control().readyState !== 'open') throw new Error('Control channel closed');
    control().send(JSON.stringify(packet));
  }

  function close(reason: string) {
    if (scope.signal.aborted) return;
    scope.abort(new Error(reason));
    pc?.close();
    relay?.socket.close();
    if (room) element<HTMLOutputElement>('relay-room').textContent = 'Relay disconnected. Reset to pair again.';
    log('disconnected', { reason });
    refresh();
  }

  async function receive(meta: FileMeta) {
    const timing = transferTiming();
    const start = now();
    let sink: FileSink | undefined;
    if (!armed || receiving || outgoing) {
      sendControl({ type: 'v2-ready', transferId: meta.transferId, ok: false, reason: 'Receiver must allow a probe' });
      return;
    }
    armed = false;
    receiving = true;
    receivingId = meta.transferId;
    refresh();
    try {
      validateMeta(meta);
      if (meta.size > maxBytes) throw new Error('File exceeds diagnostic limit');
      if (room) {
        if (receivedProbes >= relayProbeLimit) throw new Error('Relay session probe limit reached');
        if (!relayChunkSizes.includes(meta.chunkSize)) throw new Error('Invalid relay probe metadata');
        receivedProbes++;
      }
      const sinkMode = storage.value;
      const writeDelayMs = limitInput('write-delay', 200);
      if (sinkMode === 'opfs') {
        const root = await navigator.storage.getDirectory();
        const key = 'localdrop-probe-' + crypto.randomUUID();
        const handle = await root.getFileHandle(key, { create: true });
        const remove = async () => { await root.removeEntry(key).catch(() => {}); };
        try {
          const output = await createFileSink('probe.bin', '', meta.size, handle);
          sink = {
            ...output,
            write: async (bytes) => {
              if (writeDelayMs) await delay(writeDelayMs);
              await output.write(bytes);
            },
            abort: async () => { try { await output.abort(); } finally { await remove(); } },
            dispose: remove,
          };
        } catch (error) {
          await remove();
          throw error;
        }
      } else {
        sink = {
          write: async () => { if (writeDelayMs) await delay(writeDelayMs); },
          finish: async () => new File([], 'probe.bin'),
          abort: async () => {},
          dispose: async () => {},
        };
      }
      timing.measure('sink-init', now() - start);
      if (scope.signal.aborted) throw scope.signal.reason;
      const payloadStart = now();
      const output = sink;
      let written = 0;
      receiver = createReceiver({
        meta, sink: output, signal: scope.signal, measure: timing.measure,
        // Match the two-full-frame credit cadence used by the standard relay.
        creditBatchBytes: room ? 2 * (MAX_FRAME - HEADER) : undefined,
        sendCredit: (frame) => relay ? relay.socket.send(frame) : control().send(frame),
        record: (bytes) => {
          if (!written && bytes) log('first-chunk-written');
          written += bytes;
        },
        result: (result: ResultMessage) => {
          receiver = undefined;
          receiving = false;
          receivingId = undefined;
          const metrics = throughput(written, payloadStart);
          const reason = result.ok ? undefined : failure(new Error(result.reason));
          log('receive-result', {
            ok: result.ok, reason, sink: sinkMode, writeDelayMs, ...metrics, timing: timing.snapshot(),
          });
          if (result.ok) void output.dispose();
          try {
            if (!scope.signal.aborted) sendControl({ ...result, reason });
          } catch (error) {
            close(failure(error));
          }
          refresh();
        },
      });
      sendControl({ type: 'v2-ready', transferId: meta.transferId, ok: true });
    } catch (error) {
      await sink?.abort();
      receiving = false;
      receivingId = undefined;
      const reason = failure(error);
      log('receive-setup-failed', { reason });
      if (!scope.signal.aborted) sendControl({ type: 'v2-ready', transferId: meta.transferId, ok: false, reason });
      refresh();
    }
  }

  function attach(channel: RTCDataChannel) {
    if (!labels.includes(channel.label) || channels.has(channel.label)) {
      channel.close();
      return;
    }
    channels.set(channel.label, channel);
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => { log('channel-open', { label: channel.label }); refresh(); };
    channel.onclose = () => close('Data channel closed');
    channel.onerror = () => close('Data channel error');
    channel.onmessage = ({ data }) => {
      if (data instanceof ArrayBuffer) {
        if (channel === control() && data.byteLength === 5) onCredit?.(data);
        else receiver?.push(data);
        return;
      }
      if (channel !== control() || typeof data !== 'string' || data.length > 2048) return;
      try { handleControl(JSON.parse(data)); }
      catch { close('Invalid probe control message'); }
    };
    refresh();
  }

  let receivingId: string | undefined;
  function handleControl(packet: unknown) {
    if (!packet || typeof packet !== 'object') return;
    const msg = packet as Record<string, unknown>;
    if (typeof msg.transferId !== 'string' || msg.transferId.length > 128) return;
    if (msg.type === 'v2-meta') {
      void receive(msg as unknown as FileMeta).catch(() => close('Receiver setup failed'));
    } else if (msg.type === 'v2-end') {
      if (msg.transferId === receivingId) receiver?.end(msg as unknown as EndMessage);
    } else if (msg.type === 'v2-cancel') {
      if (msg.transferId === receivingId) {
        if (receiver) void receiver.abort(new Error('Peer cancelled'));
        else close('Peer cancelled');
      }
    } else if (msg.type === 'v2-result' || msg.type === 'v2-ready') {
      const reason = msg.ok ? undefined : 'Peer rejected probe; see receiver report';
      onControl?.({ ...msg, reason } as SenderControl);
    }
  }

  function startChannels() {
    if (!pc) return;
    if (single) attach(pc.createDataChannel(labels[0], { ordered: true }));
    else {
      const { control: ctrl, bulk } = createChannels(pc);
      [ctrl, ...bulk].forEach(attach);
    }
  }

  if (pc) {
    pc.ondatachannel = ({ channel }) => attach(channel);
    pc.onicecandidate = ({ candidate }) => log(candidate ? 'candidate' : 'gathering-complete',
      candidate ? { type: candidate.type, protocol: candidate.protocol } : {});
    pc.onicecandidateerror = ({ errorCode }) => log('ice-error', { errorCode });
    pc.oniceconnectionstatechange = () => log('ice-state', { state: pc.iceConnectionState });
    pc.onconnectionstatechange = () => log('connection-state', { state: pc.connectionState });
  }
  if (room) {
    relay = connectDiagnosticRelay(room.code, room.host, {
      admitted: () => {
        element<HTMLOutputElement>('relay-room').textContent = room.host
          ? `Room ${room.code}. Waiting for the other diagnostic page.` : 'Waiting for the other diagnostic page…';
      },
      paired: () => { relayReady = true; refresh(); },
      heartbeat: (elapsedMs) => log('relay-heartbeat', { elapsedMs }),
      message: handleControl,
      binary: (frame) => {
        if (frame.byteLength === 5) onCredit?.(frame);
        else receiver?.push(frame);
      },
      failure: close,
    });
  }

  async function send(file: File) {
    if (file.size > maxBytes) throw new Error('File exceeds diagnostic limit');
    if (receiving || outgoing || armed) return;
    const timing = transferTiming();
    if (relay) {
      if (!relayReady || relay.socket.readyState !== WebSocket.OPEN) throw new Error('Diagnostic peer not ready');
      if (sentProbes >= relayProbeLimit) throw new Error('Relay session probe limit reached');
      sentProbes++;
    }
    const path: TransferPath = relay ? { kind: 'relay', socket: relay.socket } : single
      ? { kind: 'rtc-single', channel: control() }
      : { kind: 'rtc', bulk: labels.slice(1).map((label) => channels.get(label)!) };
    const meta: FileMeta = {
      transferId: crypto.randomUUID(), fileId: fileId++ & 0xffff,
      name: 'probe.bin', mime: 'application/octet-stream', size: file.size, chunkSize: relay ? Number(relayFrame.value) * 1024 - HEADER : chunkSize(pc ?? undefined),
    };
    outgoing = true;
    refresh();
    const start = now();
    let payloadStart = start;
    let confirmed = 0;
    log('send-start', { bytes: file.size, chunkSize: meta.chunkSize, windowBytes: WINDOW });
    try {
      await sendVerified({
        meta, file, path, signal: scope.signal, sendControl, measure: timing.measure,
        subscribe: (controlHandler, creditHandler) => {
          onControl = controlHandler;
          onCredit = creditHandler;
          return () => { onControl = undefined; onCredit = undefined; };
        },
        phase: (phase) => {
          if (phase === 'payload-start') payloadStart = now();
          log(phase, relay ? { queuedBytes: relay.socket.bufferedAmount, confirmedBytes: confirmed } : {});
        },
        record: (bytes) => { confirmed += bytes; },
        invalidatePath: () => {},
      });
      log('send-result', {
        ok: true, ...throughput(confirmed, payloadStart),
        totalMs: Math.round(now() - start), timing: timing.snapshot(),
      });
    } catch (error) {
      const reason = failure(error);
      log('send-result', { ok: false, reason, ...throughput(confirmed, payloadStart), timing: timing.snapshot() });
      close(reason);
    } finally {
      outgoing = false;
      refresh();
    }
  }

  const browser = navigator.userAgent.match(/(?:Firefox|EdgA?|Chrome|Version)\/\d+/)?.[0];
  const platform = /Android|iPhone|iPad|Windows|Macintosh|Linux/.exec(navigator.userAgent)?.[0];
  log('start', { platform, iceMode: room ? undefined : ice.value, topology: room ? 'relay' : single ? 'single' : 'striped', hostOnly: room ? undefined : hostOnly, browser });
  return { pc, signal: scope.signal, startChannels, send, close, arm: () => { armed = true; refresh(); } };
}

let probe: ReturnType<typeof createProbe> | undefined;
let preparingTurn: AbortController | undefined;

async function exportDescription(current: NonNullable<typeof probe>, description: RTCSessionDescriptionInit) {
  if (!current.pc) return;
  const { pc, signal } = current;
  await pc.setLocalDescription(description);
  await new Promise<void>((resolve, reject) => {
    function finish(error?: Error) {
      clearTimeout(timeout);
      pc.removeEventListener('icegatheringstatechange', check);
      signal.removeEventListener('abort', aborted);
      if (error) reject(error);
      else resolve();
    }
    const check = () => { if (pc.iceGatheringState === 'complete') finish(); };
    const aborted = () => finish(new Error('Probe disconnected'));
    const timeout = setTimeout(() => finish(new Error('ICE gathering timed out')), 20000);
    pc.addEventListener('icegatheringstatechange', check);
    signal.addEventListener('abort', aborted);
    if (signal.aborted) aborted(); else check();
  });
  if (!signal.aborted) local.value = JSON.stringify(pc.localDescription);
}

async function importDescription(current: NonNullable<typeof probe>, type: 'offer' | 'answer') {
  const value = remote.value;
  remote.value = '';
  if (value.length > 64 * 1024) throw new Error('Connection description too large');
  let description: RTCSessionDescriptionInit;
  try { description = JSON.parse(value); }
  catch { throw new Error('Paste a valid connection description'); }
  if (description?.type !== type || typeof description.sdp !== 'string') throw new Error('Wrong connection description type');
  const ms = limitInput('signal-delay', 15000);
  if (ms) await delay(ms);
  if (current.signal.aborted) throw new Error('Probe disconnected');
  if (!current.pc) return;
  await current.pc.setRemoteDescription(description);
  log('description-applied', { type, addedDelayMs: ms });
}

function reset(reason: string) {
  preparingTurn?.abort();
  preparingTurn = undefined;
  probe?.close(reason);
  probe = undefined;
  topology.disabled = ice.disabled = turnProtocol.disabled = false;
  local.value = remote.value = input('room-code').value = '';
  element<HTMLOutputElement>('relay-room').textContent = '';
}

function action(id: string, run: () => Promise<void>) {
  button(id).onclick = () => {
    button(id).disabled = true;
    void run().catch((error) => {
      // SDP exceptions can include private offer/answer contents.
      log('action-failed', { action: id, reason: failure(error) });
    }).finally(() => { button(id).disabled = false; });
  };
}

function begin(room?: { code: string; host: boolean }, configuration?: RTCConfiguration) {
  if (probe && !probe.signal.aborted) throw new Error('Disconnect before starting a new probe');
  probe = createProbe(room, configuration);
  topology.disabled = ice.disabled = turnProtocol.disabled = true;
  return probe;
}

async function beginRtc() {
  if (preparingTurn || (probe && !probe.signal.aborted)) throw new Error('Disconnect before starting a new probe');
  const mode = ice.value;
  if (mode !== 'turn' && mode !== 'forced-turn') return begin();
  const controller = new AbortController();
  preparingTurn = controller;
  topology.disabled = ice.disabled = turnProtocol.disabled = true;
  const protocol = turnProtocol.value as TurnProtocol;
  const started = now();
  try {
    const response = await fetchDiagnosticTurn(newRoomCode(), controller.signal);
    controller.signal.throwIfAborted();
    const forced = mode === 'forced-turn';
    log('turn-credentials', { status: response.status, requestMs: response.requestMs, elapsedMs: Math.round(now() - started),
      lifetimeSeconds: response.expiresAt === null ? null : Math.round((response.expiresAt - Date.now()) / 1000),
      protocol, forced });
    if (response.status !== 'turn-issued') throw new Error('TURN credentials unavailable');
    const servers = filterTurnServers(response.iceServers, protocol, forced === false);
    if (!servers.some((server) => server.username)) throw new Error('Selected TURN protocol unavailable');
    return begin(undefined, { iceServers: servers, iceTransportPolicy: forced ? 'relay' : 'all' });
  } finally {
    if (preparingTurn === controller) {
      preparingTurn = undefined;
      if (!probe || probe.signal.aborted) topology.disabled = ice.disabled = turnProtocol.disabled = false;
    }
  }
}

action('offer', async () => {
  const current = await beginRtc();
  if (!current.pc) return;
  current.startChannels();
  await exportDescription(current, await current.pc.createOffer());
});
action('answer', async () => {
  const current = await beginRtc();
  if (!current.pc) return;
  await importDescription(current, 'offer');
  await exportDescription(current, await current.pc.createAnswer());
});
action('apply', async () => {
  if (!probe) throw new Error('Create an offer first');
  await importDescription(probe, 'answer');
  local.value = '';
});
function newRoomCode() {
  return String(1000 + Math.floor(crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32 * 9000));
}

function startRelay(host: boolean) {
  if (topology.value !== 'relay') return;
  const code = host
    ? newRoomCode()
    : input('room-code').value.trim();
  if (!/^\d{4}$/.test(code)) throw new Error('INVALID_PIN');
  begin({ code, host });
  input('room-code').value = '';
  element<HTMLOutputElement>('relay-room').textContent = host ? 'Creating relay room…' : 'Joining relay room…';
}

action('host-relay', async () => startRelay(true));
action('join-relay', async () => startRelay(false));
topology.onchange = () => {
  element('rtc-settings').hidden = topology.value === 'relay';
  element('relay-settings').hidden = topology.value !== 'relay';
};
button('send').onclick = () => {
  const file = input('file').files?.[0];
  if (!file || !probe) { log('select-a-test-file'); return; }
  void probe.send(file).catch((error) => log('send-failed', { reason: failure(error) }));
};
button('arm').onclick = () => probe?.arm();
button('download').onclick = saveReport;
button('reset').onclick = () => reset('Cancelled locally');
window.addEventListener('pagehide', () => reset('Page closed'));
