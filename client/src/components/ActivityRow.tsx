import type { ReactNode } from 'react';
import { Check, ArrowUpRight, ArrowDownLeft, AlertCircle, X } from 'lucide-react';

export type ActivityState = 'active' | 'complete' | 'failed' | 'cancelled';

export interface ActivityRowProps {
  name: string;
  size: string;
  direction: 'send' | 'receive';
  state: ActivityState;
  progress: number;
  detail?: string;
  saveControl?: ReactNode;
  onCancel?: () => void;
}

export function ActivityRow({
  name,
  size,
  direction,
  state,
  progress,
  detail,
  saveControl,
  onCancel,
}: ActivityRowProps) {
  const active = state === 'active';
  const received = direction === 'receive';
  const Icon =
    state === 'failed'
      ? AlertCircle
      : state === 'cancelled'
        ? X
        : received
          ? ArrowDownLeft
          : ArrowUpRight;
  const label =
    state === 'complete'
      ? received
        ? 'Received'
        : 'Sent'
      : state === 'failed'
        ? 'Failed'
        : state === 'cancelled'
          ? 'Cancelled'
          : received
            ? 'Receiving'
            : 'Sending';
  const pct = Number.isFinite(progress) ? Math.min(99, Math.max(0, progress)) : 0;
  const dot = name.lastIndexOf('.');
  const split = dot > 0 && name.length - dot <= 12;

  return (
    <article className="ldv-activity-row" data-direction={direction} data-state={state}>
      <span className="ldv-file-mark" aria-hidden="true">
        <Icon size={20} />
      </span>
      <div className="ldv-file-body">
        <div className="ldv-filename" title={name} aria-label={name}>
          <span>{split ? name.slice(0, dot) : name}</span>
          {split && <span>{name.slice(dot)}</span>}
        </div>
        <div className="ldv-meta">
          <span className="ldt-size">{size}</span> · {label}
          {detail && ` · ${detail}`}
        </div>
        {active && <progress max={100} value={pct} aria-label={`Transfer progress: ${name}`} />}
        {received && state === 'complete' && saveControl && (
          <div className="ldv-save">{saveControl}</div>
        )}
      </div>
      {state === 'complete' && <Check className="ldv-success" size={18} aria-label="Transfer complete" />}
      {active && onCancel && (
        <button
          type="button"
          className="ldv-cancel"
          onClick={onCancel}
          aria-label={`Cancel ${name}`}
        >
          <X size={18} />
        </button>
      )}
    </article>
  );
}
