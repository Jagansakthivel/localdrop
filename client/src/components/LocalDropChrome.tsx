import { useState, useEffect, useRef, useId } from 'react';
import { motion, AnimatePresence, useReducedMotion } from 'motion/react';
import {
  Laptop2,
  Smartphone,
  ChevronDown,
  ShieldCheck,
  Moon,
  Sun,
  Settings2,
} from 'lucide-react';
import './localdrop-chrome.css';

export type ConnectionState = 'connected' | 'ready' | 'connecting' | 'offline';

export type LocalDropChromeProps = {
  deviceName: string;
  peerName?: string;
  state: ConnectionState;
  secure?: boolean;
  transportLabel?: string;
  dark: boolean;
  onToggleTheme: () => void;
  onSettings?: () => void;
  onDisconnect?: () => void;
};

const spring = { type: 'spring' as const, stiffness: 420, damping: 33, mass: 0.78 };

function DeviceGlyph({ name }: { name: string }) {
  return /android|iphone|mobile|phone|ipad|tablet/i.test(name) ? (
    <Smartphone size={17} strokeWidth={1.9} aria-hidden="true" />
  ) : (
    <Laptop2 size={17} strokeWidth={1.9} aria-hidden="true" />
  );
}

function GithubIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4" />
      <path d="M9 18c-4.51 2-5-2-7-2" />
    </svg>
  );
}

function LinkedinIcon({ size = 16 }: { size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-2-2 2 2 0 0 0-2 2v7h-4v-7a6 6 0 0 1 6-6z" />
      <rect x="2" y="9" width="4" height="12" />
      <circle cx="4" cy="4" r="2" />
    </svg>
  );
}

export function LocalDropHeader({
  deviceName,
  peerName,
  state,
  secure = false,
  transportLabel = 'WebRTC',
  dark,
  onToggleTheme,
  onSettings,
  onDisconnect,
}: LocalDropChromeProps) {
  const [open, setOpen] = useState(false);
  const reducedMotion = useReducedMotion();
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panelId = useId();

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!wrap.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const statusText =
    state === 'connected'
      ? 'Connected'
      : state === 'ready'
        ? 'Ready to pair'
        : state === 'offline'
          ? 'Offline'
          : 'Connecting';

  return (
    <header className="ldx-header">
      <a className="ldx-brand" href="#localdrop" aria-label="LocalDrop home">
        <span className="ldx-brandmark" aria-hidden="true">
          <span />
          <span />
        </span>
        localdrop<span className="ldx-brandperiod">.</span>
      </a>

      <div className="ldx-header-right">
        <div className="ldx-status" role="status" aria-label={`Connection status: ${statusText}`}>
          <span className={`ldx-status-dot ldx-status-dot--${state}`} />
          <span className="ldx-status-label">{statusText}</span>
          {state === 'connected' && secure && (
            <span className="ldx-status-secure" title={`${transportLabel} secure connection`}>
              <ShieldCheck size={14} />{' '}
              <span className="ldx-status-secure-text">Secure connection</span>
            </span>
          )}
        </div>

        <div className="ldx-device-wrap" ref={wrap}>
          <motion.button
            ref={trigger}
            aria-controls={open ? panelId : undefined}
            type="button"
            className="ldx-device-button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-label={`This device: ${deviceName}. Show connection information`}
            whileTap={reducedMotion ? undefined : { scale: 0.97 }}
            transition={spring}
          >
            <span className="ldx-device-icon">
              <DeviceGlyph name={deviceName} />
            </span>
            <span className="ldx-device-content">
              <span className="ldx-device-name" title={deviceName}>
                {deviceName}
              </span>
            </span>
            <motion.span
              className="ldx-device-chevron"
              animate={{ rotate: open ? 180 : 0 }}
              transition={reducedMotion ? { duration: 0 } : spring}
            >
              <ChevronDown size={15} />
            </motion.span>
          </motion.button>

          <AnimatePresence>
            {open && (
              <motion.div
                id={panelId}
                className="ldx-device-popover"
                role="region"
                aria-label="Device details"
                initial={reducedMotion ? false : { opacity: 0, y: -7, scale: 0.97 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -5, scale: 0.98 }}
                transition={reducedMotion ? { duration: 0 } : spring}
              >
                <span className="ldx-popover-eyebrow">Local identity</span>
                <strong className="ldx-popover-device">
                  <DeviceGlyph name={deviceName} />
                  {deviceName}
                </strong>

                <div className="ldx-popover-separator" />

                <div className="ldx-popover-line">
                  <span>{state === 'connected' ? 'Connection' : 'Availability'}</span>
                  <strong>
                    <span className={`ldx-status-dot ldx-status-dot--${state}`} />
                    {statusText}
                  </strong>
                </div>

                {peerName && (
                  <div className="ldx-popover-line">
                    <span>Paired with</span>
                    <strong title={peerName}>{peerName}</strong>
                  </div>
                )}

                {state === 'connected' && (
                  <div className="ldx-popover-line">
                    <span>Transport</span>
                    <strong>
                      {transportLabel}
                      {secure ? ' · Secure' : ''}
                    </strong>
                  </div>
                )}

                {state === 'connected' && onDisconnect && (
                  <button
                    className="ldx-popover-disconnect"
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      onDisconnect();
                    }}
                  >
                    Disconnect
                  </button>
                )}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        <button
          className="ldx-icon-button"
          type="button"
          aria-label={dark ? 'Switch to light mode' : 'Switch to dark mode'}
          onClick={onToggleTheme}
        >
          {dark ? <Sun size={19} /> : <Moon size={19} />}
        </button>

        {onSettings && (
          <button
            className="ldx-icon-button"
            type="button"
            aria-label="Open settings"
            onClick={onSettings}
          >
            <Settings2 size={19} />
          </button>
        )}
      </div>
    </header>
  );
}

export function LocalDropFooter() {
  return (
    <footer className="ldx-footer ldv-footer">
      <div className="ldx-footer-inner">
        <p>
          Designed &amp; built by{' '}
          <strong className="ldx-signature">
            Jagan
            <svg viewBox="0 0 64 9" preserveAspectRatio="none" aria-hidden="true">
              <path d="M2 6 Q 25 1 62 4" />
            </svg>
          </strong>
        </p>
        <nav className="ldx-footer-links" aria-label="Creator profiles">
          <a
            href="https://www.linkedin.com/in/jagan-sakthivel-dev/?utm_source=chatgpt.com"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Jagan on LinkedIn (opens in new tab)"
          >
            <LinkedinIcon size={16} />
            <span>LinkedIn</span>
          </a>
          <a
            href="https://github.com/Jagansakthivel?utm_source=chatgpt.com"
            target="_blank"
            rel="noopener noreferrer"
            aria-label="Jagan on GitHub (opens in new tab)"
          >
            <GithubIcon size={16} />
            <span>GitHub</span>
          </a>
        </nav>
      </div>
    </footer>
  );
}
