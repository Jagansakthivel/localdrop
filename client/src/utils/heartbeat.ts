/** JSON ping/pong compatible with current worker. Own one instance per physical socket. */
export function attachHeartbeat(socket: WebSocket, onTimeout: () => void, options: {intervalMs?:number; timeoutMs?:number; visible?:()=>boolean} = {}): () => void {
  const intervalMs=options.intervalMs??25000, timeoutMs=options.timeoutMs??10000;
  const visible=options.visible??(()=>typeof document==='undefined'||document.visibilityState==='visible');
  let pendingAt:number|null=null, stopped=false;
  const message=(event:MessageEvent)=>{
    if(typeof event.data!=='string')return;
    try{const msg:unknown=JSON.parse(event.data);if(msg&&typeof msg==='object'&&'type' in msg&&msg.type==='pong')pendingAt=null;}catch{/* Other messages are handled by the existing dispatcher. */}
  };
  function tick(){
    if(stopped||socket.readyState!==1)return;
    if(!visible()){pendingAt=null;return;}
    const now=performance.now();
    if(pendingAt!==null){if(now-pendingAt>=timeoutMs){stop();onTimeout();}return;}
    try{socket.send(JSON.stringify({type:'ping'}));pendingAt=now;}catch{stop();onTimeout();}
  }
  // A separate deadline check avoids waiting for the next 25s ping interval.
  let lastPing=performance.now();
  const timer=setInterval(()=>{if(!visible()){pendingAt=null;lastPing=performance.now();return;}if(pendingAt!==null||performance.now()-lastPing>=intervalMs){if(pendingAt===null)lastPing=performance.now();tick();}},Math.min(1000,timeoutMs,intervalMs));
  function stop(){if(stopped)return;stopped=true;clearInterval(timer);socket.removeEventListener('message',message);socket.removeEventListener('close',stop);}
  socket.addEventListener('message',message);socket.addEventListener('close',stop,{once:true});return stop;
}
