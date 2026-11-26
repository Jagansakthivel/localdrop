export interface Sample { bytes: number; total: number; speedBps: number; etaSeconds: number; progress: number; bufferWaitRatio: number; elapsedMs: number }
export function createSampler(total: number, emit: (s: Sample)=>void) {
  const start=performance.now();let last=start, lastBytes=0, bytes=0, wait=0, ema=0, stopped=false;
  function flush(complete=false){const now=performance.now();const dt=Math.max(1,now-last);const speed=(bytes-lastBytes)*1000/dt;ema=ema===0?speed:0.3*speed+0.7*ema;last=now;lastBytes=bytes;emit({bytes,total,speedBps:ema,etaSeconds:complete?0:ema>0?Math.ceil(Math.max(0,total-bytes)/ema):Infinity,progress:complete?100:Math.min(99,total?Math.floor(100*bytes/total):0),bufferWaitRatio:Math.min(1,wait/Math.max(1,now-start)),elapsedMs:now-start});}
  const timer=setInterval(()=>flush(),150);
  return { record(delta:number,waitMs=0){if(!stopped){bytes+=delta;wait+=waitMs;}}, stop(complete=false){if(!stopped){stopped=true;clearInterval(timer);flush(complete);}} };
}
