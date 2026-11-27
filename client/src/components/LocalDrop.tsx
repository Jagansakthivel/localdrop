import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'motion/react';
import { formatFilename } from '../utils/formatFilename';
import { downloadReceivedFile } from '../utils/saveReceivedFile';
import {
  ArrowUpRight,
  ArrowDownLeft,
  Laptop,
  Smartphone,
  Copy,
  Check,
  QrCode,
  Plus,
  Folder,
  Clipboard,
  X,
  Moon,
  Sun,
  Mic,
  Square,
  FileArchive,
  FileText,
  Download,
  FileSliders,
  Send,
  History,
} from 'lucide-react';
import { QRCodeSVG } from 'qrcode.react';
import type { ConnectionState, NetworkDiagnostics, TransportType } from '../types/network';
import { springs } from '../motion-presets';
import { LocalDropHeader, LocalDropFooter } from './LocalDropChrome';
import { Handshake, FileStack, TransferMotion, type StagedFile } from './LocalDropMotion';
import { MotionErrorBoundary } from './MotionErrorBoundary';
import { normalizeFiles, useSafeThumbnails, formatBytes, type NormalizedFile } from '../utils/fileAdapter';
import { ReceivedFileSave, type SaveState } from './ReceivedFileSave';
import { IncomingTransferPopup, type IncomingTransferOffer } from './IncomingTransferPopup';
import { ActivityRow, type ActivityState } from './ActivityRow';
import { getTransportCopy } from '../utils/transportCopy';
import type { SaveFileHandle } from '../utils/saveReceivedFile';
import '../localdrop.css';
import './mobile-refinement.css';
import './type-finish.css';

export type Transfer = {
  id: string;
  name: string;
  size: string;
  progress: number;
  direction: 'send' | 'receive';
  status: string;
  transferState?: ActivityState;
  awaitingApproval?: boolean;
  paused?: boolean;
  file?: File | null;
};

function getActivityState(t: Transfer): ActivityState {
  const s = t.status.toLowerCase();
  if (t.transferState === 'failed' || s.includes('fail')) return 'failed';
  if (t.transferState === 'cancelled' || s.includes('cancel')) return 'cancelled';
  if (t.transferState === 'active') return 'active';
  if (t.transferState === 'complete' || t.progress >= 100) return 'complete';
  return 'active';
}

export type StagedItem = NormalizedFile;

export type Props = {
  pin: string;
  device: string;
  peer?: string;
  qrUrl?: string;
  pairingUrl: string;
  transfers: Transfer[];
  stagedFiles: StagedItem[];
  onConnect: (pin: string) => void;
  onDisconnect: () => void;
  onFiles: (files: File[]) => void;
  onClipboard: (text: string) => void;
  onCancel?: (id: string) => void;
  onFolder?: () => void;
  onSettings?: () => void;
  onRemoveStaged?: (id: string) => void;
  onClearStaged?: () => void;
  onSendStaged?: () => void;
  onVoiceNote?: (file: File) => void;
  connecting?: boolean;
  error?: string;
  connectionState?: ConnectionState;
  transport?: TransportType;
  pathKind?: NetworkDiagnostics['pathKind'];
  // Diagnostics & Session extras
  wsConnected: boolean;
  autoAccept: boolean;
  onToggleAutoAccept: () => void;
  telemetry: {
    direction: 'sending' | 'receiving';
    fileName: string;
    totalBytes: number;
    transferredBytes: number;
    speedMbps: number;
    etaSeconds: number;
    progress: number;
  } | null;
  incomingOffer: {
    offerId: string;
    name: string;
    size: number;
    mime?: string;
    fromName: string;
    senderDeviceType?: 'mobile' | 'desktop';
  } | null;
  onAcceptOffer: (saveDirectly?: boolean) => Promise<boolean | void>;
  canSaveIncomingDirectly: boolean;
  onDeclineOffer: () => void;
  sharedItems: Array<{
    id: string;
    kind: 'file' | 'text';
    file?: File;
    text?: string;
    direction: 'sent' | 'received';
    timestamp: number;
  }>;
  onBatchZip?: () => void;
  onMergePdfs?: () => void;
  channelSessionId: string | null;
  peerIsPhone?: boolean;
};

function StandardFileList({
  files,
  onRemove,
}: {
  files: StagedFile[];
  onRemove?: (id: string) => void;
}) {
  return (
    <div className="ld-staged-queue mt-3">
      <div className="ld-staged-header">
        <span>Ready to send ({files.length})</span>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {files.map((sf) => (
          <div key={sf.id} className="ld-staged-card">
            <span
              className="text-xs font-medium truncate flex-1 min-w-0"
              title={sf.name}
              aria-label={sf.name}
            >
              {formatFilename(sf.name, 36)}
            </span>
            <span className="text-[11px] text-[var(--muted)] flex-shrink-0">{sf.sizeLabel}</span>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(sf.id)}
                className="text-[var(--muted)] hover:text-[var(--accent)] flex-shrink-0 min-h-[32px] min-w-[32px]"
                aria-label={`Remove ${sf.name}`}
              >
                ×
              </button>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

export default function LocalDrop(p: Props) {
  const [code, setCode] = useState('');
  const [qr, setQr] = useState(false);
  const [copied, setCopied] = useState(false);
  const [dark, setDark] = useState(() => {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  });
  const [drag, setDrag] = useState(false);
  const [tab, setTab] = useState<'files' | 'clipboard' | 'vault' | 'diagnostics'>('files');
  const [clip, setClip] = useState('');
  const [notice, setNotice] = useState('');
  const [showSettingsModal, setShowSettingsModal] = useState(false);
  const [recordingVoice, setRecordingVoice] = useState(false);
  const [voiceElapsed, setVoiceElapsed] = useState(0);
  const [saveHandles, setSaveHandles] = useState<Record<string, SaveFileHandle>>({});
  const [saveStates, setSaveStates] = useState<Record<string, { state: SaveState; filename: string }>>({});

  const getSaveHandle = (t: Transfer) => saveHandles[t.id] || null;
  const setSaveHandle = (t: Transfer, handle: SaveFileHandle) => {
    setSaveHandles((prev) => ({
      ...prev,
      [t.id]: handle,
    }));
  };
  const getSaveState = (t: Transfer) => saveStates[t.id];
  const setSaveStateRecord = (t: Transfer, state: SaveState, savedName: string) => {
    setSaveStates((prev) => ({
      ...prev,
      [t.id]: { state, filename: savedName },
    }));
  };

  const input = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const voiceTimerRef = useRef<number | null>(null);
  const reduced = useReducedMotion();

  const normalizedStaged = useMemo(() => normalizeFiles(p.stagedFiles), [p.stagedFiles]);
  const thumbnails = useSafeThumbnails(normalizedStaged);

  const stagedFilesForStack: StagedFile[] = useMemo(() => {
    return normalizedStaged.map((sf) => ({
      id: sf.id,
      name: sf.name,
      sizeLabel: formatBytes(sf.size),
      previewUrl: thumbnails[sf.id],
    }));
  }, [normalizedStaged, thumbnails]);

  const tCopy = getTransportCopy(p.connectionState, p.transport, p.wsConnected, p.pathKind);
  const eligiblePdfCount = useMemo(
    () =>
      p.sharedItems.filter(
        (i) =>
          i.kind === 'file' &&
          i.file &&
          (i.file.type === 'application/pdf' || i.file.name.toLowerCase().endsWith('.pdf'))
      ).length,
    [p.sharedItems]
  );
  const activeTransfers = useMemo(
    () => p.transfers.filter((t) => getActivityState(t) === 'active'),
    [p.transfers]
  );
  const historyTransfers = useMemo(
    () =>
      p.transfers.filter(
        (t) => getActivityState(t) !== 'active' && t.id !== 'active-telemetry'
      ),
    [p.transfers]
  );

  useEffect(() => {
    if (dark) {
      document.documentElement.classList.add('ld-dark');
    } else {
      document.documentElement.classList.remove('ld-dark');
    }
  }, [dark]);

  async function copy() {
    try {
      await navigator.clipboard.writeText(p.pin);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setNotice('Select the code to copy it manually.');
    }
  }

  // Voice recording handler
  const voiceStreamRef = useRef<MediaStream | null>(null);
  const voiceUnmountedRef = useRef(false);

  useEffect(() => {
    voiceUnmountedRef.current = false;
    return () => {
      voiceUnmountedRef.current = true;
      if (voiceTimerRef.current) {
        clearInterval(voiceTimerRef.current);
        voiceTimerRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        try {
          mediaRecorderRef.current.stop();
        } catch {
          // ignore
        }
      }
      if (voiceStreamRef.current) {
        voiceStreamRef.current.getTracks().forEach((track) => track.stop());
        voiceStreamRef.current = null;
      }
    };
  }, []);

  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      voiceStreamRef.current = stream;

      const candidates = [
        'audio/webm;codecs=opus',
        'audio/webm',
        'audio/mp4',
        'audio/ogg;codecs=opus',
      ];
      const supportedMime =
        typeof MediaRecorder.isTypeSupported === 'function'
          ? candidates.find((m) => MediaRecorder.isTypeSupported(m))
          : undefined;
      const recorder = supportedMime
        ? new MediaRecorder(stream, { mimeType: supportedMime })
        : new MediaRecorder(stream);

      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const actualMime =
          recorder.mimeType ||
          audioChunksRef.current[0]?.type ||
          supportedMime ||
          'audio/webm';
        const ext = actualMime.includes('mp4')
          ? 'm4a'
          : actualMime.includes('ogg')
          ? 'ogg'
          : 'webm';
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const audioBlob = new Blob(audioChunksRef.current, { type: actualMime });
        const voiceFile = new File([audioBlob], `Voice-memo-${stamp}.${ext}`, {
          type: actualMime,
        });
        stream.getTracks().forEach((track) => track.stop());
        if (voiceStreamRef.current === stream) {
          voiceStreamRef.current = null;
        }
        if (!voiceUnmountedRef.current && p.onVoiceNote && audioBlob.size > 0) {
          p.onVoiceNote(voiceFile);
        }
      };

      recorder.onerror = () => {
        stream.getTracks().forEach((track) => track.stop());
        if (voiceStreamRef.current === stream) {
          voiceStreamRef.current = null;
        }
        if (voiceTimerRef.current) {
          clearInterval(voiceTimerRef.current);
          voiceTimerRef.current = null;
        }
        setRecordingVoice(false);
        setNotice('Voice recording failed.');
      };

      recorder.start();
      setRecordingVoice(true);
      setVoiceElapsed(0);
      voiceTimerRef.current = window.setInterval(() => {
        setVoiceElapsed((v) => v + 1);
      }, 1000);
    } catch {
      if (voiceStreamRef.current) {
        voiceStreamRef.current.getTracks().forEach((track) => track.stop());
        voiceStreamRef.current = null;
      }
      setNotice('Microphone access denied or unavailable.');
    }
  };

  const stopVoiceRecording = () => {
    if (mediaRecorderRef.current && recordingVoice) {
      mediaRecorderRef.current.stop();
      setRecordingVoice(false);
      if (voiceTimerRef.current) {
        clearInterval(voiceTimerRef.current);
        voiceTimerRef.current = null;
      }
    }
  };

  const isReceiverMobile =
    p.device.toLowerCase().includes('phone') ||
    p.device.toLowerCase().includes('android') ||
    p.device.toLowerCase().includes('iphone');

  const popupOffer: IncomingTransferOffer | null = useMemo(() => {
    if (!p.incomingOffer) return null;
    return {
      id: p.incomingOffer.offerId,
      senderName: p.incomingOffer.fromName,
      filename: p.incomingOffer.name,
      size: p.incomingOffer.size,
      mime: p.incomingOffer.mime,
      senderDeviceType:
        p.incomingOffer.senderDeviceType || (p.peerIsPhone ? 'mobile' : 'desktop'),
      receiverDeviceType: isReceiverMobile ? 'mobile' : 'desktop',
    };
  }, [p.incomingOffer, p.peerIsPhone, isReceiverMobile]);

  return (
    <MotionConfig reducedMotion="user" transition={springs.smooth}>
      <div className={'ld ' + (dark ? 'ld-dark' : '')}>
        {/* AirDrop-Style Premium Animated Incoming Transfer Popup */}
        <IncomingTransferPopup
          offer={popupOffer}
          onAccept={(_, saveDirectly) => p.onAcceptOffer(saveDirectly)}
          canSaveDirectly={p.canSaveIncomingDirectly}
          onDecline={p.onDeclineOffer}
          receiverDeviceType={isReceiverMobile ? 'mobile' : 'desktop'}
        />

        {/* Persistent Magnetic Handshake Sequence with Error Boundary */}
        <MotionErrorBoundary name="Handshake">
          <Handshake
            connectionId={p.channelSessionId}
            peerName={p.peer || 'Connected Peer'}
            peerIsPhone={p.peerIsPhone}
            localIsPhone={isReceiverMobile}
            ready={
              !p.incomingOffer &&
              Boolean(p.peer) &&
              (p.connectionState === 'direct' ||
                (p.connectionState === 'relayed' && p.wsConnected))
            }
          />
        </MotionErrorBoundary>

        {/* Consolidated Responsive Header & Status Area */}
        <LocalDropHeader
          deviceName={p.device}
          peerName={p.peer}
          state={
            p.connectionState === 'direct' || (p.connectionState === 'relayed' && p.wsConnected)
              ? 'connected'
              : p.connectionState === 'waiting' && p.wsConnected
                ? 'ready'
                : p.connectionState === 'offline'
                  ? 'offline'
                  : 'connecting'
          }
          secure={p.transport === 'webrtc'}
          transportLabel={
            p.transport === 'webrtc'
              ? 'Direct WebRTC'
              : p.transport === 'websocket'
                ? 'WebSocket Relay'
                : 'WebRTC'
          }
          dark={dark}
          onToggleTheme={() => setDark(!dark)}
          onSettings={() => {
            if (p.onSettings) p.onSettings();
            setShowSettingsModal(true);
          }}
          onDisconnect={p.onDisconnect}
        />

        {/* Main Application Area */}
        <main id="localdrop" className="ld-main">
          <AnimatePresence mode="wait" initial={false}>
            {!p.peer ? (
              /* ================= DISCONNECTED PAIRING SCREEN ================= */
              <motion.section
                key="pair"
                className="ld-pair"
                initial={{ opacity: 0, y: reduced ? 0 : 18 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: reduced ? 0 : -12 }}
              >
                <div className="ld-intro">
                  <span className="ld-kicker">
                    <span className="ld-dot" /> Pair a device
                  </span>
                  <h1>
                    From here.
                    <br />
                    <em>To there.</em>
                  </h1>
                  <p>Share files and text with another device.</p>
                </div>

                {/* Pairing Ticket */}
                <div className="ld-ticket">
                  {/* Signature Device Illustration */}
                  <div className="ld-art" aria-hidden="true">
                    <motion.div
                      className="ld-machine"
                      initial={{ rotate: -12, y: 8 }}
                      animate={{ rotate: -8, y: 0 }}
                      transition={springs.fluid}
                    >
                      <Laptop size={72} strokeWidth={1.25} />
                    </motion.div>

                    <motion.div
                      className="ld-orbit"
                      animate={reduced ? {} : { x: [0, 22, 0] }}
                      transition={{ duration: 2.8, repeat: Infinity, ease: 'easeInOut' }}
                    >
                      <ArrowUpRight size={22} />
                    </motion.div>

                    <motion.div
                      className="ld-phone"
                      initial={{ rotate: 15 }}
                      animate={{ rotate: 9 }}
                      transition={springs.fluid}
                    >
                      <Smartphone size={58} strokeWidth={1.4} />
                    </motion.div>
                  </div>

                  {/* Ticket Details */}
                  <div className="ld-ticket-body">
                    <div className="ld-label">Your pairing code</div>
                    <div className="ld-pin pairing-code">{p.pin}</div>

                    <div className="ld-actions">
                      <button type="button" onClick={copy}>
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                        {copied ? 'Copied' : 'Copy code'}
                      </button>

                      <button
                        type="button"
                        onClick={() => setQr(!qr)}
                        aria-expanded={qr}
                      >
                        <QrCode size={16} />
                        {qr ? 'Hide QR' : 'Show QR'}
                      </button>
                    </div>

                    {/* Offline Vector QR Code Expansion */}
                    <AnimatePresence>
                      {qr && (
                        <motion.div
                          initial={{ height: 0, opacity: 0 }}
                          animate={{ height: 'auto', opacity: 1 }}
                          exit={{ height: 0, opacity: 0 }}
                          transition={springs.responsive}
                          style={{ overflow: 'hidden' }}
                        >
                          <div className="ld-qr-card">
                            <QRCodeSVG
                              value={p.pairingUrl}
                              size={150}
                              level="M"
                              bgColor="#ffffff"
                              fgColor="#252723"
                            />
                            <span className="text-[11px] text-[var(--muted)] mt-2">
                              Scan with your camera to pair
                            </span>
                          </div>
                        </motion.div>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Connect Form */}
                <form
                  className="ld-connect"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (/^\d{4}$/.test(code) && p.wsConnected) p.onConnect(code);
                  }}
                >
                  <label htmlFor="ld-code">Enter the other device’s code</label>
                  <div className="ld-inputrow">
                    <input
                      id="ld-code"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder={p.wsConnected ? '0000' : 'Connecting to server…'}
                      maxLength={4}
                      value={code}
                      disabled={!p.wsConnected}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    />
                    <motion.button
                      className="ld-primary"
                      whileTap={{ scale: 0.96 }}
                      disabled={code.length !== 4 || p.connecting || !p.wsConnected}
                    >
                      {p.connecting
                        ? 'Connecting…'
                        : !p.wsConnected
                          ? 'Connecting to server…'
                          : 'Connect'}
                      <ArrowUpRight size={19} />
                    </motion.button>
                  </div>
                </form>
              </motion.section>
            ) : (
              /* ================= CONNECTED WORKSPACE ================= */
              <motion.section
                key="connected"
                initial={{ opacity: 0, y: reduced ? 0 : 14 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0 }}
                className="ld-work"
              >
                {/* Peer Header */}
                <div className="ld-peer ldv-peer">
                  <div>
                    <span className="ld-kicker">
                      <span className="ld-dot" /> {tCopy.peerLabel}
                    </span>
                    <h1>{p.peer}</h1>
                  </div>

                  <button type="button" className="ld-quiet" onClick={p.onDisconnect}>
                    Disconnect
                  </button>
                </div>

                {/* Segmented Navigation (Shared-Layout Indicator) */}
                <nav
                  className="segmented-navigation"
                  role="tablist"
                  aria-label="Sharing mode"
                >
                  {[
                    { id: 'files', label: 'Files', icon: Send },
                    { id: 'clipboard', label: 'Clipboard', icon: Clipboard },
                    { id: 'vault', label: 'Vault', icon: History },
                    { id: 'diagnostics', label: 'Diagnostics', icon: FileSliders },
                  ].map((t) => (
                    <button
                      key={t.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === t.id}
                      onClick={() => setTab(t.id as any)}
                      className="segment"
                    >
                      {tab === t.id && (
                        <motion.span
                          layoutId="ld-tab"
                          className="segment-indicator"
                          transition={springs.smooth}
                        />
                      )}
                      <span className="segment-content">
                        <t.icon size={16} strokeWidth={1.8} />
                        {t.label}
                      </span>
                    </button>
                  ))}
                </nav>

                {/* Tab 1: Files */}
                <AnimatePresence mode="wait" initial={false}>
                  {tab === 'files' && (
                    <motion.div
                      key="files-tab"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                    >
                      {/* Drag & Drop Target */}
                      <div
                        className={'ld-drop ldv-drop ' + (drag ? 'ld-drag' : '')}
                        onDragOver={(e) => {
                          e.preventDefault();
                          setDrag(true);
                        }}
                        onDragLeave={() => setDrag(false)}
                        onDrop={(e) => {
                          e.preventDefault();
                          setDrag(false);
                          p.onFiles(Array.from(e.dataTransfer.files));
                        }}
                      >
                        <motion.div
                          className="ld-plus"
                          animate={{ scale: drag ? 1.15 : 1, rotate: drag ? 90 : 0 }}
                          transition={springs.responsive}
                        >
                          <Plus size={34} />
                        </motion.div>

                        <h2>
                          <span className="ldv-desktop-title">
                            {drag ? 'Release to add files' : 'Drop it here.'}
                          </span>
                          <span className="ldv-touch-title">
                            {drag ? 'Release to add files' : 'Send files'}
                          </span>
                        </h2>
                        <p>{tCopy.dropSubtitle}</p>

                        <div className="ld-actions">
                          <motion.button
                            type="button"
                            whileTap={{ scale: 0.96 }}
                            className="ld-primary"
                            onClick={() => input.current?.click()}
                          >
                            Choose files <ArrowUpRight size={18} />
                          </motion.button>

                          {p.onFolder && (
                            <button type="button" onClick={p.onFolder}>
                              <Folder size={17} /> Folder
                            </button>
                          )}

                          {/* Voice Note Button */}
                          {p.onVoiceNote && (
                            <button
                              type="button"
                              onClick={recordingVoice ? stopVoiceRecording : startVoiceRecording}
                              className={`transition ${recordingVoice ? 'bg-[var(--accent)] text-white border-transparent' : ''}`}
                            >
                              {recordingVoice ? (
                                <>
                                  <Square size={16} className="fill-current" />
                                  <span>{voiceElapsed}s Stop</span>
                                </>
                              ) : (
                                <>
                                  <Mic size={17} />
                                  <span>Voice note</span>
                                </>
                              )}
                            </button>
                          )}
                        </div>

                        {/* Hidden Native Inputs */}
                        <input
                          ref={input}
                          type="file"
                          multiple
                          hidden
                          onChange={(e) => {
                            p.onFiles(Array.from(e.target.files ?? []));
                            e.target.value = '';
                          }}
                        />
                        <input
                          ref={folderInput}
                          type="file"
                          // @ts-expect-error webkitdirectory is standard for folder picking
                          webkitdirectory=""
                          directory=""
                          multiple
                          hidden
                          onChange={(e) => {
                            p.onFiles(Array.from(e.target.files ?? []));
                            e.target.value = '';
                          }}
                        />
                      </div>

                      {/* Elastic File Stack */}
                      {p.stagedFiles.length > 0 && (
                        <div className="mt-4">
                          <MotionErrorBoundary
                            name="FileStack"
                            fallback={
                              <StandardFileList
                                files={stagedFilesForStack}
                                onRemove={p.onRemoveStaged}
                              />
                            }
                          >
                            <FileStack
                              files={stagedFilesForStack}
                              onRemove={(id) => p.onRemoveStaged?.(id)}
                            />
                          </MotionErrorBoundary>
                          <div className="flex items-center justify-between mt-3 px-1">
                            {p.onClearStaged && (
                              <button
                                type="button"
                                onClick={p.onClearStaged}
                                className="text-xs text-[var(--muted)] hover:text-[var(--accent)] font-medium transition"
                              >
                                Clear all
                              </button>
                            )}
                            {p.onSendStaged && (
                              <motion.button
                                whileTap={{ scale: 0.96 }}
                                type="button"
                                onClick={p.onSendStaged}
                                className="ld-primary text-xs !py-2 !px-4"
                              >
                                Send all ({p.stagedFiles.length}) <ArrowUpRight size={15} />
                              </motion.button>
                            )}
                          </div>
                        </div>
                      )}
                    </motion.div>
                  )}

                  {/* Tab 2: Universal Clipboard */}
                  {tab === 'clipboard' && (
                    <motion.form
                      key="clipboard-tab"
                      className="ld-clip ldv-clipboard"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      onSubmit={(e) => {
                        e.preventDefault();
                        if (clip.trim()) {
                          p.onClipboard(clip);
                          setClip('');
                        }
                      }}
                    >
                      <label htmlFor="ld-clip">Share text or a link with {p.peer}</label>
                      <textarea
                        id="ld-clip"
                        placeholder="Paste text or a link…"
                        value={clip}
                        onChange={(e) => setClip(e.target.value)}
                      />
                      <button type="submit" className="ld-primary" disabled={!clip.trim()}>
                        <Clipboard size={17} /> Send text
                      </button>
                    </motion.form>
                  )}

                  {/* Tab 3: Session Vault */}
                  {tab === 'vault' && (
                    <motion.div
                      key="vault-tab"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="bg-[var(--surface)] border border-[var(--line)] rounded-3xl p-6 ldv-vault"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                        <div>
                          <h3 className="font-bold text-lg">Session Vault</h3>
                          <p className="text-xs text-[var(--muted)]">
                            Shared in this session ({p.sharedItems.length})
                          </p>
                        </div>

                        <div className="flex items-center gap-2 ldv-vault-actions">
                          {p.onBatchZip && p.sharedItems.length > 0 && (
                            <button
                              type="button"
                              onClick={p.onBatchZip}
                              className="px-3 py-1.5 text-xs font-semibold rounded-xl border border-[var(--line)] hover:bg-[var(--line)] flex items-center gap-1.5 transition"
                            >
                              <FileArchive size={14} /> Export ZIP
                            </button>
                          )}
                          {p.onMergePdfs && (
                            <button
                              type="button"
                              disabled={eligiblePdfCount < 2}
                              title={
                                eligiblePdfCount < 2
                                  ? 'Requires at least 2 PDF files in this session'
                                  : 'Merge session PDFs'
                              }
                              onClick={p.onMergePdfs}
                              className="px-3 py-1.5 text-xs font-semibold rounded-xl border border-[var(--line)] hover:bg-[var(--line)] flex items-center gap-1.5 transition"
                            >
                              <FileText size={14} /> Merge PDFs
                            </button>
                          )}
                        </div>
                      </div>

                      <div className="ld-list">
                        {p.sharedItems.map((item) => (
                          <div key={item.id} className="ld-row">
                            <span className="ld-fileicon">
                              {item.direction === 'sent' ? <ArrowUpRight /> : <ArrowDownLeft />}
                            </span>
                            <div className="ld-file">
                              <strong
                                className="ld-filename"
                                title={item.kind === 'file' ? item.file?.name : item.text}
                                aria-label={item.kind === 'file' ? item.file?.name : item.text}
                              >
                                {item.kind === 'file'
                                  ? formatFilename(item.file?.name || '', 40)
                                  : item.text?.slice(0, 40)}
                              </strong>
                              <small>
                                {item.direction === 'sent' ? 'Sent' : 'Received'} ·{' '}
                                {new Date(item.timestamp).toLocaleTimeString()}
                              </small>
                            </div>

                            {item.kind === 'file' && item.file && (
                              <button
                                type="button"
                                onClick={() => downloadReceivedFile(item.file!)}
                                className="p-2 rounded-xl border border-[var(--line)] hover:bg-[var(--line)] text-inherit"
                                aria-label="Download file"
                              >
                                <Download size={15} />
                              </button>
                            )}
                          </div>
                        ))}

                        {p.sharedItems.length === 0 && (
                          <p className="ld-empty text-center py-8">
                            No files or text exchanged in this session yet.
                          </p>
                        )}
                      </div>
                    </motion.div>
                  )}

                  {/* Tab 4: Diagnostics */}
                  {tab === 'diagnostics' && (
                    <motion.div
                      key="diagnostics-tab"
                      initial={{ opacity: 0, y: 8 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -8 }}
                      className="bg-[var(--surface)] border border-[var(--line)] rounded-3xl p-6"
                    >
                      <h3 className="font-bold text-lg mb-2">Network Diagnostics</h3>
                      <p className="text-xs text-[var(--muted)] mb-5">
                        Connection and transfer details
                      </p>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                        <div className="p-4 rounded-2xl bg-[var(--paper)] border border-[var(--line)]">
                          <span className="text-[var(--muted)] block mb-1">Active transport</span>
                          <strong className="text-sm font-semibold">
                            {tCopy.diagnosticsLabel}
                          </strong>
                        </div>

                        <div className="p-4 rounded-2xl bg-[var(--paper)] border border-[var(--line)]">
                          <span className="text-[var(--muted)] block mb-1">Transport security</span>
                          <strong className="text-sm font-semibold">{tCopy.securityLabel}</strong>
                        </div>

                        <div className="p-4 rounded-2xl bg-[var(--paper)] border border-[var(--line)]">
                          <span className="text-[var(--muted)] block mb-1">Auto-accept files</span>
                          <div className="flex items-center justify-between mt-1">
                            <span className="font-semibold">
                              {p.autoAccept ? 'Enabled' : 'Ask before accepting'}
                            </span>
                            <button
                              type="button"
                              onClick={p.onToggleAutoAccept}
                              className="px-2.5 py-1 text-xs font-semibold rounded-lg border border-[var(--line)] hover:bg-[var(--line)]"
                            >
                              Toggle
                            </button>
                          </div>
                        </div>

                        <div className="p-4 rounded-2xl bg-[var(--paper)] border border-[var(--line)]">
                          <span className="text-[var(--muted)] block mb-1">Paired device</span>
                          <strong className="text-sm font-semibold">{p.peer || 'None'}</strong>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Activity Feed */}
                {tab === 'files' ? (
                  <>
                    <h2 className="ld-activity ldv-activity-heading">
                      Activity <span>{p.transfers.length}</span>
                    </h2>

                    {/* Signature Packet Departure (Send) & Packet Assembly (Receive) for active transfers only */}
                    <AnimatePresence initial={false}>
                      {activeTransfers.slice(0, 3).map((t, index) => (
                        <motion.div
                          key={t.id}
                          layout
                          initial={{ opacity: 0, height: 0 }}
                          animate={{ opacity: 1, height: 'auto' }}
                          exit={{ opacity: 0, height: 0 }}
                          transition={reduced ? { duration: 0 } : { duration: 0.25 }}
                          style={{ overflow: 'hidden' }}
                        >
                          <MotionErrorBoundary name="TransferMotion">
                            <TransferMotion
                              transfer={{
                                id: t.id,
                                name: t.name,
                                direction: t.direction,
                                progress: t.progress,
                                status: 'active',
                                speedLabel: t.status,
                                awaitingApproval: t.awaitingApproval,
                                paused: t.paused,
                              }}
                              localIsPhone={isReceiverMobile}
                              peerIsPhone={p.peerIsPhone}
                              animatePackets={index === 0}
                              onCancel={p.onCancel ? () => p.onCancel?.(t.id) : undefined}
                            >
                              {t.direction === 'receive' && (
                                <ReceivedFileSave
                                  key={t.id}
                                  filename={t.name}
                                  file={t.file ?? null}
                                  receiving={t.progress < 100}
                                  transferFailed={false}
                                  initialHandle={getSaveHandle(t)}
                                  initialState={getSaveState(t)?.state}
                                  initialSavedName={getSaveState(t)?.filename}
                                  onHandleSelected={(handle) => setSaveHandle(t, handle)}
                                  onSaveStateChange={(state, name) => setSaveStateRecord(t, state, name)}
                                />
                              )}
                            </TransferMotion>
                          </MotionErrorBoundary>
                        </motion.div>
                      ))}
                    </AnimatePresence>

                    <div className="ld-list mt-3">
                      {historyTransfers.map((t) => {
                        const rowState = getActivityState(t);
                        return (
                          <ActivityRow
                            key={t.id}
                            name={t.name}
                            size={t.size}
                            direction={t.direction}
                            state={rowState}
                            progress={t.progress}
                            detail={rowState === 'active' ? t.status : undefined}
                            onCancel={p.onCancel ? () => p.onCancel?.(t.id) : undefined}
                            saveControl={
                              t.direction === 'receive' && rowState === 'complete' ? (
                                <ReceivedFileSave
                                  key={t.id}
                                  filename={t.name}
                                  file={t.file ?? null}
                                  receiving={t.progress < 100}
                                  transferFailed={false}
                                  initialHandle={getSaveHandle(t)}
                                  initialState={getSaveState(t)?.state}
                                  initialSavedName={getSaveState(t)?.filename}
                                  onHandleSelected={(handle) => setSaveHandle(t, handle)}
                                  onSaveStateChange={(state, name) =>
                                    setSaveStateRecord(t, state, name)
                                  }
                                />
                              ) : undefined
                            }
                          />
                        );
                      })}

                      {!p.transfers.length && (
                        <p className="ld-empty">Files you exchange will appear here.</p>
                      )}
                    </div>
                  </>
                ) : (
                  activeTransfers.length > 0 && (
                    <div className="mt-4 p-3 rounded-2xl border border-[var(--line)] bg-[var(--surface)] flex items-center justify-between gap-3">
                      <span className="text-xs font-medium text-[var(--ink)] truncate">
                        {activeTransfers.length} active{' '}
                        {activeTransfers.length === 1 ? 'transfer' : 'transfers'} ({activeTransfers[0].name})
                      </span>
                      <button
                        type="button"
                        onClick={() => setTab('files')}
                        className="text-xs font-semibold text-[var(--accent)] flex-shrink-0 min-h-[44px] px-2"
                      >
                        View in Files
                      </button>
                    </div>
                  )
                )}
              </motion.section>
            )}
          </AnimatePresence>

          <p role="status" className="ld-notice">
            {p.error || notice}
          </p>
        </main>

        {/* Global Settings & Shortcuts Modal */}
        <AnimatePresence>
          {showSettingsModal && (
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="ld-modal-overlay"
              onClick={() => setShowSettingsModal(false)}
            >
              <motion.div
                initial={{ scale: 0.94, opacity: 0, y: 12 }}
                animate={{ scale: 1, opacity: 1, y: 0 }}
                exit={{ scale: 0.94, opacity: 0, y: 12 }}
                transition={springs.smooth}
                className="ld-modal"
                onClick={(e) => e.stopPropagation()}
              >
                <div className="flex items-center justify-between mb-4">
                  <h3 className="ld-modal-title !mb-0">Settings & Info</h3>
                  <button
                    type="button"
                    className="ld-icon"
                    onClick={() => setShowSettingsModal(false)}
                    aria-label="Close modal"
                  >
                    <X />
                  </button>
                </div>

                <div className="space-y-4 text-sm text-[var(--ink)]">
                  <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--paper)] border border-[var(--line)]">
                    <div>
                      <div className="font-semibold">Auto-Accept Transfers</div>
                      <div className="text-xs text-[var(--muted)]">
                        Instantly receive incoming files without prompt
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={p.onToggleAutoAccept}
                      className="px-3 py-1.5 rounded-lg border border-[var(--line)] text-xs font-semibold hover:bg-[var(--surface)]"
                    >
                      {p.autoAccept ? 'Enabled' : 'Disabled'}
                    </button>
                  </div>

                  <div className="flex items-center justify-between p-3 rounded-xl bg-[var(--paper)] border border-[var(--line)]">
                    <div>
                      <div className="font-semibold">Visual Theme</div>
                      <div className="text-xs text-[var(--muted)]">
                        Switch between light and midnight forest
                      </div>
                    </div>
                    <button
                      type="button"
                      onClick={() => setDark(!dark)}
                      className="px-3 py-1.5 rounded-lg border border-[var(--line)] text-xs font-semibold hover:bg-[var(--surface)] flex items-center gap-1.5"
                    >
                      {dark ? <Sun size={14} /> : <Moon size={14} />}
                      {dark ? 'Light' : 'Dark'}
                    </button>
                  </div>

                  <div className="p-3 rounded-xl bg-[var(--paper)] border border-[var(--line)]">
                    <div className="font-semibold mb-1">Keyboard Shortcuts</div>
                    <ul className="text-xs space-y-1 text-[var(--muted)]">
                      <li>
                        <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface)] border border-[var(--line)] font-mono">
                          Esc
                        </kbd>{' '}
                        Close modals
                      </li>
                      <li>
                        <kbd className="px-1.5 py-0.5 rounded bg-[var(--surface)] border border-[var(--line)] font-mono">
                          ⌘/Ctrl + U
                        </kbd>{' '}
                        Select files
                      </li>
                    </ul>
                  </div>
                </div>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Footer */}
        <LocalDropFooter />
      </div>
    </MotionConfig>
  );
}
