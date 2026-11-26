/** Pure helpers. Keep display names separate from storage/export names. */
export function safeFilename(input: string): string {
  let name = (input.split(/[\\/]/u).pop() ?? '').replace(/[\u0000-\u001f\u007f<>:"|?*]/gu, '_').trim().replace(/[. ]+$/u, '');
  if (!name || name === '.' || name === '..') name = 'download';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/iu.test(name)) name = '_' + name;
  // Limit encoded length without splitting surrogate pairs; keep an extension when practical.
  const encoder = new TextEncoder();
  if (encoder.encode(name).length <= 240) return name;
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && encoder.encode(name.slice(dot)).length <= 24 ? name.slice(dot) : '';
  const body = ext ? name.slice(0, dot) : name;
  let out = '';
  for (const ch of body) {
    if (encoder.encode(out + ch + ext).length > 240) break;
    out += ch;
  }
  return (out || 'download') + ext;
}
export function uniqueExportName(input: string, used: Set<string>): string {
  const name = safeFilename(input);
  const dot = name.lastIndexOf('.');
  const hasExt = dot > 0 && new TextEncoder().encode(name.slice(dot)).length <= 24;
  const stem = hasExt ? name.slice(0, dot) : name;
  const ext = hasExt ? name.slice(dot) : '';
  let candidate = name;
  let i = 1;
  const encoder = new TextEncoder();
  while (used.has(candidate.normalize('NFC').toLowerCase())) {
    const suffix = ` (${i++})${ext}`;
    let shortened = stem;
    while (encoder.encode(shortened + suffix).length > 240) shortened = Array.from(shortened).slice(0, -1).join('');
    candidate = shortened + suffix;
  }
  used.add(candidate.normalize('NFC').toLowerCase());
  return candidate;
}
export function isPdf(file: Pick<File, 'name' | 'type'>): boolean {
  return file.type === 'application/pdf' || /\.pdf$/iu.test(file.name);
}
export function clearMatchingTransfer<T extends { transferId?: string }>(previous: T | null, id: string): T | null {
  return previous?.transferId === id ? null : previous;
}
