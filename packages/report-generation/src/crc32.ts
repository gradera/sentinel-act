// From-scratch, table-based CRC-32 (IEEE 802.3 / ZIP polynomial,
// 0xEDB88320 reflected form) — written by hand rather than pulled from
// node:zlib, per this package's "zero new npm dependencies" constraint
// (see README.md) and the task's explicit ask for a first-principles
// implementation rather than a half-remembered polynomial. Every ZIP
// local-file-header / central-directory CRC-32 field written by
// zip-writer.ts is computed with this function, over the UNCOMPRESSED
// bytes of each part (per the ZIP spec — CRC-32 is always over the
// original data, never the deflated bytes).
//
// Algorithm: build a 256-entry table where table[n] is the CRC-32 of the
// single byte n processed through 8 rounds of "shift right, XOR the
// polynomial in if the low bit was set" — the standard reflected CRC-32
// table-construction algorithm. Then process a buffer by, for each byte,
// XOR-ing it into the low byte of the running CRC and looking up the
// table entry to fold in the rest. Initial value 0xFFFFFFFF and a final
// XOR with 0xFFFFFFFF (both required for the ZIP/IEEE 802.3 variant, not
// present in the "textbook" naive CRC-32) are applied around the loop.
const CRC32_POLYNOMIAL = 0xedb88320;

function buildCrc32Table(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? CRC32_POLYNOMIAL ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC32_TABLE = buildCrc32Table();

/** Computes the standard ZIP/IEEE-802.3 CRC-32 of `data`, as an unsigned
 *  32-bit integer (0 .. 0xFFFFFFFF). This is the exact value ZIP's local
 *  file header and central directory record expect in their `crc-32`
 *  field, computed over the part's ORIGINAL (pre-deflate) bytes. */
export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC32_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
