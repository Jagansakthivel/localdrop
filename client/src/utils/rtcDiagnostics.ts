export function attachRtcDiagnostics(pc: RTCPeerConnection): () => void {
  const report = () => {
    if (!import.meta.env.DEV) return;
    console.info('[LocalDrop RTC Diagnostics]', {
      connection: pc.connectionState,
      ice: pc.iceConnectionState,
      gathering: pc.iceGatheringState,
      signaling: pc.signalingState,
    });
  };

  pc.addEventListener('connectionstatechange', report);
  pc.addEventListener('iceconnectionstatechange', report);
  pc.addEventListener('icegatheringstatechange', report);
  pc.addEventListener('signalingstatechange', report);

  return () => {
    pc.removeEventListener('connectionstatechange', report);
    pc.removeEventListener('iceconnectionstatechange', report);
    pc.removeEventListener('icegatheringstatechange', report);
    pc.removeEventListener('signalingstatechange', report);
  };
}
