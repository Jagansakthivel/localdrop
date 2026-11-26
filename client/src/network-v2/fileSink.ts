export interface FileSink { write(bytes: Uint8Array): Promise<void>; finish(): Promise<File>; abort(): Promise<void>; dispose(): Promise<void> }
// Memory fallback is deliberately bounded; do not claim arbitrary file-size support.
const MEMORY_LIMIT = 128 * 1024 * 1024;
export async function createFileSink(name: string, mime: string, size: number, handle?: FileSystemFileHandle): Promise<FileSink> {
  if (!Number.isSafeInteger(size) || size < 0) throw new Error('Invalid file size');
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
  if (size>MEMORY_LIMIT) throw new Error('Disk streaming unavailable; file exceeds safe memory limit');
  let chunks: BlobPart[]=[];let written=0;let closed=false;
  return {
    async write(bytes){if(closed || written+bytes.byteLength>size) throw new Error('Sink bounds exceeded');chunks.push(bytes.slice());written+=bytes.byteLength;},
    async finish(){if(closed||written!==size)throw new Error('Incomplete sink');closed=true;const f=new File(chunks,name,{type:mime});chunks=[];return f;},
    async abort(){closed=true;chunks=[];},async dispose(){chunks=[];},
  };
}
