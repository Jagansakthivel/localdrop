import {
  ackMatches,
  isRelayError,
  matchesTransfer,
  peerVersion,
} from '../network-v2/protocol';
import { createSerialSignals } from '../network-v2/serialSignals';
import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import type { ConnectionState, TransportType, NetworkDiagnostics } from '../types/network';
import { createReconnectingSocket } from '../utils/reconnectingSocket';
import { IceCandidateQueue } from '../utils/iceCandidateQueue';
import { attachRtcDiagnostics } from '../utils/rtcDiagnostics';
import { isSocketOpen, isValidPin, networkLog, pingBackendHealth } from '../utils/network';
import { createConnectionProfiler } from '../utils/connectionProfiler';
import { createConnectionResilience } from '../utils/connectionResilience';
import {
  HEADER,
  MAX_FRAME,
  VERSION,
  chunkSize as computeRtcChunkSize,
  validateMeta,
  type FileMeta,
} from '../network-v2/wire';
import { createFileSink, pruneOrphanedOpfsFiles, type FileSink } from '../network-v2/fileSink';
import { clearMatchingTransfer } from '../utils/fileSafety';
import { sendVerified, type SenderControl } from '../network-v2/verifiedSend';
import { waitChannel, waitSocket } from '../network-v2/flow';
import { createReceiver, type EndMessage, type ResultMessage } from '../network-v2/engine';
import { createSampler } from '../network-v2/telemetry';
import {
  STUN,
  createChannels,
  fetchIceServersWithExpiry,
  prewarmCertificate,
  rtcConfiguration,
  selectedPath,
  startTransportRace,
} from '../network-v2/transportRace';
import { createPathAgreement, type CommittedPath } from '../network-v2/pathAgreement';
import { createSpeedTrace, traceIce } from '../network-v2/speedTrace';
import { OfferReservations } from '../network-v2/offerReservations';
import { createBatchAdmission } from '../network-v2/batchSafety';
import { SessionLease } from '../network-v2/sessionLease';
import { affectedByPathLoss, ReceiverSlot, type TransferAttempt } from '../network-v2/lifecycle';
import { turnNeedsRefresh } from '../network-v2/turnCredentials';
import { elapsedMs, mergeTransferDiagnostics } from '../utils/diagnosticsSafety';

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: 'mobile' | 'desktop';
  networkVersion?: number;
}

export interface ReceivedItem {
  id: string;
  kind: 'file' | 'text';
  file?: File;
  text?: string;
  direction: 'sent' | 'received';
  timestamp: number;
}

export interface TransferTelemetry {
  transferId?: string;
  direction: 'sending' | 'receiving';
  fileName: string;
  fileMime: string;
  totalBytes: number;
  transferredBytes: number;
  speedMbps: number;
  etaSeconds: number;
  progress: number;
  awaitingApproval?: boolean;
}

export interface IncomingFileOffer {
  offerId: string;
  transferId?: string;
  name: string;
  size: number;
  mime: string;
  fromName: string;
  senderDeviceType?: 'mobile' | 'desktop';
}

const CHUNK_SIZE = 64 * 1024;
const NEGOTIATION_TIMEOUT_MS = 8000;
const PAIRING_TIMEOUT_MS = 15000;
const OFFER_APPROVAL_TIMEOUT_MS = 30000;
const ACK_TIMEOUT_MS = 10000;

function detectBrowserName(): string {
  const ua = navigator.userAgent;
  if ((navigator as unknown as { brave?: unknown }).brave) return 'Brave';
  if (/Edg\//i.test(ua)) return 'Edge';
  if (/Firefox\//i.test(ua)) return 'Firefox';
  if (/Chrome\//i.test(ua) && !/Edg\//i.test(ua)) return 'Chrome';
  if (/Safari\//i.test(ua) && !/Chrome\//i.test(ua)) return 'Safari';
  return 'Browser';
}

function detectDevice(): { name: string; deviceType: 'mobile' | 'desktop' } {
  const ua = navigator.userAgent;
  const browser = detectBrowserName();
  const isMobile = /Android|iPhone|iPad|iPod/i.test(ua);
  if (/Android/i.test(ua)) return { name: `Android • ${browser}`, deviceType: 'mobile' };
  if (/iPhone|iPad/i.test(ua)) return { name: `iPhone • ${browser}`, deviceType: 'mobile' };
  if (/Linux/i.test(ua)) return { name: `Linux PC • ${browser}`, deviceType: 'desktop' };
  if (/Win/i.test(ua)) return { name: `Windows PC • ${browser}`, deviceType: 'desktop' };
  if (/Mac/i.test(ua)) return { name: `MacBook • ${browser}`, deviceType: 'desktop' };
  return {
    name: `${isMobile ? 'Mobile' : 'Computer'} • ${browser}`,
    deviceType: isMobile ? 'mobile' : 'desktop',
  };
}

function generateSecurePin(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return String(1000 + (buf[0] % 9000));
  }
  return Math.floor(1000 + Math.random() * 9000).toString();
}

export function usePeerDrop(wsUrl: string) {
  const [wsConnected, setWsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [transport, setTransport] = useState<TransportType>(null);
  const [connectedPeer, setConnectedPeer] = useState<PeerInfo | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [localDeviceName] = useState<string>(() => detectDevice().name);

  // Host 4-digit PIN for this device
  const [pin, setPin] = useState<string>(() => generateSecurePin());
  const pinRef = useRef<string>(pin);
  pinRef.current = pin;
  const pinRetryCountRef = useRef<number>(0);

  const [autoAccept, setAutoAccept] = useState<boolean>(true);
  const [totalSessionBytes, setTotalSessionBytes] = useState<number>(0);
  const [remoteClipboard, setRemoteClipboard] = useState<string>('');
  const [localClipboard, setLocalClipboard] = useState<string>('');
  const [sharedItems, setSharedItems] = useState<ReceivedItem[]>([]);
  const [transferProgress, setTransferProgress] = useState<number>(0);
  const [telemetry, setTelemetry] = useState<TransferTelemetry | null>(null);
  const [incomingOffer, setIncomingOffer] = useState<IncomingFileOffer | null>(null);
  const [statusText, setStatusText] = useState<string>('Starting LocalDrop server...');

  // Diagnostics tracking
  const [diagnostics, setDiagnostics] = useState<NetworkDiagnostics>({
    signalingConnected: false,
    peerDiscovered: false,
    connectionState: 'offline',
    transport: null,
    iceState: null,
    peerState: null,
    channelState: null,
    lastError: null,
  });

  // Internal references
  const socketManagerRef = useRef<ReturnType<typeof createReconnectingSocket> | null>(null);
  const myIdRef = useRef<string>('');
  const activeRoomRef = useRef<string>(pin);
  const pendingPinRef = useRef<string | null>(null);
  const pairingTimeoutTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const negotiationTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const iceQueueRef = useRef<IceCandidateQueue>(new IceCandidateQueue());
  const rtcCleanupRef = useRef<(() => void) | null>(null);
  const targetPeerRef = useRef<PeerInfo | null>(null);
  const sessionIdRef = useRef<string>(crypto.randomUUID());

  const cancelFlagRef = useRef<boolean>(false);
  const autoAcceptRef = useRef<boolean>(autoAccept);
  const isTransferActiveRef = useRef<boolean>(false);
  const profilerRef = useRef<ReturnType<typeof createConnectionProfiler> | null>(null);
  const negotiatingPeerIdRef = useRef<string | null>(null);
  const relayReadyRef = useRef<boolean>(false);
  const hasConnectedOnceRef = useRef<boolean>(false);
  const resumeTokenRef = useRef<string | null>(null);
  const authenticatedSessionRef = useRef<boolean>(false);
  const directEstablishedRef = useRef<boolean>(false);
  const resilienceRef = useRef<ReturnType<typeof createConnectionResilience> | null>(null);
  const recoveryLockRef = useRef<Promise<void> | null>(null);
  const sessionGenerationRef = useRef<number>(0);
  const connectionStateRef = useRef<ConnectionState>(connectionState);
  const wsConnectedRef = useRef<boolean>(wsConnected);
  const backpressureWaiterRef = useRef<(() => void) | null>(null);

  // Network v2 state refs
  const serverV2Ref = useRef<boolean>(false);
  const peerNetworkVersionRef = useRef<number>(1);
  const iceServersRef = useRef<RTCIceServer[]>(STUN);
  const controlChannelRef = useRef<RTCDataChannel | null>(null);
  const bulkChannelsRef = useRef<Map<number, RTCDataChannel>>(new Map());
  const agreementRef = useRef<ReturnType<typeof createPathAgreement> | null>(null);
  const raceRef = useRef<ReturnType<typeof startTransportRace> | null>(null);
  const nextFileIdRef = useRef<number>(0);
  const approvedOffersRef = useRef<
    Map<string, { name: string; size: number; mime: string; at: number }>
  >(new Map());
  const incomingOfferRef = useRef<boolean>(false);
  const earlySignalsRef = useRef<Array<{ msg: Record<string, unknown>; at: number }>>([]);
  const signalsRef = useRef<ReturnType<typeof createSerialSignals> | null>(null);
  if (!signalsRef.current) {
    signalsRef.current = createSerialSignals((error) =>
      networkLog('Signal processing failed:', error instanceof Error ? error.name : 'unknown')
    );
  }
  const incomingReceiverRef = useRef<ReturnType<typeof createReceiver> | null>(null);
  const incomingReceiverIdRef = useRef<string | null>(null);
  const opfsSinksRef = useRef<Map<string, FileSink>>(new Map());
  const transferControllerRef = useRef<AbortController | null>(null);
  const activeOutgoingIdRef = useRef<string | null>(null);
  const senderSubsRef = useRef<
    Set<{
      control: (packet: SenderControl) => void;
      credit: (frame: ArrayBuffer) => void;
    }>
  >(new Set());
  const samplerRef = useRef<ReturnType<typeof createSampler> | null>(null);
  const pairingStartMsRef = useRef<number>(0);
  const turnFetchPromiseRef = useRef<Promise<void> | null>(null);
  const turnExpiresAtRef = useRef<number | null>(null);
  const relayPingIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const offerResRef = useRef(new OfferReservations());
  const receiverSlotRef = useRef(new ReceiverSlot());
  const sessionLeaseRef = useRef(new SessionLease());
  const activeOutgoingAttemptRef = useRef<TransferAttempt | null>(null);
  const relayAdmissionRef = useRef(createBatchAdmission(250));

  const isV2Active = useCallback(
    () => serverV2Ref.current && peerNetworkVersionRef.current === VERSION,
    []
  );

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    wsConnectedRef.current = wsConnected;
  }, [wsConnected]);

  useEffect(() => {
    autoAcceptRef.current = autoAccept;
  }, [autoAccept]);

  // Synchronize diagnostics state without overwriting live connection fields from stale closures
  const updateDiagnostics = useCallback(
    (overrides?: Partial<NetworkDiagnostics>) => {
      setDiagnostics((prev) => {
        if (
          overrides &&
          typeof overrides.receiverConfirmedBytes === 'number' &&
          typeof overrides.transferElapsedMs === 'number' &&
          Object.keys(overrides).length === 2
        ) {
          return mergeTransferDiagnostics(prev, {
            receiverConfirmedBytes: overrides.receiverConfirmedBytes,
            transferElapsedMs: overrides.transferElapsedMs,
          });
        }
        return {
          ...prev,
          signalingConnected: wsConnectedRef.current,
          peerDiscovered: Boolean(targetPeerRef.current),
          connectionState: connectionStateRef.current,
          transport,
          iceState: pcRef.current?.iceConnectionState ?? null,
          peerState: pcRef.current?.connectionState ?? null,
          channelState:
            agreementRef.current?.current === 'rtc'
              ? controlChannelRef.current?.readyState ?? null
              : dcRef.current?.readyState ?? null,
          lastError,
          ...overrides,
        };
      });
    },
    [transport, lastError]
  );

  useEffect(() => {
    updateDiagnostics();
  }, [updateDiagnostics]);

  const pendingOfferResolverRef = useRef<{
    offerId: string;
    resolve: (accepted: boolean) => void;
  } | null>(null);

  const pendingAckResolverRef = useRef<{
    transferId: string;
    expectedBytes: number;
    resolve: (ok: boolean) => void;
  } | null>(null);

  const incomingMetaRef = useRef<{
    transferId: string;
    name: string;
    size: number;
    mime: string;
  } | null>(null);

  const incomingBuffersRef = useRef<ArrayBuffer[]>([]);
  const receivedBytesRef = useRef<number>(0);
  const transferStartRef = useRef<number>(0);

  // Unified protocol sender: in v2 uses strictly the committed control path; in v1 uses DC if open else relay
  const sendJsonPacket = useCallback((payload: Record<string, unknown>) => {
    const committed = agreementRef.current?.current;
    if (committed === 'rtc') {
      if (controlChannelRef.current?.readyState === 'open') {
        try {
          controlChannelRef.current.send(JSON.stringify(payload));
          return true;
        } catch {
          return false;
        }
      }
      return false;
    }
    if (committed === 'relay') {
      if (socketManagerRef.current) {
        return socketManagerRef.current.send(JSON.stringify({ type: 'relay', payload }));
      }
      return false;
    }

    if (dcRef.current?.readyState === 'open') {
      try {
        dcRef.current.send(JSON.stringify(payload));
        return true;
      } catch (err) {
        networkLog('DataChannel send failed, falling back to relay', err);
      }
    }

    if (socketManagerRef.current) {
      return socketManagerRef.current.send(
        JSON.stringify({ type: 'relay', payload })
      );
    }
    return false;
  }, []);

  const sendSignal = useCallback((to: string, signal: unknown) => {
    const ok = socketManagerRef.current?.send(
      JSON.stringify({
        type: 'signal',
        to,
        sessionId: sessionIdRef.current,
        signal,
      })
    );
    if (!ok) {
      networkLog('Failed to send WebRTC signal: socket not open');
    }
  }, []);

  const closeRtcResources = useCallback(() => {
    if (negotiationTimerRef.current) {
      clearTimeout(negotiationTimerRef.current);
      negotiationTimerRef.current = null;
    }

    if (
      affectedByPathLoss(
        activeOutgoingAttemptRef.current,
        'rtc',
        sessionLeaseRef.current.epoch
      )
    ) {
      transferControllerRef.current?.abort(new Error('RTC path closed'));
    }
    if (
      affectedByPathLoss(
        receiverSlotRef.current.current,
        'rtc',
        sessionLeaseRef.current.epoch
      )
    ) {
      receiverSlotRef.current.cancel(receiverSlotRef.current.current!.id, new Error('RTC path closed'));
    }

    if (rtcCleanupRef.current) {
      rtcCleanupRef.current();
      rtcCleanupRef.current = null;
    }

    if (dcRef.current) {
      dcRef.current.onopen = null;
      dcRef.current.onclose = null;
      dcRef.current.onmessage = null;
      dcRef.current.onerror = null;
      try {
        dcRef.current.close();
      } catch {
        // ignore
      }
      dcRef.current = null;
    }

    if (controlChannelRef.current) {
      controlChannelRef.current.onopen = null;
      controlChannelRef.current.onclose = null;
      controlChannelRef.current.onmessage = null;
      controlChannelRef.current.onerror = null;
      try {
        controlChannelRef.current.close();
      } catch {
        // ignore
      }
      controlChannelRef.current = null;
    }

    for (const ch of bulkChannelsRef.current.values()) {
      ch.onopen = null;
      ch.onclose = null;
      ch.onmessage = null;
      ch.onerror = null;
      try {
        ch.close();
      } catch {
        // ignore
      }
    }
    bulkChannelsRef.current.clear();

    if (pcRef.current) {
      pcRef.current.onicecandidate = null;
      pcRef.current.ondatachannel = null;
      pcRef.current.onconnectionstatechange = null;
      pcRef.current.oniceconnectionstatechange = null;
      try {
        pcRef.current.close();
      } catch {
        // ignore
      }
      pcRef.current = null;
    }

    iceQueueRef.current.clear();
    signalsRef.current?.reset();
    earlySignalsRef.current = [];
    if (relayPingIntervalRef.current) {
      clearInterval(relayPingIntervalRef.current);
      relayPingIntervalRef.current = null;
    }
    negotiatingPeerIdRef.current = null;
  }, []);

  // Teardown WebRTC peer resources + agreement/race cleanly
  const teardownPeerConnection = useCallback(() => {
    raceRef.current?.stop();
    raceRef.current = null;
    agreementRef.current?.close();
    agreementRef.current = null;
    closeRtcResources();
  }, [closeRtcResources]);

  // Declare established connection
  const markConnected = useCallback(
    (mode: 'direct' | 'relayed', peer: PeerInfo) => {
      if (mode === 'direct' || !agreementRef.current) {
        negotiatingPeerIdRef.current = null;
      }
      if (negotiationTimerRef.current) {
        clearTimeout(negotiationTimerRef.current);
        negotiationTimerRef.current = null;
      }
      if (pairingTimeoutTimerRef.current) {
        clearTimeout(pairingTimeoutTimerRef.current);
        pairingTimeoutTimerRef.current = null;
      }

      setConnectedPeer(peer);
      targetPeerRef.current = peer;
      authenticatedSessionRef.current = true;
      if (mode === 'direct') {
        directEstablishedRef.current = true;
      }
      setConnectionState(mode);
      setTransport(mode === 'direct' ? 'webrtc' : 'websocket');
      setLastError(null);
      setStatusText(
        mode === 'direct'
          ? `Paired with ${peer.name}`
          : `Relayed with ${peer.name} (Direct WebRTC unavailable)`
      );
      networkLog(`Connection established (${mode}) with`, peer.name);

      profilerRef.current?.mark('UI connected');
      profilerRef.current?.report();
      if (mode === 'direct') {
        resilienceRef.current?.notify();
      }
    },
    []
  );

  // Fallback to WebSocket relay if direct WebRTC negotiation fails or stalls
  const fallbackToRelay = useCallback(() => {
    if (isV2Active()) {
      raceRef.current?.check();
      return;
    }
    if (!targetPeerRef.current) return;
    const socket = socketManagerRef.current?.getSocket();
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      networkLog('Cannot fall back to relay: socket not open');
      return;
    }
    profilerRef.current?.mark('relay confirmed');
    networkLog('Falling back to WebSocket room relay');
    sendJsonPacket({ type: 'transport-switch', transport: 'relayed' });
    markConnected('relayed', targetPeerRef.current);
  }, [markConnected, sendJsonPacket]);

  // Handle incoming protocol messages (from DataChannel or WebSocket relay)
  const handleProtocolJson = useCallback(
    (msg: Record<string, unknown>) => {
      if (!msg || typeof msg.type !== 'string') return;

      if (msg.type === 'clipboard-sync') {
        setRemoteClipboard(String(msg.text || ''));
      } else if (msg.type === 'request-clipboard') {
        // A remote request never authorizes reading the local system clipboard.
        return;
      } else if (msg.type === 'shared-text') {
        setSharedItems((prev) => [
          {
            id: crypto.randomUUID(),
            kind: 'text',
            text: String(msg.text || ''),
            direction: 'received',
            timestamp: Date.now(),
          },
          ...prev,
        ]);
      } else if (msg.type === 'file-offer') {
        const offerId = typeof msg.offerId === 'string' ? msg.offerId : '';
        const transferId = typeof msg.transferId === 'string' ? msg.transferId : '';
        const name = typeof msg.name === 'string' ? msg.name.slice(0, 255) : '';
        const size = Number(msg.size);
        const mime = typeof msg.mime === 'string' ? msg.mime.slice(0, 128) : 'application/octet-stream';
        if (!offerId || !name || !Number.isSafeInteger(size) || size < 0) return;

        if (autoAcceptRef.current) {
          if (transferId) {
            const gen = sessionGenerationRef.current;
            const reserved = offerResRef.current.reserve({
              offerId,
              transferId,
              generation: gen,
              name,
              size,
              mime,
              deadline: performance.now() + 65_000,
              accepted: autoAcceptRef.current,
            });
            if (!reserved) {
              sendJsonPacket({
                type: 'file-offer-response',
                offerId,
                accepted: false,
              });
              return;
            }
            approvedOffersRef.current.set(transferId, { name, size, mime, at: Date.now() });
          }
          sendJsonPacket({
            type: 'file-offer-response',
            offerId,
            accepted: true,
          });
        } else {
          if (transferId) {
            const reserved = offerResRef.current.reserve({
              offerId,
              transferId,
              generation: sessionGenerationRef.current,
              name,
              size,
              mime,
              deadline: performance.now() + 65_000,
              accepted: false,
            });
            if (!reserved) {
              sendJsonPacket({
                type: 'file-offer-response',
                offerId,
                accepted: false,
              });
              return;
            }
          }
          incomingOfferRef.current = true;
          setIncomingOffer({
            offerId,
            transferId: transferId || undefined,
            name,
            size,
            mime,
            fromName: targetPeerRef.current?.name || 'Peer',
            senderDeviceType:
              (msg.senderDeviceType as 'mobile' | 'desktop') ||
              targetPeerRef.current?.deviceType ||
              'desktop',
          });
        }
      } else if (msg.type === 'file-offer-response') {
        const resolver = pendingOfferResolverRef.current;
        if (resolver && resolver.offerId === msg.offerId) {
          resolver.resolve(Boolean(msg.accepted));
          pendingOfferResolverRef.current = null;
        }
      } else if (msg.type === 'v2-meta') {
        const meta: FileMeta = {
          transferId: String(msg.transferId || ''),
          fileId: Number(msg.fileId),
          name: String(msg.name || ''),
          mime: String(msg.mime || 'application/octet-stream'),
          size: Number(msg.size),
          chunkSize: Number(msg.chunkSize),
        };
        const committed = agreementRef.current?.current;
        if (!committed || !agreementRef.current?.canReceive(committed)) {
          sendJsonPacket({
            type: 'v2-ready',
            transferId: meta.transferId,
            ok: false,
            reason: 'Transport path not committed',
          });
          return;
        }
        const approved = approvedOffersRef.current.get(meta.transferId);
        const consumed = offerResRef.current.consume(
          meta.transferId,
          sessionGenerationRef.current,
          meta.name,
          meta.size,
          meta.mime
        );
        if (
          !approved ||
          !consumed ||
          approved.name !== meta.name ||
          approved.size !== meta.size ||
          incomingReceiverRef.current ||
          receiverSlotRef.current.current
        ) {
          sendJsonPacket({
            type: 'v2-ready',
            transferId: meta.transferId,
            ok: false,
            reason:
              incomingReceiverRef.current || receiverSlotRef.current.current
                ? 'Receiver busy'
                : 'Unapproved transfer',
          });
          return;
        }
        try {
          validateMeta(meta);
        } catch {
          sendJsonPacket({
            type: 'v2-ready',
            transferId: meta.transferId,
            ok: false,
            reason: 'Invalid metadata',
          });
          return;
        }

        approvedOffersRef.current.delete(meta.transferId);
        // Reserve immediately to prevent duplicate meta racing sink open
        const slot = receiverSlotRef.current.reserve({
          id: meta.transferId,
          path: committed,
          generation: sessionLeaseRef.current.epoch,
        });
        incomingReceiverIdRef.current = meta.transferId;
        const receiverStartedAt = performance.now();
        const receiveTrace = createSpeedTrace('receive');
        receiveTrace('v2-meta');
        let firstChunkTraced = false;
        const genAtStart = sessionGenerationRef.current;
        const ac = new AbortController();
        const sampler = createSampler(meta.size, (s) => {
          if (incomingReceiverIdRef.current !== meta.transferId) return;
          setTransferProgress(s.progress);
          setTelemetry({
            transferId: meta.transferId,
            direction: 'receiving',
            fileName: meta.name,
            fileMime: meta.mime,
            totalBytes: meta.size,
            transferredBytes: s.bytes,
            speedMbps: Number((s.speedBps / (1024 * 1024)).toFixed(2)),
            etaSeconds: Number.isFinite(s.etaSeconds) ? s.etaSeconds : 0,
            progress: s.progress,
          });
        });

        setStatusText(`Receiving ${meta.name}...`);
        setTransferProgress(1);

        void createFileSink(meta.name, meta.mime, meta.size)
          .then(async (sink) => {
            if (
              genAtStart !== sessionGenerationRef.current ||
              incomingReceiverIdRef.current !== meta.transferId ||
              !receiverSlotRef.current.valid(slot) ||
              ac.signal.aborted
            ) {
              receiverSlotRef.current.release(slot);
              await sink.abort().catch(() => {});
              sampler.stop(false);
              return;
            }
            opfsSinksRef.current.set(meta.transferId, sink);

            const receiver = createReceiver({
              meta,
              sink,
              signal: ac.signal,
              sendCredit: (creditBuf) => {
                if (committed === 'rtc') {
                  if (controlChannelRef.current?.readyState === 'open') {
                    controlChannelRef.current.send(creditBuf);
                  }
                } else {
                  socketManagerRef.current?.send(creditBuf);
                }
              },
              record: (delta) => {
                if (!firstChunkTraced && delta > 0) {
                  firstChunkTraced = true;
                  receiveTrace('first-chunk');
                }
                sampler.record(delta, 0);
              },
              result: (res: ResultMessage, file?: File) => {
                sampler.stop(res.ok);
                receiveTrace('ack-sent');
                receiverSlotRef.current.release(slot);
                if (incomingReceiverIdRef.current === meta.transferId) {
                  incomingReceiverRef.current = null;
                  incomingReceiverIdRef.current = null;
                }
                sendJsonPacket({ ...res });
                if (res.ok && file && genAtStart === sessionGenerationRef.current) {
                  receiveTrace('sink-finish');
                  setTotalSessionBytes((b) => b + meta.size);
                  setSharedItems((prev) => [
                    {
                      id: meta.transferId,
                      kind: 'file',
                      file,
                      direction: 'received',
                      timestamp: Date.now(),
                    },
                    ...prev,
                  ]);
                  setTransferProgress(100);
                  setStatusText(`Received ${meta.name}`);
                  updateDiagnostics({
                    receiverConfirmedBytes: res.size,
                    transferElapsedMs: elapsedMs(receiverStartedAt),
                  });
                } else {
                  opfsSinksRef.current.delete(meta.transferId);
                  setTransferProgress(0);
                  setStatusText(res.reason || 'Transfer failed');
                }
                const tid = meta.transferId;
                setTimeout(() => setTelemetry((prev) => clearMatchingTransfer(prev, tid)), 1200);
              },
            });

            incomingReceiverRef.current = {
              push: receiver.push,
              end: receiver.end,
              abort: (reason?: unknown) => {
                ac.abort(reason);
                return receiver.abort(reason);
              },
            };

            sendJsonPacket({ type: 'v2-ready', transferId: meta.transferId, ok: true });
          })
          .catch((err) => {
            sampler.stop(false);
            if (incomingReceiverIdRef.current === meta.transferId) {
              incomingReceiverIdRef.current = null;
            }
            sendJsonPacket({
              type: 'v2-ready',
              transferId: meta.transferId,
              ok: false,
              reason: err instanceof Error ? err.message : 'Storage unavailable',
            });
          });
      } else if (msg.type === 'v2-ready' || msg.type === 'v2-result') {
        for (const sub of senderSubsRef.current) {
          sub.control(msg as unknown as SenderControl);
        }
      } else if (msg.type === 'v2-end') {
        if (
          incomingReceiverRef.current &&
          typeof msg.transferId === 'string' &&
          msg.transferId === incomingReceiverIdRef.current
        ) {
          incomingReceiverRef.current.end(msg as unknown as EndMessage);
        }
      } else if (msg.type === 'v2-cancel') {
        const tid = typeof msg.transferId === 'string' ? msg.transferId : '';
        if (tid && tid === incomingReceiverIdRef.current && incomingReceiverRef.current) {
          void incomingReceiverRef.current.abort(new Error(String(msg.reason || 'Peer cancelled')));
          incomingReceiverRef.current = null;
          incomingReceiverIdRef.current = null;
        }
        if (tid && tid === activeOutgoingIdRef.current && transferControllerRef.current) {
          transferControllerRef.current.abort(new Error(String(msg.reason || 'Peer cancelled')));
        }
        setTransferProgress(0);
        setTelemetry(null);
        setStatusText('Transfer cancelled');
      } else if (msg.type === 'file-meta') {
        const transferId = String(msg.transferId || crypto.randomUUID());
        incomingMetaRef.current = {
          transferId,
          name: String(msg.name),
          size: Number(msg.size),
          mime: String(msg.mime),
        };
        incomingBuffersRef.current = [];
        receivedBytesRef.current = 0;
        transferStartRef.current = performance.now();
        setTransferProgress(1);
        setTelemetry({
          transferId,
          direction: 'receiving',
          fileName: String(msg.name),
          fileMime: String(msg.mime),
          totalBytes: Number(msg.size),
          transferredBytes: 0,
          speedMbps: 0,
          etaSeconds: 1,
          progress: 1,
        });
        setStatusText(`Receiving ${msg.name}...`);
      } else if (msg.type === 'file-cancel') {
        incomingMetaRef.current = null;
        incomingBuffersRef.current = [];
        receivedBytesRef.current = 0;
        incomingOfferRef.current = false;
        setIncomingOffer(null);
        setTransferProgress(0);
        setTelemetry(null);
        setStatusText('Transfer cancelled');
      } else if (msg.type === 'file-end' && incomingMetaRef.current) {
        const meta = incomingMetaRef.current;
        const blob = new Blob(incomingBuffersRef.current, { type: meta.mime });
        const valid =
          receivedBytesRef.current === meta.size && blob.size === meta.size;

        // Acknowledge receipt to the sender with actual received byte count
        sendJsonPacket({
          type: 'file-ack',
          transferId: meta.transferId,
          receivedBytes: valid ? receivedBytesRef.current : -1,
        });

        if (!valid) {
          incomingMetaRef.current = null;
          incomingBuffersRef.current = [];
          receivedBytesRef.current = 0;
          setTransferProgress(0);
          setTelemetry(null);
          setStatusText(`Transfer failed: ${meta.name}`);
          return;
        }

        const file = new File([blob], meta.name, { type: meta.mime });

        setTotalSessionBytes((b) => b + meta.size);
        setSharedItems((prev) => [
          {
            id: meta.transferId || crypto.randomUUID(),
            kind: 'file',
            file,
            direction: 'received',
            timestamp: Date.now(),
          },
          ...prev,
        ]);
        setTransferProgress(100);
        setTelemetry((prev) =>
          prev
            ? {
                ...prev,
                transferredBytes: meta.size,
                etaSeconds: 0,
                progress: 100,
              }
            : null
        );
        setStatusText(`Received ${meta.name}`);
        incomingMetaRef.current = null;
        incomingBuffersRef.current = [];
        const tid = meta.transferId;
        setTimeout(() => setTelemetry((prev) => clearMatchingTransfer(prev, tid)), 1200);
      } else if (msg.type === 'file-ack') {
        const resolver = pendingAckResolverRef.current;
        if (resolver && resolver.transferId === msg.transferId) {
          resolver.resolve(ackMatches(resolver.expectedBytes, msg.receivedBytes));
          pendingAckResolverRef.current = null;
        }
      } else if (msg.type === 'relay-ping') {
        // Must be explicitly sent via WS relay, never routed through direct channel
        socketManagerRef.current?.send(
          JSON.stringify({
            type: 'relay',
            payload: {
              type: 'relay-pong',
              from: myIdRef.current,
              sessionId: sessionIdRef.current,
              nonce: msg.nonce,
            },
          })
        );
      } else if (msg.type === 'relay-pong') {
        relayReadyRef.current = true;
        if (relayPingIntervalRef.current) {
          clearInterval(relayPingIntervalRef.current);
          relayPingIntervalRef.current = null;
        }
        profilerRef.current?.mark('relay confirmed');
        networkLog('Relay path confirmed concurrently with direct negotiation');
        raceRef.current?.check();
      } else if (msg.type === 'transport-switch') {
        if (isV2Active()) return;
        if (msg.transport === 'relayed' && targetPeerRef.current) {
          profilerRef.current?.mark('relay confirmed');
          markConnected('relayed', targetPeerRef.current);
        }
      }
    },
    [sendJsonPacket, markConnected, isV2Active]
  );

  // Handle incoming binary chunk
  const handleBinaryChunk = useCallback((buffer: ArrayBuffer) => {
    if (!incomingMetaRef.current) return;
    if (receivedBytesRef.current + buffer.byteLength > incomingMetaRef.current.size) {
      return;
    }
    incomingBuffersRef.current.push(buffer);
    receivedBytesRef.current += buffer.byteLength;

    if (incomingMetaRef.current) {
      const elapsedSec = Math.max(0.05, (performance.now() - transferStartRef.current) / 1000);
      const bytesPerSec = receivedBytesRef.current / elapsedSec;
      const mbPerSec = Number((bytesPerSec / (1024 * 1024)).toFixed(1));
      const remainingBytes = Math.max(0, incomingMetaRef.current.size - receivedBytesRef.current);
      const eta = Math.max(1, Math.ceil(remainingBytes / Math.max(1, bytesPerSec)));
      const pct = Math.min(
        99,
        Math.max(1, Math.round((receivedBytesRef.current / incomingMetaRef.current.size) * 100))
      );

      setTransferProgress(pct);
      setTelemetry({
        transferId: incomingMetaRef.current.transferId,
        direction: 'receiving',
        fileName: incomingMetaRef.current.name,
        fileMime: incomingMetaRef.current.mime,
        totalBytes: incomingMetaRef.current.size,
        transferredBytes: receivedBytesRef.current,
        speedMbps: mbPerSec,
        etaSeconds: eta,
        progress: pct,
      });
    }
  }, []);

  // Configure DataChannel listeners
  const setupDataChannel = useCallback(
    (channel: RTCDataChannel, peer: PeerInfo) => {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = 512 * 1024;
      dcRef.current = channel;

      channel.onopen = () => {
        if (dcRef.current !== channel) return;
        profilerRef.current?.mark('channel open');
        markConnected('direct', peer);
      };

      channel.onclose = () => {
        backpressureWaiterRef.current?.();
        backpressureWaiterRef.current = null;
        if (dcRef.current === channel) {
          dcRef.current = null;
          resilienceRef.current?.notify();
          if (targetPeerRef.current && isSocketOpen(socketManagerRef.current?.getSocket() ?? null)) {
            fallbackToRelay();
          } else if (authenticatedSessionRef.current && targetPeerRef.current) {
            setConnectionState('reconnecting');
            setStatusText('Direct connection interrupted, reconnecting...');
          } else {
            setConnectionState('waiting');
            setTransport(null);
            setConnectedPeer(null);
            setStatusText('Connection closed');
          }
        }
      };

      channel.onerror = (err) => {
        networkLog('DataChannel error:', err);
        backpressureWaiterRef.current?.();
        backpressureWaiterRef.current = null;
        resilienceRef.current?.notify();
        fallbackToRelay();
      };

      channel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            handleProtocolJson(JSON.parse(event.data));
          } catch {
            // malformed
          }
        } else if (event.data instanceof ArrayBuffer) {
          handleBinaryChunk(event.data);
        }
      };
    },
    [markConnected, fallbackToRelay, handleProtocolJson, handleBinaryChunk]
  );

  // Attach v2 control channel ('control') or bulk channel ('bulk-0'..'bulk-3')
  const attachV2Channel = useCallback(
    (channel: RTCDataChannel) => {
      channel.binaryType = 'arraybuffer';

      if (channel.label === 'control') {
        if (controlChannelRef.current && controlChannelRef.current !== channel) {
          try {
            channel.close();
          } catch {
            // ignore duplicate
          }
          return;
        }
        controlChannelRef.current = channel;
        channel.onopen = () => {
          createSpeedTrace('ice')('control-open');
          raceRef.current?.check();
        };
        channel.onclose = () => {
          if (controlChannelRef.current === channel) {
            controlChannelRef.current = null;
            if (activeOutgoingIdRef.current) {
              transferControllerRef.current?.abort(new Error('Control channel closed'));
            }
            resilienceRef.current?.notify();
          }
        };
        channel.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            if (event.data.byteLength === 5) {
              for (const sub of senderSubsRef.current) {
                sub.credit(event.data);
              }
            }
            return;
          }
          if (typeof event.data === 'string') {
            try {
              handleProtocolJson(JSON.parse(event.data));
            } catch {
              // ignore malformed
            }
          }
        };
        return;
      }

      if (channel.label.startsWith('bulk-')) {
        const idx = Number(channel.label.slice(5));
        if (!Number.isInteger(idx) || idx < 0 || idx > 3 || bulkChannelsRef.current.has(idx)) {
          try {
            channel.close();
          } catch {
            // ignore duplicate/unknown
          }
          return;
        }
        bulkChannelsRef.current.set(idx, channel);
        channel.onopen = () => {
          createSpeedTrace('ice')(`bulk-${idx}-open`);
          raceRef.current?.check();
        };
        channel.onclose = () => {
          if (bulkChannelsRef.current.get(idx) === channel) {
            bulkChannelsRef.current.delete(idx);
            if (activeOutgoingIdRef.current) {
              transferControllerRef.current?.abort(new Error('Bulk channel closed'));
            }
            resilienceRef.current?.notify();
          }
        };
        channel.onmessage = (event) => {
          if (event.data instanceof ArrayBuffer) {
            const committed = agreementRef.current?.current;
            if (committed === 'rtc' && agreementRef.current?.canReceive('rtc')) {
              incomingReceiverRef.current?.push(event.data);
            }
          }
        };
        return;
      }

      // Unknown channel label
      try {
        channel.close();
      } catch {
        // ignore
      }
    },
    [handleProtocolJson]
  );

  // Create an RTCPeerConnection instance with state listeners
  const createPeerConnection = useCallback(
    (peer: PeerInfo, preserveAgreement = false) => {
      if (preserveAgreement) {
        closeRtcResources();
      } else {
        teardownPeerConnection();
      }
      targetPeerRef.current = peer;

      const pc = new RTCPeerConnection(rtcConfiguration(iceServersRef.current));
      pcRef.current = pc;
      const unsubDiag = attachRtcDiagnostics(pc);
      const unsubTrace = traceIce(pc);
      rtcCleanupRef.current = () => {
        unsubDiag();
        unsubTrace();
      };

      pc.onicecandidate = (e) => {
        if (e.candidate && myIdRef.current) {
          profilerRef.current?.mark('first ICE candidate');
          sendSignal(peer.id, { candidate: e.candidate });
        }
      };

      pc.ondatachannel = (e) => {
        if (isV2Active() || e.channel.label === 'control' || e.channel.label.startsWith('bulk-')) {
          attachV2Channel(e.channel);
        } else {
          setupDataChannel(e.channel, peer);
        }
      };

      pc.oniceconnectionstatechange = () => {
        networkLog('ICE connection state:', pc.iceConnectionState);
        resilienceRef.current?.notify();
        raceRef.current?.check();
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          profilerRef.current?.mark('ICE connected');
        } else if (pc.iceConnectionState === 'failed' && !isV2Active()) {
          fallbackToRelay();
        }
      };

      pc.onconnectionstatechange = () => {
        networkLog('PeerConnection connectionState:', pc.connectionState);
        resilienceRef.current?.notify();
        raceRef.current?.check();
        if (pc.connectionState === 'connected') {
          profilerRef.current?.mark('ICE connected');
        } else if (pc.connectionState === 'failed' && !isV2Active()) {
          networkLog('PeerConnection failed, attempting relay');
          fallbackToRelay();
        }
      };

      return pc;
    },
    [teardownPeerConnection, closeRtcResources, sendSignal, setupDataChannel, attachV2Channel, fallbackToRelay, isV2Active]
  );

  // Deterministic WebRTC negotiation: designated initiator starts offer
  const startNegotiation = useCallback(
    async (peer: PeerInfo, isInitiator: boolean) => {
      // Guard against duplicate negotiation tearing down an in-flight PeerConnection or committed agreement
      if (
        pcRef.current &&
        pcRef.current.signalingState !== 'closed' &&
        (negotiatingPeerIdRef.current === peer.id ||
          (targetPeerRef.current?.id === peer.id && Boolean(agreementRef.current?.current)))
      ) {
        networkLog(`Already negotiating or connected with ${peer.name} (${peer.id}), skipping duplicate trigger`);
        return;
      }

      if (turnFetchPromiseRef.current) {
        await Promise.race([
          turnFetchPromiseRef.current,
          new Promise<void>((resolve) => setTimeout(resolve, 1200)),
        ]);
      }

      const v2 = isV2Active();
      const pc = createPeerConnection(peer, false);
      // Set negotiating identity AFTER teardown inside createPeerConnection
      negotiatingPeerIdRef.current = peer.id;
      pairingStartMsRef.current = performance.now();
      setConnectionState('negotiating');
      setStatusText(`Establishing connection with ${peer.name}...`);
      targetPeerRef.current = peer;

      if (v2) {
        const genAtStart = sessionGenerationRef.current;
        const ac = new AbortController();
        const agreement = createPathAgreement({
          leader: isInitiator,
          send: (pkt) => {
            const ok = socketManagerRef.current?.send(JSON.stringify({ ...pkt, to: peer.id }));
            if (!ok) throw new Error('Signaling unavailable for path agreement');
          },
          available: (path: CommittedPath) => {
            if (path === 'rtc') {
              return (
                controlChannelRef.current?.readyState === 'open' &&
                bulkChannelsRef.current.size === 4 &&
                Array.from(bulkChannelsRef.current.values()).every((c) => c.readyState === 'open')
              );
            }
            return isSocketOpen(socketManagerRef.current?.getSocket() ?? null) && relayReadyRef.current;
          },
          busy: () => {
            const now = Date.now();
            for (const [id, entry] of approvedOffersRef.current) {
              if (now - entry.at > 60_000) {
                approvedOffersRef.current.delete(id);
              }
            }
            return Boolean(
              pendingOfferResolverRef.current ||
                isTransferActiveRef.current ||
                incomingReceiverRef.current ||
                incomingReceiverIdRef.current ||
                receiverSlotRef.current.current ||
                offerResRef.current.busy() ||
                incomingOfferRef.current ||
                approvedOffersRef.current.size > 0
            );
          },
          onCommit: (path) => {
            if (genAtStart !== sessionGenerationRef.current) return;
            markConnected(path === 'rtc' ? 'direct' : 'relayed', peer);
            if (path === 'rtc' && pcRef.current) {
              const committedPc = pcRef.current;
              void selectedPath(committedPc).then((sp) => {
                if (genAtStart === sessionGenerationRef.current && agreementRef.current?.current === 'rtc') {
                  updateDiagnostics({
                    pathKind: sp.kind,
                    localCandidateType: sp.localType,
                    remoteCandidateType: sp.remoteType,
                    candidateProtocol: sp.protocol,
                  });
                }
              });
            } else if (path === 'relay') {
              updateDiagnostics({ pathKind: 'ws-relay' });
            }
          },
          invalidate: (err) => {
            networkLog('Path agreement invalidated:', err.message);
            if (agreementRef.current === agreement) {
              raceRef.current?.stop();
              raceRef.current = null;
              agreement.close();
              agreementRef.current = null;
              negotiatingPeerIdRef.current = null;
              if (activeOutgoingIdRef.current) {
                transferControllerRef.current?.abort(err);
              }
              if (incomingReceiverRef.current) {
                void incomingReceiverRef.current.abort(err);
                incomingReceiverRef.current = null;
                incomingReceiverIdRef.current = null;
              }
              closeRtcResources();
              setLastError(err.message);
              setConnectionState('reconnecting');
              resilienceRef.current?.notify();
            }
          },
          signal: ac.signal,
        });
        agreementRef.current = agreement;

        if (isInitiator) {
          const race = startTransportRace({
            pc,
            channels: () => [
              ...(controlChannelRef.current ? [controlChannelRef.current] : []),
              ...Array.from(bulkChannelsRef.current.values()),
            ],
            relayReady: () => relayReadyRef.current,
            signal: ac.signal,
            committed: () => agreement.current,
            switching: () => agreement.locked,
            propose: (path) => agreement.request(path),
            expireRtc: () => {
              if (agreement.current !== 'rtc') {
                closeRtcResources();
              }
            },
            exhausted: () => {
              if (!agreement.current) {
                setConnectionState('failed');
                setLastError('Unable to establish direct or relayed connection');
                setStatusText('Connection failed');
              }
            },
          });
          raceRef.current = race;
        }
      } else {
        // Legacy v1 8s safety timeout
        if (negotiationTimerRef.current) clearTimeout(negotiationTimerRef.current);
        negotiationTimerRef.current = setTimeout(() => {
          networkLog('WebRTC negotiation timed out, falling back to relay');
          profilerRef.current?.report();
          callbacksRef.current.fallbackToRelay();
        }, NEGOTIATION_TIMEOUT_MS);
      }

      if (isInitiator) {
        try {
          if (v2) {
            const { control, bulk } = createChannels(pc);
            attachV2Channel(control);
            bulk.forEach((ch) => attachV2Channel(ch));
          } else {
            const dc = pc.createDataChannel('localdrop', { ordered: true });
            setupDataChannel(dc, peer);
          }

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          profilerRef.current?.mark('offer sent');
          sendSignal(peer.id, { sdp: pc.localDescription });
        } catch (err) {
          networkLog('CreateOffer failed:', err);
          if (!v2) fallbackToRelay();
        }
      }
    },
    [
      isV2Active,
      createPeerConnection,
      closeRtcResources,
      markConnected,
      updateDiagnostics,
      attachV2Channel,
      setupDataChannel,
      sendSignal,
      fallbackToRelay,
    ]
  );

  // Stable callback references to prevent tearing down the WebSocket when peer callbacks change
  const callbacksRef = useRef({
    startNegotiation,
    createPeerConnection,
    setupDataChannel,
    sendSignal,
    handleProtocolJson,
    handleBinaryChunk,
    teardownPeerConnection,
    fallbackToRelay,
  });

  useLayoutEffect(() => {
    callbacksRef.current = {
      startNegotiation,
      createPeerConnection,
      setupDataChannel,
      sendSignal,
      handleProtocolJson,
      handleBinaryChunk,
      teardownPeerConnection,
      fallbackToRelay,
    };
  });

  // Initialize and manage the reconnecting WebSocket lifecycle and direct resilience controller
  useEffect(() => {
    sessionIdRef.current = crypto.randomUUID();
    const mountGen = ++sessionGenerationRef.current;

    // Prewarm ECDSA P-256 certificate once without blocking signaling
    void prewarmCertificate();
    // Prune orphaned OPFS temp files from previous crashed sessions
    void pruneOrphanedOpfsFiles();
    // Send asynchronous HTTP health check to wake up sleeping free-tier backends (Render cold start)
    void pingBackendHealth(8000);

    const refreshTurnIceServers = (roomCode: string, token: string) => {
      if (!turnNeedsRefresh(turnExpiresAtRef.current)) return;
      const ac = new AbortController();
      const promise = fetchIceServersWithExpiry(wsUrl, token, roomCode, ac.signal)
        .then((res) => {
          if (mountGen === sessionGenerationRef.current && res.iceServers.length > 0) {
            iceServersRef.current = res.iceServers;
            if (res.expiresAt !== null) {
              turnExpiresAtRef.current = res.expiresAt;
            }
            if (
              pcRef.current &&
              pcRef.current.signalingState !== 'closed' &&
              !isTransferActiveRef.current
            ) {
              try {
                pcRef.current.setConfiguration(rtcConfiguration(res.iceServers));
              } catch {
                // ignore if browser disallows setConfiguration in current state
              }
            }
          }
        })
        .finally(() => {
          if (turnFetchPromiseRef.current === promise) {
            turnFetchPromiseRef.current = null;
          }
        });
      turnFetchPromiseRef.current = promise;
    };

    const socketManager = createReconnectingSocket(wsUrl, {
      onOpen: (ws) => {
        hasConnectedOnceRef.current = true;
        setLastError(null);
        // Preserve healthy direct channel state during signaling reconnects
        const directOpen =
          dcRef.current?.readyState === 'open' ||
          (agreementRef.current?.current === 'rtc' && controlChannelRef.current?.readyState === 'open');
        if (!directOpen) {
          setConnectionState('signaling');
          setStatusText('Registering device…');
        }

        // Step 1: Register client device metadata with v2 capability
        const device = detectDevice();
        ws.send(JSON.stringify({ type: 'register', ...device, networkVersion: VERSION }));
        resilienceRef.current?.notify();
      },

      onClose: () => {
        relayReadyRef.current = false;
        setWsConnected(false);
        agreementRef.current?.signalingLost();

        if (agreementRef.current?.current === 'relay') {
          if (activeOutgoingIdRef.current) {
            transferControllerRef.current?.abort(new Error('Relay signaling closed'));
          }
          if (incomingReceiverRef.current) {
            void incomingReceiverRef.current.abort(new Error('Relay signaling closed'));
            incomingReceiverRef.current = null;
            incomingReceiverIdRef.current = null;
          }
        }

        const directOpen =
          dcRef.current?.readyState === 'open' ||
          (agreementRef.current?.current === 'rtc' && controlChannelRef.current?.readyState === 'open');
        if (directOpen) {
          // Keep direct transport usable if its channel is healthy
          resilienceRef.current?.notify();
          return;
        }
        setConnectionState('reconnecting');
        setStatusText(
          hasConnectedOnceRef.current
            ? 'Signaling disconnected, reconnecting...'
            : 'Starting LocalDrop server...'
        );
        resilienceRef.current?.notify();
      },

      onError: () => {
        // Do not display misleading connection failure during normal free-tier cold start
        if (hasConnectedOnceRef.current) {
          setLastError('Signaling server connection error');
        }
      },

      onReconnect: (attempt, delay) => {
        if (dcRef.current?.readyState === 'open') return;
        if (!hasConnectedOnceRef.current) {
          setStatusText('Starting LocalDrop server...');
        } else {
          setStatusText(`Reconnecting to server (attempt ${attempt})...`);
        }
        networkLog(`Reconnecting attempt ${attempt} in ${delay}ms`);
      },

      onExhausted: () => {
        relayReadyRef.current = false;
        if (dcRef.current?.readyState === 'open') return;
        setConnectionState('offline');
        setStatusText('Signaling server unavailable');
        setLastError(
          'Unable to reach LocalDrop signaling server. Please check your internet connection or verify your signaling endpoint.'
        );
      },

      onMessage: async (event) => {
        if (event.data instanceof ArrayBuffer) {
          if (isV2Active()) {
            if (agreementRef.current?.current === 'relay') {
              if (event.data.byteLength === 5) {
                for (const sub of senderSubsRef.current) {
                  sub.credit(event.data);
                }
              } else if (event.data.byteLength >= 8 && agreementRef.current.canReceive('relay')) {
                incomingReceiverRef.current?.push(event.data);
              }
            }
            return;
          }
          callbacksRef.current.handleBinaryChunk(event.data);
          return;
        }

        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(event.data);
        } catch {
          return;
        }

        if (msg.type === 'welcome') {
          // Step 2: Welcome received with assigned UUID. Restore authenticated session or join/create room
          myIdRef.current = String(msg.id || '');
          serverV2Ref.current = msg.v2Supported === true || msg.networkVersion === VERSION;
          networkLog('Registered with signaling ID:', myIdRef.current);

          if (authenticatedSessionRef.current) {
            if (resumeTokenRef.current && activeRoomRef.current) {
              socketManager.send(
                JSON.stringify({
                  type: 'resume-session',
                  roomCode: activeRoomRef.current,
                  resumeToken: resumeTokenRef.current,
                })
              );
            } else {
              // Cannot securely restore without a valid resume credential; never blindly rejoin by PIN
              authenticatedSessionRef.current = false;
              if (dcRef.current?.readyState !== 'open') {
                setConnectionState('failed');
                setConnectedPeer(null);
                setTransport(null);
                setLastError('Session disconnected. Please pair again.');
                setStatusText('Session disconnected. Please pair again.');
              }
            }
          } else if (pendingPinRef.current) {
            const target = pendingPinRef.current;
            setConnectionState('pairing');
            setStatusText(`Linking to ${target}...`);
            socketManager.send(
              JSON.stringify({
                type: 'join-room',
                roomCode: target,
                createIfMissing: false,
              })
            );
          } else {
            // Host own PIN room
            activeRoomRef.current = pinRef.current;
            socketManager.send(
              JSON.stringify({
                type: 'create-room',
                roomCode: pinRef.current,
              })
            );
          }
        } else if (msg.type === 'room-created') {
          // Step 3: Room confirmed by server. Now pairing is ready!
          activeRoomRef.current = String(msg.roomCode);
          if (typeof msg.resumeToken === 'string') {
            resumeTokenRef.current = msg.resumeToken;
            refreshTurnIceServers(activeRoomRef.current, msg.resumeToken);
          }
          profilerRef.current?.mark('room ack');
          setWsConnected(true);
          if (dcRef.current?.readyState !== 'open' && agreementRef.current?.current !== 'rtc') {
            setConnectionState('waiting');
            setStatusText('Ready to pair');
          }
          setLastError(null);
        } else if (msg.type === 'room-joined') {
          activeRoomRef.current = String(msg.roomCode);
          if (typeof msg.resumeToken === 'string') {
            resumeTokenRef.current = msg.resumeToken;
            refreshTurnIceServers(activeRoomRef.current, msg.resumeToken);
          }
          authenticatedSessionRef.current = true;
          profilerRef.current?.mark('room ack');
          setWsConnected(true);
          pendingPinRef.current = null;
          if (pairingTimeoutTimerRef.current) {
            clearTimeout(pairingTimeoutTimerRef.current);
            pairingTimeoutTimerRef.current = null;
          }
        } else if (msg.type === 'session-resumed') {
          activeRoomRef.current = String(msg.roomCode);
          if (typeof msg.participantId === 'string' && msg.participantId) {
            myIdRef.current = msg.participantId;
          }
          if (typeof msg.resumeToken === 'string') {
            resumeTokenRef.current = msg.resumeToken;
            refreshTurnIceServers(activeRoomRef.current, msg.resumeToken);
          }
          setWsConnected(true);
          setLastError(null);
          if (dcRef.current?.readyState === 'open' || (agreementRef.current?.current === 'rtc' && controlChannelRef.current?.readyState === 'open')) {
            setConnectionState('direct');
            setTransport('webrtc');
          } else if (directEstablishedRef.current) {
            resilienceRef.current?.notify();
          } else if (targetPeerRef.current) {
            socketManager.send(
              JSON.stringify({
                type: 'relay',
                payload: {
                  type: 'relay-ping',
                  from: myIdRef.current,
                  sessionId: sessionIdRef.current,
                },
              })
            );
          }
        } else if (msg.type === 'error') {
          if (isRelayError(msg.code)) {
            const reason =
              typeof msg.message === 'string' ? msg.message : 'Relay transfer rejected';
            if (
              agreementRef.current?.current === 'relay' &&
              matchesTransfer(activeOutgoingIdRef.current, msg.transferId)
            ) {
              transferControllerRef.current?.abort(new Error(reason));
            }
            if (
              agreementRef.current?.current === 'relay' &&
              matchesTransfer(incomingReceiverIdRef.current, msg.transferId)
            ) {
              void incomingReceiverRef.current?.abort(new Error(reason));
              incomingReceiverRef.current = null;
              incomingReceiverIdRef.current = null;
            }
            if (agreementRef.current?.current !== 'rtc') {
              if (
                pendingAckResolverRef.current &&
                matchesTransfer(pendingAckResolverRef.current.transferId, msg.transferId)
              ) {
                pendingAckResolverRef.current.resolve(false);
                pendingAckResolverRef.current = null;
              }
              if (
                pendingOfferResolverRef.current &&
                (msg.transferId === undefined ||
                  matchesTransfer(activeOutgoingIdRef.current, msg.transferId))
              ) {
                pendingOfferResolverRef.current.resolve(false);
                pendingOfferResolverRef.current = null;
              }
            }
            setLastError(reason);
          }
        } else if (msg.type === 'room-error') {
          // Room rejected (e.g. ROOM_NOT_FOUND, ROOM_FULL, INVALID_PIN, RESUME_FAILED)
          const code = String(msg.code || '');
          const errorMsg = String(msg.message || 'Pairing error');
          setLastError(errorMsg);
          setStatusText(errorMsg);
          pendingPinRef.current = null;
          profilerRef.current?.report();

          if (pairingTimeoutTimerRef.current) {
            clearTimeout(pairingTimeoutTimerRef.current);
            pairingTimeoutTimerRef.current = null;
          }

          if (code === 'ROOM_TAKEN' && !authenticatedSessionRef.current && pinRetryCountRef.current < 8) {
            pinRetryCountRef.current += 1;
            const nextPin = generateSecurePin();
            pinRef.current = nextPin;
            setPin(nextPin);
            activeRoomRef.current = nextPin;
            socketManager.send(
              JSON.stringify({
                type: 'create-room',
                roomCode: nextPin,
              })
            );
          } else if (code === 'RESUME_FAILED' || code === 'TOO_MANY_ATTEMPTS') {
            resumeTokenRef.current = null;
            authenticatedSessionRef.current = false;
            if (dcRef.current?.readyState !== 'open') {
              setConnectionState('failed');
              setConnectedPeer(null);
              setTransport(null);
            }
          } else {
            setConnectionState('failed');
            // Restore own host room so device remains discoverable
            activeRoomRef.current = pinRef.current;
            socketManager.send(
              JSON.stringify({
                type: 'create-room',
                roomCode: pinRef.current,
              })
            );
          }
        } else if (msg.type === 'room-peers') {
          const peers: PeerInfo[] = (msg.peers as PeerInfo[]) || [];
          if (peers.length > 0) {
            const peer = peers[0];
            peerNetworkVersionRef.current = peerVersion(
              targetPeerRef.current?.id, peerNetworkVersionRef.current, peer.id, peer.networkVersion
            );
            targetPeerRef.current = peer;
            authenticatedSessionRef.current = true;

            if (!profilerRef.current) {
              profilerRef.current = createConnectionProfiler();
            }
            profilerRef.current.mark('peer discovery');

            // Concurrently verify relay readiness explicitly over WS relay with bounded retry
            const sendRelayPing = () => {
              if (!socketManagerRef.current) return;
              socketManagerRef.current.send(
                JSON.stringify({
                  type: 'relay',
                  payload: {
                    type: 'relay-ping',
                    from: myIdRef.current,
                    sessionId: sessionIdRef.current,
                  },
                })
              );
            };
            sendRelayPing();
            if (!relayReadyRef.current) {
              if (relayPingIntervalRef.current) clearInterval(relayPingIntervalRef.current);
              let attempts = 0;
              relayPingIntervalRef.current = setInterval(() => {
                attempts++;
                if (
                  relayReadyRef.current ||
                  connectionStateRef.current !== 'negotiating' ||
                  attempts >= 15
                ) {
                  if (relayPingIntervalRef.current) {
                    clearInterval(relayPingIntervalRef.current);
                    relayPingIntervalRef.current = null;
                  }
                  return;
                }
                sendRelayPing();
              }, 1000);
            }

            // Preserve healthy open DataChannel instead of restarting negotiation
            const directHealthy =
              (dcRef.current?.readyState === 'open' ||
                (agreementRef.current?.current === 'rtc' && controlChannelRef.current?.readyState === 'open')) &&
              pcRef.current?.connectionState === 'connected';
            if (directHealthy) {
              networkLog(`Keeping healthy direct DataChannel with ${peer.name}`);
              return;
            }

            // Deterministic offer initiator: lexicographical UUID comparison
            const isInitiator = myIdRef.current < peer.id;
            networkLog(`Room paired with ${peer.name} (v${peerNetworkVersionRef.current}). Is initiator: ${isInitiator}`);
            callbacksRef.current.startNegotiation(peer, isInitiator);
          } else {
            // Peer left or is temporarily reconnecting within grace period
            if (dcRef.current?.readyState === 'open' || (agreementRef.current?.current === 'rtc' && controlChannelRef.current?.readyState === 'open')) {
              return;
            }
            targetPeerRef.current = null;
            peerNetworkVersionRef.current = 1;
            authenticatedSessionRef.current = false;
            directEstablishedRef.current = false;
            callbacksRef.current.teardownPeerConnection();
            setConnectedPeer(null);
            setConnectionState('waiting');
            setTransport(null);
            setIncomingOffer(null);
            setTelemetry(null);
            setStatusText('Ready to pair');
          }
        } else if (msg.type === 'peer-reconnecting') {
          if (authenticatedSessionRef.current) {
            setConnectionState('reconnecting');
            setStatusText('Peer reconnecting...');
          }
        } else if (msg.type === 'peer-joined-room') {
          const peer = msg.peer as PeerInfo;
          if (peer && peer.id !== myIdRef.current) {
            peerNetworkVersionRef.current = peerVersion(
              targetPeerRef.current?.id, peerNetworkVersionRef.current, peer.id, peer.networkVersion
            );
            targetPeerRef.current = peer;
            authenticatedSessionRef.current = true;

            if (!profilerRef.current) {
              profilerRef.current = createConnectionProfiler();
            }
            profilerRef.current.mark('peer discovery');

            // Concurrently verify relay readiness
            if (socketManagerRef.current) {
              socketManagerRef.current.send(
                JSON.stringify({
                  type: 'relay',
                  payload: {
                    type: 'relay-ping',
                    from: myIdRef.current,
                    sessionId: sessionIdRef.current,
                  },
                })
              );
            }

            const directHealthy =
              (dcRef.current?.readyState === 'open' ||
                (agreementRef.current?.current === 'rtc' && controlChannelRef.current?.readyState === 'open')) &&
              pcRef.current?.connectionState === 'connected';
            if (directHealthy) {
              return;
            }

            const isInitiator = myIdRef.current < peer.id;
            callbacksRef.current.startNegotiation(peer, isInitiator);
            if (earlySignalsRef.current.length > 0) {
              const now = Date.now();
              const queued = earlySignalsRef.current.splice(0);
              const gen = sessionGenerationRef.current;
              const pc = pcRef.current;
              for (const entry of queued) {
                if (now - entry.at > 5_000) continue;
                const queuedMsg = entry.msg;
                if (queuedMsg.from === peer.id && pc && pc.signalingState !== 'closed') {
                  const sig = queuedMsg.signal as {
                    sdp?: RTCSessionDescriptionInit;
                    candidate?: RTCIceCandidateInit;
                  };
                  signalsRef.current?.enqueue(async (current) => {
                    const valid = () =>
                      current() &&
                      pcRef.current === pc &&
                      gen === sessionGenerationRef.current &&
                      pc.signalingState !== 'closed';
                    if (!valid()) return;
                    if (sig?.sdp) {
                      try {
                        await pc.setRemoteDescription(new RTCSessionDescription(sig.sdp));
                        if (!valid()) return;
                        await iceQueueRef.current.flush(pc);
                        if (!valid()) return;
                        if (sig.sdp.type === 'offer') {
                          const answer = await pc.createAnswer();
                          if (!valid()) return;
                          await pc.setLocalDescription(answer);
                          if (!valid()) return;
                          callbacksRef.current.sendSignal(peer.id, { sdp: pc.localDescription });
                        }
                      } catch (err) {
                        networkLog('Error handling queued SDP signal:', err);
                        if (isV2Active()) {
                          raceRef.current?.check();
                        } else {
                          callbacksRef.current.fallbackToRelay();
                        }
                      }
                    } else if (sig?.candidate) {
                      await iceQueueRef.current.add(pc, sig.candidate);
                    }
                  });
                }
              }
            }
          }
        } else if (msg.type === 'v2-path') {
          if (typeof msg.from === 'string' && msg.from === targetPeerRef.current?.id) {
            agreementRef.current?.receive(msg);
          }
        } else if (msg.type === 'relay') {
          callbacksRef.current.handleProtocolJson(msg.payload as Record<string, unknown>);
        } else if (msg.type === 'signal') {
          if (!targetPeerRef.current || !authenticatedSessionRef.current) {
            const now = Date.now();
            earlySignalsRef.current = earlySignalsRef.current.filter((e) => now - e.at <= 5_000);
            if (earlySignalsRef.current.length < 128) {
              earlySignalsRef.current.push({ msg, at: now });
            }
            return;
          }
          if (msg.from !== targetPeerRef.current.id) {
            return;
          }
          const sender = targetPeerRef.current;
          const pc = pcRef.current;
          if (!pc || pc.signalingState === 'closed') {
            return;
          }
          const gen = sessionGenerationRef.current;
          const signal = msg.signal as {
            sdp?: RTCSessionDescriptionInit;
            candidate?: RTCIceCandidateInit;
          };

          signalsRef.current?.enqueue(async (current) => {
            const valid = () =>
              current() &&
              pcRef.current === pc &&
              gen === sessionGenerationRef.current &&
              pc.signalingState !== 'closed';
            if (!valid()) return;

            if (signal?.sdp) {
              try {
                const polite = myIdRef.current > sender.id;
                if (signal.sdp.type === 'offer' && pc.signalingState === 'have-local-offer') {
                  if (!polite) return;
                  await pc.setLocalDescription({ type: 'rollback' });
                  if (!valid()) return;
                }
                iceQueueRef.current.beginRemoteDescription();
                try {
                  await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
                } finally {
                  iceQueueRef.current.endRemoteDescription();
                }
                if (!valid()) return;
                await iceQueueRef.current.flush(pc);
                if (!valid()) return;

                if (signal.sdp.type === 'offer') {
                  const answer = await pc.createAnswer();
                  if (!valid()) return;
                  await pc.setLocalDescription(answer);
                  if (!valid()) return;
                  callbacksRef.current.sendSignal(sender.id, { sdp: pc.localDescription });
                } else if (signal.sdp.type === 'answer') {
                  profilerRef.current?.mark('answer installed');
                }
              } catch (err) {
                networkLog('Error handling remote SDP signal:', err);
                if (isV2Active()) {
                  raceRef.current?.check();
                } else {
                  callbacksRef.current.fallbackToRelay();
                }
              }
            } else if (signal?.candidate) {
              await iceQueueRef.current.add(pc, signal.candidate);
            }
          });
        }
      },
    });

    socketManagerRef.current = socketManager;

    // Direct transport recovery controller (only active for previously established DIRECT sessions)
    const resilience = createConnectionResilience({
      socketState: () => socketManagerRef.current?.getSocket()?.readyState,
      peer: () => pcRef.current,
      channel: () => {
        if (agreementRef.current?.current === 'rtc') {
          return bulkChannelsRef.current.size === 4 &&
            Array.from(bulkChannelsRef.current.values()).every((c) => c.readyState === 'open')
            ? controlChannelRef.current : null;
        }
        return dcRef.current;
      },
      hasSession: () =>
        directEstablishedRef.current &&
        authenticatedSessionRef.current &&
        Boolean(targetPeerRef.current),
      transferActive: () => isTransferActiveRef.current,
      ensureSignaling: () => {
        socketManagerRef.current?.wake();
      },
      recoverPeer: async (signal: AbortSignal) => {
        const runRecovery = async () => {
          const startGen = sessionGenerationRef.current;
          if (
            signal.aborted ||
            startGen !== sessionGenerationRef.current ||
            isTransferActiveRef.current ||
            !wsConnectedRef.current ||
            !authenticatedSessionRef.current ||
            !targetPeerRef.current
          ) {
            return;
          }

          const peer = targetPeerRef.current;
          const pc = pcRef.current;

          // Keep current channel if healthy
          const directOpen = agreementRef.current?.current === 'rtc'
            ? controlChannelRef.current?.readyState === 'open' && bulkChannelsRef.current.size === 4 &&
              Array.from(bulkChannelsRef.current.values()).every((c) => c.readyState === 'open')
            : dcRef.current?.readyState === 'open';
          if (directOpen && pc?.connectionState === 'connected') {
            return;
          }

          const isInitiator = myIdRef.current < peer.id;

          if (pc && pc.signalingState !== 'closed' && pc.connectionState !== 'failed') {
            try {
              if (typeof pc.restartIce === 'function') {
                pc.restartIce();
              }
              if (isInitiator) {
                const offer = await pc.createOffer({ iceRestart: true });
                if (signal.aborted || startGen !== sessionGenerationRef.current) return;
                await pc.setLocalDescription(offer);
                if (signal.aborted || startGen !== sessionGenerationRef.current) return;
                callbacksRef.current.sendSignal(peer.id, { sdp: pc.localDescription });
              }
              return;
            } catch {
              // Fall through to full peer recreation if ICE restart fails
            }
          }

          if (signal.aborted || startGen !== sessionGenerationRef.current || isTransferActiveRef.current) {
            return;
          }

          // Recreate peer only after confirming no active transfer, negotiating with the same authenticated peer
          negotiatingPeerIdRef.current = null;
          await callbacksRef.current.startNegotiation(peer, isInitiator);
        };

        const prev = recoveryLockRef.current ?? Promise.resolve();
        const next = prev.then(runRecovery, runRecovery);
        recoveryLockRef.current = next;
        try {
          await next;
        } finally {
          if (recoveryLockRef.current === next) {
            recoveryLockRef.current = null;
          }
        }
      },
      report: () => {
        // Advisory only; UI connected status is derived strictly from live channel / confirmed relay
      },
    });
    resilienceRef.current = resilience;

    return () => {
      if (mountGen === sessionGenerationRef.current) {
        sessionGenerationRef.current++;
      }
      resilience.dispose();
      if (resilienceRef.current === resilience) {
        resilienceRef.current = null;
      }
      if (pairingTimeoutTimerRef.current) clearTimeout(pairingTimeoutTimerRef.current);
      if (negotiationTimerRef.current) clearTimeout(negotiationTimerRef.current);
      if (relayPingIntervalRef.current) {
        clearInterval(relayPingIntervalRef.current);
        relayPingIntervalRef.current = null;
      }
      transferControllerRef.current?.abort(new Error('Unmounted'));
      void incomingReceiverRef.current?.abort(new Error('Unmounted'));
      for (const sink of opfsSinksRef.current.values()) {
        void sink.dispose();
      }
      opfsSinksRef.current.clear();
      backpressureWaiterRef.current?.();
      backpressureWaiterRef.current = null;
      callbacksRef.current.teardownPeerConnection();
      socketManager.close();
      socketManagerRef.current = null;
    };
  }, [wsUrl]);

  // Request to connect with a 4-digit PIN
  const connectWithPin = useCallback(
    (targetPin: string) => {
      const clean = targetPin.trim();

      if (!isValidPin(clean)) {
        setLastError('Enter a valid 4-digit PIN');
        return;
      }

      if (clean === pinRef.current) {
        setLastError('Enter the PIN shown on your other device');
        return;
      }

      setLastError(null);
      pendingPinRef.current = clean;

      profilerRef.current = createConnectionProfiler();
      profilerRef.current.mark('PIN submission');

      const socket = socketManagerRef.current?.getSocket();
      if (!socket || socket.readyState !== WebSocket.OPEN) {
        setConnectionState('signaling');
        setStatusText('Waiting for signaling server...');
        return;
      }

      setConnectionState('pairing');
      setStatusText(`Linking to ${clean}...`);

      // Set pairing timeout safety net
      if (pairingTimeoutTimerRef.current) clearTimeout(pairingTimeoutTimerRef.current);
      pairingTimeoutTimerRef.current = setTimeout(() => {
        if (pendingPinRef.current === clean && connectionStateRef.current === 'pairing') {
          setConnectionState('failed');
          setLastError(`Pairing to ${clean} timed out. Make sure the code is correct.`);
          setStatusText(`Pairing to ${clean} timed out`);
          pendingPinRef.current = null;
          profilerRef.current?.report();
          // Restore host room
          socketManagerRef.current?.send(
            JSON.stringify({
              type: 'create-room',
              roomCode: pinRef.current,
            })
          );
        }
      }, PAIRING_TIMEOUT_MS);

      socketManagerRef.current?.send(
        JSON.stringify({
          type: 'join-room',
          roomCode: clean,
          createIfMissing: false,
        })
      );
    },
    []
  );

  // Manual disconnect / session teardown
  const disconnect = useCallback(() => {
    sessionGenerationRef.current++;
    sessionLeaseRef.current.reset('Disconnected');
    offerResRef.current.reset();
    turnExpiresAtRef.current = null;
    activeOutgoingAttemptRef.current = null;
    authenticatedSessionRef.current = false;
    directEstablishedRef.current = false;
    resumeTokenRef.current = null;
    relayReadyRef.current = false;
    peerNetworkVersionRef.current = 1;
    approvedOffersRef.current.clear();
    transferControllerRef.current?.abort(new Error('Disconnected'));
    void incomingReceiverRef.current?.abort(new Error('Disconnected'));
    incomingReceiverRef.current = null;
    incomingReceiverIdRef.current = null;
    for (const sink of opfsSinksRef.current.values()) {
      void sink.dispose();
    }
    opfsSinksRef.current.clear();
    backpressureWaiterRef.current?.();
    backpressureWaiterRef.current = null;
    resilienceRef.current?.notify();

    teardownPeerConnection();
    targetPeerRef.current = null;
    setConnectedPeer(null);
    setConnectionState('waiting');
    setTransport(null);
    setIncomingOffer(null);
    setTelemetry(null);
    setSharedItems([]);
    setStatusText('Ready to pair');

    socketManagerRef.current?.send(JSON.stringify({ type: 'leave-room' }));

    // Return to own host room
    activeRoomRef.current = pinRef.current;
    socketManagerRef.current?.send(
      JSON.stringify({
        type: 'create-room',
        roomCode: pinRef.current,
      })
    );
  }, [teardownPeerConnection]);

  const pushMyClipboard = useCallback(
    (text: string) => {
      setLocalClipboard(text);
      sendJsonPacket({ type: 'clipboard-sync', text });
    },
    [sendJsonPacket]
  );

  const requestRemoteClipboard = useCallback(() => {
    sendJsonPacket({ type: 'request-clipboard' });
  }, [sendJsonPacket]);

  const sendTextOrLink = useCallback(
    (text: string): boolean => {
      const clean = text.trim();
      if (!clean) return false;
      const packet = { type: 'shared-text', text: clean };
      if (new TextEncoder().encode(JSON.stringify(packet)).byteLength > 48 * 1024) {
        setLastError('Message exceeds maximum relay size (48 KB)');
        return false;
      }
      const sent = sendJsonPacket(packet);
      if (!sent) {
        setLastError('Unable to send message: no active connection');
        return false;
      }
      setSharedItems((prev) => [
        {
          id: crypto.randomUUID(),
          kind: 'text',
          text: clean,
          direction: 'sent',
          timestamp: Date.now(),
        },
        ...prev,
      ]);
      return true;
    },
    [sendJsonPacket]
  );

  const acceptIncomingFile = useCallback(() => {
    if (!incomingOffer) return;
    offerResRef.current.accept(incomingOffer.offerId, sessionGenerationRef.current);
    if (incomingOffer.transferId) {
      approvedOffersRef.current.set(incomingOffer.transferId, {
        name: incomingOffer.name,
        size: incomingOffer.size,
        mime: incomingOffer.mime,
        at: Date.now(),
      });
    }
    sendJsonPacket({
      type: 'file-offer-response',
      offerId: incomingOffer.offerId,
      accepted: true,
    });
    incomingOfferRef.current = false;
    setIncomingOffer(null);
  }, [incomingOffer, sendJsonPacket]);

  const declineIncomingFile = useCallback(() => {
    if (!incomingOffer) return;
    if (incomingOffer.transferId) {
      offerResRef.current.clear(
        incomingOffer.offerId,
        incomingOffer.transferId,
        sessionGenerationRef.current
      );
    }
    sendJsonPacket({
      type: 'file-offer-response',
      offerId: incomingOffer.offerId,
      accepted: false,
    });
    incomingOfferRef.current = false;
    setIncomingOffer(null);
  }, [incomingOffer, sendJsonPacket]);

  const cancelTransfer = useCallback(() => {
    cancelFlagRef.current = true;
    backpressureWaiterRef.current?.();
    backpressureWaiterRef.current = null;
    if (pendingOfferResolverRef.current) {
      pendingOfferResolverRef.current.resolve(false);
      pendingOfferResolverRef.current = null;
    }
    if (pendingAckResolverRef.current) {
      pendingAckResolverRef.current.resolve(false);
      pendingAckResolverRef.current = null;
    }
    if (activeOutgoingIdRef.current) {
      const tid = activeOutgoingIdRef.current;
      transferControllerRef.current?.abort(new Error('Cancelled by user'));
      sendJsonPacket({ type: 'v2-cancel', transferId: tid });
    }
    if (incomingReceiverRef.current) {
      const tid = incomingReceiverIdRef.current;
      void incomingReceiverRef.current.abort(new Error('Cancelled by user'));
      incomingReceiverRef.current = null;
      incomingReceiverIdRef.current = null;
      if (tid) sendJsonPacket({ type: 'v2-cancel', transferId: tid });
    }
    sendJsonPacket({ type: 'file-cancel' });
    setTransferProgress(0);
    setTelemetry(null);
    isTransferActiveRef.current = false;
    setStatusText('Transfer cancelled');
  }, [sendJsonPacket]);

  // Robust streaming file sender (Network v2 verified 4-channel/paced relay, with v1 fallback)
  const sendFile = useCallback(
    async (file: File, skipOffer = false): Promise<boolean> => {
      const v2 = isV2Active();
      if (v2 && !agreementRef.current?.canStart()) {
        setLastError('Connection is switching or unavailable');
        return false;
      }

      const hasDc =
        dcRef.current?.readyState === 'open' ||
        (agreementRef.current?.current === 'rtc' && controlChannelRef.current?.readyState === 'open');
      const hasWs = isSocketOpen(socketManagerRef.current?.getSocket() ?? null);
      if (!hasDc && !hasWs) {
        setLastError('No active peer connection');
        return false;
      }

      if (isTransferActiveRef.current) {
        networkLog('A transfer is already active');
        return false;
      }

      isTransferActiveRef.current = true;
      cancelFlagRef.current = false;
      const mime = file.type || 'application/octet-stream';
      const transferId = crypto.randomUUID();
      const genAtStart = sessionGenerationRef.current;

      // Pin committed path before transmitting offer
      const committedPath = v2 ? agreementRef.current?.current ?? null : null;
      const pinnedControl = committedPath === 'rtc' ? controlChannelRef.current : null;
      const pinnedBulk =
        committedPath === 'rtc'
          ? ([0, 1, 2, 3].map((i) => bulkChannelsRef.current.get(i)).filter(Boolean) as RTCDataChannel[])
          : [];
      const pinnedSocket = committedPath === 'relay' ? socketManagerRef.current?.getSocket() ?? null : null;

      // 1. Send file offer unless auto-accepted / skip
      if (!skipOffer) {
        const offerId = crypto.randomUUID();
        setTransferProgress(1);
        setTelemetry({
          transferId,
          direction: 'sending',
          fileName: file.name,
          fileMime: mime,
          totalBytes: file.size,
          transferredBytes: 0,
          speedMbps: 0,
          etaSeconds: 0,
          progress: 0,
          awaitingApproval: true,
        });

        let approvalTimer: ReturnType<typeof setTimeout> | null = null;
        const accepted = await new Promise<boolean>((resolve) => {
          pendingOfferResolverRef.current = { offerId, resolve };
          approvalTimer = setTimeout(() => {
            if (pendingOfferResolverRef.current?.offerId === offerId) {
              pendingOfferResolverRef.current = null;
              resolve(false);
            }
          }, OFFER_APPROVAL_TIMEOUT_MS);

          sendJsonPacket({
            type: 'file-offer',
            offerId,
            transferId,
            name: file.name,
            size: file.size,
            mime,
            senderDeviceType: detectDevice().deviceType,
          });
        });

        if (approvalTimer) clearTimeout(approvalTimer);

        if (!accepted || cancelFlagRef.current) {
          setTransferProgress(0);
          setTelemetry(null);
          isTransferActiveRef.current = false;
          setStatusText(cancelFlagRef.current ? 'Cancelled' : 'Declined by peer');
          return false;
        }
      }

      // 2. Network v2 verified transfer path
      if (v2 && committedPath) {
        const transferAc = new AbortController();
        transferControllerRef.current = transferAc;
        activeOutgoingIdRef.current = transferId;
        const cs =
          committedPath === 'rtc'
            ? computeRtcChunkSize(pcRef.current ?? undefined)
            : MAX_FRAME - HEADER;
        const fileId = nextFileIdRef.current++ & 0xffff;
        const meta: FileMeta = {
          transferId,
          fileId,
          name: file.name,
          mime,
          size: file.size,
          chunkSize: cs,
        };

        setStatusText(`Beaming ${file.name}...`);
        setTransferProgress(1);
        const sampler = createSampler(file.size, (s) => {
          if (activeOutgoingIdRef.current !== transferId) return;
          setTransferProgress(s.progress);
          setTelemetry({
            transferId,
            direction: 'sending',
            fileName: file.name,
            fileMime: mime,
            totalBytes: file.size,
            transferredBytes: s.bytes,
            speedMbps: Number((s.speedBps / (1024 * 1024)).toFixed(2)),
            etaSeconds: Number.isFinite(s.etaSeconds) ? s.etaSeconds : 0,
            progress: s.progress,
            awaitingApproval: false,
          });
        });
        samplerRef.current = sampler;

        try {
          if (committedPath === 'rtc' && (!pinnedControl || pinnedBulk.length !== 4)) {
            throw new Error('WebRTC channels not ready');
          }
          if (committedPath === 'relay' && (!pinnedSocket || pinnedSocket.readyState !== WebSocket.OPEN)) {
            throw new Error('Relay socket not open');
          }
          if (committedPath === 'relay') {
            await relayAdmissionRef.current(transferAc.signal);
          }

          activeOutgoingAttemptRef.current = {
            id: transferId,
            path: committedPath,
            generation: sessionLeaseRef.current.epoch,
          };

          const trace = createSpeedTrace('send');
          const transferStartedAt = performance.now();
          const finalResult = await sendVerified({
            meta,
            file,
            path:
              committedPath === 'rtc'
                ? { kind: 'rtc', bulk: pinnedBulk }
                : { kind: 'relay', socket: pinnedSocket! },
            signal: transferAc.signal,
            sendControl: (packet) => {
              if (committedPath === 'rtc') {
                if (!pinnedControl || pinnedControl.readyState !== 'open') {
                  throw new Error('Control channel closed');
                }
                pinnedControl.send(JSON.stringify(packet));
              } else {
                const ok = socketManagerRef.current?.send(
                  JSON.stringify({ type: 'relay', payload: packet })
                );
                if (!ok) throw new Error('Relay signaling closed');
              }
            },
            subscribe: (control, credit) => {
              const entry = { control, credit };
              senderSubsRef.current.add(entry);
              return () => {
                senderSubsRef.current.delete(entry);
              };
            },
            record: (bytes, waitMs) => sampler.record(bytes, waitMs),
            phase: trace,
            invalidatePath: () => {
              // Retire uncertain data path without silently switching mid-transfer
              if (committedPath === 'rtc') {
                closeRtcResources();
              }
            },
          });

          sampler.stop(true);
          if (genAtStart === sessionGenerationRef.current) {
            setTotalSessionBytes((b) => b + file.size);
            setSharedItems((prev) => [
              {
                id: transferId,
                kind: 'file',
                file,
                direction: 'sent',
                timestamp: Date.now(),
              },
              ...prev,
            ]);
            setTransferProgress(100);
            setStatusText(`Sent ${file.name}`);
            updateDiagnostics({
              receiverConfirmedBytes: finalResult.size,
              transferElapsedMs: elapsedMs(transferStartedAt),
            });
          }
          setTimeout(() => {
            if (activeOutgoingIdRef.current === null) setTelemetry(null);
          }, 1200);
          return true;
        } catch (err) {
          sampler.stop(false);
          setTransferProgress(0);
          setTelemetry(null);
          setStatusText(err instanceof Error ? err.message : `Transfer failed: ${file.name}`);
          return false;
        } finally {
          transferAc.abort();
          if (transferControllerRef.current === transferAc) {
            transferControllerRef.current = null;
          }
          if (activeOutgoingIdRef.current === transferId) {
            activeOutgoingIdRef.current = null;
            activeOutgoingAttemptRef.current = null;
          }
          if (samplerRef.current === sampler) {
            samplerRef.current = null;
          }
          isTransferActiveRef.current = false;
        }
      }

      // 3. Legacy v1 fallback path (when peer or server is v1)
      setStatusText(`Beaming ${file.name}...`);
      setTransferProgress(1);
      const startTime = performance.now();

      setTelemetry({
        transferId,
        direction: 'sending',
        fileName: file.name,
        fileMime: mime,
        totalBytes: file.size,
        transferredBytes: 0,
        speedMbps: 0,
        etaSeconds: 1,
        progress: 1,
        awaitingApproval: false,
      });

      sendJsonPacket({
        type: 'file-meta',
        transferId,
        name: file.name,
        size: file.size,
        mime,
      });

      // Select one transport per transfer, do not switch mid-transfer
      const transferTransport = dcRef.current?.readyState === 'open' ? 'direct' : 'relayed';
      const v1Ac = new AbortController();
      transferControllerRef.current = v1Ac;

      // 3. Sequentially slice and stream chunks with backpressure
      let offset = 0;
      while (offset < file.size) {
        if (cancelFlagRef.current) {
          isTransferActiveRef.current = false;
          return false;
        }

        const slice = file.slice(offset, offset + CHUNK_SIZE);
        const chunk = await slice.arrayBuffer();

        // Send exclusively using the pinned transport
        if (transferTransport === 'direct') {
          const dc = dcRef.current;
          if (!dc || dc.readyState !== 'open') {
            isTransferActiveRef.current = false;
            setStatusText('Transfer failed: direct connection interrupted');
            return false;
          }
          try {
            await waitChannel(dc, chunk.byteLength, v1Ac.signal);
            if (cancelFlagRef.current || dc.readyState !== 'open') {
              throw new Error('Direct connection interrupted');
            }
            dc.send(chunk);
          } catch {
            isTransferActiveRef.current = false;
            setStatusText('Transfer failed: direct connection interrupted');
            return false;
          }
        } else {
          const sm = socketManagerRef.current;
          const socket = sm?.getSocket();
          if (!sm || !socket || socket.readyState !== WebSocket.OPEN) {
            isTransferActiveRef.current = false;
            setStatusText('Transfer failed: relay connection interrupted');
            return false;
          }
          try {
            await waitSocket(socket, chunk.byteLength, v1Ac.signal);
            if (cancelFlagRef.current || socket.readyState !== WebSocket.OPEN) {
              throw new Error('Relay connection interrupted');
            }
            sm.send(chunk);
          } catch {
            isTransferActiveRef.current = false;
            setStatusText('Transfer failed: relay connection interrupted');
            return false;
          }
        }

        offset += chunk.byteLength;

        // Accurate telemetry calculation
        const elapsedSec = Math.max(0.05, (performance.now() - startTime) / 1000);
        const bytesPerSec = offset / elapsedSec;
        const mbPerSec = Number((bytesPerSec / (1024 * 1024)).toFixed(1));
        const remainingBytes = Math.max(0, file.size - offset);
        const eta = Math.max(1, Math.ceil(remainingBytes / Math.max(1, bytesPerSec)));
        const pct = Math.min(99, Math.max(1, Math.round((offset / file.size) * 100)));

        setTransferProgress(pct);
        setTelemetry({
          transferId,
          direction: 'sending',
          fileName: file.name,
          fileMime: mime,
          totalBytes: file.size,
          transferredBytes: offset,
          speedMbps: mbPerSec,
          etaSeconds: eta,
          progress: pct,
          awaitingApproval: false,
        });
      }

      if (cancelFlagRef.current) {
        isTransferActiveRef.current = false;
        return false;
      }

      // 4. Send end marker on pinned transport and wait for receiver ACK
      if (transferTransport === 'direct' && dcRef.current?.readyState === 'open') {
        dcRef.current.send(JSON.stringify({ type: 'file-end', transferId }));
      } else {
        socketManagerRef.current?.send(
          JSON.stringify({
            type: 'relay',
            payload: {
              type: 'file-end',
              from: myIdRef.current,
              sessionId: sessionIdRef.current,
              transferId,
            },
          })
        );
      }

      let ackTimer: ReturnType<typeof setTimeout> | null = null;
      const acknowledged = await new Promise<boolean>((resolve) => {
        pendingAckResolverRef.current = {
          transferId,
          expectedBytes: file.size,
          resolve,
        };
        ackTimer = setTimeout(() => {
          if (pendingAckResolverRef.current?.transferId === transferId) {
            pendingAckResolverRef.current = null;
            resolve(false);
          }
        }, ACK_TIMEOUT_MS);
      });

      if (ackTimer) clearTimeout(ackTimer);

      isTransferActiveRef.current = false;

      if (!acknowledged) {
        setStatusText(`Transfer failed: no acknowledgement`);
        return false;
      }

      setTotalSessionBytes((b) => b + file.size);
      setSharedItems((prev) => [
        {
          id: transferId || crypto.randomUUID(),
          kind: 'file',
          file,
          direction: 'sent',
          timestamp: Date.now(),
        },
        ...prev,
      ]);

      const totalElapsed = Math.max(0.05, (performance.now() - startTime) / 1000);
      const finalSpeed = Number((file.size / totalElapsed / (1024 * 1024)).toFixed(1));

      setTransferProgress(100);
      setTelemetry({
        transferId,
        direction: 'sending',
        fileName: file.name,
        fileMime: mime,
        totalBytes: file.size,
        transferredBytes: file.size,
        speedMbps: finalSpeed,
        etaSeconds: 0,
        progress: 100,
        awaitingApproval: false,
      });

      setStatusText(`Sent ${file.name}`);
      setTimeout(() => setTelemetry((prev) => clearMatchingTransfer(prev, transferId)), 1200);
      return true;
    },
    [sendJsonPacket, isV2Active, closeRtcResources, updateDiagnostics]
  );

  return {
    wsConnected,
    connectionState,
    transport,
    diagnostics,
    connectedPeer,
    localDeviceName,
    pin,
    autoAccept,
    setAutoAccept,
    totalSessionBytes,
    remoteClipboard,
    localClipboard,
    sharedItems,
    transferProgress,
    telemetry,
    incomingOffer,
    statusText,
    lastError,
    connectWithPin,
    disconnect,
    pushMyClipboard,
    requestRemoteClipboard,
    sendTextOrLink,
    sendFile,
    acceptIncomingFile,
    declineIncomingFile,
    cancelTransfer,
  };
}
