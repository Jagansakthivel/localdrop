export type ConnectionState =
  | 'offline'
  | 'signaling'
  | 'waiting'
  | 'pairing'
  | 'negotiating'
  | 'direct'
  | 'relayed'
  | 'reconnecting'
  | 'failed';

export type TransportType = 'webrtc' | 'websocket' | null;

export interface NetworkDiagnostics {
  signalingConnected: boolean;
  peerDiscovered: boolean;
  connectionState: ConnectionState;
  transport: TransportType;
  iceState: RTCIceConnectionState | null;
  peerState: RTCPeerConnectionState | null;
  channelState: RTCDataChannelState | null;
  lastError: string | null;
}
