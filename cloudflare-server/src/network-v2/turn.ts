export interface TurnEnv { TURN_KEY_ID?:string;TURN_API_TOKEN?:string }
export type AuthorizeTurn=(room:string,token:string,ip:string)=>Promise<boolean>;
const STUN=[{urls:'stun:stun.l.google.com:19302'},{urls:'stun:stun1.l.google.com:19302'}];
// Invoke inside SignalingHub.fetch, after exact Origin allowlist. authorize must use the
// existing hashed active-session credential + durable per-IP/session issuance quota.
export async function iceServersResponse(request:Request,env:TurnEnv,authorize:AuthorizeTurn,origin:string):Promise<Response>{
  const headers={'Content-Type':'application/json','Cache-Control':'no-store','Access-Control-Allow-Origin':origin,'Vary':'Origin'};
  const respond=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers});
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:{...headers,'Access-Control-Allow-Methods':'POST, OPTIONS','Access-Control-Allow-Headers':'Authorization, Content-Type'}});
  if(request.method!=='POST')return respond({error:'Method not allowed'},405);
  if(!env.TURN_KEY_ID||!env.TURN_API_TOKEN)return respond({iceServers:STUN});
  const token=request.headers.get('Authorization')?.match(/^Bearer ([A-Za-z0-9_-]{32,256})$/)?.[1];
  const reqHost=new URL(request.url).hostname.toLowerCase();
  const isLocal=reqHost==='localhost'||reqHost==='127.0.0.1';
  const ip=request.headers.get('CF-Connecting-IP')||(isLocal?(request.headers.get('x-forwarded-for')?.split(',')[0]?.trim()||'127.0.0.1'):null);
  if(!token||!ip)return respond({error:'Unauthorized'},401);
  let room:string;try{const raw=await request.text();if(raw.length>1024)return respond({error:'Invalid request'},400);const parsed:unknown=JSON.parse(raw);if(!parsed||typeof parsed!=='object'||!('roomCode' in parsed)||typeof parsed.roomCode!=='string'||!/^\d{4}$/.test(parsed.roomCode))return respond({error:'Invalid room'},400);room=parsed.roomCode;}catch{return respond({error:'Invalid request'},400);}
  if(!await authorize(room,token,ip))return respond({error:'Unauthorized or quota exceeded'},403);
  try{const ttl=3600;const upstream=await fetch(`https://rtc.live.cloudflare.com/v1/turn/keys/${encodeURIComponent(env.TURN_KEY_ID)}/credentials/generate-ice-servers`,{method:'POST',headers:{Authorization:`Bearer ${env.TURN_API_TOKEN}`,'Content-Type':'application/json'},body:JSON.stringify({ttl}),signal:AbortSignal.timeout(1200)});if(!upstream.ok)return respond({iceServers:STUN});const value:unknown=await upstream.json();if(!value||typeof value!=='object'||!('iceServers' in value)||!Array.isArray(value.iceServers))return respond({iceServers:STUN});return respond({iceServers:value.iceServers,expiresAt:Date.now()+ttl*1000});}catch{return respond({iceServers:STUN});}
}
