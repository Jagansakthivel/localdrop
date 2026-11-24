import { useEffect, useId, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import '../motion.css';

const spring = { type: 'spring', stiffness: 240, damping: 24, mass: 0.85 } as const;

export type MotionTransfer = {
  id: string;
  name: string;
  direction: 'send' | 'receive';
  progress: number;
  status: 'active' | 'complete' | 'failed' | 'cancelled';
  speedLabel?: string;
};

export type StagedFile = {
  id: string;
  name: string;
  sizeLabel: string;
  previewUrl?: string;
};

function Device({ phone = false }: { phone?: boolean }) {
  return (
    <svg viewBox="0 0 100 100" fill="none" aria-hidden="true">
      {phone ? (
        <>
          <rect x="31" y="12" width="38" height="76" rx="9" fill="currentColor" />
          <rect x="35" y="17" width="30" height="65" rx="6" fill="var(--ld-paper)" />
          <path d="M44 21h12" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
        </>
      ) : (
        <>
          <rect x="13" y="21" width="74" height="51" rx="5" fill="currentColor" />
          <rect x="17" y="25" width="66" height="43" rx="2" fill="var(--ld-paper)" />
          <path d="M8 77h84l-6 7H14z" fill="currentColor" />
        </>
      )}
    </svg>
  );
}

// Mount persistently. Trigger only on the actual data-channel open event.
export function Handshake({
  connectionId,
  peerName,
  peerIsPhone = false,
}: {
  connectionId: string | null;
  peerName: string;
  peerIsPhone?: boolean;
}) {
  const reduced = useReducedMotion();
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!connectionId) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const timer = setTimeout(() => setVisible(false), reduced ? 1200 : 2350);
    return () => clearTimeout(timer);
  }, [connectionId, reduced]);

  return (
    <AnimatePresence>
      {visible && connectionId && (
        <motion.div
          key={connectionId}
          className="ld-handshake"
          role="status"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <motion.div
            className="ld-handshake-sheet"
            initial={reduced ? false : { y: 24, scale: 0.94 }}
            animate={{ y: 0, scale: 1 }}
            transition={spring}
          >
            <div className="ld-kicker">LOCALDROP / CONNECTION</div>
            <div className="ld-handshake-stage">
              <motion.div
                className="ld-device"
                initial={reduced ? false : { x: -42, rotate: -13 }}
                animate={{ x: 0, rotate: -5 }}
                transition={spring}
              >
                <Device />
              </motion.div>
              <svg className="ld-bridge" viewBox="0 0 120 60" aria-hidden="true">
                <motion.path
                  d="M2 30 C35 30 35 8 60 30 S85 30 118 30"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  initial={{ pathLength: reduced ? 1 : 0 }}
                  animate={{ pathLength: 1 }}
                  transition={{ duration: 0.55, delay: reduced ? 0 : 0.25 }}
                />
                <motion.circle
                  cx="60"
                  cy="30"
                  r="8"
                  fill="currentColor"
                  initial={{ scale: reduced ? 1 : 0 }}
                  animate={{ scale: 1 }}
                  transition={{ ...spring, delay: reduced ? 0 : 0.65 }}
                />
                {!reduced && (
                  <motion.circle
                    cx="60"
                    cy="30"
                    r="12"
                    fill="none"
                    stroke="currentColor"
                    initial={{ scale: 0.5, opacity: 0 }}
                    animate={{ scale: [0.5, 1, 3], opacity: [0, 1, 0] }}
                    transition={{ delay: 0.65, duration: 0.85 }}
                  />
                )}
              </svg>
              <motion.div
                className="ld-device ld-peer"
                initial={reduced ? false : { x: 42, rotate: 13 }}
                animate={{ x: 0, rotate: 5 }}
                transition={spring}
              >
                <Device phone={peerIsPhone} />
              </motion.div>
            </div>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              transition={{ delay: reduced ? 0 : 0.55 }}
            >
              <h2>You're connected.</h2>
              <p>{peerName || 'Peer'}</p>
            </motion.div>
            <button
              className="ld-dismiss"
              onClick={() => setVisible(false)}
              aria-label="Dismiss connection confirmation"
            >
              ×
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

export function FileStack({
  files,
  onRemove,
}: {
  files: StagedFile[];
  onRemove: (id: string) => void;
}) {
  const reduced = useReducedMotion();
  const [expanded, setExpanded] = useState(false);
  const id = useId();

  const validFiles = Array.isArray(files) ? files.filter((f) => f && typeof f === 'object' && f.id) : [];

  if (validFiles.length === 0) return null;

  return (
    <AnimatePresence>
      <motion.section
        className="ld-stack"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
      >
        <div className="ld-stack-top">
          <div className="ld-paper-stage" aria-hidden="true">
            <AnimatePresence>
              {validFiles.slice(-4).map((f, i, a) => {
                const depth = a.length - 1 - i;
                const ext = (f.name || 'file').split('.').pop()?.slice(0, 5).toUpperCase() || 'FILE';

                return (
                  <motion.div
                    key={f.id}
                    className="ld-paper"
                    initial={
                      reduced
                        ? false
                        : { y: -65, x: 35, rotate: 18, scale: 0.7, opacity: 0 }
                    }
                    animate={{
                      y: -depth * 8,
                      x: depth * 12,
                      rotate: depth * 7 - 5,
                      scale: 1 - depth * 0.045,
                      opacity: 1,
                    }}
                    exit={{ opacity: 0 }}
                    transition={spring}
                  >
                    {f.previewUrl ? (
                      <img
                        src={f.previewUrl}
                        alt=""
                        onError={(e) => {
                          // Fallback to extension view if image fails
                          (e.target as HTMLElement).style.display = 'none';
                        }}
                      />
                    ) : (
                      <>
                        <span className="ld-extension">{ext}</span>
                        <i />
                        <i />
                        <i />
                      </>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
          <div>
            <div className="ld-kicker">READY TO SEND</div>
            <h3>
              <span className="ld-number">{validFiles.length}</span>{' '}
              {validFiles.length === 1 ? 'file' : 'files'}
            </h3>
            <button
              className="ld-text-button"
              aria-expanded={expanded}
              aria-controls={id}
              onClick={() => setExpanded((v) => !v)}
            >
              {expanded ? 'Hide files' : 'Review files'} ↗
            </button>
          </div>
        </div>

        <AnimatePresence initial={false}>
          {expanded && (
            <motion.div
              id={id}
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: 'auto', opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={reduced ? { duration: 0 } : spring}
              className="ld-file-list"
            >
              {validFiles.map((f) => (
                <div key={f.id} className="ld-file-row">
                  <span>{f.name || 'Unnamed file'}</span>
                  <small>{f.sizeLabel}</small>
                  <button onClick={() => onRemove(f.id)} aria-label={`Remove ${f.name}`}>
                    ×
                  </button>
                </div>
              ))}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.section>
    </AnimatePresence>
  );
}

export function TransferMotion({ transfer: t }: { transfer: MotionTransfer }) {
  const reduced = useReducedMotion();
  const rawClip = useId();
  const clip = `clip-${rawClip.replace(/:/g, '')}`;

  if (!t || typeof t !== 'object') return null;

  const p = Math.min(100, Math.max(0, typeof t.progress === 'number' && Number.isFinite(t.progress) ? t.progress : 0));
  const sending = t.direction === 'send';
  const active = t.status === 'active';
  const done = t.status === 'complete';

  return (
    <motion.article
      className={`ld-transfer ${sending ? 'ld-out' : 'ld-in'}`}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
    >
      <div className="ld-transfer-art" aria-hidden="true">
        <svg viewBox="0 0 320 120">
          <defs>
            <clipPath id={clip}>
              <rect x="235" y="25" width="54" height="70" rx="7" />
            </clipPath>
          </defs>
          <g transform={sending ? '' : 'translate(320 0) scale(-1 1)'}>
            <rect
              x="30"
              y="25"
              width="54"
              height="70"
              rx="7"
              fill="var(--ld-paper)"
              stroke="currentColor"
              strokeWidth="1.5"
            />
            <path
              d="M42 43h29M42 53h22M42 63h26"
              stroke="currentColor"
              opacity=".45"
              strokeWidth="2"
              strokeLinecap="round"
            />
            <path
              d="M91 60H228"
              stroke="currentColor"
              opacity=".25"
              strokeDasharray="3 6"
            />
            <rect
              x="235"
              y="25"
              width="54"
              height="70"
              rx="7"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeDasharray={done ? undefined : '4 4'}
            />
            <g clipPath={`url(#${clip})`}>
              <motion.rect
                x="235"
                width="54"
                y={95 - (70 * (done ? 100 : p)) / 100}
                height={(70 * (done ? 100 : p)) / 100}
                fill="currentColor"
                opacity=".23"
                initial={false}
                animate={{
                  y: 95 - (70 * (done ? 100 : p)) / 100,
                  height: (70 * (done ? 100 : p)) / 100,
                }}
                transition={reduced ? { duration: 0 } : { duration: 0.25 }}
              />
            </g>
            {active &&
              !reduced &&
              Array.from({ length: 5 }, (_, i) => (
                <motion.rect
                  key={i}
                  x="92"
                  y={47 + (i % 3) * 12}
                  width={8 + (i % 2) * 5}
                  height="5"
                  rx="2"
                  fill="currentColor"
                  initial={{ x: 0, opacity: 0 }}
                  animate={{ x: [0, 128], opacity: [0, 1, 1, 0] }}
                  transition={{
                    duration: 1.15,
                    delay: i * 0.18,
                    repeat: Infinity,
                    ease: 'linear',
                  }}
                />
              ))}
            {done && (
              <motion.path
                d="M247 60l10 10 20-23"
                fill="none"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
                strokeLinejoin="round"
                initial={{ pathLength: reduced ? 1 : 0 }}
                animate={{ pathLength: 1 }}
                transition={{ duration: 0.35 }}
              />
            )}
          </g>
        </svg>
      </div>
      <div className="ld-transfer-copy">
        <div className="ld-kicker">
          {done
            ? sending
              ? 'SENT'
              : 'RECEIVED'
            : active
              ? sending
                ? 'SENDING'
                : 'RECEIVING'
              : (t.status || 'READY').toUpperCase()}
        </div>
        <h3 title={t.name}>{t.name || 'File'}</h3>
        <div
          className="ld-progress"
          role="progressbar"
          aria-label={`Transfer progress for ${t.name}`}
          aria-valuenow={p}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <motion.div
            initial={false}
            animate={{ scaleX: p / 100 }}
            transition={reduced ? { duration: 0 } : { duration: 0.2 }}
          />
        </div>
        <div className="ld-metrics">
          <span className="ld-number">{Math.floor(p)}%</span>
          <span>{active ? t.speedLabel : undefined}</span>
        </div>
      </div>
    </motion.article>
  );
}
