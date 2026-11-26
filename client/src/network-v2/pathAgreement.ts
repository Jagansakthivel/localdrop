export type CommittedPath='rtc'|'relay';
type Stage='prepare'|'ready'|'reject'|'commit'|'committed'|'activate';
export interface PathPacket {type:'v2-path'; epoch:string; path:CommittedPath; stage:Stage}
export interface PathAgreementOptions {
  leader:boolean;
  /** Must be authenticated, ordered signaling. Throw on failed send. */
  send:(message:PathPacket)=>void;
  available:(path:CommittedPath)=>boolean;
  /** Include both directions, pending offers and outstanding file-end results. */
  busy:()=>boolean;
  onCommit:(path:CommittedPath)=>void;
  invalidate:(reason:Error)=>void;
  signal:AbortSignal;
}
interface Pending {epoch:string;path:CommittedPath;stage:'prepare'|'ready'|'commit'|'committed'}
/** Two-sided path commitment. Never infer the active path from an open data channel. */
export function createPathAgreement(o:PathAgreementOptions){
  let current:CommittedPath|null=null,pending:Pending|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false;
  const release=()=>{clearTimeout(timer);timer=undefined;pending=undefined;};
  const close=()=>{closed=true;release();o.signal.removeEventListener('abort',close);};
  const invalidate=(e:unknown)=>{if(closed)return;close();o.invalidate(e instanceof Error?e:new Error('Transport agreement failed'));};
  const arm=()=>{clearTimeout(timer);timer=setTimeout(()=>invalidate(new Error('Transport agreement timed out')),3000);};
  function send(stage:Stage,p:Pick<Pending,'epoch'|'path'>){o.send({type:'v2-path',epoch:p.epoch,path:p.path,stage});}
  function commit(path:CommittedPath){if(!o.available(path)||o.busy())throw new Error('Transport no longer safe to commit');current=path;o.onCommit(path);}
  o.signal.addEventListener('abort',close,{once:true});if(o.signal.aborted)close();
  return {
    get current(){return current;},
    get locked(){return closed||Boolean(pending);},
    canStart(){return !closed&&!pending&&current!==null&&o.available(current);},
    // While waiting for activate, the follower may receive on the newly committed path.
    // This handles cross-transport ordering of signaling activate vs RTC metadata.
    canReceive(path:CommittedPath){return !closed&&current===path&&o.available(path)&&(!pending||(!o.leader&&pending.stage==='committed'));},
    request(path:CommittedPath){if(closed||!o.leader||pending||o.busy()||path===current||!o.available(path))return false;
      try{pending={epoch:crypto.randomUUID(),path,stage:'prepare'};arm();send('prepare',pending);return true;}catch(e){invalidate(e);return false;}},
    receive(raw:unknown){if(closed||!raw||typeof raw!=='object'||!('type'in raw)||raw.type!=='v2-path')return;
      if(!('epoch'in raw)||typeof raw.epoch!=='string'||raw.epoch.length>64||!('path'in raw)||(raw.path!=='rtc'&&raw.path!=='relay')||!('stage'in raw)||typeof raw.stage!=='string')return;
      const p={epoch:raw.epoch,path:raw.path} as Pick<Pending,'epoch'|'path'>;
      try{
        if(!o.leader&&raw.stage==='prepare'){
          if(pending||o.busy()||!o.available(p.path)){send('reject',p);return;}
          pending={...p,stage:'ready'};arm();send('ready',pending);return;
        }
        if(!pending||p.epoch!==pending.epoch||p.path!==pending.path)return;
        if(o.leader&&raw.stage==='reject'&&pending.stage==='prepare'){release();return;}
        if(o.leader&&raw.stage==='ready'&&pending.stage==='prepare'){
          if(o.busy()||!o.available(p.path))throw new Error('Path changed during prepare');pending.stage='commit';arm();send('commit',pending);return;
        }
        if(!o.leader&&raw.stage==='commit'&&pending.stage==='ready'){
          commit(p.path);pending.stage='committed';arm();send('committed',pending);return;
        }
        if(o.leader&&raw.stage==='committed'&&pending.stage==='commit'){
          commit(p.path);send('activate',pending);release();return;
        }
        if(!o.leader&&raw.stage==='activate'&&pending.stage==='committed'){release();return;}
      }catch(e){invalidate(e);}
    },
    signalingLost(){if(pending)invalidate(new Error('Signaling lost during transport agreement'));},
    close,
  };
}
