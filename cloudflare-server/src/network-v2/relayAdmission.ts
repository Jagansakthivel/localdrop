export const MAX_FRAME=256*1024;
export interface RelayMeta {transferId:string;fileId:number;size:number;chunkSize:number;targetId:string}
export type Admission={ok:true;meta:RelayMeta}|{ok:false;code:'RELAY_BUSY'|'RELAY_INVALID_META'};
/** Call before mutating pending/active ledger. Destination comes from authenticated room lookup. */
export function admitRelayMeta(raw:Record<string,unknown>,targetId:string|undefined,busy:boolean):Admission{
  if(busy)return {ok:false,code:'RELAY_BUSY'};
  const {transferId,fileId,size,chunkSize}=raw;
  if(!targetId||typeof transferId!=='string'||!transferId||transferId.length>128||typeof fileId!=='number'||!Number.isInteger(fileId)||fileId<0||fileId>65535||typeof size!=='number'||!Number.isSafeInteger(size)||size<0||typeof chunkSize!=='number'||!Number.isSafeInteger(chunkSize)||chunkSize<1||chunkSize>MAX_FRAME-8||Math.ceil(size/chunkSize)>0x100000000)return {ok:false,code:'RELAY_INVALID_META'};
  return {ok:true,meta:{transferId,fileId,size,chunkSize,targetId}};
}
