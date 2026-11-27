export class IceCandidateQueue {
  private candidates: RTCIceCandidateInit[] = [];
  private settingRemote = false;

  beginRemoteDescription(): void {
    this.settingRemote = true;
  }

  endRemoteDescription(): void {
    this.settingRemote = false;
  }

  async add(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<'applied' | 'queued' | 'rejected' | 'ignored'> {
    if (pc.signalingState === 'closed') return 'ignored';
    if (
      candidate.candidate === '' &&
      candidate.sdpMid == null &&
      candidate.sdpMLineIndex == null
    ) {
      return 'ignored';
    }

    if (!pc.remoteDescription || this.settingRemote) {
      if (this.candidates.length >= 256) return 'rejected';
      this.candidates.push(candidate);
      return 'queued';
    }
    return this.apply(pc, candidate);
  }

  private async apply(pc: RTCPeerConnection, candidate: RTCIceCandidateInit): Promise<'applied' | 'rejected'> {
    try {
      await pc.addIceCandidate(candidate);
      return 'applied';
    } catch {
      return 'rejected';
    }
  }

  async flush(pc: RTCPeerConnection) {
    let applied = 0;
    let rejected = 0;
    const queued = this.candidates;
    this.candidates = [];
    for (const candidate of queued) {
      if (!pc.remoteDescription || pc.signalingState === 'closed') break;
      if (await this.apply(pc, candidate) === 'applied') applied++;
      else rejected++;
    }
    return { applied, rejected };
  }

  clear(): void {
    this.candidates = [];
  }
}
