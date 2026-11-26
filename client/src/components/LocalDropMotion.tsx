import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { formatFilename } from '../utils/formatFilename';
import { canAnimatePackets, clampProgress, motionPhase, phaseLabel, type TransferDirection, type TransferStatus } from '../utils/motionPhase';
import '../motion.css';
import './motion-finale.css';

const soft = { type: 'spring', stiffness: 270, damping: 25, mass: .85 } as const;
const snap = { type: 'spring', stiffness: 420, damping: 31, mass: .72 } as const;
const instant = { duration: 0 } as const;
const ease = [0.22, 1, 0.36, 1] as const;
export type MotionTransfer = { id: string; name: string; direction: TransferDirection; progress: number; status: TransferStatus; speedLabel?: string; awaitingApproval?: boolean; paused?: boolean };
export type StagedFile = { id: string; name: string; sizeLabel: string; previewUrl?: string };

function usePageVisible() {
  const [visible, setVisible] = useState(() => typeof document !== 'undefined' && !document.hidden);
  useEffect(() => { const update = () => setVisible(!document.hidden); document.addEventListener('visibilitychange', update); update(); return () => document.removeEventListener('visibilitychange', update); }, []);
  return visible;
}
// Decorative activity only: a stall never modifies transfer state or network timeouts.
function useAdvancing(id: string, progress: number, enabled: boolean) {
  const previous = useRef<{ id: string; progress: number } | null>(null);
  const [advancing, setAdvancing] = useState(false);
  useEffect(() => {
    if (!enabled) { previous.current = null; setAdvancing(false); return; }
    const prev = previous.current;
    previous.current = { id, progress };
    if (prev?.id === id && progress <= prev.progress) { setAdvancing(false); return; }
    setAdvancing(progress > 0);
    const timer = window.setTimeout(() => setAdvancing(false), 2200);
    return () => window.clearTimeout(timer);
  }, [id, progress, enabled]);
  return advancing && enabled;
}

// Custom device artwork. The file on the destination screen fills from real progress.
function Device({ phone = false, destination = false, progress = 0, connected = false }: { phone?: boolean; destination?: boolean; progress?: number; connected?: boolean }) {
  const reduced = useReducedMotion();
  const clip = useId();
  return <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
    <defs><clipPath id={clip}><rect x="40" y="37" width="20" height="25" rx="3" /></clipPath></defs>
    {phone ? <><rect x="28" y="10" width="44" height="80" rx="10" fill="currentColor"/><rect x="32" y="14" width="36" height="72" rx="7" fill="var(--ld-paper,var(--surface))"/><path d="M45 19h10m-10 62h10" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round"/></> : <><rect x="11" y="20" width="78" height="55" rx="6" fill="currentColor"/><rect x="15" y="24" width="70" height="47" rx="3" fill="var(--ld-paper,var(--surface))"/><path d="M6 79h88l-7 6H13z" fill="currentColor"/><path d="M42 80h16" stroke="var(--ld-paper,var(--surface))" strokeWidth="2" strokeLinecap="round"/></>}
    {connected ? <motion.path d="m42 48 6 6 11-13" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" initial={reduced ? false : { pathLength:0, opacity:0 }} animate={{ pathLength:1, opacity:1 }} transition={reduced ? instant : {duration:.32,delay:.58}}/> : <>
      <rect x="40" y="37" width="20" height="25" rx="3" stroke="currentColor" strokeWidth="1.5" opacity={destination ? .65 : 1}/>
      <g clipPath={`url(#${clip})`}><motion.rect x="40" y="37" width="20" height="25" fill="currentColor" opacity=".23" style={{transformOrigin:'50px 62px'}} initial={false} animate={{scaleY:destination ? clampProgress(progress)/100 : 1}} transition={reduced ? instant : {duration:.16,ease:'linear'}}/></g>
      <path d="M44 44h12m-12 5h8m-8 5h10" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" opacity=".65"/>
    </>}
  </svg>;
}

// 1. Magnetic handshake: finite sequence, no focus trap or full-screen blur.
// connectionId must identify an established logical session, not a socket/ICE generation.
export function Handshake({ connectionId, peerName, peerIsPhone = false, localIsPhone = false, ready = true }: { connectionId: string | null; peerName: string; peerIsPhone?: boolean; localIsPhone?: boolean; ready?: boolean }) {
  const reduced = Boolean(useReducedMotion());
  const visible = usePageVisible();
  const seen = useRef<string | null>(null);
  const [shown, setShown] = useState<string | null>(null);
  useEffect(() => {
    if (!connectionId) { seen.current = null; setShown(null); return; }
    if (ready && visible && seen.current !== connectionId) { seen.current = connectionId; setShown(connectionId); }
    if (!visible || !ready) setShown(null);
  }, [connectionId, ready, visible]);
  useEffect(() => {
    if (!shown) return;
    const timer = window.setTimeout(() => setShown(null), reduced ? 1500 : 2350);
    return () => window.clearTimeout(timer);
  }, [shown, reduced]);
  return <AnimatePresence>{shown && shown === connectionId && ready && visible && <motion.div key={shown} className="ld-handshake ldf-handshake" initial={reduced ? false : {opacity:0}} animate={{opacity:1}} exit={{opacity:0}} transition={reduced ? instant : {duration:.18}}>
    <motion.div className="ld-handshake-sheet ldv-connection-modal" initial={reduced ? false : {y:18,scale:.94,opacity:0}} animate={{y:0,scale:1,opacity:1}} exit={reduced ? {opacity:0} : {y:8,scale:.98,opacity:0}} transition={reduced ? instant : soft}>
      <div className="ld-kicker">Connection established</div>
      <div className="ld-handshake-stage" aria-hidden="true">
        <motion.div className="ld-device" initial={reduced ? false : {x:-24,rotate:-14,scale:.88}} animate={{x:0,rotate:-5,scale:1}} transition={reduced ? instant : soft}><Device phone={localIsPhone} connected/></motion.div>
        <svg className="ld-bridge" viewBox="0 0 120 64" fill="none">
          <motion.path d="M3 32C25 32 40 16 60 32S95 32 117 32" stroke="currentColor" strokeWidth="2" strokeLinecap="round" initial={reduced ? false : {pathLength:0,opacity:0}} animate={{pathLength:1,opacity:1}} transition={reduced ? instant : {duration:.5,delay:.12,ease}}/>
          {!reduced && [0,1].map(i=><motion.circle key={i} cx="60" cy="32" r="11" stroke="currentColor" strokeWidth="1.2" style={{transformOrigin:'60px 32px'}} initial={{scale:.65,opacity:0}} animate={{scale:[.65,1,2.5],opacity:[0,.7,0]}} transition={{duration:.78,delay:.5+i*.15,ease:'easeOut'}}/>)}
          <motion.g style={{transformOrigin:'60px 32px'}} initial={reduced ? false : {scale:0}} animate={{scale:1}} transition={reduced ? instant : {...snap,delay:.42}}><circle cx="60" cy="32" r="11" fill="currentColor"/><path d="m55 32 3 3 7-7" stroke="var(--ld-paper,var(--surface))" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></motion.g>
        </svg>
        <motion.div className="ld-device ldf-peer-device" initial={reduced ? false : {x:24,rotate:14,scale:.88}} animate={{x:0,rotate:5,scale:1}} transition={reduced ? instant : soft}><Device phone={peerIsPhone} connected/></motion.div>
      </div>
      <div role="status"><h2>You're connected.</h2><p>{peerName}</p></div>
      <button type="button" className="ld-dismiss" onClick={()=>setShown(null)} aria-label="Dismiss connection confirmation">×</button>
    </motion.div>
  </motion.div>}</AnimatePresence>;
}

// 2. Elastic stack: same existing layout, at most four illustrated files.
function PaperPreview({ file }: {file: StagedFile}) {
  const [failed, setFailed] = useState(false);
  const ext = file.name.includes('.') ? file.name.split('.').pop()?.slice(0,5).toUpperCase() : 'FILE';
  return <>{file.previewUrl && !failed ? <img src={file.previewUrl} alt="" onError={()=>setFailed(true)}/> : <><span className="ld-extension">{ext || 'FILE'}</span><i/><i/><i/></>}</>;
}
export function FileStack({files,onRemove}:{files:StagedFile[];onRemove:(id:string)=>void}) {
  const reduced = Boolean(useReducedMotion());
  const [expanded,setExpanded] = useState(false);
  const id = useId();
  const valid = Array.isArray(files) ? files.filter(f=>f && f.id) : [];
  if (!valid.length) return null;
  return <motion.section className="ld-stack" initial={reduced ? false : {opacity:0,y:6}} animate={{opacity:1,y:0}} transition={reduced ? instant : soft}>
    <div className="ld-stack-top"><div className="ld-paper-stage" aria-hidden="true"><AnimatePresence initial={false}>{valid.slice(-4).map((f,i,a)=>{const depth=a.length-1-i;return <motion.div key={f.id} className="ld-paper" initial={reduced ? false : {x:28,y:-25,rotate:23,scale:.78,opacity:0}} animate={{x:depth*10,y:-depth*7,rotate:depth*7-5,scale:1-depth*.04,opacity:1}} exit={reduced ? {opacity:0} : {x:-12,y:8,rotate:-13,scale:.86,opacity:0}} transition={reduced ? instant : {...soft,delay:Math.min(depth*.025,.075)}}><PaperPreview key={f.previewUrl || f.id} file={f}/></motion.div>})}</AnimatePresence></div>
      <div><div className="ld-kicker">Ready to send</div><h3><span className="ld-number">{valid.length}</span> {valid.length===1?'file':'files'}</h3><button type="button" className="ld-text-button" aria-expanded={expanded} aria-controls={id} onClick={()=>setExpanded(v=>!v)}>{expanded?'Hide files':'Review files'} ↗</button></div></div>
    <AnimatePresence initial={false}>{expanded && <motion.div id={id} className="ld-file-list" initial={reduced?false:{height:0,opacity:0}} animate={{height:'auto',opacity:1}} exit={{height:0,opacity:0}} transition={reduced?instant:{duration:.22,ease}}>{valid.map(f=><div key={f.id} className="ld-file-row"><span title={f.name}>{formatFilename(f.name,36)}</span><small>{f.sizeLabel}</small><button type="button" onClick={()=>onRemove(f.id)} aria-label={`Remove ${f.name}`}>×</button></div>)}</motion.div>}</AnimatePresence>
  </motion.section>;
}

// 3/4. Packet departure and assembly. Device positions stay fixed: local left, peer right.
// Packet paths are symbolic, not one visual object per real network packet.
function TransferScene({direction,progress,running,localIsPhone,peerIsPhone,complete}:{direction:TransferDirection;progress:number;running:boolean;localIsPhone:boolean;peerIsPhone:boolean;complete:boolean}) {
  const reduced = Boolean(useReducedMotion());
  const send = direction === 'send';
  return <div className="ldf-scene" data-direction={direction} aria-hidden="true">
    <div className="ldf-scene-device"><Device phone={localIsPhone} destination={!send} progress={progress} connected={complete&&!send}/><small>This device</small></div>
    <svg className="ldf-flight" viewBox="0 0 144 86" fill="none" aria-hidden="true">
      {[0,1,2].map(i=><path key={i} d={`M4 ${35+i*8} C40 ${10+i*15} 100 ${64-i*8} 140 ${35+i*8}`} stroke="currentColor" strokeWidth="1" opacity=".19" strokeLinecap="round"/>)}
      <path d="M4 43H140" stroke="currentColor" strokeDasharray="2 5" opacity=".4"/>
      <motion.path d={send?'M65 37l7 6-7 6m7-6H56':'M79 37l-7 6 7 6m-7-6h16'} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" initial={false} animate={{opacity:running ? .55 : 1}}/>
      {running && !reduced && [0,1,2].map(i=><motion.g key={i} initial={{x:send?4:140,y:43,opacity:0}} animate={{x:send?[4,38,74,110,140]:[140,110,74,38,4],y:[43,28+i*6,43,55-i*6,43],opacity:[0,1,1,1,0],scale:[.7,1,1,.85,.55]}} transition={{duration:1.65,delay:i*.39,repeat:Infinity,repeatDelay:.12,ease:'linear',times:[0,.25,.5,.75,1]}}><rect x="-5" y="-7" width="10" height="14" rx="2" fill="currentColor"/><path d="M-2-2h4m-4 4h3" stroke="var(--ld-paper,var(--surface))" strokeWidth="1" strokeLinecap="round"/></motion.g>)}
    </svg>
    <div className="ldf-scene-device"><Device phone={peerIsPhone} destination={send} progress={progress} connected={complete&&send}/><small>Peer device</small></div>
  </div>;
}
export function TransferMotion({transfer:t,children,localIsPhone=false,peerIsPhone=false,animatePackets=true,onCancel}:{transfer:MotionTransfer;children?:ReactNode;localIsPhone?:boolean;peerIsPhone?:boolean;animatePackets?:boolean;onCancel?:()=>void}) {
  const reduced=Boolean(useReducedMotion());
  const visible=usePageVisible();
  const p=clampProgress(t.progress);
  const phase=motionPhase(t.status,t.direction,p,t.awaitingApproval,t.paused);
  const active=t.status==='active';
  const advancing=useAdvancing(t.id,p,active && visible && animatePackets && (phase==='sending'||phase==='receiving'));
  const running=canAnimatePackets(phase,visible,reduced,advancing)&&animatePackets;
  const label=phase==='complete'?(t.direction==='send'?'Sent':'Received'):phaseLabel[phase];
  return <motion.article className={`ld-transfer ld-transfer-card ldf-transfer ${t.direction==='send'?'ld-out':'ld-in'}`} initial={reduced?false:{opacity:0,y:5}} animate={{opacity:1,y:0}} transition={reduced?instant:{duration:.2,ease}}>
    <div className="ld-transfer-art ld-transfer-animation"><TransferScene direction={t.direction} progress={p} running={running} localIsPhone={localIsPhone} peerIsPhone={peerIsPhone} complete={phase==='complete'}/></div>
    <div className="ld-transfer-copy ld-transfer-content ld-transfer-info"><div className="ld-kicker ld-transfer-status">{label}</div><h3 className="ld-transfer-name ld-transfer-filename" title={t.name} aria-label={t.name}>{formatFilename(t.name,44)}</h3>
      {active && <><div className="ld-progress ld-progress-track" role="progressbar" aria-label={`Transfer progress for ${t.name}`} aria-valuenow={Math.round(p)} aria-valuemin={0} aria-valuemax={100}><motion.div className="ld-progress-fill" initial={false} animate={{scaleX:p/100}} transition={reduced?instant:{duration:.16,ease:'linear'}}/></div><div className="ld-metrics ld-transfer-meta"><span className="ld-number">{Math.floor(p)}%</span><span>{phase==='sending'||phase==='receiving'?t.speedLabel:undefined}</span></div></>}
      {children}{active && onCancel && <button className="ld-quiet ldf-cancel" type="button" onClick={onCancel}>Cancel transfer</button>}
    </div>
  </motion.article>;
}
