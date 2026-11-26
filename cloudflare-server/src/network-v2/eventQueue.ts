/** FIFO across async membership mutations; use same instance for join/create/resume/leave/close/alarm. */
export class SerialQueue {
  private tail:Promise<unknown>=Promise.resolve();
  private pending=0;
  constructor(private readonly limit=128){}
  run<T>(task:()=>T|Promise<T>):Promise<T>{
    if(this.pending>=this.limit)return Promise.reject(new Error('Membership queue overloaded'));
    this.pending++;
    const result=this.tail.then(task);
    this.tail=result.then(()=>{this.pending--;},()=>{this.pending--;});
    return result;
  }
}
/** Per-socket ordered dispatcher, bounded by bytes and event count. Never silently drop frames. */
export class SocketEventQueue<S extends object>{
  private queues=new WeakMap<S,{tail:Promise<unknown>;count:number;bytes:number}>();
  constructor(private readonly maxBytes=8*1024*1024,private readonly maxCount=256){}
  run<T>(socket:S,bytes:number,task:()=>T|Promise<T>):Promise<T>{
    if(!Number.isSafeInteger(bytes)||bytes<0)return Promise.reject(new Error('Invalid event size'));
    let state=this.queues.get(socket);if(!state){state={tail:Promise.resolve(),count:0,bytes:0};this.queues.set(socket,state);}
    const q=state;if(q.count>=this.maxCount||q.bytes+bytes>this.maxBytes)return Promise.reject(new Error('Socket event queue overloaded'));
    q.count++;q.bytes+=bytes;const result=q.tail.then(task);const done=()=>{q.count--;q.bytes-=bytes;};q.tail=result.then(done,done);return result;
  }
}
