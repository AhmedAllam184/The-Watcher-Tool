import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ZIP_MAX_BYTES,
  extractSingleZipEntry,
} from '../../server/providers/common/zipEntry.js';
import { buildZip } from './zipTestWriter.mjs';

test('a deflated entry is inflated back to its exact bytes, whatever the local header lengths', () => {
  const csv = 'a\tb\tc\n1\t2\t3\n'.repeat(500);
  const archive = buildZip('20261027091500.export.CSV', csv, {
    localExtra: 17,
  });
  const out = extractSingleZipEntry(archive);
  assert.equal(out.toString('utf8'), csv);
});

test('a stored entry is returned as raw bytes', () => {
  const archive = buildZip('x.csv', 'plain text', { method: 0 });
  assert.equal(extractSingleZipEntry(archive).toString(), 'plain text');
});

test('an archive with a trailing comment still finds its end record', () => {
  const base = buildZip('x.csv', 'hello');
  const comment = Buffer.from('zip comment');
  const archive = Buffer.concat([base, comment]);
  archive.writeUInt16LE(comment.length, base.length - 2);
  assert.equal(extractSingleZipEntry(archive).toString(), 'hello');
});

test('malformed, encrypted, zip64 and unsupported-method archives are refused with BAD_ZIP', () => {
  const refused = [
    ['not a zip', Buffer.from('definitely not an archive')],
    ['empty input', Buffer.alloc(0)],
    [
      'bad signature in the local header',
      buildZip('x.csv', 'abc', {
        patch: (archive, { centralOffset }) => {
          archive.writeUInt32LE(0, 0);
          void centralOffset;
        },
      }),
    ],
    [
      'encrypted flag',
      buildZip('x.csv', 'abc', {
        patch: (archive, { centralOffset }) => {
          archive.writeUInt16LE(1, centralOffset + 8);
        },
      }),
    ],
    [
      'method 12 (bzip2)',
      buildZip('x.csv', 'abc', {
        patch: (archive, { centralOffset }) => {
          archive.writeUInt16LE(12, centralOffset + 10);
        },
      }),
    ],
    [
      'zip64 sizes',
      buildZip('x.csv', 'abc', {
        patch: (archive, { centralOffset }) => {
          archive.writeUInt32LE(0xffffffff, centralOffset + 24);
        },
      }),
    ],
    [
      'corrupt deflate data',
      buildZip('x.csv', 'abcdefgh'.repeat(20), {
        patch: (archive) => {
          archive.fill(0xff, 30 + 5, 30 + 5 + 8);
        },
      }),
    ],
    [
      'a wrong CRC',
      buildZip('x.csv', 'abc', {
        patch: (archive, { centralOffset }) => {
          archive.writeUInt32LE(0xdeadbeef, centralOffset + 16);
        },
      }),
    ],
  ];
  for (const [label, archive] of refused)
    assert.throws(
      () => extractSingleZipEntry(archive),
      (err) => err.code === 'BAD_ZIP',
      label,
    );
});

test('the declared size is capped before inflation', () => {
  const archive = buildZip('big.csv', 'x'.repeat(10_000));
  assert.throws(
    () => extractSingleZipEntry(archive, { maxBytes: 1000 }),
    (err) => err.code === 'ZIP_TOO_LARGE',
  );
  assert.equal(
    extractSingleZipEntry(archive, { maxBytes: 10_000 }).length,
    10_000,
  );
  assert.equal(ZIP_MAX_BYTES, 64 * 1024 * 1024);
});
