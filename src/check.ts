import {
  bytesContainText,
  darkMask,
  earlierRevisionEnds,
  findDarkRects,
  hiddenText,
  latin1,
  removedText,
  type Rect,
} from "./analysis.js";
import { closePdf, openPdf, pageTextBoxes, renderPage, textItems } from "./pdf.js";

export type PageCheck = {
  page: number;
  textChars: number;
  darkRects: Rect[];
  textUnderRects: string[];
  annotations: Record<string, number>;
};

export type EarlierVersions = {
  count: number;
  checked: number;
  unreadable: number;
  removedText: string[];
};

export type Verdict = "leak" | "warn" | "clean";

export type RedactionReport = {
  verdict: Verdict;
  pages: PageCheck[];
  pendingRedactAnnotations: number;
  termHitsByPage: Record<string, number[]>;
  termsInEarlierVersions: string[];
  termsInBytes: string[];
  earlierVersions: EarlierVersions;
  metadata: { key: string; value: string }[];
  xmpPresent: boolean;
  hasTextLayer: boolean;
};

export type Progress = { done: number; total: number; stage: "pages" | "earlier-versions" };

export type CheckOptions = {
  terms?: string[];
  renderScale?: number;
  maxEarlierVersions?: number;
  onProgress?: (progress: Progress) => void;
};

const METADATA_KEYS = ["Title", "Author", "Subject", "Keywords", "Creator", "Producer"];

export async function checkRedaction(
  bytes: Uint8Array,
  options: CheckOptions = {},
): Promise<RedactionReport> {
  const { terms = [], renderScale = 0.5, maxEarlierVersions = 25, onProgress } = options;
  const doc = await openPdf(bytes);
  const pages: PageCheck[] = [];
  const pageTexts: string[] = [];
  const currentItems: string[] = [];
  let pendingRedactAnnotations = 0;
  let metadata: { key: string; value: string }[] = [];
  let xmpPresent = false;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const boxes = await pageTextBoxes(doc, p);
      pageTexts.push(boxes.map((b) => b.str).join(" "));
      for (const b of boxes) currentItems.push(b.str);
      const annotations: Record<string, number> = {};
      for (const a of await (await doc.getPage(p)).getAnnotations()) {
        const subtype = typeof a.subtype === "string" ? a.subtype : "Unknown";
        annotations[subtype] = (annotations[subtype] ?? 0) + 1;
      }
      pendingRedactAnnotations += annotations.Redact ?? 0;
      const image = await renderPage(doc, p, renderScale);
      const dark = darkMask(image.data, image.width, image.height);
      const darkRects = findDarkRects(dark, image.width, image.height);
      pages.push({
        page: p,
        textChars: boxes.reduce((n, b) => n + b.str.trim().length, 0),
        darkRects,
        textUnderRects: hiddenText(boxes, darkRects, dark, image.width, image.height),
        annotations,
      });
      onProgress?.({ done: p, total: doc.numPages, stage: "pages" });
    }
    const { info, metadata: xmp } = await doc.getMetadata();
    const infoRecord = (info ?? {}) as Record<string, unknown>;
    metadata = METADATA_KEYS.flatMap((key) => {
      const value = infoRecord[key];
      return typeof value === "string" && value.trim().length > 0 ? [{ key, value: value.trim() }] : [];
    });
    xmpPresent = xmp != null;
  } finally {
    await closePdf(doc);
  }

  const cleanTerms = terms.map((t) => t.trim()).filter((t) => t.length > 0);
  const termHitsByPage: Record<string, number[]> = {};
  for (const term of cleanTerms) {
    const hits: number[] = [];
    pageTexts.forEach((text, i) => {
      if (text.toLowerCase().includes(term.toLowerCase())) hits.push(i + 1);
    });
    if (hits.length > 0) termHitsByPage[term] = hits;
  }

  const ends = earlierRevisionEnds(latin1(bytes));
  const toCheck =
    ends.length <= maxEarlierVersions
      ? ends
      : [ends[0], ...ends.slice(-(maxEarlierVersions - 1))];
  const removed = new Set<string>();
  const termsInEarlierVersions = new Set<string>();
  let unreadable = 0;
  for (let i = 0; i < toCheck.length; i++) {
    try {
      const earlier = await openPdf(bytes.subarray(0, toCheck[i]));
      const items = await textItems(earlier).finally(() => closePdf(earlier));
      for (const text of removedText(items, currentItems)) removed.add(text);
      const joined = items.join(" ").toLowerCase();
      for (const term of cleanTerms) {
        if (!(term in termHitsByPage) && joined.includes(term.toLowerCase())) {
          termsInEarlierVersions.add(term);
        }
      }
    } catch {
      unreadable++;
    }
    onProgress?.({ done: i + 1, total: toCheck.length, stage: "earlier-versions" });
  }
  const earlierVersions: EarlierVersions = {
    count: ends.length,
    checked: toCheck.length,
    unreadable,
    removedText: [...removed],
  };
  const termsInBytes = cleanTerms.filter(
    (term) =>
      !(term in termHitsByPage) && !termsInEarlierVersions.has(term) && bytesContainText(bytes, term),
  );

  const leak =
    pages.some((pg) => pg.textUnderRects.length > 0) ||
    Object.keys(termHitsByPage).length > 0 ||
    pendingRedactAnnotations > 0 ||
    earlierVersions.removedText.length > 0 ||
    termsInEarlierVersions.size > 0;
  const warn =
    termsInBytes.length > 0 ||
    metadata.some((m) => m.key === "Author" || m.key === "Keywords") ||
    xmpPresent ||
    earlierVersions.count > 0;
  return {
    verdict: leak ? "leak" : warn ? "warn" : "clean",
    pages,
    pendingRedactAnnotations,
    termHitsByPage,
    termsInEarlierVersions: [...termsInEarlierVersions],
    termsInBytes,
    earlierVersions,
    metadata,
    xmpPresent,
    hasTextLayer: pages.some((pg) => pg.textChars > 0),
  };
}
