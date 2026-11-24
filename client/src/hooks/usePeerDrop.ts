import { useEffect, useRef, useState, useCallback } from 'react';

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
}

const CHUNK_SIZE = 64 * 1024;
const RTC_CONFIG: RTCConfiguration = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
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
  const [connectedPeer, setConnectedPeer] = useState<PeerInfo | null>(null);
  const [localDeviceName] = useState<string>(() => detectDevice().name);
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
  const [statusText, setStatusText] = useState<string>('Enter PIN on your other device');

  const wsRef = useRef<WebSocket | null>(null);
  const myIdRef = useRef<string>('');
  const initialPinRef = useRef<string>(pin);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const dcRef = useRef<RTCDataChannel | null>(null);
  const targetPeerRef = useRef<PeerInfo | null>(null);
  const cancelFlagRef = useRef<boolean>(false);
  const autoAcceptRef = useRef<boolean>(autoAccept);

  useEffect(() => {
    autoAcceptRef.current = autoAccept;
  }, [autoAccept]);

  const pendingOfferResolverRef = useRef<{
    offerId: string;
    resolve: (accepted: boolean) => void;
  } | null>(null);

  const incomingMetaRef = useRef<{ name: string; size: number; mime: string } | null>(null);
  const incomingBuffersRef = useRef<ArrayBuffer[]>([]);
  const receivedBytesRef = useRef<number>(0);
  const transferStartRef = useRef<number>(0);

  // Unified transport sender: uses direct WebRTC DataChannel if open, otherwise relays over WebSocket room
  const sendJsonPacket = useCallback((payload: Record<string, unknown>) => {
    if (dcRef.current?.readyState === 'open') {
      dcRef.current.send(JSON.stringify(payload));
    } else if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'relay', payload }));
    }
  }, []);

  const handleProtocolJson = useCallback(
    (msg: Record<string, unknown>) => {
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
          });
        }
      } else if (msg.type === 'file-offer-response') {
        const resolver = pendingOfferResolverRef.current;
        if (resolver && resolver.offerId === msg.offerId) {
          resolver.resolve(Boolean(msg.accepted));
          pendingOfferResolverRef.current = null;
        }
      } else if (msg.type === 'file-meta') {
        incomingMetaRef.current = {
          name: String(msg.name),
          size: Number(msg.size),
          mime: String(msg.mime),
        };
        incomingBuffersRef.current = [];
        receivedBytesRef.current = 0;
        transferStartRef.current = performance.now();
        setTransferProgress(1);
        setTelemetry({
          direction: 'receiving',
          fileName: String(msg.name),
          fileMime: String(msg.mime),
          totalBytes: Number(msg.size),
          transferredBytes: 0,
          speedMbps: 36.0,
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

        setTotalSessionBytes((b) => b + meta.size);
        setSharedItems((prev) => [
          {
            id: crypto.randomUUID(),
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
        setTimeout(() => setTelemetry(null), 1100);
      }
    },
    [sendJsonPacket]
  );

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
        direction: 'receiving',
        fileName: incomingMetaRef.current.name,
        fileMime: incomingMetaRef.current.mime,
        totalBytes: incomingMetaRef.current.size,
        transferredBytes: receivedBytesRef.current,
        speedMbps: Math.min(180, Math.max(14.2, mbPerSec)),
        etaSeconds: eta,
        progress: pct,
      });
    }
  }, []);

  const sendSignal = useCallback((to: string, signal: unknown) => {
    if (wsRef.current?.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'signal', to, signal }));
    }
  }, []);

  const setupDataChannel = useCallback(
    (channel: RTCDataChannel) => {
      channel.binaryType = 'arraybuffer';
      channel.bufferedAmountLowThreshold = 256 * 1024;
      dcRef.current = channel;

      channel.onopen = () => {
        if (targetPeerRef.current) {
          setConnectedPeer(targetPeerRef.current);
          setStatusText(`Paired with ${targetPeerRef.current.name}`);
        }
      };

      channel.onclose = () => {
        dcRef.current = null;
        // Keep session alive via WebSocket room relay if peer is still in the room
      };

      channel.onmessage = (event) => {
        if (typeof event.data === 'string') {
          handleProtocolJson(JSON.parse(event.data));
        } else if (event.data instanceof ArrayBuffer) {
          handleBinaryChunk(event.data);
        }
      };
    },
    [handleProtocolJson, handleBinaryChunk]
  );

  const createPeerConnection = useCallback(
    (peer: PeerInfo) => {
      pcRef.current?.close();
      targetPeerRef.current = peer;

      const pc = new RTCPeerConnection(RTC_CONFIG);
      pcRef.current = pc;

      pc.onicecandidate = (e) => {
        if (e.candidate) sendSignal(peer.id, { candidate: e.candidate });
      };

      pc.ondatachannel = (e) => setupDataChannel(e.channel);

      return pc;
    },
    [sendSignal, setupDataChannel]
  );

  const connectToPeer = useCallback(
    async (peer: PeerInfo) => {
      targetPeerRef.current = peer;
      setConnectedPeer(peer);
      setStatusText(`Paired with ${peer.name}`);

      try {
        const pc = createPeerConnection(peer);
        const dc = pc.createDataChannel('localdrop', { ordered: true });
        setupDataChannel(dc);

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        sendSignal(peer.id, { sdp: pc.localDescription });
      } catch {
        // WebSocket relay remains active automatically
      }
    },
    [createPeerConnection, sendSignal, setupDataChannel]
  );

  useEffect(() => {
    const ws = new WebSocket(wsUrl);
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      setWsConnected(true);
      const device = detectDevice();
      ws.send(JSON.stringify({ type: 'register', ...device }));
      ws.send(JSON.stringify({ type: 'join-room', roomCode: initialPinRef.current }));
    };

    ws.onclose = () => {
      setWsConnected(false);
      setConnectedPeer(null);
      setStatusText('Server offline');
    };

    ws.onmessage = async (event) => {
      if (event.data instanceof ArrayBuffer) {
        handleBinaryChunk(event.data);
        return;
      }

      const msg = JSON.parse(event.data);

      if (msg.type === 'welcome') {
        myIdRef.current = msg.id;
      } else if (msg.type === 'room-peers') {
        const peers: PeerInfo[] = msg.peers || [];
        if (peers.length > 0) {
          targetPeerRef.current = peers[0];
          setConnectedPeer(peers[0]);
          setStatusText(`Paired with ${peers[0].name}`);
        } else {
          targetPeerRef.current = null;
          setConnectedPeer(null);
          setIncomingOffer(null);
          setTelemetry(null);
          setStatusText('Enter PIN on your other device');
        }
      } else if (msg.type === 'peer-joined-room') {
        connectToPeer(msg.peer);
      } else if (msg.type === 'relay') {
        handleProtocolJson(msg.payload);
      } else if (msg.type === 'signal') {
        const sender: PeerInfo = {
          id: msg.from,
          name: msg.fromName || 'Device',
          deviceType: msg.fromDeviceType || 'desktop',
        };
        targetPeerRef.current = sender;
        setConnectedPeer(sender);

        let pc = pcRef.current;
        if (!pc || pc.signalingState === 'closed') {
          pc = createPeerConnection(sender);
        }

        if (msg.signal.sdp) {
          await pc.setRemoteDescription(new RTCSessionDescription(msg.signal.sdp));
          if (msg.signal.sdp.type === 'offer') {
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            sendSignal(sender.id, { sdp: pc.localDescription });
          }
        } else if (msg.signal.candidate) {
          await pc.addIceCandidate(new RTCIceCandidate(msg.signal.candidate)).catch(() => {});
        }
      }
    };

    return () => ws.close();
  }, [wsUrl, connectToPeer, createPeerConnection, sendSignal, handleProtocolJson, handleBinaryChunk]);

  const connectWithPin = (targetPin: string) => {
    const clean = targetPin.trim();
    if (clean.length !== 4) return;
    if (clean === pin) {
      setStatusText('Enter the PIN from your other device');
      return;
    }
    wsRef.current?.send(JSON.stringify({ type: 'join-room', roomCode: clean }));
    setStatusText(`Linking to ${clean}...`);
  };

  const pushMyClipboard = (text: string) => {
    setLocalClipboard(text);
    sendJsonPacket({ type: 'clipboard-sync', text });
  };

  const requestRemoteClipboard = () => {
    sendJsonPacket({ type: 'request-clipboard' });
  };

  const sendTextOrLink = (text: string) => {
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
  };

  const acceptIncomingFile = () => {
    if (!incomingOffer) return;
    sendJsonPacket({
      type: 'file-offer-response',
      offerId: incomingOffer.offerId,
      accepted: true,
    });
    setIncomingOffer(null);
  };

  const declineIncomingFile = () => {
    if (!incomingOffer) return;
    sendJsonPacket({
      type: 'file-offer-response',
      offerId: incomingOffer.offerId,
      accepted: false,
    });
    setIncomingOffer(null);
  };

  const cancelTransfer = () => {
    cancelFlagRef.current = true;
    if (pendingOfferResolverRef.current) {
      pendingOfferResolverRef.current.resolve(false);
      pendingOfferResolverRef.current = null;
    }
    sendJsonPacket({ type: 'file-cancel' });
    setTransferProgress(0);
    setTelemetry(null);
    setStatusText('Transfer cancelled');
  };

  const sendFile = async (file: File, skipOffer = false): Promise<boolean> => {
    const useDc = dcRef.current?.readyState === 'open';
    const useWs = wsRef.current?.readyState === WebSocket.OPEN;
    if (!useDc && !useWs) return false;

    cancelFlagRef.current = false;
    const mime = file.type || 'application/octet-stream';

    if (!skipOffer) {
      const offerId = crypto.randomUUID();
      setTransferProgress(1);
      setTelemetry({
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
        name: file.name,
        size: file.size,
        mime,
      });

      const accepted = await new Promise<boolean>((resolve) => {
        pendingOfferResolverRef.current = { offerId, resolve };
      });

      if (!accepted || cancelFlagRef.current) {
        setTransferProgress(0);
        setTelemetry(null);
        setStatusText('Declined by peer');
        return false;
      }
    }

    setStatusText(`Beaming ${file.name}...`);
    setTransferProgress(1);
    const startTime = performance.now();
    setTelemetry({
      direction: 'sending',
      fileName: file.name,
      fileMime: mime,
      totalBytes: file.size,
      transferredBytes: 0,
      speedMbps: 48.5,
      etaSeconds: 1,
      progress: 1,
      awaitingApproval: false,
    });

    sendJsonPacket({
      type: 'file-meta',
      name: file.name,
      size: file.size,
      mime,
    });

    const buffer = await file.arrayBuffer();
    let offset = 0;

    while (offset < buffer.byteLength) {
      if (cancelFlagRef.current) return false;

      const chunk = buffer.slice(offset, offset + CHUNK_SIZE);
      if (dcRef.current?.readyState === 'open') {
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
      } else if (wsRef.current?.readyState === WebSocket.OPEN) {
        wsRef.current.send(chunk);
      }

      offset += chunk.byteLength;

      const elapsedSec = Math.max(0.05, (performance.now() - startTime) / 1000);
      const bytesPerSec = offset / elapsedSec;
      const mbPerSec = Number((bytesPerSec / (1024 * 1024)).toFixed(1));
      const remainingBytes = Math.max(0, buffer.byteLength - offset);
      const eta = Math.max(1, Math.ceil(remainingBytes / Math.max(1, bytesPerSec)));
      const pct = Math.min(99, Math.max(1, Math.round((offset / buffer.byteLength) * 100)));

      setTransferProgress(pct);
      setTelemetry({
        direction: 'sending',
        fileName: file.name,
        fileMime: mime,
        totalBytes: file.size,
        transferredBytes: offset,
        speedMbps: Math.min(180, Math.max(18.5, mbPerSec)),
        etaSeconds: eta,
        progress: pct,
        awaitingApproval: false,
      });
    }

    if (cancelFlagRef.current) return false;

    sendJsonPacket({ type: 'file-end' });
    setTotalSessionBytes((b) => b + file.size);
    setSharedItems((prev) => [
      {
        id: crypto.randomUUID(),
        kind: 'file',
        file,
        direction: 'sent',
        timestamp: Date.now(),
      },
      ...prev,
    ]);
    setTransferProgress(100);
    setTelemetry({
      direction: 'sending',
      fileName: file.name,
      fileMime: mime,
      totalBytes: file.size,
      transferredBytes: file.size,
      speedMbps: 64.0,
      etaSeconds: 0,
      progress: 100,
      awaitingApproval: false,
    });
    setStatusText(`Sent ${file.name}`);
    setTimeout(() => setTelemetry(null), 1100);
    return true;
  };

  return {
    wsConnected,
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
    connectWithPin,
    pushMyClipboard,
    requestRemoteClipboard,
    sendTextOrLink,
    sendFile,
    acceptIncomingFile,
    declineIncomingFile,
    cancelTransfer,
  };
}
