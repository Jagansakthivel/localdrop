export interface WebRtcTraceEvent {
  tMs: number;
  stage: string;
  detail?: Record<string, string | number | boolean | null>;
}

export interface SanitizedPeerStats {
  iceState: RTCIceConnectionState;
  connectionState: RTCPeerConnectionState;
  gatheringState: RTCIceGatheringState;
  signalingState: RTCSignalingState;
  dtlsState: string | null;
  sctpState: string | null;
  sctpMaxMessageSize: number | null;
  selectedPair: {
    state: string | null;
    nominated: boolean | null;
    localType: string | null;
    remoteType: string | null;
    protocol: string | null;
    relayProtocol: string | null;
    currentRoundTripTime: number | null;
    availableOutgoingBitrate: number | null;
    bytesSent: number | null;
    bytesReceived: number | null;
    requestsSent: number | null;
    responsesReceived: number | null;
  } | null;
  localCandidateTypes: Record<string, number>;
  remoteCandidateTypes: Record<string, number>;
}

export interface WebRtcTraceCollector {
  mark: (stage: string, detail?: Record<string, string | number | boolean | null>) => void;
  exportReport: () => { startedAtIso: string; events: WebRtcTraceEvent[] };
  reset: () => void;
}

export function isNetTraceEnabled(): boolean {
  try {
    if (typeof window !== 'undefined') {
      const search = window.location?.search || '';
      if (search.includes('nettrace=1')) return true;
    }
    return (
      typeof localStorage !== 'undefined' &&
      (localStorage.getItem('ld:nettrace') === '1' || localStorage.getItem('localdrop_debug') === '1')
    );
  } catch {
    return false;
  }
}

export function createWebRtcTrace(): WebRtcTraceCollector {
  let start = performance.now();
  let startedAtIso = new Date().toISOString();
  const events: WebRtcTraceEvent[] = [];

  const mark = (stage: string, detail?: Record<string, string | number | boolean | null>) => {
    const tMs = Math.round(performance.now() - start);
    if (events.length >= 400) {
      events.shift();
    }
    events.push(detail ? { tMs, stage, detail } : { tMs, stage });
    if (isNetTraceEnabled()) {
      console.info(`[LocalDrop WebRTC +${tMs}ms] ${stage}`, detail ?? '');
    }
  };

  const reset = () => {
    start = performance.now();
    startedAtIso = new Date().toISOString();
    events.length = 0;
  };

  const exportReport = () => ({
    startedAtIso,
    events: [...events],
  });

  if (typeof window !== 'undefined') {
    (window as unknown as Record<string, unknown>).__localdropWebRtcTrace = exportReport;
  }

  return { mark, exportReport, reset };
}

/**
 * Inspect RTCPeerConnection.getStats() without exposing any IP addresses, SDP, or credentials.
 */
export async function inspectPeerStats(pc: RTCPeerConnection): Promise<SanitizedPeerStats> {
  const localCandidateTypes: Record<string, number> = {};
  const remoteCandidateTypes: Record<string, number> = {};
  let dtlsState: string | null = null;
  let selectedPairId: string | null = null;
  let selectedPair: SanitizedPeerStats['selectedPair'] = null;

  try {
    const stats = await pc.getStats();
    stats.forEach((raw) => {
      const r = raw as unknown as Record<string, unknown>;
      if (r.type === 'local-candidate' && typeof r.candidateType === 'string') {
        localCandidateTypes[r.candidateType] = (localCandidateTypes[r.candidateType] || 0) + 1;
      } else if (r.type === 'remote-candidate' && typeof r.candidateType === 'string') {
        remoteCandidateTypes[r.candidateType] = (remoteCandidateTypes[r.candidateType] || 0) + 1;
      } else if (r.type === 'transport') {
        if (typeof r.dtlsState === 'string') dtlsState = r.dtlsState;
        if (typeof r.selectedCandidatePairId === 'string') selectedPairId = r.selectedCandidatePairId;
      }
    });

    if (!selectedPairId) {
      const nominated: string[] = [];
      stats.forEach((entry) => {
        const pair = entry as unknown as Record<string, unknown>;
        if (pair.type !== 'candidate-pair' || typeof pair.id !== 'string') return;
        if (pair.selected === true) selectedPairId = pair.id;
        if (pair.nominated === true && pair.state === 'succeeded') nominated.push(pair.id);
      });
      if (!selectedPairId && nominated.length === 1) selectedPairId = nominated[0];
    }

    if (selectedPairId) {
      const pair = stats.get(selectedPairId) as unknown as Record<string, unknown> | undefined;
      if (pair) {
        const local =
          typeof pair.localCandidateId === 'string'
            ? (stats.get(pair.localCandidateId) as unknown as Record<string, unknown> | undefined)
            : undefined;
        const remote =
          typeof pair.remoteCandidateId === 'string'
            ? (stats.get(pair.remoteCandidateId) as unknown as Record<string, unknown> | undefined)
            : undefined;
        selectedPair = {
          state: typeof pair.state === 'string' ? pair.state : null,
          nominated: typeof pair.nominated === 'boolean' ? pair.nominated : null,
          localType: typeof local?.candidateType === 'string' ? local.candidateType : null,
          remoteType: typeof remote?.candidateType === 'string' ? remote.candidateType : null,
          protocol: typeof local?.protocol === 'string' ? local.protocol : null,
          relayProtocol: typeof local?.relayProtocol === 'string' ? local.relayProtocol : null,
          currentRoundTripTime:
            typeof pair.currentRoundTripTime === 'number' ? pair.currentRoundTripTime : null,
          availableOutgoingBitrate:
            typeof pair.availableOutgoingBitrate === 'number' ? pair.availableOutgoingBitrate : null,
          bytesSent: typeof pair.bytesSent === 'number' ? pair.bytesSent : null,
          bytesReceived: typeof pair.bytesReceived === 'number' ? pair.bytesReceived : null,
          requestsSent: typeof pair.requestsSent === 'number' ? pair.requestsSent : null,
          responsesReceived: typeof pair.responsesReceived === 'number' ? pair.responsesReceived : null,
        };
      }
    }
  } catch {
    // getStats unsupported or PC closed
  }

  const sctp = (pc as RTCPeerConnection & { sctp?: { state?: string; maxMessageSize?: number } }).sctp;
  return {
    iceState: pc.iceConnectionState,
    connectionState: pc.connectionState,
    gatheringState: pc.iceGatheringState,
    signalingState: pc.signalingState,
    dtlsState,
    sctpState: typeof sctp?.state === 'string' ? sctp.state : null,
    sctpMaxMessageSize: typeof sctp?.maxMessageSize === 'number' ? sctp.maxMessageSize : null,
    selectedPair,
    localCandidateTypes,
    remoteCandidateTypes,
  };
}

export function extractCandidateType(candidateStr: string): string {
  const m = /\btyp\s+([a-z0-9]+)/i.exec(candidateStr);
  return m ? m[1].toLowerCase() : 'unknown';
}

export function attachRtcDiagnostics(
  pc: RTCPeerConnection,
  trace?: WebRtcTraceCollector
): () => void {
  const report = () => {
    const payload = {
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      signaling: pc.signalingState,
    };
    if (import.meta.env.DEV || isNetTraceEnabled()) {
      console.info('[LocalDrop RTC Diagnostics]', payload);
    }
    trace?.mark('rtc-state', payload);
    if (pc.iceConnectionState === 'connected' || pc.iceConnectionState === 'completed') {
      void inspectPeerStats(pc).then((s) => trace?.mark('ice-stats', {
        localType: s.selectedPair?.localType ?? null,
        remoteType: s.selectedPair?.remoteType ?? null,
        protocol: s.selectedPair?.protocol ?? null,
        dtlsState: s.dtlsState,
        sctpState: s.sctpState,
        rttMs: s.selectedPair?.currentRoundTripTime != null ? Math.round(s.selectedPair.currentRoundTripTime * 1000) : null,
      }));
    }
  };

  const onIceCandidateError = (event: Event) => {
    const e = event as RTCPeerConnectionIceErrorEvent;
    let urlHost: string | null = null;
    try {
      if (e.url) urlHost = new URL(e.url).hostname;
    } catch {
      urlHost = null;
    }
    trace?.mark('ice-candidate-error', {
      errorCode: typeof e.errorCode === 'number' ? e.errorCode : null,
      errorText: typeof e.errorText === 'string' ? e.errorText.slice(0, 120) : null,
      urlHost,
    });
  };

  pc.addEventListener('connectionstatechange', report);
  pc.addEventListener('iceconnectionstatechange', report);
  pc.addEventListener('icegatheringstatechange', report);
  pc.addEventListener('signalingstatechange', report);
  pc.addEventListener('icecandidateerror', onIceCandidateError);

  return () => {
    pc.removeEventListener('connectionstatechange', report);
    pc.removeEventListener('iceconnectionstatechange', report);
    pc.removeEventListener('icegatheringstatechange', report);
    pc.removeEventListener('signalingstatechange', report);
    pc.removeEventListener('icecandidateerror', onIceCandidateError);
  };
}
