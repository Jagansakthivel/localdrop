export type SqlValue=string|number;
export interface TurnAuthorizationStore {
  query:(sql:string,...bindings:SqlValue[])=>Record<string,unknown>[];
  execute:(sql:string,...bindings:SqlValue[])=>void;
  transaction:<T>(fn:()=>T)=>T;
  activeParticipant:(room:string,id:string,ip:string)=>boolean;
}
/** Initialize in existing SignalingHub.initDatabase; no new DO migration is needed. */
export const TURN_QUOTA_DDL=`CREATE TABLE IF NOT EXISTS turn_issuance (scope TEXT NOT NULL, hour INTEGER NOT NULL, count INTEGER NOT NULL, PRIMARY KEY(scope,hour));`;
/** Authenticate against existing active, non-rotated resume credential; reserve issuance quotas atomically. */
export async function authorizeTurn(store:TurnAuthorizationStore,room:string,token:string,ip:string,now=Date.now()):Promise<boolean>{
  if(!/^\d{4}$/.test(room)||!/^[A-Za-z0-9_-]{43}$/.test(token)||!ip||ip.length>128)return false;
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(token))),b=>b.toString(16).padStart(2,'0')).join('');
  return store.transaction(()=>{
    const rows=store.query('SELECT participant_id FROM session_credentials WHERE room_code = ? AND token_hash = ? AND grace_until = 0 AND expires_at > ?',room,hash,now);
    const id=rows[0]?.participant_id;if(typeof id!=='string'||!store.activeParticipant(room,id,ip))return false;
    const hour=Math.floor(now/3600000);
    const caps:[string,number][]=[[`peer:${id}`,8],[`ip:${ip}`,40],['global',300]];
    for(const [key,cap]of caps){const used=store.query('SELECT count FROM turn_issuance WHERE scope = ? AND hour = ?',key,hour);if(Number(used[0]?.count??0)>=cap)return false;}
    for(const [key]of caps)store.execute('INSERT INTO turn_issuance (scope,hour,count) VALUES (?,?,1) ON CONFLICT(scope,hour) DO UPDATE SET count = count + 1',key,hour);
    store.execute('DELETE FROM turn_issuance WHERE hour < ?',hour-1);return true;
  });
}
