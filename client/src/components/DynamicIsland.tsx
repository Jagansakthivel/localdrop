import { useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowUpRight, ArrowDownLeft, X, ShieldCheck } from 'lucide-react';
import { springs } from '../motion-presets';
import { TransferSuccess } from './TransferSuccess';
import { formatBytes } from '../utils/fileAdapter';

export interface DynamicIslandProps {
  telemetry: {
    direction: 'sending' | 'receiving';
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    speedMbps: number;
    etaSeconds: number;
    progress: number;
  } | null;
  peer?: string;
  wsConnected: boolean;
  onCancel?: () => void;
}

export function DynamicIsland({
  telemetry,
  peer,
  wsConnected,
  onCancel,
}: DynamicIslandProps) {
  const [expanded, setExpanded] = useState(false);

  const isComplete = telemetry && telemetry.progress >= 100;

  return (
    <div className="ld-island-wrapper">
      <motion.div
        layout
        transition={springs.responsive}
        className="ld-island cursor-pointer select-none"
        onClick={() => setExpanded((prev) => !prev)}
      >
        <AnimatePresence mode="wait" initial={false}>
          {telemetry ? (
            <motion.div
              key="active-transfer"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              transition={springs.tactile}
              className="flex items-center gap-3"
            >
              {isComplete ? (
                <div className="flex items-center gap-2">
                  <TransferSuccess size={24} />
                  <span className="font-semibold text-xs tracking-wide text-[var(--forest)]">
                    Transfer Verified
                  </span>
                </div>
              ) : (
                <>
                  <span className="ld-island-pill pulsing" />
                  <div className="flex items-center gap-1.5 text-xs">
                    {telemetry.direction === 'sending' ? (
                      <ArrowUpRight size={14} className="text-[var(--accent)]" />
                    ) : (
                      <ArrowDownLeft size={14} className="text-[var(--forest)]" />
                    )}
                    <span className="max-w-[130px] truncate font-medium">
                      {telemetry.fileName}
                    </span>
                  </div>

                  <span className="numeric-data text-xs font-semibold px-2 py-0.5 rounded-full bg-[var(--paper)] border border-[var(--line)]">
                    {Math.round(telemetry.progress)}%
                  </span>

                  <span className="numeric-data text-[11px] text-[var(--muted)] hidden sm:inline">
                    {(telemetry.speedMbps / 8).toFixed(1)} MB/s
                  </span>

                  {expanded && (
                    <motion.div
                      initial={{ opacity: 0, width: 0 }}
                      animate={{ opacity: 1, width: 'auto' }}
                      exit={{ opacity: 0, width: 0 }}
                      className="flex items-center gap-2 pl-2 border-l border-[var(--line)]"
                    >
                      <span className="numeric-data text-[11px] text-[var(--muted)] whitespace-nowrap">
                        {formatBytes(telemetry.transferredBytes)} / {formatBytes(telemetry.totalBytes)}
                      </span>
                      {onCancel && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            onCancel();
                          }}
                          className="p-1 rounded-full hover:bg-[var(--line)] text-[var(--muted)] hover:text-[var(--ink)]"
                          aria-label="Cancel transfer"
                        >
                          <X size={13} />
                        </button>
                      )}
                    </motion.div>
                  )}
                </>
              )}
            </motion.div>
          ) : (
            <motion.div
              key="idle-state"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="flex items-center gap-2.5 text-xs text-[var(--muted)]"
            >
              <span
                className={`ld-island-pill ${wsConnected ? 'bg-[#52936c]' : 'bg-[var(--accent)]'}`}
              />
              {peer ? (
                <div className="flex items-center gap-1.5">
                  <span className="font-medium text-[var(--ink)]">{peer}</span>
                  <span>·</span>
                  <span className="flex items-center gap-1 text-[11px]">
                    <ShieldCheck size={12} className="text-[#52936c]" /> DTLS 256-bit
                  </span>
                </div>
              ) : (
                <span>{wsConnected ? 'Ready for pairing' : 'Connecting signaling...'}</span>
              )}
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>
    </div>
  );
}
