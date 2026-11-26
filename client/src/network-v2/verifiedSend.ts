import { CreditWindow } from './flow';
import { sendPayload, type ResultMessage, type TransferPath } from './engine';
import { checkAbort, readCredit, validateMeta, type FileMeta } from './wire';
export interface Ready {type:'v2-ready';transferId:string;ok:boolean;reason?:string}
export type SenderControl=Ready|ResultMessage;
export interface VerifiedOptions {
  meta:FileMeta;file:File;path:TransferPath;signal:AbortSignal;
  sendControl:(packet:Record<string,unknown>)=>void;
  // Install BEFORE sending metadata; return an unsubscribe function.
  subscribe:(control:(packet:SenderControl)=>void,credit:(frame:ArrayBuffer)=>void)=>()=>void;
  record:(bytes:number,waitMs:number)=>void;
  invalidatePath:(reason:unknown)=>void;
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
  validateMeta(o.meta);checkAbort(o.signal);const controller=new AbortController();const signal=AbortSignal.any([o.signal,controller.signal]);const credit=new CreditWindow();
  const ready=gate<Ready>(signal,15000);let result:ReturnType<typeof gate<ResultMessage>>|undefined;let earlyResult:ResultMessage|undefined;let started=false;
  let unsubscribe=()=>{};
  try{
  unsubscribe=o.subscribe(msg=>{if(msg.transferId!==o.meta.transferId)return;if(msg.type==='v2-ready'){if(typeof msg.ok!=='boolean'){controller.abort(new Error('Invalid ready'));return;}ready.resolve(msg);}else if(msg.type==='v2-result'){if(typeof msg.ok!=='boolean'){controller.abort(new Error('Invalid result'));return;}if(result)result.resolve(msg);else earlyResult=msg;if(!msg.ok)controller.abort(new Error(msg.reason??'Receiver rejected transfer'));}},frame=>{try{if(!started)throw new Error('Unexpected credit before ready');credit.add(readCredit(frame));}catch(e){controller.abort(e);}});
    o.sendControl({type:'v2-meta',...o.meta});const accepted=await ready.promise;if(!accepted.ok)throw new Error(accepted.reason??'Receiver not ready');started=true;
    const end=await sendPayload({meta:o.meta,file:o.file,path:o.path,signal,credit,record:o.record});checkAbort(signal);
    if(earlyResult)throw new Error('Premature completion acknowledgement');result=gate<ResultMessage>(signal,30000);o.sendControl({...end});const final=await result.promise;
    if(!final.ok||final.size!==o.file.size||final.digest!==end.digest||credit.outstanding!==0)throw new Error('Unverified receiver completion');return final;
  }catch(e){try{o.sendControl({type:'v2-cancel',transferId:o.meta.transferId});}catch{/* transport already closed */}if(started)o.invalidatePath(e);throw e;}
  finally{controller.abort(new Error('Transfer scope closed'));unsubscribe();}
}
