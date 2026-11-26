import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import {
  Laptop,
  Smartphone,
  ArrowDownToLine,
  FileText,
  FileImage,
  FileVideo,
  FileAudio,
  FileArchive,
  File,
  Check,
  X,
} from 'lucide-react';
import { formatFilename } from '../utils/formatFilename';

export interface IncomingTransferOffer {
  id: string;
  senderName: string;
  filename: string;
  size: number;
  mime?: string;
  senderDeviceType?: 'mobile' | 'desktop';
  receiverDeviceType?: 'mobile' | 'desktop';
}

export interface IncomingTransferPopupProps {
  offer: IncomingTransferOffer | null;
  onAccept: (id: string) => void | Promise<void>;
  onDecline: (id: string) => void | Promise<void>;
  receiverDeviceType?: 'mobile' | 'desktop';
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return 'Unknown size';
  }

  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const index = Math.min(
    units.length - 1,
    Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024)))
  );

  return `${Number((bytes / 1024 ** index).toFixed(1))} ${units[index]}`;
}

function TransferFilePreviewIcon({
  mime = '',
  filename = '',
  size = 24,
}: {
  mime?: string;
  filename?: string;
  size?: number;
}) {
  if (mime.startsWith('image/')) return <FileImage size={size} strokeWidth={1.6} />;
  if (mime.startsWith('video/')) return <FileVideo size={size} strokeWidth={1.6} />;
  if (mime.startsWith('audio/')) return <FileAudio size={size} strokeWidth={1.6} />;

  if (/\.(zip|rar|7z|tar|gz|bz2|xz)$/i.test(filename)) {
    return <FileArchive size={size} strokeWidth={1.6} />;
  }

  if (/\.(pdf|docx?|txt|xlsx?|pptx?|md|json|csv)$/i.test(filename)) {
    return <FileText size={size} strokeWidth={1.6} />;
  }

  return <File size={size} strokeWidth={1.6} />;
}

export function IncomingTransferPopup({
  offer,
  onAccept,
  onDecline,
  receiverDeviceType = 'desktop',
}: IncomingTransferPopupProps) {
  const reducedMotion = useReducedMotion();

  const dialogRef = useRef<HTMLDialogElement>(null);
  const declineRef = useRef<HTMLButtonElement>(null);
  const previousFocusRef = useRef<HTMLElement | null>(null);

  const processingRef = useRef(false);

  const [decision, setDecision] = useState<'idle' | 'accepted' | 'declined'>('idle');
  const [error, setError] = useState('');

  useEffect(() => {
    setDecision('idle');
    setError('');
    processingRef.current = false;
  }, [offer?.id]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (offer) {
      processingRef.current = false;

      if (!dialog.open) {
        previousFocusRef.current = document.activeElement as HTMLElement | null;
        try {
          dialog.showModal();
        } catch {
          // Fallback if showModal throws in test environment
          dialog.setAttribute('open', '');
        }
        // Focus decline button initially as safe default
        requestAnimationFrame(() => {
          declineRef.current?.focus();
        });
      }
    }
  }, [offer]);

  const handleExitComplete = () => {
    const dialog = dialogRef.current;
    if (!offer && dialog && dialog.open) {
      try {
        dialog.close();
      } catch {
        dialog.removeAttribute('open');
      }
      setDecision('idle');
      setError('');
      processingRef.current = false;

      // Restore focus to previously active element
      if (previousFocusRef.current && typeof previousFocusRef.current.focus === 'function') {
        previousFocusRef.current.focus();
      }
    }
  };

  async function respond(action: 'accepted' | 'declined') {
    const targetOffer = offer;
    if (!targetOffer || processingRef.current) return;

    const offerId = targetOffer.id;
    processingRef.current = true;
    setDecision(action);
    setError('');

    try {
      if (action === 'accepted') {
        await onAccept(offerId);
      } else {
        await onDecline(offerId);
      }
    } catch {
      if (offer?.id === offerId) {
        processingRef.current = false;
        setDecision('idle');
        setError('Unable to respond. Please try again.');
      }
    }
  }

  const activeOffer = offer; // AnimatePresence retains the exiting element itself.

  const SenderIcon = activeOffer?.senderDeviceType === 'mobile' ? Smartphone : Laptop;
  const ReceiverIcon =
    (activeOffer?.receiverDeviceType || receiverDeviceType) === 'mobile' ? Smartphone : Laptop;

  return (
    <dialog
      ref={dialogRef}
      className="ld-incoming-dialog"
      aria-labelledby="ld-incoming-title"
      aria-describedby="ld-incoming-description"
      onCancel={(event) => {
        event.preventDefault();
        void respond('declined');
      }}
    >
      <AnimatePresence mode="wait" onExitComplete={handleExitComplete}>
        {activeOffer && (
          <motion.section
            key={activeOffer.id}
            className="ld-incoming-card"
            initial={{
              opacity: 0,
              y: reducedMotion ? 0 : 24,
              scale: reducedMotion ? 1 : 0.96,
            }}
            animate={{
              opacity: 1,
              y: 0,
              scale: 1,
            }}
            exit={{
              opacity: 0,
              y: reducedMotion ? 0 : 12,
              scale: reducedMotion ? 1 : 0.98,
            }}
            transition={
              reducedMotion
                ? { duration: 0 }
                : {
                    type: 'spring',
                    stiffness: 320,
                    damping: 27,
                    mass: 0.8,
                  }
            }
          >
            <div className="ld-incoming-handle" />

            <span className="ld-incoming-kicker">
              <span className="ld-incoming-dot" />
              Transfer request
            </span>

            {/* Device transfer illustration */}
            <div className="ld-incoming-illustration" aria-hidden="true">
              <motion.div
                className="ld-incoming-device"
                initial={{ x: reducedMotion ? 0 : -10 }}
                animate={{ x: 0 }}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.3 }}
              >
                <SenderIcon size={30} strokeWidth={1.5} />
              </motion.div>

              <div className="ld-incoming-route">
                <span />
                {[0, 1, 2].map((index) => (
                  <motion.i
                    key={index}
                    animate={
                      reducedMotion
                        ? { opacity: 0.7 }
                        : {
                            opacity: [0.25, 1, 0.25],
                            scale: [0.8, 1.2, 0.8],
                          }
                    }
                    transition={{
                      duration: 0.65,
                      repeat: reducedMotion ? 0 : 1,
                      delay: index * 0.1,
                    }}
                  />
                ))}
                <span />
              </div>

              <motion.div
                className="ld-incoming-device ld-incoming-receiver"
                initial={{ x: reducedMotion ? 0 : 10 }}
                animate={{ x: 0 }}
                transition={reducedMotion ? { duration: 0 } : { duration: 0.3 }}
              >
                <ReceiverIcon size={30} strokeWidth={1.5} />
              </motion.div>
            </div>

            {/* Request details */}
            <h2 id="ld-incoming-title">Incoming file</h2>

            <p id="ld-incoming-description">
              <strong>{activeOffer.senderName}</strong>
              {' wants to share a file with you.'}
            </p>

            {/* File preview */}
            <div className="ld-incoming-file">
              <div className="ld-incoming-file-icon">
                <TransferFilePreviewIcon
                  mime={activeOffer.mime}
                  filename={activeOffer.filename}
                  size={24}
                />
              </div>

              <div className="ld-incoming-file-details">
                <strong title={activeOffer.filename}>
                  {formatFilename(activeOffer.filename, 38)}
                </strong>
                <span>{formatSize(activeOffer.size)}</span>
              </div>
            </div>

            <p className="ld-incoming-note">Only accept files you trust.</p>

            {/* Decision buttons */}
            <div className="ld-incoming-actions">
              <motion.button
                ref={declineRef}
                type="button"
                className="ld-incoming-decline"
                disabled={decision !== 'idle'}
                whileTap={reducedMotion ? undefined : { scale: 0.96 }}
                onClick={() => void respond('declined')}
              >
                <X size={17} />
                {decision === 'declined' ? 'Declining…' : 'Decline'}
              </motion.button>

              <motion.button
                type="button"
                className="ld-incoming-accept"
                disabled={decision !== 'idle'}
                whileTap={reducedMotion ? undefined : { scale: 0.96 }}
                onClick={() => void respond('accepted')}
              >
                {decision === 'accepted' ? (
                  <Check size={18} />
                ) : (
                  <ArrowDownToLine size={18} />
                )}
                {decision === 'accepted' ? 'Accepting…' : 'Accept'}
              </motion.button>
            </div>

            {error && (
              <p className="ld-incoming-error" role="alert">
                {error}
              </p>
            )}
          </motion.section>
        )}
      </AnimatePresence>
    </dialog>
  );
}
