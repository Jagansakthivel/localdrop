import type { ConnectionState, NetworkDiagnostics, TransportType } from '../types/network';

export interface TransportCopy {
  badgeLabel: string;
  peerLabel: string;
  dropSubtitle: string;
  diagnosticsLabel: string;
  securityLabel: string;
  isDirect: boolean;
  isRelayed: boolean;
}

/**
 * Honest transport status & security copy derived strictly from live channel
 * or confirmed relay readiness.
 */
export function getTransportCopy(
  connectionState?: ConnectionState,
  transport?: TransportType,
  wsConnected?: boolean,
  pathKind?: NetworkDiagnostics['pathKind'],
): TransportCopy {
  if (connectionState === 'direct' && transport === 'webrtc' && pathKind === 'webrtc-turn') {
    return {
      badgeLabel: 'TURN Relay',
      peerLabel: 'Relayed via TURN',
      dropSubtitle: 'Send files over WebRTC through a TURN relay.',
      diagnosticsLabel: 'TURN-relayed WebRTC DataChannel',
      securityLabel: 'DTLS-encrypted WebRTC',
      isDirect: false,
      isRelayed: true,
    };
  }
  if (connectionState === 'direct' && transport === 'webrtc' &&
      pathKind !== 'webrtc-lan' && pathKind !== 'webrtc-wan') {
    return {
      badgeLabel: 'WebRTC',
      peerLabel: 'WebRTC connected',
      dropSubtitle: 'Send files over the connected WebRTC channel.',
      diagnosticsLabel: 'WebRTC DataChannel · route unconfirmed',
      securityLabel: 'DTLS-encrypted WebRTC',
      isDirect: false,
      isRelayed: false,
    };
  }
  if (connectionState === 'direct' && transport === 'webrtc') {
    return {
      badgeLabel: 'Direct P2P',
      peerLabel: 'Direct peer-to-peer',
      dropSubtitle: 'Send files directly to your connected device over WebRTC.',
      diagnosticsLabel: 'Direct WebRTC DataChannel',
      securityLabel: 'DTLS-encrypted peer-to-peer',
      isDirect: true,
      isRelayed: false,
    };
  }

  if (connectionState === 'relayed' && wsConnected) {
    return {
      badgeLabel: 'Cloud Relay',
      peerLabel: 'Relayed via server',
      dropSubtitle: 'Send files to your connected device via the WebSocket relay.',
      diagnosticsLabel: 'WebSocket Relay (TLS in transit)',
      securityLabel: 'TLS-encrypted WebSocket relay',
      isDirect: false,
      isRelayed: true,
    };
  }

  return {
    badgeLabel: 'Connecting',
    peerLabel: 'Establishing link…',
    dropSubtitle: 'Preparing connection to your peer.',
    diagnosticsLabel: wsConnected ? 'Signaling ready (negotiating)' : 'Offline / Reconnecting',
    securityLabel: 'DTLS when direct · TLS on signaling',
    isDirect: false,
    isRelayed: false,
  };
}
