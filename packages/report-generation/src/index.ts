// Public entry point of @sentinel-act/report-generation (Spec 10 §5.1).
export { toRegisterRows } from "./to-register-rows.js";
export { generateXlsx, escapeXml, computeIntegrityHash, serializeRowsForHash } from "./xlsx-generator.js";
export type { XlsxMetadata } from "./xlsx-generator.js";
export { generatePdf, wrapText, escapePdfText } from "./pdf-generator.js";
export type { PdfMetadata } from "./pdf-generator.js";
export { REGISTER_COLUMNS } from "./integrity-hash.js";
export { buildZip } from "./zip-writer.js";
export type { ZipEntryInput } from "./zip-writer.js";
export { crc32 } from "./crc32.js";
