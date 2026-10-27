import zlib from 'node:zlib';

/**
 * Read the first entry of a single-file zip archive (GDELT publishes one CSV
 * per zip) without a zip dependency. The End Of Central Directory record
 * locates the first central directory header, which gives the sizes, method
 * and local header offset; the local header then gives the data start (its own
 * name and extra lengths, which can differ from the central copy).
 *
 * Only stored (0) and deflate (8) entries are read. Encrypted, zip64 and
 * multi-disk archives are refused, and the declared size is capped before any
 * inflation. The CRC-32 of the result is checked against the header.
 */

/** Largest uncompressed entry accepted, in bytes. */
export const ZIP_MAX_BYTES = 64 * 1024 * 1024;

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;
const LOCAL_SIGNATURE = 0x04034b50;
const EOCD_SIZE = 22;
/** The record may be followed by a comment of at most 65535 bytes. */
const EOCD_SEARCH_SIZE = EOCD_SIZE + 0xffff;
const CENTRAL_SIZE = 46;
const LOCAL_SIZE = 30;
const FLAG_ENCRYPTED = 0x1;
const ZIP64_MARK = 0xffffffff;

const zipError = (message, code = 'BAD_ZIP') =>
  Object.assign(new Error(message), { code });

/**
 * The bytes of the first entry in a single-file zip.
 * @param {Buffer|Uint8Array} input - the whole archive.
 * @param {{maxBytes?: number}} [options]
 * @returns {Buffer}
 * @throws {Error} code BAD_ZIP for malformed or unsupported archives,
 *   ZIP_TOO_LARGE when the declared size exceeds maxBytes.
 */
export function extractSingleZipEntry(
  input,
  { maxBytes = ZIP_MAX_BYTES } = {},
) {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (bytes.length < EOCD_SIZE) throw zipError('zip is too short');

  let eocd = -1;
  const lowest = Math.max(0, bytes.length - EOCD_SEARCH_SIZE);
  for (let at = bytes.length - EOCD_SIZE; at >= lowest; at--) {
    if (bytes.readUInt32LE(at) === EOCD_SIGNATURE) {
      eocd = at;
      break;
    }
  }
  if (eocd < 0) throw zipError('no end of central directory');

  const entryCount = bytes.readUInt16LE(eocd + 10);
  const centralOffset = bytes.readUInt32LE(eocd + 16);
  if (entryCount === 0 || entryCount === 0xffff || centralOffset === ZIP64_MARK)
    throw zipError('unsupported zip layout');
  if (
    centralOffset + CENTRAL_SIZE > eocd ||
    bytes.readUInt32LE(centralOffset) !== CENTRAL_SIGNATURE
  )
    throw zipError('bad central directory');

  const flags = bytes.readUInt16LE(centralOffset + 8);
  const method = bytes.readUInt16LE(centralOffset + 10);
  const crc = bytes.readUInt32LE(centralOffset + 16);
  const compressedSize = bytes.readUInt32LE(centralOffset + 20);
  const uncompressedSize = bytes.readUInt32LE(centralOffset + 24);
  const localOffset = bytes.readUInt32LE(centralOffset + 42);

  if (flags & FLAG_ENCRYPTED)
    throw zipError('encrypted zip entries are not supported');
  if (method !== 0 && method !== 8)
    throw zipError(`unsupported zip method ${method}`);
  if (compressedSize === ZIP64_MARK || uncompressedSize === ZIP64_MARK)
    throw zipError('zip64 entries are not supported');
  if (uncompressedSize > maxBytes)
    throw zipError('zip entry is too large', 'ZIP_TOO_LARGE');

  if (
    localOffset + LOCAL_SIZE > bytes.length ||
    bytes.readUInt32LE(localOffset) !== LOCAL_SIGNATURE
  )
    throw zipError('bad local header');
  const start =
    localOffset +
    LOCAL_SIZE +
    bytes.readUInt16LE(localOffset + 26) +
    bytes.readUInt16LE(localOffset + 28);
  const end = start + compressedSize;
  if (end > bytes.length) throw zipError('entry data is truncated');

  const raw = bytes.subarray(start, end);
  let data;
  if (method === 0) {
    if (compressedSize !== uncompressedSize)
      throw zipError('stored entry sizes disagree');
    data = Buffer.from(raw);
  } else {
    try {
      data = zlib.inflateRawSync(raw, { maxOutputLength: maxBytes });
    } catch {
      throw zipError('zip entry could not be inflated');
    }
  }
  if (data.length !== uncompressedSize)
    throw zipError('zip entry size does not match its header');
  if (zlib.crc32(data) !== crc) throw zipError('zip entry checksum mismatch');
  return data;
}
