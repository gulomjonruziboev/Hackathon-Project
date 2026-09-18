import { ApiError } from '../middleware/error.js';
import { PARSER_VERSION } from '../llm/extractionSchema.js';

export type ExtractedDocumentText = {
  text: string;
  /** Per-page text, 1-based by array index + 1. Enables page selection (supplement 9). */
  pages: string[];
  pageCount: number | null;
  parserVersion: string;
};

const MIN_MEANINGFUL_CHARS = 20;

/**
 * Supplement 6 specifies pdfplumber, which is Python-only. This project is
 * Node, so the equivalent role — open-source text-layer extraction, explicitly
 * NOT OCR — is filled by `pdf-parse` (pdf.js). The substitution is recorded in
 * docs/model-card.md and THIRD_PARTY_NOTICES.md.
 */
export async function extractDocumentText(
  buffer: Buffer,
  mimeType: string,
  limits: { maxPdfPages: number },
): Promise<ExtractedDocumentText> {
  if (mimeType === 'text/plain') return extractPlainText(buffer);
  if (mimeType === 'application/pdf') return extractPdfText(buffer, limits.maxPdfPages);
  throw new ApiError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Faqat TXT va matn qatlamiga ega PDF qabul qilinadi.');
}

function extractPlainText(buffer: Buffer): ExtractedDocumentText {
  const text = buffer.toString('utf8');
  if (text.trim().length < MIN_MEANINGFUL_CHARS) {
    throw new ApiError(422, 'EMPTY_DOCUMENT', 'Hujjatda tahlil qilinadigan matn topilmadi.');
  }
  return { text, pages: [text], pageCount: 1, parserVersion: PARSER_VERSION };
}

async function extractPdfText(buffer: Buffer, maxPages: number): Promise<ExtractedDocumentText> {
  const mod = (await import('pdf-parse')) as unknown as {
    default?: (b: Buffer, o?: unknown) => Promise<PdfParseResult>;
    pdf?: (b: Buffer, o?: unknown) => Promise<PdfParseResult>;
  };
  const parse = mod.pdf ?? mod.default;
  if (!parse) throw ApiError.unavailable('PDF_PARSER_UNAVAILABLE', 'PDF kutubxonasi yuklanmadi.');

  const pageTexts: string[] = [];
  let parsed: PdfParseResult;
  try {
    parsed = await parse(buffer, {
      // Collect per-page text so a quote can be attributed to a page number and
      // so the doctor can send only the pages that matter (supplement 9).
      pagerender: async (pageData: {
        getTextContent: (o: unknown) => Promise<{ items: Array<{ str: string }> }>;
      }) => {
        const content = await pageData.getTextContent({ normalizeWhitespace: true, disableCombineTextItems: false });
        const pageText = content.items.map((i) => i.str).join(' ');
        pageTexts.push(pageText);
        return pageText;
      },
    });
  } catch {
    throw new ApiError(422, 'PDF_PARSE_FAILED', 'PDF faylni o‘qib bo‘lmadi.');
  }

  const pageCount = parsed.numpages ?? parsed.numPages ?? pageTexts.length ?? null;
  if (pageCount != null && pageCount > maxPages) {
    throw new ApiError(413, 'PDF_TOO_MANY_PAGES', `PDF sahifalari soni chegaradan oshdi (maksimum ${maxPages}).`);
  }

  const pages = pageTexts.length > 0 ? pageTexts : [parsed.text ?? ''];
  const joined = pages.join('\n\n');
  if (joined.replace(/\s/g, '').length < MIN_MEANINGFUL_CHARS) {
    // Main spec 13 / AT-04: a scanned PDF is an explicit, named failure — never
    // an empty success. OCR stays P2 (supplement 6).
    throw new ApiError(
      422,
      'OCR_NOT_SUPPORTED',
      'PDF da matn qatlami topilmadi (ehtimol skaner nusxasi). OCR qo‘llab-quvvatlanmaydi — faktlarni qo‘lda kiriting.',
    );
  }

  return { text: joined, pages, pageCount, parserVersion: PARSER_VERSION };
}

type PdfParseResult = { text: string; numpages?: number; numPages?: number };

/** 1-based page whose text contains the quote, or null when it cannot be located. */
export function pageForQuote(pages: string[], normalizedQuote: string, normalize: (s: string) => string): number | null {
  for (let i = 0; i < pages.length; i += 1) {
    const page = pages[i];
    if (page !== undefined && normalize(page).includes(normalizedQuote)) return i + 1;
  }
  return null;
}
