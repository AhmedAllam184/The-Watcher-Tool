import zlib from 'node:zlib';

/**
 * Test-only writer for one-entry zip archives: a local header, the data, a
 * central directory header and an end record. `patch(archive, {centralOffset})`
 * damages one field after the build, so a test can exercise a refusal.
 */
export function buildZip(
  name,
  data,
  { method = 8, patch = null, localExtra = 0 } = {},
) {
  const raw = Buffer.from(data);
  const body = method === 8 ? zlib.deflateRawSync(raw) : raw;
  const nameBytes = Buffer.from(name);
  const extra = Buffer.alloc(localExtra, 0x20);
  const crc = zlib.crc32(raw);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(raw.length, 22);
  local.writeUInt16LE(nameBytes.length, 26);
  local.writeUInt16LE(extra.length, 28);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(raw.length, 24);
  central.writeUInt16LE(nameBytes.length, 28);
  central.writeUInt32LE(0, 42);

  const centralOffset =
    local.length + nameBytes.length + extra.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(central.length + nameBytes.length, 12);
  eocd.writeUInt32LE(centralOffset, 16);

  const archive = Buffer.concat([
    local,
    nameBytes,
    extra,
    body,
    central,
    nameBytes,
    eocd,
  ]);
  if (patch) patch(archive, { centralOffset });
  return archive;
}
