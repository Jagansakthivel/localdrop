import type { ConnectionState, TransportType } from '../types/network';

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
  wsConnected?: boolean
): TransportCopy {
  if (connectionState === 'direct' && transport === 'webrtc') {
    return {
      badgeLabel: 'Direct P2P',
      peerLabel: 'Direct peer-to-peer',
      dropSubtitle: 'Send files directly to your connected device over WebRTC.',
      diagnosticsLabel: 'Direct WebRTC DataChannel',
      securityLabel: 'DTLS-SRTP encrypted peer-to-peer',
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
