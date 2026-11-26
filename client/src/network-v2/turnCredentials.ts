export interface TurnResponse {iceServers:RTCIceServer[];expiresAt:number|null}
/** Normalize only known, bounded Cloudflare TURN endpoints; never log credentials. */
export function parseTurnResponse(raw:unknown, now=Date.now()):TurnResponse {
  const result:TurnResponse={iceServers:[],expiresAt:null};
  if(!raw||typeof raw!=='object'||!('iceServers' in raw))return result;
  const entries=Array.isArray(raw.iceServers)?raw.iceServers:[raw.iceServers];
  for(const e of entries.slice(0,16)){
    if(!e||typeof e!=='object'||!('urls' in e)||!('username' in e)||!('credential' in e)||typeof e.username!=='string'||typeof e.credential!=='string'||!e.username||!e.credential)continue;
    const urls=(Array.isArray(e.urls)?e.urls:[e.urls]).filter((x:unknown):x is string=>typeof x==='string'&&!/^turns?:turn\.cloudflare\.com:0*53(?:\?|$)/i.test(x)&&/^turns?:turn\.cloudflare\.com:\d{1,5}(?:\?transport=(?:udp|tcp))?$/i.test(x));
    if(urls.length)result.iceServers.push({urls,username:e.username,credential:e.credential});
  }
  const expiry='expiresAt' in raw?raw.expiresAt:undefined;
  if(typeof expiry==='number'&&Number.isFinite(expiry)&&expiry>now)result.expiresAt=expiry;
  if(result.expiresAt===null)result.iceServers=[]; // Never cache unknown/expired credentials.
  return result;
}
export function turnNeedsRefresh(expiresAt:number|null,now=Date.now(),marginMs=300000){return expiresAt===null||expiresAt-now<=marginMs;}
