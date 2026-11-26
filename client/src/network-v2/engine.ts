import { ABORT, DATA, EOF, WINDOW, checkAbort, creditFrame, decode, encode, validateMeta, type FileMeta } from './wire';
import { CreditWindow, waitChannel, waitSocket } from './flow';
import { Sha256 } from './sha256';
import { relayPacerFor } from './relayPacer';
import type { Measure } from './transferTiming';
import type { FileSink } from './fileSink';
export type TransferPath = { kind:'rtc'; bulk: readonly RTCDataChannel[] } | { kind:'rtc-single'; channel: RTCDataChannel } | { kind:'relay'; socket: WebSocket };
export interface EndMessage { type:'v2-end'; transferId:string; digest:string; size:number }
export interface ResultMessage { type:'v2-result'; transferId:string; ok:boolean; size:number; digest?:string; reason?:string }
export interface SendOptions { meta:FileMeta; file:File; path:TransferPath; credit:CreditWindow; signal:AbortSignal; record:(bytes:number,waitMs:number)=>void; measure?:Measure }
// Call only after receiver v2-ready. All writes use the exact path captured at metadata time.
// A single sequential reader hashes in file order and stripes frames across four streams.
export async function sendPayload(o:SendOptions):Promise<EndMessage>{
  const {meta,file,path,credit,signal,record,measure}=o;const count=validateMeta(meta);
  checkAbort(signal);
  if(file.size!==meta.size)throw new Error('File size changed');
  if(path.kind==='rtc'&&(path.bulk.length!==4 || new Set(path.bulk).size!==4 || path.bulk.some(c=>c.readyState!=='open')))throw new Error('Bulk channels not ready');
  const sha=new Sha256();const pace=path.kind==='relay'?relayPacerFor(path.socket):null;
  for(let index=0;index<count;index++){
    checkAbort(signal);const offset=index*meta.chunkSize;const size=Math.min(meta.chunkSize,file.size-offset);const start=performance.now();
    try { await credit.take(size,signal); }
    finally { measure?.('credit-wait',performance.now()-start); }
    const channel=path.kind==='rtc'?path.bulk[index%4]:path.kind==='rtc-single'?path.channel:undefined;
    if(path.kind==='relay'&&pace){
      const pacingStart=performance.now();await pace(size+8,signal);
      measure?.('relay-pacing',performance.now()-pacingStart);
    }
    const bufferStart=performance.now();
    if(channel)await waitChannel(channel,size+8,signal);else if(path.kind==='relay')await waitSocket(path.socket,size+8,signal);
    measure?.('send-buffer-wait',performance.now()-bufferStart);
    const waited=performance.now()-start;checkAbort(signal);
    const readStart=performance.now();
    const bytes=new Uint8Array(await file.slice(offset,offset+size).arrayBuffer());checkAbort(signal);
    measure?.('file-read',performance.now()-readStart);
    if(bytes.byteLength!==size)throw new Error('Unexpected file read length');
    const hashStart=performance.now();sha.update(bytes);measure?.('send-hash',performance.now()-hashStart);const frame=encode(meta.fileId,index,index===count-1?EOF:DATA,bytes);
    if(channel){if(channel.readyState!=='open')throw new Error('Bulk channel closed');channel.send(frame);}
    else if(path.kind==='relay'){if(path.socket.readyState!==WebSocket.OPEN)throw new Error('Relay closed');path.socket.send(frame);}
    record(0,waited);
  }
  return {type:'v2-end',transferId:meta.transferId,digest:sha.digest(),size:file.size};
}
export interface ReceiveOptions { meta:FileMeta; sink:FileSink; signal:AbortSignal; sendCredit:(frame:ArrayBuffer)=>void; record:(bytes:number)=>void; result:(r:ResultMessage,file?:File)=>void; measure?:Measure }
// One accepted transfer per direction. Credit bounds all four channels together.
// No acknowledgement of completion until the sink is committed AND the digest matches.
export function createReceiver(o:ReceiveOptions){
  const {meta,sink,signal,sendCredit,record,result,measure}=o;const count=validateMeta(meta);const sha=new Sha256();
  const pending=new Map<number,Uint8Array>();let pendingBytes=0,next=0,written=0,credit=0,done=false,writing=false,finishing=false,terminal:EndMessage|undefined;
  let activeWrite:Promise<void>|undefined;let timer:ReturnType<typeof setTimeout>|undefined;let creditTimer:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=>{clearTimeout(timer);clearTimeout(creditTimer);signal.removeEventListener('abort',onAbort);};
  function flushCredit(){clearTimeout(creditTimer);creditTimer=undefined;if(credit>0){const amt=credit;credit=0;try{sendCredit(creditFrame(amt));}catch(e){void fail(e);}}}
  function armCreditTimer(){if(creditTimer===undefined&&credit>0){creditTimer=setTimeout(()=>flushCredit(),250);}}
  function resetTimer(){clearTimeout(timer);timer=setTimeout(()=>void fail(new Error('Receiver transfer stalled')),30000);}
  async function fail(reason:unknown){if(done)return;done=true;cleanup();pending.clear();pendingBytes=0;await activeWrite?.catch(()=>{});await sink.abort().catch(()=>{});result({type:'v2-result',transferId:meta.transferId,ok:false,size:written,reason:reason instanceof Error?reason.message:'Transfer aborted'});}
  const onAbort=()=>void fail(signal.reason??new Error('Aborted'));
  async function complete(){
    if(done||writing||finishing||!terminal||next!==count)return;
    finishing=true;
    try{checkAbort(signal);if(written!==meta.size||terminal.size!==written)throw new Error('File size mismatch');const digest=sha.digest();if(digest!==terminal.digest.toLowerCase())throw new Error('SHA-256 mismatch');
      flushCredit();
      // Keep storage until the vault item is removed. Caller owns sink.dispose().
      const commitStart=performance.now();const file=await sink.finish();measure?.('sink-commit',performance.now()-commitStart);if(done){await sink.dispose();return;}done=true;cleanup();result({type:'v2-result',transferId:meta.transferId,ok:true,size:written,digest},file);
    }catch(e){await fail(e);}
  }
  async function drain(){if(writing||done)return;writing=true;
    try{while(!done&&pending.has(next)){checkAbort(signal);const bytes=pending.get(next)!;const writeStart=performance.now();activeWrite=sink.write(bytes);await activeWrite;activeWrite=undefined;measure?.('sink-write',performance.now()-writeStart);if(done)return;const hashStart=performance.now();sha.update(bytes);measure?.('receive-hash',performance.now()-hashStart);pending.delete(next);pendingBytes-=bytes.length;next++;written+=bytes.length;credit+=bytes.length;record(bytes.length);resetTimer();if(credit>=256*1024||written===meta.size){flushCredit();}else{armCreditTimer();}}}
    catch(e){writing=false;await fail(e);return;}finally{writing=false;}
    await complete();
  }
  signal.addEventListener('abort',onAbort,{once:true});resetTimer();if(signal.aborted)onAbort();
  return {
    push(frame:ArrayBuffer){if(done)return;try{checkAbort(signal);const f=decode(frame);if(f.id!==meta.fileId)throw new Error('Unexpected file id');if(f.flag===ABORT){void fail(new Error('Peer cancelled'));return;}
      if(f.index>=count||f.index<next||pending.has(f.index))throw new Error('Invalid or duplicate chunk index');
      const expected=Math.min(meta.chunkSize,meta.size-f.index*meta.chunkSize);if(f.payload.length!==expected||f.flag!==(f.index===count-1?EOF:DATA))throw new Error('Invalid chunk size or flags');
      if(pendingBytes+f.payload.length>WINDOW)throw new Error('Receiver credit window exceeded');pending.set(f.index,f.payload);pendingBytes+=f.payload.length;resetTimer();void drain();
    }catch(e){void fail(e);}},
    end(msg:EndMessage){if(done)return;if(terminal||msg.transferId!==meta.transferId||msg.size!==meta.size||!/^[0-9a-fA-F]{64}$/u.test(msg.digest)){void fail(new Error('Invalid end message'));return;}terminal=msg;resetTimer();void complete();},
    abort(reason:unknown=new Error('Cancelled')){return fail(reason);},
  };
}
