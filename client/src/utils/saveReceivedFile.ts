import { sanitizeSuggestedFilename } from "./saveName";
import { Sha256 } from "../network-v2/sha256";

interface WritableFileStream {
  write(data: Blob): Promise<void>;
  close(): Promise<void>;
  abort(): Promise<void>;
}

export interface SaveFileHandle {
  name: string;
  createWritable(): Promise<WritableFileStream>;
}

interface SavePickerOptions {
  suggestedName?: string;
  startIn?: "downloads" | "documents" | "desktop";
}

type SavePickerWindow = Window & {
  showSaveFilePicker?: (
    options?: SavePickerOptions
  ) => Promise<SaveFileHandle>;
};

export type SaveResult =
  | { status: "saved"; filename: string }
  | { status: "download-started"; filename: string }
  | { status: "cancelled" }
  | { status: "failed"; message: string };

export function supportsNativeSavePicker(): boolean {
  return (
    typeof window !== "undefined" &&
    window.isSecureContext &&
    typeof (window as SavePickerWindow).showSaveFilePicker === "function"
  );
}

export async function chooseSaveLocation(
  filename: string
): Promise<SaveFileHandle | null> {
  const browser = window as SavePickerWindow;

  if (!supportsNativeSavePicker()) {
    return null;
  }

  try {
    return await browser.showSaveFilePicker!({
      suggestedName: sanitizeSuggestedFilename(filename),
      startIn: "downloads",
    });
  } catch (error) {
    if (
      error instanceof DOMException &&
      error.name === "AbortError"
    ) {
      return null;
    }

    throw error;
  }
}

export async function writeReceivedFile(
  file: File,
  handle: SaveFileHandle
): Promise<SaveResult> {
  let writable: WritableFileStream | null = null;

  try {
    writable = await handle.createWritable();

    await writable.write(file);
    await writable.close();

    return {
      status: "saved",
      filename: handle.name,
    };
  } catch (error) {
    if (writable) {
      await writable.abort().catch(() => {});
    }

    return {
      status: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Unable to save the received file.",
    };
  }
}

const activeBlobUrls = new Set<string>();
if (typeof window !== "undefined") {
  window.addEventListener("pagehide", () => {
    for (const u of activeBlobUrls) {
      try {
        URL.revokeObjectURL(u);
      } catch {
        // ignore
      }
    }
    activeBlobUrls.clear();
  });
}

export function downloadReceivedFile(
  file: File
): SaveResult {
  const safeName = sanitizeSuggestedFilename(file.name);
  const url = URL.createObjectURL(file);
  activeBlobUrls.add(url);

  const link = document.createElement("a");

  link.href = url;
  link.download = safeName;
  link.style.display = "none";

  try {
    document.body.appendChild(link);
    link.click();

    return {
      status: "download-started",
      filename: safeName,
    };
  } catch (error) {
    return {
      status: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Unable to initiate download.",
    };
  } finally {
    link.remove();

    setTimeout(() => {
      activeBlobUrls.delete(url);
      URL.revokeObjectURL(url);
    }, 300000);
  }
}

export async function computeFileSha256(file: Blob | File): Promise<string> {
  const sha = new Sha256();
  const chunkSize = 1024 * 1024;
  for (let offset = 0; offset < file.size; offset += chunkSize) {
    const buf = await file.slice(offset, offset + chunkSize).arrayBuffer();
    sha.update(new Uint8Array(buf));
  }
  return sha.digest();
}

export async function saveReceivedFile(
  file: File
): Promise<SaveResult> {
  if (!supportsNativeSavePicker()) {
    return downloadReceivedFile(file);
  }

  try {
    const handle = await chooseSaveLocation(file.name);

    if (!handle) {
      return { status: "cancelled" };
    }

    return await writeReceivedFile(file, handle);
  } catch (error) {
    return {
      status: "failed",
      message:
        error instanceof Error
          ? error.message
          : "Unable to open the file picker.",
    };
  }
}
