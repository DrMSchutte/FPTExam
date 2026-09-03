import * as cheerio from "cheerio";

// SAQA doesn't publish an official API. Every registered qualification has a
// public page, keyed by its SAQA qualification ID, that lists (among other
// things) its Exit Level Outcomes and Associated Assessment Criteria. This
// module fetches that page and pulls those two sections out as plain text.
//
// Because this is HTML scraping against a page SAQA doesn't version or
// guarantee, the extraction is heading-anchored rather than tied to precise
// markup (table/div/etc.) - it looks for the section heading text itself,
// which is far less likely to change than the surrounding markup. If SAQA
// restructures the page enough that the headings themselves disappear or are
// reworded, this throws a clear SaqaExtractError rather than silently
// returning an empty/wrong extract.

const CANDIDATE_URLS = (saqaQualificationId: string) => [
  `https://allqs.saqa.org.za/showQualification.php?id=${encodeURIComponent(saqaQualificationId)}`,
  // Qualifications not yet on the "all qualifications" list sometimes only
  // resolve on the registered-qualifications viewer instead.
  `https://regqs.saqa.org.za/viewQualification.php?id=${encodeURIComponent(saqaQualificationId)}`,
];

const ELO_HEADING = /EXIT\s+LEVEL\s+OUTCOMES/i;
const AC_HEADING = /ASSOCIATED\s+ASSESSMENT\s+CRITERIA/i;
// A generic "next SAQA section heading" detector: a short, ALL-CAPS-ish line
// (SAQA's own section headings - ARTICULATION OPTIONS, MODERATION OPTIONS,
// CRITERIA FOR THE REGISTRATION OF ASSESSORS, etc. - are consistently styled
// this way). Used to find where the Assessment Criteria section ends.
const NEXT_HEADING_LINE = /^[A-Z][A-Z\s/&,()-]{4,70}$/;

export class SaqaExtractError extends Error {}

interface RawExtract {
  exitLevelOutcomes: string[];
  assessmentCriteria: string[];
  sourceUrl: string;
}

function normalizeText(raw: string): string {
  return raw
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.trim())
    .join("\n")
    .trim();
}

function splitIntoParagraphs(block: string): string[] {
  const paragraphs = block
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\n/g, " ").trim())
    .filter((p) => p.length > 0);
  return paragraphs.length > 0 ? paragraphs : [block.trim()].filter(Boolean);
}

function extractSection(text: string, headingPattern: RegExp, stopPattern: RegExp | null): string {
  const lines = text.split("\n");
  const headingIdx = lines.findIndex((l) => headingPattern.test(l.trim()) && l.trim().length < 80);
  if (headingIdx === -1) {
    throw new SaqaExtractError(`Could not find a heading matching ${headingPattern} on the SAQA page.`);
  }
  let endIdx = lines.length;
  for (let i = headingIdx + 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (stopPattern && stopPattern.test(line) && !headingPattern.test(line)) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(headingIdx + 1, endIdx).join("\n").trim();
}

async function fetchOne(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (compatible; FPTExamBot/1.0; +https://fptacademy.co.za) instrument-generation",
      },
    });
    if (!res.ok) {
      throw new SaqaExtractError(`SAQA page at ${url} returned HTTP ${res.status}.`);
    }
    return await res.text();
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSaqaExtract(saqaQualificationId: string): Promise<RawExtract> {
  const urls = CANDIDATE_URLS(saqaQualificationId);
  let lastError: unknown = null;

  for (const url of urls) {
    try {
      const html = await fetchOne(url);
      const $ = cheerio.load(html);
      $("script, style, nav, header, footer").remove();
      const text = normalizeText($("body").text());

      const eloBlock = extractSection(text, ELO_HEADING, AC_HEADING);
      const acBlock = extractSection(text, AC_HEADING, NEXT_HEADING_LINE);

      if (!eloBlock || !acBlock) {
        throw new SaqaExtractError(
          `Found the Exit Level Outcomes / Associated Assessment Criteria headings on ${url} but the section content was empty.`
        );
      }

      return {
        exitLevelOutcomes: splitIntoParagraphs(eloBlock),
        assessmentCriteria: splitIntoParagraphs(acBlock),
        sourceUrl: url,
      };
    } catch (err) {
      lastError = err;
      // Try the next candidate URL before giving up.
    }
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new SaqaExtractError(
    `Could not extract Exit Level Outcomes / Associated Assessment Criteria for SAQA qualification ID "${saqaQualificationId}". ` +
      `Tried: ${urls.join(", ")}. Last error: ${detail}`
  );
}
