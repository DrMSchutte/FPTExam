import * as cheerio from "cheerio";

// SAQA doesn't publish an official API. Every registered qualification has a
// public page, keyed by its SAQA qualification ID, that lists (among other
// things) its Exit Level Outcomes and Associated Assessment Criteria. This
// module fetches that page and pulls those two sections out as plain text.
//
// The extraction is heading-anchored rather than tied to precise markup - it
// looks for the section heading text itself, which is far less likely to
// change than the surrounding tables. If SAQA restructures the page enough
// that the headings disappear or are reworded, this throws a clear
// SaqaExtractError rather than silently returning an empty/wrong extract.
//
// Verified against the real page structure (allqs.saqa.org.za, Sept 2026):
// each section is a one-cell <table> holding <b>HEADING</b>&nbsp;, followed by
// a one-cell <table> holding the content, which uses <br> line breaks and
// <li> bullets for the individual outcomes / criteria.

const CANDIDATE_URLS = (saqaQualificationId: string) => [
  `https://allqs.saqa.org.za/showQualification.php?id=${encodeURIComponent(saqaQualificationId)}`,
  // Qualifications not yet on the "all qualifications" list sometimes only
  // resolve on the registered-qualifications viewer instead.
  `https://regqs.saqa.org.za/viewQualification.php?id=${encodeURIComponent(saqaQualificationId)}`,
];

const ELO_HEADING = /^EXIT\s+LEVEL\s+OUTCOMES:?$/i;
const AC_HEADING = /^ASSOCIATED\s+ASSESSMENT\s+CRITERIA:?$/i;

// The SAQA section headings that can follow ASSOCIATED ASSESSMENT CRITERIA on
// the page - whichever appears first ends that section. Listing them by name
// is more reliable than a generic "looks like a heading" heuristic, which an
// all-caps line inside the criteria could trip.
const SECTION_HEADINGS_AFTER_AC = /^(INTEGRATED\s+ASSESSMENT|INTERNATIONAL\s+COMPARABILITY|ARTICULATION\s+OPTIONS|MODERATION\s+OPTIONS|CRITERIA\s+FOR\s+THE\s+REGISTRATION\s+OF\s+ASSESSORS|REREGISTRATION\s+HISTORY|NOTES|UNIT\s+STANDARDS:?|LEARNING\s+PROGRAMMES\s+RECORDED.*|PROVIDERS\s+CURRENTLY\s+ACCREDITED.*)$/i;

// Within the criteria block SAQA often appends an "Integrated assessment"
// essay (frequently misspelt "Intergrated" on the site). It is guidance, not a
// criterion, so the criteria list stops there.
const AC_INLINE_STOP = /^inte?r?grated\s+assessment\b/i;

// Within the outcomes block, "Exit points for learners who do not complete the
// qualification" and similar sub-blocks describe credit rules, not outcomes.
const ELO_INLINE_STOP = /^exit\s+points?\b/i;

const BULLET = "\u2022 ";

export class SaqaExtractError extends Error {}

interface RawExtract {
  exitLevelOutcomes: string[];
  assessmentCriteria: string[];
  sourceUrl: string;
  nqfLevel: number | null;
}

// SAQA shows the level as e.g. "NQF Level 05" or "Level TBA: Pre-2009 was L5".
function findNqfLevel(lines: string[]): number | null {
  for (const l of lines) {
    const m = l.match(/NQF\s+Level\s*0?(\d{1,2})\b/i) ?? l.match(/Pre-2009\s+was\s+L(\d{1,2})\b/i);
    if (m) {
      const n = Number(m[1]);
      if (n >= 1 && n <= 10) return n;
    }
  }
  return null;
}

// Turn the page into text with one line per block element, so headings and
// bullets each land on their own line regardless of how the HTML source was
// wrapped. cheerio's .text() alone would run <td>s and <li>s together.
function htmlToLines(html: string): string[] {
  const $ = cheerio.load(html);
  $("script, style, nav, header, footer").remove();
  $("br").replaceWith("\n");
  // Mark list items so the extractor can tell real bullets from lead-in prose.
  $("li").each((_, el) => {
    $(el).prepend(BULLET);
  });
  $("li, p, div, tr, td, th, h1, h2, h3, h4, h5, h6, table").each((_, el) => {
    $(el).append("\n");
  });
  return $("body")
    .text()
    .replace(/\u00a0/g, " ")
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length > 0);
}

function findHeading(lines: string[], pattern: RegExp, from = 0): number {
  for (let i = from; i < lines.length; i++) if (pattern.test(lines[i])) return i;
  return -1;
}

// Pull the content lines between a heading and the next section boundary,
// then reduce them to the individual items: drop the lead-in sentence that
// ends with ":", drop very short fragments, stop at an inline sub-block, and
// de-duplicate (SAQA pages sometimes repeat an outcome verbatim).
function extractItems(lines: string[], start: number, end: number, inlineStop: RegExp): string[] {
  const section: string[] = [];
  for (let i = start; i < end; i++) {
    if (inlineStop.test(lines[i].replace(BULLET, ""))) break;
    section.push(lines[i]);
  }
  // SAQA renders the actual outcomes/criteria as <li> bullets; anything else
  // in the block is lead-in prose ("On achieving this Qualification, the
  // learner will be able to:") which may wrap across several lines. If the
  // section has bullets, only the bullets are items. If it has none (older
  // pages sometimes use plain <br>-separated lines), fall back to every line
  // that isn't a lead-in.
  const bullets = section.filter((l) => l.startsWith(BULLET));
  const candidates = bullets.length > 0 ? bullets : section.filter((l) => !l.endsWith(":"));

  const items: string[] = [];
  const seen = new Set<string>();
  for (const raw of candidates) {
    const line = raw.replace(BULLET, "").trim();
    if (line.length < 12) continue;
    const key = line.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    items.push(line);
  }
  return items;
}

async function fetchOne(url: string): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        // A conventional browser UA - SAQA's site is a plain PHP application
        // and some hosts of this kind refuse obviously non-browser agents.
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36",
        Accept: "text/html,application/xhtml+xml",
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

// Exported separately so the parser can be tested against saved HTML without
// a network call.
export function parseSaqaHtml(html: string, sourceUrl: string): RawExtract {
  const lines = htmlToLines(html);

  const eloIdx = findHeading(lines, ELO_HEADING);
  if (eloIdx === -1) {
    throw new SaqaExtractError(`Could not find an "EXIT LEVEL OUTCOMES" heading on ${sourceUrl}.`);
  }
  const acIdx = findHeading(lines, AC_HEADING, eloIdx + 1);
  if (acIdx === -1) {
    throw new SaqaExtractError(`Could not find an "ASSOCIATED ASSESSMENT CRITERIA" heading on ${sourceUrl}.`);
  }
  let acEnd = findHeading(lines, SECTION_HEADINGS_AFTER_AC, acIdx + 1);
  if (acEnd === -1) acEnd = lines.length;

  const exitLevelOutcomes = extractItems(lines, eloIdx + 1, acIdx, ELO_INLINE_STOP);
  const assessmentCriteria = extractItems(lines, acIdx + 1, acEnd, AC_INLINE_STOP);

  if (exitLevelOutcomes.length === 0 || assessmentCriteria.length === 0) {
    throw new SaqaExtractError(
      `Found the section headings on ${sourceUrl} but extracted ${exitLevelOutcomes.length} outcomes and ${assessmentCriteria.length} criteria - the page layout may have changed.`
    );
  }

  return { exitLevelOutcomes, assessmentCriteria, sourceUrl, nqfLevel: findNqfLevel(lines) };
}

export async function fetchSaqaExtract(saqaQualificationId: string): Promise<RawExtract> {
  const urls = CANDIDATE_URLS(saqaQualificationId);
  let lastError: unknown = null;

  for (const url of urls) {
    try {
      const html = await fetchOne(url);
      return parseSaqaHtml(html, url);
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
