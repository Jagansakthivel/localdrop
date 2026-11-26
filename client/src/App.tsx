import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import JSZip from 'jszip';
import { PDFDocument } from 'pdf-lib';
import { Toaster, toast } from 'sonner';
import { usePeerDrop } from './hooks/usePeerDrop';
import LocalDrop, { type Transfer, type StagedItem } from './components/LocalDrop';
import { normalizeFiles, formatBytes } from './utils/fileAdapter';
import { resolveWebSocketUrl } from './utils/network';
import './localdrop.css';

const WS_URL = resolveWebSocketUrl();

export default function App() {
  const {
    wsConnected,
    connectionState,
    transport,
    connectedPeer,
    localDeviceName,
    pin,
    autoAccept,
    setAutoAccept,
    sharedItems,
    telemetry,
    incomingOffer,
    statusText,
    lastError,
    connectWithPin,
    disconnect,
    sendTextOrLink,
    sendFile,
    acceptIncomingFile,
    declineIncomingFile,
    cancelTransfer,
  } = usePeerDrop(WS_URL);

  const [stagedFiles, setStagedFiles] = useState<StagedItem[]>([]);
  const [isSendingBatch, setIsSendingBatch] = useState(false);
  const [channelSessionId, setChannelSessionId] = useState<string | null>(null);
  const lastPeerIdRef = useRef<string | null>(null);
  const autoPairAttemptedRef = useRef<string | null>(null);

  useEffect(() => {
    if (connectedPeer) {
      if (lastPeerIdRef.current !== connectedPeer.id) {
        lastPeerIdRef.current = connectedPeer.id;
        setChannelSessionId(connectedPeer.id || crypto.randomUUID());
      }
    } else if (connectionState === 'waiting' || connectionState === 'offline' || connectionState === 'failed') {
      lastPeerIdRef.current = null;
      setChannelSessionId(null);
    }
  }, [connectedPeer, connectionState]);

  // Safe Auto-connect from URL ?pin=XXXX (waits until WebSocket signaling is ready)
  useEffect(() => {
    if (!wsConnected || connectedPeer) return;

    const params = new URLSearchParams(window.location.search);
    const urlPin = params.get('pin');
    if (!urlPin || !/^\d{4}$/.test(urlPin)) return;
    if (autoPairAttemptedRef.current === urlPin) return;

    autoPairAttemptedRef.current = urlPin;
    connectWithPin(urlPin);
  }, [wsConnected, connectedPeer, connectWithPin]);

  const pairingUrl = useMemo(() => {
    const publicUrl = import.meta.env.VITE_PUBLIC_APP_URL?.replace(/\/+$/, '');
    const base = publicUrl || `${window.location.protocol}//${window.location.host}`;
    return `${base}/?pin=${pin}`;
  }, [pin]);

  // Add files to staging with defensive normalization
  const handleFiles = useCallback((incoming: unknown) => {
    const normalized = normalizeFiles(incoming);
    if (!normalized.length) return;
    setStagedFiles((prev) => [...prev, ...normalized]);
    toast.success(`Staged ${normalized.length} ${normalized.length === 1 ? 'file' : 'files'}`);
  }, []);

  // Send all staged files sequentially with real acknowledgement verification
  const handleSendStaged = async () => {
    if (!connectedPeer || stagedFiles.length === 0 || isSendingBatch) return;
    setIsSendingBatch(true);
    const queue = [...stagedFiles];

    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      try {
        const success = await sendFile(item.file);
        if (!success) {
          toast.error(`Transfer cancelled or declined: ${item.name}`);
          break;
        }
        setStagedFiles((prev) => prev.filter((sf) => sf.id !== item.id));
      } catch (err) {
        console.error('Failed sending staged file:', err);
        toast.error(`Error sending ${item.name}`);
        break;
      }
    }
    setIsSendingBatch(false);
  };

  // Folder zip and stage
  const handleFolderSelect = async () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.setAttribute('webkitdirectory', '');
    input.setAttribute('directory', '');
    input.multiple = true;

    input.onchange = async () => {
      const fileList = input.files;
      if (!fileList || fileList.length === 0) return;

      toast.info('Compressing directory into ZIP archive...');
      const zip = new JSZip();
      let topFolder = 'Archive';

      for (let i = 0; i < fileList.length; i++) {
        const f = fileList[i];
        const relativePath = f.webkitRelativePath || f.name;
        if (i === 0 && f.webkitRelativePath) {
          topFolder = f.webkitRelativePath.split('/')[0] || 'Archive';
        }
        zip.file(relativePath, f);
      }

      const zipBlob = await zip.generateAsync({
        type: 'blob',
        compression: 'DEFLATE',
        compressionOptions: { level: 6 },
      });

      const zipFile = new File([zipBlob], `${topFolder}.zip`, {
        type: 'application/zip',
      });

      handleFiles([zipFile]);
    };

    input.click();
  };

  // Batch download session items as ZIP
  const handleBatchZip = async () => {
    const files = sharedItems.filter((item) => item.kind === 'file' && item.file);
    if (files.length === 0) return;

    toast.info('Packaging session items into ZIP...');
    const zip = new JSZip();
    files.forEach((item) => {
      if (item.file) zip.file(item.file.name, item.file);
    });

    const content = await zip.generateAsync({ type: 'blob' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(content);
    link.download = `LocalDrop-Session-${Date.now()}.zip`;
    link.click();
    toast.success('ZIP download started');
  };

  // Merge PDFs
  const handleMergePdfs = async () => {
    const pdfs = sharedItems.filter(
      (item) => item.kind === 'file' && item.file && item.file.type === 'application/pdf'
    );
    if (pdfs.length < 2) {
      toast.info('Need at least 2 PDF documents in session vault to merge');
      return;
    }

    try {
      toast.info(`Merging ${pdfs.length} PDF documents...`);
      const merged = await PDFDocument.create();

      for (const item of pdfs) {
        if (!item.file) continue;
        const arrayBuf = await item.file.arrayBuffer();
        const doc = await PDFDocument.load(arrayBuf);
        const copiedPages = await merged.copyPages(doc, doc.getPageIndices());
        copiedPages.forEach((p) => merged.addPage(p));
      }

      const out = await merged.save();
      const blob = new Blob([out as unknown as BlobPart], { type: 'application/pdf' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `Merged-LocalDrop-${Date.now()}.pdf`;
      link.click();
      toast.success('Merged PDF generated');
    } catch {
      toast.error('Failed merging PDFs');
    }
  };

  // Compile unified transfers list for presentation component
  const transfersList = useMemo<Transfer[]>(() => {
    const list: Transfer[] = [];

    // If active transfer is underway
    if (telemetry) {
      const matchingFile = sharedItems.find(
        (item) =>
          item.kind === 'file' &&
          item.file &&
          (telemetry.transferId ? item.id === telemetry.transferId : item.file.name === telemetry.fileName)
      )?.file;

      list.push({
        id: telemetry.transferId || 'active-telemetry',
        name: telemetry.fileName,
        size: formatBytes(telemetry.totalBytes),
        progress: telemetry.progress,
        direction: telemetry.direction === 'sending' ? 'send' : 'receive',
        transferState: matchingFile ? 'complete' : 'active',
        awaitingApproval: telemetry.awaitingApproval,
        status:
          telemetry.progress >= 100
            ? matchingFile
              ? 'Verified ✓'
              : 'Finalizing…'
            : `${(telemetry.speedMbps).toFixed(1)} MB/s · ${telemetry.etaSeconds}s remaining`,
        file: matchingFile || null,
      });
    }

    // Historical items from sharedItems
    sharedItems.forEach((item) => {
      if (item.kind === 'file' && item.file) {
        if (
          telemetry &&
          (telemetry.transferId
            ? telemetry.transferId === item.id
            : telemetry.fileName === item.file.name)
        ) {
          return;
        }
        list.push({
          id: item.id,
          name: item.file.name,
          size: formatBytes(item.file.size),
          progress: 100,
          direction: item.direction === 'sent' ? 'send' : 'receive',
          transferState: 'complete',
          status: 'Completed',
          file: item.file,
        });
      }
    });

    return list;
  }, [telemetry, sharedItems]);

  const isConnecting =
    connectionState === 'pairing' ||
    connectionState === 'negotiating' ||
    connectionState === 'signaling';

  const displayError = lastError || (connectionState === 'failed' ? statusText : '');

  return (
    <>
      <Toaster position="bottom-right" richColors />
      <LocalDrop
        pin={pin}
        device={localDeviceName}
        peer={connectedPeer?.name}
        pairingUrl={pairingUrl}
        transfers={transfersList}
        stagedFiles={stagedFiles}
        onConnect={(targetPin) => {
          connectWithPin(targetPin);
        }}
        onDisconnect={disconnect}
        onFiles={handleFiles}
        onClipboard={(text) => {
          sendTextOrLink(text);
          toast.success('Text beamed to peer');
        }}
        onCancel={() => {
          cancelTransfer();
          toast.info('Transfer cancelled');
        }}
        onFolder={handleFolderSelect}
        onRemoveStaged={(id) => setStagedFiles((prev) => prev.filter((sf) => sf.id !== id))}
        onClearStaged={() => setStagedFiles([])}
        onSendStaged={handleSendStaged}
        onVoiceNote={(voiceFile) => {
          handleFiles([voiceFile]);
          toast.success('Voice memo recorded and staged');
        }}
        connecting={isConnecting}
        error={displayError}
        connectionState={connectionState}
        transport={transport}
        wsConnected={wsConnected}
        autoAccept={autoAccept}
        onToggleAutoAccept={() => setAutoAccept(!autoAccept)}
        telemetry={telemetry}
        incomingOffer={incomingOffer}
        onAcceptOffer={acceptIncomingFile}
        onDeclineOffer={declineIncomingFile}
        sharedItems={sharedItems}
        onBatchZip={handleBatchZip}
        onMergePdfs={handleMergePdfs}
        channelSessionId={channelSessionId}
        peerIsPhone={connectedPeer?.deviceType === 'mobile'}
      />
    </>
  );
}
