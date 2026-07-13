// Test-only minimal ZIP reader. There is no XLSX/ZIP-parsing library
// available in this environment (see ../README.md), so xlsx-generator's
// round-trip test needs its own tiny reader to verify zip-writer.ts's
// output is actually valid — this is that reader. It deliberately walks
// the archive the same way a real ZIP tool would (end-of-central-directory
// record found by backward search, central directory parsed from there,
// each part located via its local file header), rather than just trusting
// buildZip's own bookkeeping, so a bug in zip-writer.ts's offsets/lengths
// would show up as a failed test here, not be silently assumed away.
import { inflateRawSync } from "node:zlib";
import { crc32 } from "../src/crc32.js";

const END_OF_CENTRAL_DIRECTORY_SIGNATURE = 0x06054b50;
const CENTRAL_DIRECTORY_SIGNATURE = 0x02014b50;
const LOCAL_FILE_HEADER_SIGNATURE = 0x04034b50;
// EOCD is 22 bytes plus up to a 65535-byte comment; this package never
// writes a comment, but search a generous window anyway rather than
// assuming the fixed 22-byte case, to genuinely exercise "find the EOCD
// by walking backward" rather than hardcoding its position.
const MAX_EOCD_SEARCH_WINDOW = 65557;

export interface ParsedZipEntry {
  name: string;
  data: Buffer;
  compressionMethod: number;
  /** CRC-32 value stored in this entry's local file header. */
  storedCrc32: number;
  /** CRC-32 recomputed here (test-side, from-scratch implementation) over
   *  the decompressed bytes — comparing this to storedCrc32 is the
   *  strongest correctness check available without a real XLSX library. */
  recomputedCrc32: number;
}

function findEndOfCentralDirectory(buffer: Buffer): number {
  const start = Math.max(0, buffer.length - MAX_EOCD_SEARCH_WINDOW);
  for (let i = buffer.length - 22; i >= start; i--) {
    if (buffer.readUInt32LE(i) === END_OF_CENTRAL_DIRECTORY_SIGNATURE) {
      return i;
    }
  }
  throw new Error("End of central directory record not found — not a valid ZIP.");
}

/** Parses a ZIP buffer entirely by hand (EOCD -> central directory ->
 *  local file headers -> decompressed data), returning every entry
 *  keyed by its archive path. Throws if the structure doesn't check out
 *  (wrong signature anywhere), rather than returning a partial result. */
export function parseZip(buffer: Buffer): Map<string, ParsedZipEntry> {
  const eocdOffset = findEndOfCentralDirectory(buffer);
  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const centralDirectorySize = buffer.readUInt32LE(eocdOffset + 12);
  const centralDirectoryOffset = buffer.readUInt32LE(eocdOffset + 16);

  if (centralDirectoryOffset + centralDirectorySize !== eocdOffset) {
    throw new Error("Central directory size/offset does not line up with the EOCD record — corrupt ZIP.");
  }

  const entries = new Map<string, ParsedZipEntry>();
  let cursor = centralDirectoryOffset;

  for (let i = 0; i < totalEntries; i++) {
    const signature = buffer.readUInt32LE(cursor);
    if (signature !== CENTRAL_DIRECTORY_SIGNATURE) {
      throw new Error(`Expected central directory signature at offset ${cursor}, got 0x${signature.toString(16)}.`);
    }
    const compressionMethod = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);
    const name = buffer.toString("utf8", cursor + 46, cursor + 46 + nameLength);

    // Walk into the local file header to find where the actual (possibly
    // compressed) data starts — its name/extra field lengths can in
    // principle differ from the central directory's, so this must be read
    // fresh rather than assumed.
    const localSignature = buffer.readUInt32LE(localHeaderOffset);
    if (localSignature !== LOCAL_FILE_HEADER_SIGNATURE) {
      throw new Error(`Expected local file header signature at offset ${localHeaderOffset}, got 0x${localSignature.toString(16)}.`);
    }
    const localNameLength = buffer.readUInt16LE(localHeaderOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localHeaderOffset + 28);
    const storedCrc32 = buffer.readUInt32LE(localHeaderOffset + 14);
    const dataStart = localHeaderOffset + 30 + localNameLength + localExtraLength;
    const compressedBytes = buffer.subarray(dataStart, dataStart + compressedSize);

    const decompressed = compressionMethod === 8 ? inflateRawSync(compressedBytes) : Buffer.from(compressedBytes);
    if (decompressed.length !== uncompressedSize) {
      throw new Error(`Decompressed size mismatch for ${name}: expected ${uncompressedSize}, got ${decompressed.length}.`);
    }

    entries.set(name, {
      name,
      data: decompressed,
      compressionMethod,
      storedCrc32,
      recomputedCrc32: crc32(decompressed)
    });

    cursor += 46 + nameLength + extraLength + commentLength;
  }

  return entries;
}
