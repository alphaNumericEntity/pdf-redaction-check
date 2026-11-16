import type { RedactionReport } from "./check.js";

const VERDICT_LABEL = {
  leak: "LEAK: redacted content can still be recovered",
  warn: "WARN: no recoverable redacted text found, but check the notes",
  clean: "CLEAN: no recoverable redacted content found",
} as const;

function quoteList(items: string[]): string {
  return items.map((s) => `"${s}"`).join(", ");
}

export function formatReport(report: RedactionReport, file?: string): string {
  const lines: string[] = [];
  lines.push(`${file ? `${file}: ` : ""}${VERDICT_LABEL[report.verdict]}`);

  for (const page of report.pages) {
    if (page.textUnderRects.length > 0) {
      lines.push(`  page ${page.page}: text under a black box: ${quoteList(page.textUnderRects)}`);
    }
  }
  if (report.pendingRedactAnnotations > 0) {
    lines.push(
      `  ${report.pendingRedactAnnotations} Redact annotation(s) were marked but never applied; the text beneath them is intact`,
    );
  }
  for (const [term, pages] of Object.entries(report.termHitsByPage)) {
    lines.push(`  "${term}" is in the text layer on page(s) ${pages.join(", ")}`);
  }
  if (report.earlierVersions.removedText.length > 0) {
    lines.push(
      `  an earlier saved version of this file still contains removed text: ${quoteList(report.earlierVersions.removedText.slice(0, 10))}`,
    );
  }
  for (const term of report.termsInEarlierVersions) {
    lines.push(`  "${term}" is in an earlier saved version of this file`);
  }
  for (const term of report.termsInBytes) {
    lines.push(`  "${term}" appears in the raw file bytes (not in the visible text)`);
  }
  if (report.earlierVersions.count > 0 && report.earlierVersions.removedText.length === 0) {
    lines.push(
      `  the file keeps ${report.earlierVersions.count} earlier saved version(s); none had extra text, but they can hold other edits`,
    );
  }
  if (report.earlierVersions.unreadable > 0) {
    lines.push(`  ${report.earlierVersions.unreadable} earlier version(s) could not be opened`);
  }
  for (const m of report.metadata) {
    if (m.key === "Author" || m.key === "Keywords") lines.push(`  metadata ${m.key}: "${m.value}"`);
  }
  if (report.xmpPresent) lines.push("  the file has an XMP metadata packet; review it before sharing");
  if (!report.hasTextLayer) {
    lines.push("  no text layer: scanned pages can't be checked for hidden text");
  }
  return lines.join("\n");
}
