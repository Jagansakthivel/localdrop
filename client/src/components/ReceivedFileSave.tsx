import { useCallback, useEffect, useRef, useState } from "react";
import {
  Download,
  FolderOpen,
  Check,
  LoaderCircle,
  AlertCircle,
} from "lucide-react";
import {
  chooseSaveLocation,
  supportsNativeSavePicker,
  writeReceivedFile,
  downloadReceivedFile,
  type SaveFileHandle,
  type SaveResult,
} from "../utils/saveReceivedFile";

export type SaveState =
  | "idle"
  | "choosing"
  | "location-selected"
  | "saving"
  | "saved"
  | "download-started"
  | "failed";

export interface ReceivedFileSaveProps {
  filename: string;
  file: File | null;
  receiving: boolean;
  transferFailed?: boolean;
  onSaveStateChange?: (state: SaveState, filename: string) => void;
  initialHandle?: SaveFileHandle | null;
  onHandleSelected?: (handle: SaveFileHandle) => void;
  initialState?: SaveState;
  initialSavedName?: string;
}

export function ReceivedFileSave({
  filename,
  file,
  receiving,
  transferFailed = false,
  onSaveStateChange,
  initialHandle = null,
  onHandleSelected,
  initialState,
  initialSavedName,
}: ReceivedFileSaveProps) {
  const [state, setState] = useState<SaveState>(
    initialState || (initialHandle ? "location-selected" : "idle")
  );
  const [error, setError] = useState("");
  const [selectedName, setSelectedName] = useState(
    initialSavedName || initialHandle?.name || ""
  );

  const handleRef = useRef<SaveFileHandle | null>(initialHandle);
  const savingRef = useRef(false);
  const savedRef = useRef(initialState === "saved");

  const nativePicker = supportsNativeSavePicker();

  useEffect(() => {
    if (initialHandle && !handleRef.current) {
      handleRef.current = initialHandle;
      setSelectedName(initialHandle.name);
      setState("location-selected");
    }
  }, [initialHandle]);

  const applyResult = useCallback((result: SaveResult) => {
    switch (result.status) {
      case "saved":
        savedRef.current = true;
        setSelectedName(result.filename);
        setState("saved");
        onSaveStateChange?.("saved", result.filename);
        break;

      case "download-started":
        setState("download-started");
        onSaveStateChange?.("download-started", result.filename);
        break;

      case "cancelled":
        setState("idle");
        break;

      case "failed":
        setError(result.message);
        setState("failed");
        onSaveStateChange?.("failed", filename);
        break;
    }
  }, [filename, onSaveStateChange]);

  const saveToSelectedLocation = useCallback(async (
    receivedFile: File,
    handle: SaveFileHandle
  ) => {
    if (savingRef.current || savedRef.current) {
      return;
    }

    savingRef.current = true;
    setState("saving");
    setError("");

    try {
      const result = await writeReceivedFile(
        receivedFile,
        handle
      );
      applyResult(result);
    } finally {
      savingRef.current = false;
    }
  }, [applyResult]);

  // Save automatically to the chosen destination
  // once the complete file becomes available.
  useEffect(() => {
    if (
      receiving ||
      transferFailed ||
      !file ||
      !handleRef.current ||
      state !== "location-selected" ||
      savingRef.current ||
      savedRef.current
    ) {
      return;
    }

    void saveToSelectedLocation(
      file,
      handleRef.current
    );
  }, [file, receiving, transferFailed, state, saveToSelectedLocation]);

  async function handleSave() {
    if (
      savingRef.current ||
      savedRef.current ||
      transferFailed ||
      state === "choosing"
    ) {
      return;
    }

    setError("");

    // Firefox and unsupported mobile browsers.
    if (!nativePicker) {
      if (!file || receiving) return;

      applyResult(downloadReceivedFile(file));
      return;
    }

    setState("choosing");

    try {
      // Must execute directly from a user click.
      const handle = await chooseSaveLocation(filename);

      if (!handle) {
        setState("idle");
        return;
      }

      handleRef.current = handle;
      setSelectedName(handle.name);
      onHandleSelected?.(handle);

      // If the file is already received and available, write immediately.
      if (!receiving && file) {
        await saveToSelectedLocation(file, handle);
        return;
      }

      // The transfer may still be running.
      // Wait until the complete file is available.
      setState("location-selected");
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : "Could not select a save location."
      );
      setState("failed");
    }
  }

  if (transferFailed) {
    return (
      <div className="ld-save-error" role="alert">
        <AlertCircle size={15} />
        Transfer failed. File not saved.
      </div>
    );
  }

  if (state === "saved") {
    return (
      <div className="ld-save-success" role="status">
        <Check size={17} />
        <div>
          <strong>Saved to device</strong>
          <span title={selectedName}>
            {selectedName}
          </span>
        </div>
      </div>
    );
  }

  if (state === "location-selected") {
    return (
      <div className="ld-save-selected" role="status">
        <FolderOpen size={17} />
        <div>
          <strong>Save location selected</strong>
          <span>
            File will be saved after reception.
          </span>
        </div>
      </div>
    );
  }

  if (state === "saving" || state === "choosing") {
    return (
      <div className="ld-save-pending" role="status">
        <LoaderCircle
          size={16}
          className="ld-save-spinner"
        />
        {state === "choosing"
          ? "Choose a save location..."
          : "Saving file..."}
      </div>
    );
  }

  return (
    <div className="ld-save-actions">
      <button
        type="button"
        className="ld-save-button"
        onClick={handleSave}
        disabled={
          (!nativePicker && receiving) ||
          (!receiving && !file)
        }
      >
        {nativePicker ? (
          <FolderOpen size={17} />
        ) : (
          <Download size={17} />
        )}

        {state === "failed"
          ? "Retry saving"
          : state === "download-started"
            ? "Download again"
            : nativePicker
              ? "Save as..."
              : "Save file"}
      </button>

      {!nativePicker && receiving && (
        <span className="ld-save-hint">
          Available after transfer completes.
        </span>
      )}

      {state === "download-started" && (
        <span className="ld-save-hint" role="status">
          Download started. Check your browser downloads.
        </span>
      )}

      {error && (
        <span className="ld-save-error" role="alert">
          <AlertCircle size={14} />
          {error}
        </span>
      )}
    </div>
  );
}
