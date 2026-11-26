export interface BatchItem {id:string}
/** Snapshot IDs only. Re-read live files and session identity immediately before every send. */
export async function sendLiveBatch<T extends BatchItem>(o:{initial:readonly T[];live:()=>readonly T[];sameSession:()=>boolean;signal:AbortSignal;beforeSend?:(signal:AbortSignal)=>Promise<void>;send:(item:T)=>Promise<boolean>;onSent:(item:T)=>void}) {
  for(const id of [...new Set(o.initial.map(x=>x.id))]){
    if(o.signal.aborted||!o.sameSession())return false;
    if(!o.live().some(x=>x.id===id))continue;
    await o.beforeSend?.(o.signal);
    if(o.signal.aborted||!o.sameSession())return false;
    const item=o.live().find(x=>x.id===id);if(!item)continue;
    if(!await o.send(item))return false;
    if(o.signal.aborted||!o.sameSession())return false;
    o.onSent(item);
  }
  return true;
}
/** Conservative admission cadence, not an exemption from server quotas. Shared per session/socket. */
export function createBatchAdmission(intervalMs=200){
  if(!Number.isFinite(intervalMs)||intervalMs<0)throw new Error('Invalid interval');
  let next=0;
  return async(signal:AbortSignal)=>{
    if(signal.aborted)throw signal.reason??new Error('Aborted');
    const now=performance.now(), at=Math.max(now,next);next=at+intervalMs;const delay=at-now;if(delay<=0)return;
    await new Promise<void>((resolve,reject)=>{const cleanup=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);};const abort=()=>{cleanup();reject(signal.reason??new Error('Aborted'));};const timer=setTimeout(()=>{cleanup();resolve();},delay);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});
  };
}
