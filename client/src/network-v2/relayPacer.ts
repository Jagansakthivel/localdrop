import { checkAbort } from './wire';
// Limit average offered rate below server quota, with bounded bursts. Network jitter
// can still trigger a quota error, which must abort rather than drop any payload.
export function createRelayPacer(rate=28*1024*1024,burst=1024*1024){let tokens=burst,last=performance.now();return async(bytes:number,signal:AbortSignal)=>{
  if(bytes>burst||bytes<=0)throw new Error('Invalid pacing request');
  for(;;){checkAbort(signal);const now=performance.now();tokens=Math.min(burst,tokens+(now-last)*rate/1000);last=now;if(tokens>=bytes){tokens-=bytes;return;}const delay=Math.max(1,Math.ceil((bytes-tokens)*1000/rate));await new Promise<void>((resolve,reject)=>{const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(signal.reason??new Error('Aborted'));};const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},delay);signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();});}
};}
