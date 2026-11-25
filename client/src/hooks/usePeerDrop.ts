import { useEffect, useLayoutEffect, useRef, useState, useCallback } from 'react';
import type { ConnectionState, TransportType, NetworkDiagnostics } from '../types/network';
import { createReconnectingSocket } from '../utils/reconnectingSocket';
import { IceCandidateQueue } from '../utils/iceCandidateQueue';
import { attachRtcDiagnostics } from '../utils/rtcDiagnostics';
import { isSocketOpen, isValidPin, networkLog, pingBackendHealth } from '../utils/network';
import { createConnectionProfiler } from '../utils/connectionProfiler';

export interface PeerInfo {
  id: string;
  name: string;
  deviceType: 'mobile' | 'desktop';
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

const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    { urls: 'stun:stun2.l.google.com:19302' },
  ],
};

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

export function usePeerDrop(wsUrl: string) {
  const [wsConnected, setWsConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<ConnectionState>('offline');
  const [transport, setTransport] = useState<TransportType>(null);
  const [connectedPeer, setConnectedPeer] = useState<PeerInfo | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [localDeviceName] = useState<string>(() => detectDevice().name);

  // Host 4-digit PIN for this device
  const [pin] = useState<string>(() =>
    Math.floor(1000 + Math.random() * 9000).toString()
  );

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

  useEffect(() => {
    autoAcceptRef.current = autoAccept;
  }, [autoAccept]);

  // Synchronize diagnostics state
  const updateDiagnostics = useCallback(
    (overrides?: Partial<NetworkDiagnostics>) => {
      setDiagnostics((prev) => ({
        ...prev,
        signalingConnected: wsConnected,
        peerDiscovered: Boolean(targetPeerRef.current),
        connectionState,
        transport,
        iceState: pcRef.current?.iceConnectionState ?? null,
        peerState: pcRef.current?.connectionState ?? null,
        channelState: dcRef.current?.readyState ?? null,
        lastError,
        ...overrides,
      }));
    },
    [wsConnected, connectionState, transport, lastError]
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

  // Unified protocol sender: sends over WebRTC DataChannel if open, or WebSocket relay
  const sendJsonPacket = useCallback((payload: Record<string, unknown>) => {
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
    socketManagerRef.current?.send(
      JSON.stringify({
        type: 'signal',
        to,
        sessionId: sessionIdRef.current,
        signal,
      })
    );
  }, []);

  // Teardown WebRTC peer resources cleanly
  const teardownPeerConnection = useCallback(() => {
    if (negotiationTimerRef.current) {
      clearTimeout(negotiationTimerRef.current);
      negotiationTimerRef.current = null;
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
    negotiatingPeerIdRef.current = null;
  }, []);

  // Declare established connection
  const markConnected = useCallback(
    (mode: 'direct' | 'relayed', peer: PeerInfo) => {
      negotiatingPeerIdRef.current = null;
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
    },
    []
  );

  // Fallback to WebSocket relay if direct WebRTC negotiation fails or stalls
  const fallbackToRelay = useCallback(() => {
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
        navigator.clipboard
          .readText()
          .then((text) => {
            if (text) {
              setLocalClipboard(text);
              sendJsonPacket({ type: 'clipboard-sync', text });
            }
          })
          .catch(() => {});
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
        if (autoAcceptRef.current) {
          sendJsonPacket({
            type: 'file-offer-response',
            offerId: msg.offerId,
            accepted: true,
          });
        } else {
          setIncomingOffer({
            offerId: String(msg.offerId),
            name: String(msg.name),
            size: Number(msg.size),
            mime: String(msg.mime),
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
        setIncomingOffer(null);
        setTransferProgress(0);
        setTelemetry(null);
        setStatusText('Transfer cancelled');
      } else if (msg.type === 'file-end' && incomingMetaRef.current) {
        const meta = incomingMetaRef.current;
        const blob = new Blob(incomingBuffersRef.current, { type: meta.mime });
        const file = new File([blob], meta.name, { type: meta.mime });

        // Acknowledge receipt to the sender
        sendJsonPacket({
          type: 'file-ack',
          transferId: meta.transferId,
          receivedBytes: receivedBytesRef.current,
        });

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
        setTimeout(() => setTelemetry(null), 1200);
      } else if (msg.type === 'file-ack') {
        const resolver = pendingAckResolverRef.current;
        if (resolver && resolver.transferId === msg.transferId) {
          resolver.resolve(true);
          pendingAckResolverRef.current = null;
        }
      } else if (msg.type === 'relay-ping') {
        sendJsonPacket({
          type: 'relay-pong',
          from: myIdRef.current,
          sessionId: sessionIdRef.current,
        });
      } else if (msg.type === 'relay-pong') {
        relayReadyRef.current = true;
        profilerRef.current?.mark('relay confirmed');
        networkLog('Relay path confirmed concurrently with direct negotiation');
      } else if (msg.type === 'transport-switch') {
        if (msg.transport === 'relayed' && targetPeerRef.current) {
          profilerRef.current?.mark('relay confirmed');
          markConnected('relayed', targetPeerRef.current);
        }
      }
    },
    [sendJsonPacket, markConnected]
  );

  // Handle incoming binary chunk
  const handleBinaryChunk = useCallback((buffer: ArrayBuffer) => {
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
        if (dcRef.current === channel) {
          dcRef.current = null;
          // If signaling is still healthy, fall back to relay rather than dropping entirely
          if (targetPeerRef.current && isSocketOpen(socketManagerRef.current?.getSocket() ?? null)) {
            fallbackToRelay();
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

  // Create an RTCPeerConnection instance with state listeners
  const createPeerConnection = useCallback(
    (peer: PeerInfo) => {
      teardownPeerConnection();
      targetPeerRef.current = peer;

      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;
      rtcCleanupRef.current = attachRtcDiagnostics(pc);

      pc.onicecandidate = (e) => {
        if (e.candidate && myIdRef.current) {
          profilerRef.current?.mark('first ICE candidate');
          sendSignal(peer.id, { candidate: e.candidate });
        }
      };

      pc.ondatachannel = (e) => {
        setupDataChannel(e.channel, peer);
      };

      pc.oniceconnectionstatechange = () => {
        networkLog('ICE connection state:', pc.iceConnectionState);
        if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
          profilerRef.current?.mark('ICE connected');
        } else if (pc.iceConnectionState === 'failed') {
          fallbackToRelay();
        }
      };

      pc.onconnectionstatechange = () => {
        networkLog('PeerConnection connectionState:', pc.connectionState);
        if (pc.connectionState === 'connected') {
          profilerRef.current?.mark('ICE connected');
        } else if (pc.connectionState === 'failed') {
          networkLog('PeerConnection failed, attempting relay');
          fallbackToRelay();
        }
      };

      return pc;
    },
    [teardownPeerConnection, sendSignal, setupDataChannel, fallbackToRelay]
  );

  // Deterministic WebRTC negotiation: designated initiator starts offer
  const startNegotiation = useCallback(
    async (peer: PeerInfo, isInitiator: boolean) => {
      // Guard against duplicate negotiation tearing down an in-flight PeerConnection
      if (
        pcRef.current &&
        pcRef.current.signalingState !== 'closed' &&
        negotiatingPeerIdRef.current === peer.id
      ) {
        networkLog(`Already negotiating with ${peer.name} (${peer.id}), skipping duplicate trigger`);
        return;
      }

      negotiatingPeerIdRef.current = peer.id;
      setConnectionState('negotiating');
      setStatusText(`Establishing connection with ${peer.name}...`);
      targetPeerRef.current = peer;

      const pc = createPeerConnection(peer);

      // Start safety timeout: if WebRTC direct channel isn't established, fall back to relay
      if (negotiationTimerRef.current) clearTimeout(negotiationTimerRef.current);
      negotiationTimerRef.current = setTimeout(() => {
        networkLog('WebRTC negotiation timed out, falling back to relay');
        profilerRef.current?.report();
        callbacksRef.current.fallbackToRelay();
      }, NEGOTIATION_TIMEOUT_MS);

      if (isInitiator) {
        try {
          const dc = pc.createDataChannel('localdrop', { ordered: true });
          setupDataChannel(dc, peer);

          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          profilerRef.current?.mark('offer sent');
          sendSignal(peer.id, { sdp: pc.localDescription });
        } catch (err) {
          networkLog('CreateOffer failed:', err);
          fallbackToRelay();
        }
      }
    },
    [createPeerConnection, setupDataChannel, sendSignal, fallbackToRelay]
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

  // Initialize and manage the reconnecting WebSocket lifecycle
  useEffect(() => {
    sessionIdRef.current = crypto.randomUUID();

    // Send asynchronous HTTP health check to wake up sleeping free-tier backends (Render cold start)
    void pingBackendHealth(8000);

    const socketManager = createReconnectingSocket(wsUrl, {
      onOpen: (ws) => {
        hasConnectedOnceRef.current = true;
        setLastError(null);
        setConnectionState('signaling');
        setStatusText('Registering device…');

        // Step 1: Register client device metadata immediately upon socket connection
        const device = detectDevice();
        ws.send(JSON.stringify({ type: 'register', ...device }));
      },

      onClose: () => {
        setWsConnected(false);
        setConnectionState('reconnecting');
        setStatusText(
          hasConnectedOnceRef.current
            ? 'Signaling disconnected, reconnecting...'
            : 'Starting LocalDrop server...'
        );
      },

      onError: () => {
        // Do not display misleading connection failure during normal free-tier cold start
        if (hasConnectedOnceRef.current) {
          setLastError('Signaling server connection error');
        }
      },

      onReconnect: (attempt, delay) => {
        if (!hasConnectedOnceRef.current) {
          setStatusText('Starting LocalDrop server...');
        } else {
          setStatusText(`Reconnecting to server (attempt ${attempt})...`);
        }
        networkLog(`Reconnecting attempt ${attempt} in ${delay}ms`);
      },

      onExhausted: () => {
        setConnectionState('offline');
        setStatusText('Signaling server unavailable');
        setLastError(
          'Unable to reach LocalDrop signaling server. Please check your internet connection or verify your signaling endpoint.'
        );
      },

      onMessage: async (event) => {
        if (event.data instanceof ArrayBuffer) {
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
          // Step 2: Welcome received with assigned UUID. Proceed with room creation or pending join
          myIdRef.current = String(msg.id || '');
          networkLog('Registered with signaling ID:', myIdRef.current);

          if (pendingPinRef.current) {
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
            activeRoomRef.current = pin;
            socketManager.send(
              JSON.stringify({
                type: 'create-room',
                roomCode: pin,
              })
            );
          }
        } else if (msg.type === 'room-created') {
          // Step 3: Room confirmed by server. Now pairing is ready!
          activeRoomRef.current = String(msg.roomCode);
          profilerRef.current?.mark('room ack');
          setWsConnected(true);
          setConnectionState('waiting');
          setStatusText('Ready to pair');
          setLastError(null);
        } else if (msg.type === 'room-joined') {
          activeRoomRef.current = String(msg.roomCode);
          profilerRef.current?.mark('room ack');
          setWsConnected(true);
          pendingPinRef.current = null;
          if (pairingTimeoutTimerRef.current) {
            clearTimeout(pairingTimeoutTimerRef.current);
            pairingTimeoutTimerRef.current = null;
          }
        } else if (msg.type === 'room-error') {
          // Room rejected (e.g. ROOM_NOT_FOUND, ROOM_FULL, INVALID_PIN)
          const errorMsg = String(msg.message || 'Pairing error');
          setLastError(errorMsg);
          setStatusText(errorMsg);
          setConnectionState('failed');
          pendingPinRef.current = null;
          profilerRef.current?.report();

          if (pairingTimeoutTimerRef.current) {
            clearTimeout(pairingTimeoutTimerRef.current);
            pairingTimeoutTimerRef.current = null;
          }

          // Restore own host room so device remains discoverable
          activeRoomRef.current = pin;
          socketManager.send(
            JSON.stringify({
              type: 'create-room',
              roomCode: pin,
            })
          );
        } else if (msg.type === 'room-peers') {
          const peers: PeerInfo[] = (msg.peers as PeerInfo[]) || [];
          if (peers.length > 0) {
            const peer = peers[0];
            targetPeerRef.current = peer;

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

            // Deterministic offer initiator: lexicographical UUID comparison
            const isInitiator = myIdRef.current < peer.id;
            networkLog(`Room paired with ${peer.name}. Is initiator: ${isInitiator}`);
            callbacksRef.current.startNegotiation(peer, isInitiator);
          } else {
            // Peer left
            targetPeerRef.current = null;
            callbacksRef.current.teardownPeerConnection();
            setConnectedPeer(null);
            setConnectionState('waiting');
            setTransport(null);
            setIncomingOffer(null);
            setTelemetry(null);
            setStatusText('Ready to pair');
          }
        } else if (msg.type === 'peer-joined-room') {
          const peer = msg.peer as PeerInfo;
          if (peer && peer.id !== myIdRef.current) {
            targetPeerRef.current = peer;

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

            const isInitiator = myIdRef.current < peer.id;
            callbacksRef.current.startNegotiation(peer, isInitiator);
          }
        } else if (msg.type === 'relay') {
          callbacksRef.current.handleProtocolJson(msg.payload as Record<string, unknown>);
        } else if (msg.type === 'signal') {
          const sender: PeerInfo = {
            id: String(msg.from),
            name: String(msg.fromName || 'Device'),
            deviceType: (msg.fromDeviceType as 'mobile' | 'desktop') || 'desktop',
          };

          let pc = pcRef.current;
          if (!pc || pc.signalingState === 'closed') {
            pc = callbacksRef.current.createPeerConnection(sender);
          }

          const signal = msg.signal as {
            sdp?: RTCSessionDescriptionInit;
            candidate?: RTCIceCandidateInit;
          };

          if (signal?.sdp) {
            try {
              await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
              await iceQueueRef.current.flush(pc);

              if (signal.sdp.type === 'offer') {
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                callbacksRef.current.sendSignal(sender.id, { sdp: pc.localDescription });
              } else if (signal.sdp.type === 'answer') {
                profilerRef.current?.mark('answer installed');
              }
            } catch (err) {
              networkLog('Error handling remote SDP signal:', err);
              callbacksRef.current.fallbackToRelay();
            }
          } else if (signal?.candidate) {
            await iceQueueRef.current.add(pc, signal.candidate);
          }
        }
      },
    });

    socketManagerRef.current = socketManager;

    return () => {
      if (pairingTimeoutTimerRef.current) clearTimeout(pairingTimeoutTimerRef.current);
      if (negotiationTimerRef.current) clearTimeout(negotiationTimerRef.current);
      callbacksRef.current.teardownPeerConnection();
      socketManager.close();
      socketManagerRef.current = null;
    };
  }, [wsUrl, pin]);

  // Request to connect with a 4-digit PIN
  const connectWithPin = useCallback(
    (targetPin: string) => {
      const clean = targetPin.trim();

      if (!isValidPin(clean)) {
        setLastError('Enter a valid 4-digit PIN');
        return;
      }

      if (clean === pin) {
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
        if (connectionState === 'pairing') {
          setConnectionState('failed');
          setLastError(`Pairing to ${clean} timed out. Make sure the code is correct.`);
          setStatusText(`Pairing to ${clean} timed out`);
          pendingPinRef.current = null;
          profilerRef.current?.report();
          // Restore host room
          socketManagerRef.current?.send(
            JSON.stringify({
              type: 'create-room',
              roomCode: pin,
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
    [pin, connectionState]
  );

  // Manual disconnect / session teardown
  const disconnect = useCallback(() => {
    teardownPeerConnection();
    targetPeerRef.current = null;
    setConnectedPeer(null);
    setConnectionState('waiting');
    setTransport(null);
    setIncomingOffer(null);
    setTelemetry(null);
    setStatusText('Ready to pair');

    // Return to own host room
    activeRoomRef.current = pin;
    socketManagerRef.current?.send(
      JSON.stringify({
        type: 'create-room',
        roomCode: pin,
      })
    );
  }, [pin, teardownPeerConnection]);

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
    (text: string) => {
      const clean = text.trim();
      if (!clean) return;
      sendJsonPacket({ type: 'shared-text', text: clean });
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
    },
    [sendJsonPacket]
  );

  const acceptIncomingFile = useCallback(() => {
    if (!incomingOffer) return;
    sendJsonPacket({
      type: 'file-offer-response',
      offerId: incomingOffer.offerId,
      accepted: true,
    });
    setIncomingOffer(null);
  }, [incomingOffer, sendJsonPacket]);

  const declineIncomingFile = useCallback(() => {
    if (!incomingOffer) return;
    sendJsonPacket({
      type: 'file-offer-response',
      offerId: incomingOffer.offerId,
      accepted: false,
    });
    setIncomingOffer(null);
  }, [incomingOffer, sendJsonPacket]);

  const cancelTransfer = useCallback(() => {
    cancelFlagRef.current = true;
    if (pendingOfferResolverRef.current) {
      pendingOfferResolverRef.current.resolve(false);
      pendingOfferResolverRef.current = null;
    }
    if (pendingAckResolverRef.current) {
      pendingAckResolverRef.current.resolve(false);
      pendingAckResolverRef.current = null;
    }
    sendJsonPacket({ type: 'file-cancel' });
    setTransferProgress(0);
    setTelemetry(null);
    isTransferActiveRef.current = false;
    setStatusText('Transfer cancelled');
  }, [sendJsonPacket]);

  // Robust streaming file sender using sequential File.slice chunks with receiver ACK
  const sendFile = useCallback(
    async (file: File, skipOffer = false): Promise<boolean> => {
      const hasDc = dcRef.current?.readyState === 'open';
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

        sendJsonPacket({
          type: 'file-offer',
          offerId,
          transferId,
          name: file.name,
          size: file.size,
          mime,
          senderDeviceType: detectDevice().deviceType,
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

      // 2. Transmit metadata header
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
          if (dcRef.current?.readyState !== 'open') {
            isTransferActiveRef.current = false;
            setStatusText('Transfer failed: direct connection interrupted');
            return false;
          }
          if (dcRef.current.bufferedAmount > 1024 * 1024) {
            await new Promise<void>((resolve) => {
              if (!dcRef.current) return resolve();
              dcRef.current.onbufferedamountlow = () => {
                if (dcRef.current) dcRef.current.onbufferedamountlow = null;
                resolve();
              };
            });
          }
          dcRef.current.send(chunk);
        } else {
          const sm = socketManagerRef.current;
          const socket = sm?.getSocket();
          if (!sm || !socket || socket.readyState !== WebSocket.OPEN) {
            isTransferActiveRef.current = false;
            setStatusText('Transfer failed: relay connection interrupted');
            return false;
          }
          sm.send(chunk);
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

      // 4. Send end marker and wait for receiver ACK
      sendJsonPacket({ type: 'file-end', transferId });

      let ackTimer: ReturnType<typeof setTimeout> | null = null;
      const acknowledged = await new Promise<boolean>((resolve) => {
        pendingAckResolverRef.current = { transferId, resolve };
        ackTimer = setTimeout(() => {
          if (pendingAckResolverRef.current?.transferId === transferId) {
            pendingAckResolverRef.current = null;
            // Graceful fallback to true if timer expires on fast LAN
            resolve(true);
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
      setTimeout(() => setTelemetry(null), 1200);
      return true;
    },
    [sendJsonPacket]
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
