export interface Bucket { tokens:number; at:number }
export const RELAY_RATE=30*1024*1024;
export const RELAY_BURST=4*1024*1024;
export const CONTROL_RATE=40;
// Full-rate payload produces about 60 credits/s at the current receiver threshold.
export const RELAY_CREDIT_RATE=80;
export function consumeRelayCredit(previous:Bucket|undefined,now=Date.now()){
  return consume(previous,1,RELAY_CREDIT_RATE,RELAY_CREDIT_RATE,now);
}
export const MAX_RELAY_FRAME=256*1024;
// Persist returned state with the existing serialized attachment, including rejected attempts.
export function consume(previous:Bucket|undefined,amount:number,rate:number,burst:number,now=Date.now()):{allowed:boolean;state:Bucket}{
  if(!Number.isFinite(amount)||amount<0||rate<=0||burst<=0)throw new Error('Invalid quota');
  const last=previous??{tokens:burst,at:now};const at=Math.max(now,last.at);const tokens=Math.min(burst,last.tokens+(at-last.at)*rate/1000);const allowed=tokens>=amount;
  return {allowed,state:{tokens:allowed?tokens-amount:tokens,at}};
}
export interface RelayLedger { fileId:number; remaining:number; outstanding:number; nextIndex:number; chunkSize:number }
// One direction, one transfer. Store in sender attachment. Never accept a client-supplied destination.
export function openLedger(fileId:number,size:number,chunkSize=MAX_RELAY_FRAME-8):RelayLedger{if(!Number.isInteger(fileId)||fileId<0||fileId>65535||!Number.isSafeInteger(size)||size<0||!Number.isSafeInteger(chunkSize)||chunkSize<1||chunkSize>MAX_RELAY_FRAME-8||Math.ceil(size/chunkSize)>0x100000000)throw new Error('Invalid relay metadata');return {fileId,remaining:size,outstanding:0,nextIndex:0,chunkSize};}
export function chargeFrame(ledger:RelayLedger,frame:ArrayBuffer):RelayLedger{
  if(frame.byteLength<8||frame.byteLength>MAX_RELAY_FRAME)throw new Error('Invalid relay frame');const v=new DataView(frame);const bytes=frame.byteLength-8;const flag=v.getUint8(6);
  if(v.getUint16(0,true)!==ledger.fileId||v.getUint8(7)!==0||v.getUint32(2,true)!==ledger.nextIndex||flag!==(bytes===ledger.remaining?2:1)||!bytes||bytes!==Math.min(ledger.chunkSize,ledger.remaining)||ledger.outstanding+bytes>RELAY_BURST)throw new Error('Invalid relay ledger');
  return {...ledger,remaining:ledger.remaining-bytes,outstanding:ledger.outstanding+bytes,nextIndex:ledger.nextIndex+1};
}
export function applyCredit(ledger:RelayLedger,frame:ArrayBuffer):RelayLedger{if(frame.byteLength!==5||new DataView(frame).getUint8(0)!==6)throw new Error('Invalid credit frame');const n=new DataView(frame).getUint32(1,true);if(!n||n>ledger.outstanding)throw new Error('Credit exceeds outstanding data');return {...ledger,outstanding:ledger.outstanding-n};}
