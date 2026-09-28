/**
 * Reading a zip archive, without a dependency.
 *
 * Enough of the format for what people upload: the central directory at
 * the end names every entry with its offset, and each entry is either
 * stored or deflated. Anything else (encryption, zip64, spanned archives)
 * is refused by name rather than silently skipped. Text is decoded as
 * UTF-8, which is what every tool that writes these archives uses today.
 */
import { inflateRawSync } from 'node:zlib';

export interface ZipEntry {
  readonly path: string;
  readonly size: number;
  readonly bytes: Uint8Array;
}

const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const CENTRAL_FILE_HEADER = 0x02014b50;
const LOCAL_FILE_HEADER = 0x04034b50;
const STORED = 0;
const DEFLATED = 8;

export interface ReadZipOptions {
  /** Entries larger than this are left out rather than read. */
  readonly maxEntryBytes?: number;
  /** Stop after this many entries. */
  readonly maxEntries?: number;
}

export function readZip(archive: Uint8Array, options: ReadZipOptions = {}): ZipEntry[] {
  const view = new DataView(archive.buffer, archive.byteOffset, archive.byteLength);
  const maxEntryBytes = options.maxEntryBytes ?? 4_000_000;
  const maxEntries = options.maxEntries ?? 2_000;

  // The end record is the last thing in the file, followed only by a
  // comment of at most 65,535 bytes. Scan backwards for its signature.
  let end = -1;
  for (let i = archive.byteLength - 22; i >= Math.max(0, archive.byteLength - 22 - 65_535); i -= 1) {
    if (view.getUint32(i, true) === END_OF_CENTRAL_DIRECTORY) { end = i; break; }
  }
  if (end === -1) throw new Error('That file is not a zip archive.');

  const count = view.getUint16(end + 10, true);
  let offset = view.getUint32(end + 16, true);
  if (count === 0xffff || offset === 0xffffffff) throw new Error('Zip64 archives are not supported. Zip the folder again without zip64.');

  const entries: ZipEntry[] = [];
  for (let n = 0; n < count && entries.length < maxEntries; n += 1) {
    if (offset + 46 > archive.byteLength || view.getUint32(offset, true) !== CENTRAL_FILE_HEADER) {
      throw new Error('That zip archive is damaged.');
    }
    const flags = view.getUint16(offset + 8, true);
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const path = decodeName(archive.subarray(offset + 46, offset + 46 + nameLength), flags);
    offset += 46 + nameLength + extraLength + commentLength;

    if (path.endsWith('/')) continue;
    if ((flags & 0x1) !== 0) throw new Error(`"${path}" is encrypted. Zip the folder without a password.`);
    if (size > maxEntryBytes) continue;

    if (view.getUint32(localOffset, true) !== LOCAL_FILE_HEADER) throw new Error('That zip archive is damaged.');
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const start = localOffset + 30 + localNameLength + localExtraLength;
    const raw = archive.subarray(start, start + compressedSize);

    let bytes: Uint8Array;
    if (method === STORED) bytes = raw;
    else if (method === DEFLATED) bytes = new Uint8Array(inflateRawSync(raw));
    else throw new Error(`"${path}" uses a compression this importer cannot read.`);

    entries.push({ path: path.replace(/\\/g, '/'), size, bytes });
  }
  return entries;
}

function decodeName(bytes: Uint8Array, flags: number): string {
  // Bit 11 says UTF-8. Without it the name is nominally CP437, but modern
  // archivers write ASCII or UTF-8 regardless, and UTF-8 decoding of ASCII
  // is the identity.
  void flags;
  return new TextDecoder('utf-8').decode(bytes);
}

export const textOf = (entry: ZipEntry): string => new TextDecoder('utf-8').decode(entry.bytes);
