// Test-only minimal PDF structure parser. There is no PDF-parsing library
// available in this environment (see ../README.md), so pdf-generator's
// tests need their own tiny reader to verify the hand-rolled writer's
// output is actually a well-formed PDF — this is that reader.
//
// This deliberately does NOT try to be a general-purpose PDF parser (no
// support for compressed object streams, cross-reference streams,
// encryption, etc.) — it only understands the exact object shapes
// pdf-generator.ts itself writes (uncompressed content streams, a
// classic xref table, a single trailer). That is a legitimate,
// documented simplification for a test utility whose only job is to
// catch regressions in this package's own writer, not to validate
// arbitrary third-party PDFs.
const OBJECT_RE = /(\d+) 0 obj\n([\s\S]*?)\nendobj\n/g;
const TRAILER_RE = /trailer\n<< \/Size (\d+) \/Root (\d+) 0 R >>\nstartxref\n(\d+)\n%%EOF/;

export interface ParsedPdf {
  /** Raw text, decoded as latin1 (matches the encoding pdf-generator.ts
   *  writes with — every byte in the file is a single latin1 code unit). */
  text: string;
  /** Every indirect object's number -> body (the text between "N 0 obj\n"
   *  and "\nendobj"), keyed by object number. */
  objects: Map<number, string>;
  /** Every object number that appears in the object table, in the order
   *  parsed (used for the obj/endobj-pairs-match check). */
  objectNumbersInOrder: number[];
  trailerSize: number;
  rootObjNum: number;
  startxrefOffset: number;
  pagesObjNum: number;
  pagesCount: number;
  /** Object numbers of each Page, in /Kids order. */
  pageObjNums: number[];
  /** Each page's content-stream text, in the same order as pageObjNums. */
  pageContents: string[];
}

function extractStreamBody(objectBody: string): string {
  const match = objectBody.match(/stream\n([\s\S]*)\nendstream$/);
  if (!match) {
    throw new Error(`Object body does not contain a stream:\n${objectBody.slice(0, 200)}`);
  }
  return match[1];
}

function extractKidsObjNums(pagesBody: string): number[] {
  const kidsMatch = pagesBody.match(/\/Kids \[([^\]]*)\]/);
  if (!kidsMatch) {
    throw new Error(`Pages object has no /Kids array:\n${pagesBody}`);
  }
  const tokens = kidsMatch[1].trim().length === 0 ? [] : kidsMatch[1].trim().split(/\s+/);
  // Each kid is written as "<num> 0 R" -> 3 tokens per kid; take every 3rd
  // token starting at index 0.
  const objNums: number[] = [];
  for (let i = 0; i < tokens.length; i += 3) {
    objNums.push(Number(tokens[i]));
  }
  return objNums;
}

/** Parses a PDF buffer produced by pdf-generator.ts and returns every
 *  structural fact this package's tests need to assert on. Throws if any
 *  expected structural piece (header line, trailer, xref, Pages/Kids) is
 *  missing or malformed — a thrown error here means the file is not the
 *  well-formed PDF this package is supposed to produce. */
export function parsePdf(buffer: Buffer): ParsedPdf {
  const text = buffer.toString("latin1");

  if (!text.startsWith("%PDF-")) {
    throw new Error("Buffer does not start with the PDF header (%PDF-...).");
  }
  if (!/%%EOF\s*$/.test(text)) {
    throw new Error("Buffer does not end with %%EOF (allowing trailing whitespace).");
  }

  const objects = new Map<number, string>();
  const objectNumbersInOrder: number[] = [];
  let match: RegExpExecArray | null;
  OBJECT_RE.lastIndex = 0;
  while ((match = OBJECT_RE.exec(text))) {
    const num = Number(match[1]);
    objects.set(num, match[2]);
    objectNumbersInOrder.push(num);
  }

  const trailerMatch = text.match(TRAILER_RE);
  if (!trailerMatch) {
    throw new Error("trailer/startxref not found or not in the expected shape.");
  }
  const trailerSize = Number(trailerMatch[1]);
  const rootObjNum = Number(trailerMatch[2]);
  const startxrefOffset = Number(trailerMatch[3]);

  const catalogBody = objects.get(rootObjNum);
  if (!catalogBody) {
    throw new Error(`Root object ${rootObjNum} (from trailer) not found among parsed objects.`);
  }
  const pagesRefMatch = catalogBody.match(/\/Pages (\d+) 0 R/);
  if (!pagesRefMatch) {
    throw new Error(`Catalog object does not reference /Pages:\n${catalogBody}`);
  }
  const pagesObjNum = Number(pagesRefMatch[1]);
  const pagesBody = objects.get(pagesObjNum);
  if (!pagesBody) {
    throw new Error(`Pages object ${pagesObjNum} not found among parsed objects.`);
  }
  const pagesCountMatch = pagesBody.match(/\/Count (\d+)/);
  if (!pagesCountMatch) {
    throw new Error(`Pages object has no /Count:\n${pagesBody}`);
  }
  const pagesCount = Number(pagesCountMatch[1]);
  const pageObjNums = extractKidsObjNums(pagesBody);

  const pageContents = pageObjNums.map((pageObjNum) => {
    const pageBody = objects.get(pageObjNum);
    if (!pageBody) {
      throw new Error(`Page object ${pageObjNum} (from /Kids) not found among parsed objects.`);
    }
    const contentsRefMatch = pageBody.match(/\/Contents (\d+) 0 R/);
    if (!contentsRefMatch) {
      throw new Error(`Page object ${pageObjNum} has no /Contents:\n${pageBody}`);
    }
    const contentObjNum = Number(contentsRefMatch[1]);
    const contentObjBody = objects.get(contentObjNum);
    if (!contentObjBody) {
      throw new Error(`Content stream object ${contentObjNum} (from Page ${pageObjNum}'s /Contents) not found.`);
    }
    return extractStreamBody(contentObjBody);
  });

  return {
    text,
    objects,
    objectNumbersInOrder,
    trailerSize,
    rootObjNum,
    startxrefOffset,
    pagesObjNum,
    pagesCount,
    pageObjNums,
    pageContents
  };
}
