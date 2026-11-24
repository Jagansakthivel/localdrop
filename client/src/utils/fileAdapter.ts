import { useState, useEffect, useRef } from 'react';

export interface NormalizedFile {
  id: string;
  name: string;
  size: number;
  type: string;
  file: File;
}

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return '—';
  }

  if (bytes === 0) return '0 B';

  const units = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

  const index = Math.min(
    Math.max(0, Math.floor(Math.log(bytes) / Math.log(1024))),
    units.length - 1
  );

  const value = bytes / Math.pow(1024, index);

  return `${Number(value.toFixed(decimals))} ${units[index]}`;
}

export function normalizeFiles(input: unknown): NormalizedFile[] {
  if (!Array.isArray(input)) return [];

  return input.flatMap((item, index) => {
    const file =
      item instanceof File
        ? item
        : item && typeof item === 'object' && 'file' in item && item.file instanceof File
          ? (item.file as File)
          : undefined;

    if (!(file instanceof File)) return [];

    const name =
      item && typeof item === 'object' && 'name' in item && typeof item.name === 'string' && item.name
        ? item.name
        : file.name || `file-${index + 1}`;

    const size =
      item && typeof item === 'object' && 'size' in item && typeof item.size === 'number' && !isNaN(item.size)
        ? item.size
        : file.size || 0;

    const type =
      item && typeof item === 'object' && 'type' in item && typeof item.type === 'string'
        ? item.type
        : file.type || 'application/octet-stream';

    const customId =
      item && typeof item === 'object' && 'id' in item && typeof (item as { id?: unknown }).id === 'string' && (item as { id: string }).id
        ? (item as { id: string }).id
        : undefined;

    const id = String(
      customId ??
        `${name}-${size}-${file.lastModified || index}-${Math.random().toString(36).slice(2, 9)}`
    );

    return [
      {
        id,
        name,
        size,
        type,
        file,
      },
    ];
  });
}

/**
 * Safely generates and tracks object URLs for image files.
 * Automatically revokes object URLs when files change or component unmounts to prevent memory leaks and browser exceptions.
 */
export function useSafeThumbnails(files: NormalizedFile[]): Record<string, string> {
  const [thumbnails, setThumbnails] = useState<Record<string, string>>({});
  const activeUrlsRef = useRef<Map<string, string>>(new Map());

  useEffect(() => {
    const nextUrls = new Map<string, string>();
    const newThumbnails: Record<string, string> = {};

    for (const f of files) {
      if (!f.file || !(f.file instanceof File)) continue;
      if (!f.file.type || !f.file.type.startsWith('image/')) continue;

      const cacheKey = `${f.id}-${f.file.name}-${f.file.size}-${f.file.lastModified}`;

      // Check existing active URL
      if (activeUrlsRef.current.has(cacheKey)) {
        const existingUrl = activeUrlsRef.current.get(cacheKey)!;
        nextUrls.set(cacheKey, existingUrl);
        newThumbnails[f.id] = existingUrl;
      } else {
        try {
          const url = URL.createObjectURL(f.file);
          nextUrls.set(cacheKey, url);
          newThumbnails[f.id] = url;
        } catch (err) {
          console.warn('[LocalDrop] Could not create thumbnail for file:', f.name, err);
        }
      }
    }

    // Revoke old URLs that are no longer in nextUrls
    activeUrlsRef.current.forEach((url, key) => {
      if (!nextUrls.has(key)) {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore revoke failure
        }
      }
    });

    activeUrlsRef.current = nextUrls;
    setThumbnails(newThumbnails);

    return () => {
      // Cleanup on unmount
      nextUrls.forEach((url) => {
        try {
          URL.revokeObjectURL(url);
        } catch {
          // ignore revoke failure
        }
      });
    };
  }, [files]);

  return thumbnails;
}
