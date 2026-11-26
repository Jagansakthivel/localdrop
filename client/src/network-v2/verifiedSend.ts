import { CreditWindow } from './flow';
import { sendPayload, type ResultMessage, type TransferPath } from './engine';
import { checkAbort, readCredit, validateMeta, type FileMeta } from './wire';
import { abortScope } from './abortScope';
import { progressGate } from './progressGate';
export interface Ready {type:'v2-ready';transferId:string;ok:boolean;reason?:string}
export type SenderControl=Ready|ResultMessage;
export interface VerifiedOptions {
  meta:FileMeta;file:File;path:TransferPath;signal:AbortSignal;
  sendControl:(packet:Record<string,unknown>)=>void;
  // Install BEFORE sending metadata; return an unsubscribe function.
  subscribe:(control:(packet:SenderControl)=>void,credit:(frame:ArrayBuffer)=>void)=>()=>void;
  record:(bytes:number,waitMs:number)=>void;
  invalidatePath:(reason:unknown)=>void;
  phase?:(phase: string)=>void;
}
function gate<T>(signal:AbortSignal,timeout:number){
  let settle:(v:T)=>void=()=>{};let rejector:(e:unknown)=>void=()=>{};let finished=false;let timer:ReturnType<typeof setTimeout>|undefined;
  const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};
  const abort=()=>reject(signal.reason??new Error('Aborted'));
  function reject(e:unknown){if(finished)return;finished=true;cleanup();rejector(e);}
  const promise=new Promise<T>((resolve,rej)=>{settle=resolve;rejector=rej;});void promise.catch(()=>{});
  timer=setTimeout(()=>reject(new Error('Peer acknowledgement timed out')),timeout);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  return {promise,resolve(v:T){if(!finished){finished=true;cleanup();settle(v);}},reject};
}
export async function sendVerified(o:VerifiedOptions):Promise<ResultMessage>{
  validateMeta(o.meta);checkAbort(o.signal);const controller=new AbortController();const scope=abortScope([o.signal,controller.signal]);const signal=scope.signal;const credit=new CreditWindow();
  const ready=gate<Ready>(signal,15000);let result:ReturnType<typeof progressGate<ResultMessage>>|undefined;let earlyResult:ResultMessage|undefined;let started=false;
  let unsubscribe=()=>{};
  try{
  unsubscribe=o.subscribe(msg=>{if(msg.transferId!==o.meta.transferId)return;if(msg.type==='v2-ready'){if(typeof msg.ok!=='boolean'){controller.abort(new Error('Invalid ready'));return;}ready.resolve(msg);}else if(msg.type==='v2-result'){if(typeof msg.ok!=='boolean'){controller.abort(new Error('Invalid result'));return;}if(result)result.resolve(msg);else earlyResult=msg;if(!msg.ok)controller.abort(new Error(msg.reason??'Receiver rejected transfer'));}},frame=>{try{if(!started)throw new Error('Unexpected credit before ready');const added=readCredit(frame);credit.add(added);if(result&&added>0)result.progress(added);}catch(e){controller.abort(e);}});
    o.phase?.('meta-send');o.sendControl({type:'v2-meta',...o.meta});const accepted=await ready.promise;o.phase?.('receiver-ready');if(!accepted.ok)throw new Error(accepted.reason??'Receiver not ready');started=true;
    o.phase?.('payload-start');const end=await sendPayload({meta:o.meta,file:o.file,path:o.path,signal,credit,record:o.record});checkAbort(signal);o.phase?.('payload-queued');
    if(earlyResult)throw new Error('Premature completion acknowledgement');result=progressGate<ResultMessage>(signal,30000,600000);o.phase?.('end-send');o.sendControl({...end});const final=await result.promise;o.phase?.('result-received');
    if(!final.ok||final.size!==o.file.size||final.digest!==end.digest||credit.outstanding!==0)throw new Error('Unverified receiver completion');o.phase?.('verified');return final;
  }catch(e){try{o.sendControl({type:'v2-cancel',transferId:o.meta.transferId});}catch{/* transport already closed */}if(started)o.invalidatePath(e);throw e;}
  finally{controller.abort(new Error('Transfer scope closed'));scope.dispose();unsubscribe();}
}
