import { checkAbort } from './wire';
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
// Relay is eligible after 2.5s, not declared ready by a timer. Keep ICE alive until
// 10s, and allow a pending authenticated commit to settle before closing the PC.
export function startTransportRace(o:RaceOptions){
  const start=performance.now();let expired=false,stopped=false,lastAttempt=-Infinity;
  const stop=()=>{if(stopped)return;stopped=true;clearInterval(interval);o.pc.removeEventListener('iceconnectionstatechange',check);o.signal.removeEventListener('abort',stop);};
  function check(){
    if(stopped||o.signal.aborted)return;const now=performance.now(),elapsed=now-start;
    const committed=o.committed();if(committed==='rtc'){stop();return;}
    if(o.switching())return;
    if(elapsed>=10000&&!expired){expired=true;o.expireRtc();}
    if(expired&&committed==='relay'){stop();return;}
    if(elapsed>=15000&&!committed){stop();o.exhausted();return;}
    if(now-lastAttempt<150)return;
    const channels=o.channels();const rtcReady=!expired&&channels.length===5&&channels.every(c=>c.readyState==='open');
    const relayEligible=elapsed>=2500||o.pc.iceConnectionState==='failed';
    // If no path is committed and the initial direct grace elapsed, prefer a
    // verified relay, then attempt promotion after the relay commit.
    if(!committed&&relayEligible&&o.relayReady()){lastAttempt=now;o.propose('relay');return;}
    if(rtcReady){lastAttempt=now;o.propose('rtc');}
  }
  const interval=setInterval(check,100);
  o.pc.addEventListener('iceconnectionstatechange',check);o.signal.addEventListener('abort',stop,{once:true});if(o.signal.aborted)stop();else check();
  return {check,stop};
}
export async function fetchIceServers(wsUrl:string,token:string,roomCode:string,signal:AbortSignal):Promise<RTCIceServer[]>{
  checkAbort(signal);const u=new URL(wsUrl,location.href);u.protocol=u.protocol==='wss:'?'https:':'http:';u.pathname='/api/ice-servers';u.search='';u.hash='';
  try{const r=await fetch(u,{method:'POST',headers:{'Content-Type':'application/json','Authorization':`Bearer ${token}`},body:JSON.stringify({roomCode}),signal:AbortSignal.any([signal,AbortSignal.timeout(1500)]),cache:'no-store'});if(!r.ok)return STUN;const body:unknown=await r.json();if(!body||typeof body!=='object'||!('iceServers' in body)||!Array.isArray(body.iceServers))return STUN;
    const turns:RTCIceServer[]=[];for(const e of body.iceServers as unknown[]){if(!e||typeof e!=='object'||!('urls' in e)||!('username' in e)||!('credential' in e)||typeof e.username!=='string'||typeof e.credential!=='string')continue;const urls=(typeof e.urls==='string'?[e.urls]:Array.isArray(e.urls)?e.urls:[]).filter((x):x is string=>typeof x==='string'&&/^turns?:turn\.cloudflare\.com:/.test(x));if(urls.length)turns.push({urls,username:e.username,credential:e.credential});}return [...STUN,...turns];
  }catch(e){checkAbort(signal);return STUN;}
}
