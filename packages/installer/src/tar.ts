import { gunzipSync } from 'node:zlib';

/**
 * Minimal ustar reader/writer: enough for Home Assistant backups and Livynq backups,
 * without a dependency. Supports regular files and directories, GNU long names and pax paths.
 */
export interface TarEntry {
  path: string;
  /** 'symlink' / 'link' only with `{ links: true }`. */
  type: 'file' | 'dir' | 'symlink' | 'link';
  /** Target of a (sym)link. */
  linkTarget?: string;
  data: Buffer;
  mode: number;
  mtime: number;
}

const BLOCK = 512;

function readString(buf: Buffer, offset: number, length: number): string {
  const slice = buf.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return slice.subarray(0, end === -1 ? length : end).toString('utf8');
}

function readOctal(buf: Buffer, offset: number, length: number): number {
  const s = readString(buf, offset, length).trim();
  return s ? parseInt(s, 8) : 0;
}

/**
 * Parses a tar (gzip is detected and inflated automatically). Links are skipped unless
 * `links: true` (then reported so callers can refuse them, e.g. untrusted npm packages).
 */
export function readTar(input: Buffer, options: { links?: boolean } = {}): TarEntry[] {
  const buf = input[0] === 0x1f && input[1] === 0x8b ? gunzipSync(input) : input;
  const entries: TarEntry[] = [];
  let offset = 0;
  let longName: string | undefined;
  let paxPath: string | undefined;
  while (offset + BLOCK <= buf.length) {
    const header = buf.subarray(offset, offset + BLOCK);
    if (header.every((b) => b === 0)) break;
    const size = readOctal(header, 124, 12);
    const typeflag = String.fromCharCode(header[156] || 48);
    const prefix = readString(header, 345, 155);
    const name = readString(header, 0, 100);
    const data = buf.subarray(offset + BLOCK, offset + BLOCK + size);
    offset += BLOCK + Math.ceil(size / BLOCK) * BLOCK;

    if (typeflag === 'L') {
      longName = data.toString('utf8').replace(/\0+$/, '');
      continue;
    }
    if (typeflag === 'x') {
      const match = data.toString('utf8').match(/\d+ path=([^\n]*)\n/);
      paxPath = match?.[1];
      continue;
    }
    if (typeflag === 'g') continue;
    const path = (paxPath ?? longName ?? (prefix ? `${prefix}/${name}` : name)).replace(/^\.\//, '');
    longName = paxPath = undefined;
    if (typeflag === '0' || typeflag === '\0' || typeflag === '5') {
      entries.push({ path: path.replace(/\/$/, ''), type: typeflag === '5' ? 'dir' : 'file', data: Buffer.from(data), mode: readOctal(header, 100, 8), mtime: readOctal(header, 136, 12) });
    } else if (options.links && (typeflag === '1' || typeflag === '2')) {
      entries.push({ path, type: typeflag === '2' ? 'symlink' : 'link', linkTarget: readString(header, 157, 100), data: Buffer.alloc(0), mode: readOctal(header, 100, 8), mtime: readOctal(header, 136, 12) });
    }
  }
  return entries;
}

function writeOctal(buf: Buffer, value: number, offset: number, length: number): void {
  buf.write(value.toString(8).padStart(length - 1, '0') + '\0', offset, length, 'ascii');
}

/** Builds an uncompressed ustar archive (gzip it with zlib if needed). */
export function writeTar(entries: { path: string; data?: Buffer; mode?: number; mtime?: number; type?: 'file' | 'dir' | 'symlink'; linkTarget?: string }[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of entries) {
    const isDir = entry.type === 'dir';
    const isLink = entry.type === 'symlink';
    const data = isDir || isLink ? Buffer.alloc(0) : (entry.data ?? Buffer.alloc(0));
    let path = isDir && !entry.path.endsWith('/') ? `${entry.path}/` : entry.path;
    if (Buffer.byteLength(path) > 100) {
      // GNU long name record
      const longName = Buffer.from(`${path}\0`);
      parts.push(header('././@LongLink', longName.length, 'L', 0o644, 0), pad(longName));
      path = path.slice(0, 99);
    }
    parts.push(header(path, data.length, isDir ? '5' : isLink ? '2' : '0', entry.mode ?? (isDir ? 0o755 : 0o644), entry.mtime ?? Math.floor(Date.now() / 1000), entry.linkTarget), pad(data));
  }
  parts.push(Buffer.alloc(BLOCK * 2));
  return Buffer.concat(parts);
}

function header(path: string, size: number, typeflag: string, mode: number, mtime: number, linkTarget?: string): Buffer {
  const buf = Buffer.alloc(BLOCK);
  buf.write(path, 0, 100, 'utf8');
  if (linkTarget) buf.write(linkTarget, 157, 100, 'utf8');
  writeOctal(buf, mode, 100, 8);
  writeOctal(buf, 0, 108, 8);
  writeOctal(buf, 0, 116, 8);
  writeOctal(buf, size, 124, 12);
  writeOctal(buf, mtime, 136, 12);
  buf.fill(' ', 148, 156);
  buf.write(typeflag, 156, 1, 'ascii');
  buf.write('ustar\0', 257, 6, 'ascii');
  buf.write('00', 263, 2, 'ascii');
  let sum = 0;
  for (const b of buf) sum += b;
  buf.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return buf;
}

function pad(data: Buffer): Buffer {
  const rem = data.length % BLOCK;
  return rem === 0 ? data : Buffer.concat([data, Buffer.alloc(BLOCK - rem)]);
}
