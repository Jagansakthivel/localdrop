import { checkAbort } from './wire';
import { abortScope } from './abortScope';
import { parseTurnResponse } from './turnCredentials';
export type PathKind='webrtc-lan'|'webrtc-wan'|'webrtc-turn'|'webrtc-unknown'|'ws-relay';
export interface CandidatePath { kind:PathKind; localType?:string; remoteType?:string; protocol?:string }
export async function selectedPath(pc:RTCPeerConnection):Promise<CandidatePath>{
  const stats=await pc.getStats();let selected:string|undefined;
  stats.forEach((r:RTCStats & {selectedCandidatePairId?:string})=>{if(r.type==='transport'&&r.selectedCandidatePairId)selected=r.selectedCandidatePairId;});
  if(!selected)return {kind:'webrtc-unknown'};
  const pair=stats.get(selected) as (RTCStats & {localCandidateId?:string;remoteCandidateId?:string})|undefined;
  if(!pair?.localCandidateId||!pair.remoteCandidateId)return {kind:'webrtc-unknown'};
  const l=stats.get(pair.localCandidateId) as {candidateType?:string;protocol?:string}|undefined;
  const r=stats.get(pair.remoteCandidateId) as {candidateType?:string}|undefined;
  const localType=l?.candidateType,remoteType=r?.candidateType;
  const kind=localType==='relay'||remoteType==='relay'?'webrtc-turn':localType==='host'&&remoteType==='host'?'webrtc-lan':localType&&remoteType?'webrtc-wan':'webrtc-unknown';
  return {kind,localType,remoteType,protocol:l?.protocol};
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
export async function fetchIceServersWithExpiry(wsUrl:string,token:string,roomCode:string,signal:AbortSignal):Promise<{iceServers:RTCIceServer[];expiresAt:number|null}>{
  checkAbort(signal);const u=new URL(wsUrl,location.href);u.protocol=u.protocol==='wss:'?'https:':'http:';u.pathname='/api/ice-servers';u.search='';u.hash='';
  const scope=abortScope([signal],1500);
  try{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({roomCode}),signal:scope.signal,cache:'no-store'});if(!r.ok)return {iceServers:STUN,expiresAt:null};const body:unknown=await r.json();const parsed=parseTurnResponse(body);return {iceServers:[...STUN,...parsed.iceServers],expiresAt:parsed.expiresAt};
  }catch{checkAbort(signal);return {iceServers:STUN,expiresAt:null};}
  finally{scope.dispose();}
}
export async function fetchIceServers(wsUrl:string,token:string,roomCode:string,signal:AbortSignal):Promise<RTCIceServer[]>{
  const res=await fetchIceServersWithExpiry(wsUrl,token,roomCode,signal);return res.iceServers;
}
