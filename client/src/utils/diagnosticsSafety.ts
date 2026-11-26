export function elapsedMs(start:number,now=performance.now()){return Math.max(0,Math.round(now-start));}
/** Preserve pathname, unrelated query parameters, and fragment. */
export function removePairingPin(href:string){const url=new URL(href);url.searchParams.delete('pin');return url.pathname+url.search+url.hash;}
/** Transfer callbacks only merge transfer fields; live connection fields belong to the connection observer. */
export function mergeTransferDiagnostics<T extends object>(state:T,fields:{receiverConfirmedBytes:number;transferElapsedMs:number}){return {...state,...fields};}
