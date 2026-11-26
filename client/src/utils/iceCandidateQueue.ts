export class IceCandidateQueue {
  private candidates: RTCIceCandidateInit[] = [];
  private settingRemote = false;

  beginRemoteDescription(): void {
    this.settingRemote = true;
  }

  endRemoteDescription(): void {
    this.settingRemote = false;
  }

  async add(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<void> {
    if (pc.signalingState === 'closed') return;
    if (
      candidate.candidate === '' &&
      candidate.sdpMid == null &&
      candidate.sdpMLineIndex == null
    ) {
      return;
    }

    if (!pc.remoteDescription || this.settingRemote) {
      if (this.candidates.length < 256) {
        this.candidates.push(candidate);
      }
      return;
    }

    try {
      await pc.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (err) {
      console.warn('[LocalDrop] Immediate ICE candidate error:', err);
    }
  }

  async flush(pc: RTCPeerConnection): Promise<void> {
    if (!pc.remoteDescription) return;
    if (pc.signalingState === 'closed') return;

    while (this.candidates.length > 0) {
      const candidate = this.candidates.shift();
      if (!candidate) continue;

      try {
        await pc.addIceCandidate(new RTCIceCandidate(candidate));
      } catch (error) {
        console.warn('[LocalDrop] Queued ICE candidate rejected:', error);
      }
    }
  }

  clear(): void {
    this.candidates = [];
  }
}
