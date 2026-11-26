/** Idle deadline; extend only on validated positive receiver progress. */
export function progressGate<T>(signal: AbortSignal, idleMs: number, maxMs: number) {
  if (!Number.isFinite(idleMs) || idleMs <= 0 || !Number.isFinite(maxMs) || maxMs < idleMs) throw new Error('Invalid deadline');
  let done = false, timer: ReturnType<typeof setTimeout> | undefined;
  const start = performance.now();
  let resolvePromise!: (v:T)=>void, rejectPromise!: (e:unknown)=>void;
  const promise = new Promise<T>((resolve,reject)=>{resolvePromise=resolve;rejectPromise=reject;});
  void promise.catch(()=>{});
  const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', onAbort); };
  const reject = (reason:unknown) => { if(done)return; done=true; cleanup(); rejectPromise(reason); };
  const onAbort = () => reject(signal.reason ?? new Error('Aborted'));
  const arm = () => { if(done)return; clearTimeout(timer); const remaining=maxMs-(performance.now()-start); if(remaining<=0){reject(new Error('Finalization maximum duration exceeded'));return;} timer=setTimeout(()=>reject(new Error('Peer acknowledgement timed out')),Math.min(idleMs,remaining)); };
  signal.addEventListener('abort',onAbort,{once:true}); if(signal.aborted)onAbort();else arm();
  return {promise, progress(bytes:number){if(Number.isSafeInteger(bytes)&&bytes>0)arm();}, resolve(v:T){if(done)return;done=true;cleanup();resolvePromise(v);},reject};
}
