export interface FileSink { write(bytes: Uint8Array): Promise<void>; finish(): Promise<File>; abort(): Promise<void>; dispose(): Promise<void> }
// Memory fallback is deliberately bounded; do not claim arbitrary file-size support.
const MEMORY_LIMIT = 128 * 1024 * 1024;
export async function createFileSink(name: string, mime: string, size: number, handle?: FileSystemFileHandle): Promise<FileSink> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
  // Explicit user-selected destinations retain priority. Small files avoid OPFS setup.
  if (!handle && size <= 8 * 1024 * 1024) return memorySink(name,mime,size);
  let root: FileSystemDirectoryHandle | undefined; let entry: string | undefined;
  let target = handle;
  if (!target && typeof navigator !== 'undefined' && navigator.storage?.getDirectory) {
    try { root = await navigator.storage.getDirectory(); entry = `localdrop-${crypto.randomUUID()}`; target = await root.getFileHandle(entry, { create: true }); } catch { root=undefined; entry=undefined; }
  }
  if (target) {
    let writer: FileSystemWritableFileStream | undefined;
    try { writer = await target.createWritable(); } catch (e) { if(root && entry) await root.removeEntry(entry).catch(()=>{}); if(handle)throw e; }
    if(writer){ const output=writer;
    const fileHandle=target; let closed=false; let written=0;
    const dispose=async()=>{if(root && entry) await root.removeEntry(entry).catch(()=>{});};
    return {
      async write(bytes) { if(closed || written+bytes.byteLength>size) throw new Error('Sink bounds exceeded'); await output.write(bytes.slice()); written+=bytes.byteLength; },
      async finish() { if(closed || written!==size) throw new Error('Incomplete sink'); await output.close(); closed=true; const f=await fileHandle.getFile(); return new File([f], name, {type:mime}); },
      async abort() { if(!closed){closed=true;await output.abort().catch(()=>{});} await dispose(); }, dispose,
    };
    }
  }
  return memorySink(name,mime,size);
}
export async function pruneOrphanedOpfsFiles(maxAgeMs = 24 * 60 * 60 * 1000): Promise<void> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return;
  try {
    const root = await navigator.storage.getDirectory();
    const dir = root as FileSystemDirectoryHandle & {
      entries?: () => AsyncIterableIterator<[string, FileSystemHandle]>;
    };
    if (typeof dir.entries !== 'function') return;
    const cutoff = Date.now() - maxAgeMs;
    for await (const [name, handle] of dir.entries()) {
      if (handle.kind !== 'file' || !name.startsWith('localdrop-')) continue;
      try {
        const file = await (handle as FileSystemFileHandle).getFile();
        if (file.lastModified <= cutoff) {
          await root.removeEntry(name).catch(() => {});
        }
      } catch {
        // Ignore locked or inaccessible entries
      }
    }
  } catch {
    // OPFS unavailable
  }
}

function memorySink(name:string,mime:string,size:number):FileSink {
  if (size>MEMORY_LIMIT) throw new Error('Disk streaming unavailable; file exceeds safe memory limit');
  let chunks: BlobPart[]=[];let written=0;let closed=false;
  return {
    async write(bytes){if(closed || written+bytes.byteLength>size) throw new Error('Sink bounds exceeded');chunks.push(bytes.slice());written+=bytes.byteLength;},
    async finish(){if(closed||written!==size)throw new Error('Incomplete sink');closed=true;const f=new File(chunks,name,{type:mime});chunks=[];return f;},
    async abort(){closed=true;chunks=[];},async dispose(){chunks=[];},
  };
}
