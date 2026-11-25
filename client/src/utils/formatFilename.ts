/**
 * formatFilename.ts
 *
 * Smartly truncates long filenames while preserving the file extension.
 * E.g. "AQN83wlhPbQnTNhmT19jnaJiraGJyAFsSwct3yp2YEIeF_vHt_1T01uM9bxN_2UY-Xbm1Qy2vpNCOo9KdmFULPx.mp4"
 *   -> "AQN83wlhPbQnTNhmT19j…9KdmFULPx.mp4"
 *
 * NOTE: Use strictly for display rendering. Never mutate the actual File or Blob name.
 */
export function formatFilename(filename: string, maxLength = 36): string {
  if (!filename || typeof filename !== 'string') return '';

  const characters = Array.from(filename);
  if (characters.length <= maxLength) {
    return filename;
  }

  const dotIndex = filename.lastIndexOf('.');
  const extension = dotIndex > 0 ? filename.slice(dotIndex) : '';
  const basename = dotIndex > 0 ? filename.slice(0, dotIndex) : filename;
  const base = Array.from(basename);

  const available = maxLength - Array.from(extension).length - 1;

  if (available < 8) {
    return characters.slice(0, maxLength - 1).join('') + '…';
  }

  const startLength = Math.ceil(available * 0.65);
  const endLength = available - startLength;

  return (
    base.slice(0, startLength).join('') +
    '…' +
    base.slice(-endLength).join('') +
    extension
  );
}
