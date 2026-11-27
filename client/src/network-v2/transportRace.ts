import { inspectPeerStats } from '../utils/rtcDiagnostics';
import { checkAbort } from './wire';
import { abortScope } from './abortScope';
import { parseTurnResponse } from './turnCredentials';
export type PathKind='webrtc-lan'|'webrtc-wan'|'webrtc-turn'|'webrtc-unknown'|'ws-relay';
export interface CandidatePath { kind:PathKind; localType?:string; remoteType?:string; protocol?:string }
export function classifyCandidatePair(pair: Awaited<ReturnType<typeof inspectPeerStats>>['selectedPair']): CandidatePath {
  const localType = pair?.localType ?? undefined;
  const remoteType = pair?.remoteType ?? undefined;
  const directTypes = ['host', 'srflx', 'prflx'];
  const kind = localType === 'relay' || remoteType === 'relay' ? 'webrtc-turn'
    : localType === 'host' && remoteType === 'host' ? 'webrtc-lan'
    : localType && remoteType && directTypes.includes(localType) && directTypes.includes(remoteType)
      ? 'webrtc-wan' : 'webrtc-unknown';
  return { kind, localType, remoteType, protocol: pair?.protocol ?? undefined };
}
export async function selectedPath(pc: RTCPeerConnection): Promise<CandidatePath> {
  return classifyCandidatePair((await inspectPeerStats(pc)).selectedPair);
}
export const STUN:RTCIceServer[]=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
let certificate:RTCCertificate|undefined;let warming:Promise<void>|undefined;
export function prewarmCertificate():Promise<void>{return warming??=Promise.resolve().then(()=>RTCPeerConnection.generateCertificate({name:'ECDSA',namedCurve:'P-256'} as EcKeyGenParams)).then(c=>{certificate=c;},()=>{});}
export function rtcConfiguration(servers:RTCIceServer[]=STUN):RTCConfiguration{return {iceServers:servers,iceTransportPolicy:'all',...(certificate?{certificates:[certificate]}:{})};}
export function createChannels(pc:RTCPeerConnection){const controlOptions:RTCDataChannelInit & {priority:string}={ordered:true,priority:'high'};const bulkOptions:RTCDataChannelInit & {priority:string}={ordered:true,priority:'low'};const control=pc.createDataChannel('control',controlOptions);const bulk=Array.from({length:4},(_,i)=>pc.createDataChannel(`bulk-${i}`,bulkOptions));for(const c of [control,...bulk])c.binaryType='arraybuffer';return {control,bulk};}
export interface RaceOptions {
  pc:RTCPeerConnection; channels:()=>readonly RTCDataChannel[]; relayReady:()=>boolean;
  signal:AbortSignal; committed:()=> 'rtc'|'relay'|null; switching:()=>boolean;
  // Leader only: returns true if an authenticated path proposal was started.
  propose:(path:'rtc'|'relay')=>boolean; expireRtc:()=>void; exhausted:()=>void;
}
// Prefer an actually ready RTC path. Relay remains available while ICE continues.
export function startTransportRace(o:RaceOptions){
  const start=performance.now();
  let stopped=false,expired=false,lastAttempt=-Infinity;
  let interval: ReturnType<typeof setInterval> | undefined;
  const stop=()=>{if(stopped)return;stopped=true;clearInterval(interval);
    o.pc.removeEventListener('iceconnectionstatechange',check);
    o.pc.removeEventListener('connectionstatechange',check);
    o.signal.removeEventListener('abort',stop);};
  function check(){
    if(stopped||o.signal.aborted)return;
    const now=performance.now(),elapsed=now-start,committed=o.committed();
    if(committed==='rtc'){stop();return;}
    if(o.switching())return;
    const channels=o.channels();
    const rtcReady=!expired&&channels.length===5&&channels.every(c=>c.readyState==='open');
    // Never retire a usable RTC path while a relayed transfer prevents promotion.
    if(!rtcReady&&!expired&&elapsed>=30000){expired=true;o.expireRtc();}
    if(expired&&committed==='relay'){stop();return;}
    if(now-lastAttempt<250)return;
    // Both peers must still commit via pathAgreement; open channels alone are insufficient.
    if(rtcReady){lastAttempt=now;if(o.propose('rtc'))return;}
    if(!committed&&(elapsed>=2500||o.pc.iceConnectionState==='failed')&&o.relayReady()){
      lastAttempt=now;if(o.propose('relay'))return;
    }
    if(!committed&&elapsed>=35000){stop();o.exhausted();}
  }
  interval=setInterval(check,250);
  o.pc.addEventListener('iceconnectionstatechange',check);
  o.pc.addEventListener('connectionstatechange',check);
  o.signal.addEventListener('abort',stop,{once:true});
  if(o.signal.aborted)stop();else check();
  return {check,stop};
}
export type TurnFetchStatus =
  | 'turn-issued'
  | 'turn-not-configured'
  | 'turn-upstream-unavailable'
  | 'turn-unavailable'
  | 'turn-auth-failed'
  | 'turn-quota-or-forbidden'
  | 'turn-timeout'
  | 'turn-invalid-response';
export async function fetchIceServersWithExpiry(wsUrl:string,token:string,roomCode:string,signal:AbortSignal):Promise<{iceServers:RTCIceServer[];expiresAt:number|null;status:TurnFetchStatus}>{
  checkAbort(signal);const u=new URL(wsUrl,location.href);u.protocol=u.protocol==='wss:'?'https:':'http:';u.pathname='/api/ice-servers';u.search='';u.hash='';
  const scope=abortScope([signal],2500);
  const requestedAt = Date.now();
  try{
    const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({roomCode}),signal:scope.signal,cache:'no-store'});
    if(!r.ok){
      const status:TurnFetchStatus=r.status===401?'turn-auth-failed':r.status===403?'turn-quota-or-forbidden':'turn-invalid-response';
      return {iceServers:STUN,expiresAt:null,status};
    }
    const body:unknown=await r.json();
    const parsed=parseTurnResponse(body);
    const reported = body && typeof body === 'object' && 'turnStatus' in body ? body.turnStatus : undefined;
    const status:TurnFetchStatus=parsed.iceServers.length>0?'turn-issued'
      : reported==='not-configured'?'turn-not-configured'
      : reported==='upstream-unavailable'?'turn-upstream-unavailable':'turn-unavailable';
    return {iceServers:[...STUN,...parsed.iceServers],expiresAt:parsed.expiresAt === null ? null : parsed.expiresAt - (Date.now() - requestedAt),status};
  }catch{
    checkAbort(signal);
    return {iceServers:STUN,expiresAt:null,status:scope.signal.aborted?'turn-timeout':'turn-invalid-response'};
  }
  finally{scope.dispose();}
}
export async function fetchIceServers(wsUrl:string,token:string,roomCode:string,signal:AbortSignal):Promise<RTCIceServer[]>{
  const res=await fetchIceServersWithExpiry(wsUrl,token,roomCode,signal);return res.iceServers;
}
