export type RelayPacer = (bytes: number, signal: AbortSignal) => Promise<void>;
function abortError(signal: AbortSignal): unknown {return signal.reason ?? new Error('Aborted');}
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve,reject)=>{
    const abort=()=>{clearTimeout(timer);signal.removeEventListener('abort',abort);reject(abortError(signal));};
    const timer=setTimeout(()=>{signal.removeEventListener('abort',abort);resolve();},ms);
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
  });
}
export class ByteBucket {
  private tokens: number;
  private last: number;
  private readonly rate: number;
  private readonly burst: number;
  constructor(rate: number, burst: number, now: number) {
    if (!(rate>0 && burst>0)) throw new Error('Invalid bucket'); this.rate=rate;this.burst=burst;this.tokens=burst;this.last=now;
  }
  take(bytes:number, now:number): number {
    if(!Number.isSafeInteger(bytes)||bytes<=0||bytes>this.burst)throw new Error('Invalid frame size');
    const time=Math.max(now,this.last);this.tokens=Math.min(this.burst,this.tokens+(time-this.last)*this.rate/1000);this.last=time;
    if(this.tokens>=bytes){this.tokens-=bytes;return 0;}
    return Math.max(1,Math.ceil((bytes-this.tokens)*1000/this.rate));
  }
}
export function createRelayPacer(rate=28*1024*1024,burst=1024*1024): RelayPacer {
  const bucket=new ByteBucket(rate,burst,performance.now());
  return async (bytes,signal)=>{for(;;){if(signal.aborted)throw abortError(signal);const wait=bucket.take(bytes,performance.now());if(wait===0)return;await sleep(wait,signal);}};
}
// Same socket = same token bucket across all files. New socket = new server attachment.
const pacers = new WeakMap<WebSocket, RelayPacer>();
export function relayPacerFor(socket: WebSocket): RelayPacer {
  let pacer=pacers.get(socket);if(!pacer){pacer=createRelayPacer();pacers.set(socket,pacer);}return pacer;
}
