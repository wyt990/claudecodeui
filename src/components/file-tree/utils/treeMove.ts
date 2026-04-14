/**
 * Whether moving `fromPath` into `toDirectoryPath` is allowed (client-side guard; server validates too).
 * `toDirectoryPath` may be "" or "." for the project root.
 */
export function canApplyTreeMove(fromPath: string, toDirectoryPath: string): boolean {
  const from = fromPath.replace(/\\/g, '/');
  const raw = toDirectoryPath.replace(/\\/g, '/').replace(/\/$/, '');
  const toDir = raw === '.' ? '' : raw;
  if (!from) {
    return false;
  }
  if (from === toDir) {
    return false;
  }
  if (toDir && (toDir === from || toDir.startsWith(`${from}/`))) {
    return false;
  }
  const parent = from.includes('/') ? from.slice(0, from.lastIndexOf('/')) : '';
  if (parent === toDir) {
    return false;
  }
  return true;
}
