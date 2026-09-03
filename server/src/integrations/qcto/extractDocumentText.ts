import { PDFParse } from "pdf-parse";
import mammoth from "mammoth";

// QCTO/AQPs don't distribute assessment specification documents as SCORM
// packages (SCORM is an e-learning content-packaging/tracking standard, not
// an assessment-paper format) - they issue a written Qualification Assessment
// Specifications (QAS) / External Assessment Specifications document, in
// practice a PDF or Word file. This module just needs to get plain text out
// of whichever of those an Administrator uploads; the actual outcome/
// criteria extraction is an AI step (see ../../ai/documentOutcomeExtraction.ts),
// not something this module tries to parse structurally.

export class DocumentExtractionError extends Error {}

const PDF_MIME = "application/pdf";
const DOCX_MIME =
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
const DOC_MIME = "application/msword";
const TEXT_MIME_PREFIXES = ["text/"];

export async function extractTextFromDocument(
  buffer: Buffer,
  mimeType: string,
  originalFilename: string
): Promise<string> {
  const lowerName = originalFilename.toLowerCase();

  if (mimeType === PDF_MIME || lowerName.endsWith(".pdf")) {
    const parser = new PDFParse({ data: buffer });
    try {
      const result = await parser.getText();
      const text = result.text?.trim() ?? "";
      if (!text) {
        throw new DocumentExtractionError(
          `Could not extract any text from "${originalFilename}" - the PDF may be a scanned image without a text layer. Try a text-based export instead.`
        );
      }
      return text;
    } finally {
      await parser.destroy?.().catch(() => {});
    }
  }

  if (mimeType === DOCX_MIME || lowerName.endsWith(".docx")) {
    const result = await mammoth.extractRawText({ buffer });
    const text = result.value?.trim() ?? "";
    if (!text) {
      throw new DocumentExtractionError(
        `Could not extract any text from "${originalFilename}".`
      );
    }
    return text;
  }

  if (mimeType === DOC_MIME || lowerName.endsWith(".doc")) {
    throw new DocumentExtractionError(
      `"${originalFilename}" looks like an older .doc file - only PDF and .docx are supported. Please re-save it as .docx or .pdf and re-upload.`
    );
  }

  if (TEXT_MIME_PREFIXES.some((p) => mimeType.startsWith(p)) || lowerName.endsWith(".txt")) {
    const text = buffer.toString("utf-8").trim();
    if (!text) {
      throw new DocumentExtractionError(`"${originalFilename}" appears to be empty.`);
    }
    return text;
  }

  throw new DocumentExtractionError(
    `Unsupported file type for "${originalFilename}" (${mimeType || "unknown"}). Upload a PDF, .docx, or .txt file.`
  );
}
