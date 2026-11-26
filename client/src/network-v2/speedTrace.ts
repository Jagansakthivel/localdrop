/** Opt-in diagnostics. No filenames, IP addresses, credentials or PINs. */
export function traceEnabled(): boolean {
  try { return globalThis.localStorage?.getItem('ld:nettrace') === '1'; }
  catch { return false; }
}
export function createSpeedTrace(scope: 'send'|'receive'|'ice') {
  const start=performance.now(); let previous=start;
  return (phase:string,details:Record<string,string|number|boolean|null|undefined>={})=>{
    const now=performance.now();
    if(traceEnabled()) console.debug('[LocalDrop timing]',{scope,phase,elapsedMs:Math.round(now-start),deltaMs:Math.round(now-previous),...details});
    previous=now;
  };
}
export function traceIce(pc:RTCPeerConnection):()=>void {
  const trace=createSpeedTrace('ice');
  const candidate=(e:RTCPeerConnectionIceEvent)=>trace(e.candidate?'candidate':'gathering-end',e.candidate?{type:e.candidate.type,protocol:e.candidate.protocol}:{});
  const state=()=>trace('state',{ice:pc.iceConnectionState,connection:pc.connectionState,gathering:pc.iceGatheringState,signaling:pc.signalingState});
  const error=(e:RTCPeerConnectionIceErrorEvent)=>trace('candidate-error',{code:e.errorCode});
  pc.addEventListener('icecandidate',candidate);pc.addEventListener('icecandidateerror',error);
  pc.addEventListener('iceconnectionstatechange',state);pc.addEventListener('connectionstatechange',state);
  state();
  return ()=>{pc.removeEventListener('icecandidate',candidate);pc.removeEventListener('icecandidateerror',error);pc.removeEventListener('iceconnectionstatechange',state);pc.removeEventListener('connectionstatechange',state);};
}
