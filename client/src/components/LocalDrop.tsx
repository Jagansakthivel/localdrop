import { useState, useRef, useEffect, useMemo } from 'react';
import { motion, AnimatePresence, MotionConfig, useReducedMotion } from 'motion/react';
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
import { springs } from '../motion-presets';
import { LocalDropHeader, LocalDropFooter } from './LocalDropChrome';
import { Handshake, FileStack, TransferMotion, type StagedFile } from './LocalDropMotion';
import { MotionErrorBoundary } from './MotionErrorBoundary';
import { normalizeFiles, useSafeThumbnails, formatBytes, type NormalizedFile } from '../utils/fileAdapter';
import '../localdrop.css';

export type Transfer = {
  id: string;
  name: string;
  size: string;
  progress: number;
  direction: 'send' | 'receive';
  status: string;
};

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
    fromName: string;
  } | null;
  onAcceptOffer: () => void;
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
        <span>Ready to dispatch ({files.length})</span>
      </div>
      <div className="max-h-48 overflow-y-auto">
        {files.map((sf) => (
          <div key={sf.id} className="ld-staged-card">
            <span className="text-xs font-medium truncate max-w-[200px]">{sf.name}</span>
            <span className="text-[11px] text-[var(--muted)]">{sf.sizeLabel}</span>
            {onRemove && (
              <button
                type="button"
                onClick={() => onRemove(sf.id)}
                className="text-[var(--muted)] hover:text-[var(--accent)]"
                aria-label="Remove file"
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
  const startVoiceRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = () => {
        const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
        const voiceFile = new File([audioBlob], `Voice-memo-${new Date().toLocaleTimeString().replace(/:/g, '-')}.webm`, {
          type: 'audio/webm',
        });
        if (p.onVoiceNote) p.onVoiceNote(voiceFile);
        stream.getTracks().forEach((track) => track.stop());
      };

      recorder.start();
      setRecordingVoice(true);
      setVoiceElapsed(0);
      voiceTimerRef.current = window.setInterval(() => {
        setVoiceElapsed((v) => v + 1);
      }, 1000);
    } catch {
      setNotice('Microphone access denied or unavailable.');
    }
  };

  const stopVoiceRecording = () => {
    if (mediaRecorderRef.current && recordingVoice) {
      mediaRecorderRef.current.stop();
      setRecordingVoice(false);
      if (voiceTimerRef.current) clearInterval(voiceTimerRef.current);
    }
  };

  return (
    <MotionConfig reducedMotion="user" transition={springs.smooth}>
      <div className={'ld ' + (dark ? 'ld-dark' : '')}>
        {/* Persistent Magnetic Handshake Sequence with Error Boundary */}
        <MotionErrorBoundary name="Handshake">
          <Handshake
            connectionId={p.channelSessionId}
            peerName={p.peer || 'Connected Peer'}
            peerIsPhone={p.peerIsPhone}
          />
        </MotionErrorBoundary>

        {/* Consolidated Responsive Header & Status Area */}
        <LocalDropHeader
          deviceName={p.device}
          peerName={p.peer}
          state={p.peer ? 'connected' : p.connecting ? 'connecting' : 'offline'}
          secure={Boolean(p.peer && p.wsConnected)}
          transportLabel="WebRTC"
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
          {/* Incoming Transfer Authorization Banner */}
          <AnimatePresence>
            {p.incomingOffer && (
              <motion.div
                initial={{ opacity: 0, y: -20, scale: 0.96 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: -10, scale: 0.96 }}
                className="mb-6 p-5 rounded-2xl bg-[var(--surface)] border-2 border-[var(--accent)] shadow-xl flex flex-col sm:flex-row items-center justify-between gap-4"
              >
                <div>
                  <div className="text-xs font-bold text-[var(--accent)] uppercase tracking-wider mb-1">
                    Incoming Transfer Request
                  </div>
                  <div className="text-sm font-semibold text-[var(--ink)]">
                    {p.incomingOffer.fromName} wants to send{' '}
                    <span className="underline">{p.incomingOffer.name}</span> (
                    {formatBytes(p.incomingOffer.size)})
                  </div>
                </div>

                <div className="flex items-center gap-3 w-full sm:w-auto">
                  <button
                    type="button"
                    onClick={p.onDeclineOffer}
                    className="flex-1 sm:flex-none px-4 py-2 text-xs font-semibold rounded-xl border border-[var(--line)] hover:bg-[var(--line)] transition"
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    onClick={p.onAcceptOffer}
                    className="flex-1 sm:flex-none px-4 py-2 text-xs font-semibold rounded-xl bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition"
                  >
                    Accept Transfer
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

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
                    <span className="ld-dot" /> DEVICE PAIRING
                  </span>
                  <h1>
                    From here.
                    <br />
                    <em>To there.</em>
                  </h1>
                  <p>Connect another device to send files and share your clipboard.</p>
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
                      <button onClick={copy}>
                        {copied ? <Check size={16} /> : <Copy size={16} />}
                        {copied ? 'Copied' : 'Copy code'}
                      </button>

                      <button
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
                              Scan with phone camera to connect
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
                    if (/^\d{4}$/.test(code)) p.onConnect(code);
                  }}
                >
                  <label htmlFor="ld-code">Have a code from another device?</label>
                  <div className="ld-inputrow">
                    <input
                      id="ld-code"
                      inputMode="numeric"
                      autoComplete="off"
                      placeholder="0000"
                      maxLength={4}
                      value={code}
                      onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
                    />
                    <motion.button
                      className="ld-primary"
                      whileTap={{ scale: 0.96 }}
                      disabled={code.length !== 4 || p.connecting}
                    >
                      {p.connecting ? 'Connecting…' : 'Connect'}
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
                <div className="ld-peer">
                  <div>
                    <span className="ld-kicker">
                      <span className="ld-dot" /> CONNECTED
                    </span>
                    <h1>{p.peer}</h1>
                  </div>

                  <button className="ld-quiet" onClick={p.onDisconnect}>
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
                        className={'ld-drop ' + (drag ? 'ld-drag' : '')}
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

                        <h2>{drag ? 'Release to send' : 'Drop it here.'}</h2>
                        <p>Send files directly to your connected device.</p>

                        <div className="ld-actions">
                          <motion.button
                            whileTap={{ scale: 0.96 }}
                            className="ld-primary"
                            onClick={() => input.current?.click()}
                          >
                            Choose files <ArrowUpRight size={18} />
                          </motion.button>

                          {p.onFolder && (
                            <button onClick={p.onFolder}>
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
                                  <span>Voice Note</span>
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
                                Send All ({p.stagedFiles.length}) <ArrowUpRight size={15} />
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
                      className="ld-clip"
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
                        placeholder="Paste URLs, code, or markdown to beam immediately..."
                        value={clip}
                        onChange={(e) => setClip(e.target.value)}
                      />
                      <button className="ld-primary" disabled={!clip.trim()}>
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
                      className="bg-[var(--surface)] border border-[var(--line)] rounded-3xl p-6"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-4 mb-4">
                        <div>
                          <h3 className="font-bold text-lg">Session Vault</h3>
                          <p className="text-xs text-[var(--muted)]">
                            All items exchanged during this session ({p.sharedItems.length})
                          </p>
                        </div>

                        <div className="flex items-center gap-2">
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
                              <strong>
                                {item.kind === 'file' ? item.file?.name : item.text?.slice(0, 40)}
                              </strong>
                              <small>
                                {item.direction === 'sent' ? 'Sent' : 'Received'} ·{' '}
                                {new Date(item.timestamp).toLocaleTimeString()}
                              </small>
                            </div>

                            {item.kind === 'file' && item.file && (
                              <a
                                href={URL.createObjectURL(item.file)}
                                download={item.file.name}
                                className="p-2 rounded-xl border border-[var(--line)] hover:bg-[var(--line)] text-inherit"
                                aria-label="Download file"
                              >
                                <Download size={15} />
                              </a>
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
                        Real-time WebRTC telemetry and channel metrics
                      </p>

                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 text-xs">
                        <div className="p-4 rounded-2xl bg-[var(--paper)] border border-[var(--line)]">
                          <span className="text-[var(--muted)] block mb-1">Signaling Transport</span>
                          <strong className="text-sm font-semibold">
                            {p.wsConnected ? 'Connected (ws://8080)' : 'Offline / Reconnecting'}
                          </strong>
                        </div>

                        <div className="p-4 rounded-2xl bg-[var(--paper)] border border-[var(--line)]">
                          <span className="text-[var(--muted)] block mb-1">Data Channel Security</span>
                          <strong className="text-sm font-semibold">DTLS-SRTP 256-bit GCM</strong>
                        </div>

                        <div className="p-4 rounded-2xl bg-[var(--paper)] border border-[var(--line)]">
                          <span className="text-[var(--muted)] block mb-1">Transfer Auto-Accept</span>
                          <div className="flex items-center justify-between mt-1">
                            <span className="font-semibold">
                              {p.autoAccept ? 'Enabled (Instant)' : 'Manual Prompt'}
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
                          <span className="text-[var(--muted)] block mb-1">Peer Node</span>
                          <strong className="text-sm font-semibold">{p.peer || 'None'}</strong>
                        </div>
                      </div>
                    </motion.div>
                  )}
                </AnimatePresence>

                {/* Activity Feed */}
                <h2 className="ld-activity">
                  Activity <span>{p.transfers.length}</span>
                </h2>

                {/* Signature Packet Departure (Send) & Packet Assembly (Receive) for active & recent transfers */}
                {(() => {
                  const active = p.transfers.filter(
                    (t) => t.progress < 100 || t.id === 'active-telemetry'
                  );
                  const displayTargets = active.length > 0 ? active.slice(0, 3) : p.transfers.slice(0, 1);
                  return displayTargets.map((t) => (
                    <MotionErrorBoundary key={t.id} name="TransferMotion">
                      <TransferMotion
                        transfer={{
                          id: t.id,
                          name: t.name,
                          direction: t.direction,
                          progress: t.progress,
                          status: t.progress >= 100 ? 'complete' : 'active',
                          speedLabel: t.status,
                        }}
                      />
                    </MotionErrorBoundary>
                  ));
                })()}

                <div className="ld-list mt-3">
                  <AnimatePresence initial={false}>
                    {p.transfers
                      .filter((t, idx) =>
                        p.transfers.some((item) => item.progress < 100 || item.id === 'active-telemetry')
                          ? t.progress >= 100 && t.id !== 'active-telemetry'
                          : idx > 0
                      )
                      .map((t) => (
                        <motion.div
                          layout
                          key={t.id}
                          initial={{ opacity: 0, y: 8 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          transition={springs.responsive}
                          className="ld-row"
                        >
                          <span className="ld-fileicon">
                            {t.direction === 'send' ? <ArrowUpRight /> : <ArrowDownLeft />}
                          </span>

                          <div className="ld-file">
                            <strong>{t.name}</strong>
                            <small>
                              {t.size} · {t.status}
                            </small>
                            <div
                              className="ld-progress"
                              role="progressbar"
                              aria-label={t.name}
                              aria-valuenow={Math.max(0, Math.min(100, t.progress))}
                            >
                              <motion.i
                                animate={{
                                  width: `${Math.max(0, Math.min(100, t.progress))}%`,
                                }}
                                transition={{ ease: 'easeOut', duration: 0.2 }}
                              />
                            </div>
                          </div>

                          {p.onCancel && t.progress < 100 && (
                            <button
                              className="ld-icon"
                              aria-label={'Cancel ' + t.name}
                              onClick={() => p.onCancel?.(t.id)}
                            >
                              <X />
                            </button>
                          )}
                        </motion.div>
                      ))}
                  </AnimatePresence>

                  {!p.transfers.length && (
                    <p className="ld-empty">Files you exchange will appear here.</p>
                  )}
                </div>
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
