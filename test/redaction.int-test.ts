import { describe, expect, it } from "vitest";
import { PDFDocument } from "pdf-lib";
import { checkRedaction, formatReport } from "../src/index.js";
import { makePdf, withIncrementalContentUpdate, withRedactAnnotation } from "./fixtures.js";

const SECRET = "Account 4417 1234 5678 9113";

describe("checkRedaction on real PDFs", () => {
  it("passes a plain document", async () => {
    const report = await checkRedaction(await makePdf([{ text: "Quarterly report", x: 72, y: 700 }]));
    expect(report.verdict).toBe("clean");
    expect(report.hasTextLayer).toBe(true);
  });

  it("finds text left under a black box", async () => {
    const bytes = await makePdf(
      [
        { text: "Payment details below", x: 72, y: 720 },
        { text: SECRET, x: 72, y: 700 },
      ],
      [{ x: 66, y: 694, w: 230, h: 22 }],
    );
    const report = await checkRedaction(bytes);
    expect(report.verdict).toBe("leak");
    expect(report.pages[0].darkRects).toHaveLength(1);
    expect(report.pages[0].textUnderRects.join(" ")).toContain("4417");
    expect(report.pages[0].textUnderRects.join(" ")).not.toContain("Payment");
    expect(formatReport(report, "statement.pdf")).toContain("text under a black box");
  });

  it("does not flag white text printed on a dark bar", async () => {
    const bytes = await makePdf(
      [{ text: "CONFIDENTIAL HEADER", x: 80, y: 700, color: "white" }],
      [{ x: 66, y: 690, w: 260, h: 30 }],
      true,
    );
    const report = await checkRedaction(bytes);
    expect(report.pages[0].darkRects.length).toBeGreaterThan(0);
    expect(report.pages[0].textUnderRects).toEqual([]);
    expect(report.verdict).toBe("clean");
  });

  it("flags Redact annotations that were never applied", async () => {
    const bytes = await withRedactAnnotation(
      await makePdf([{ text: SECRET, x: 72, y: 700 }]),
      [66, 694, 296, 716],
    );
    const report = await checkRedaction(bytes);
    expect(report.pendingRedactAnnotations).toBe(1);
    expect(report.verdict).toBe("leak");
  });

  it("recovers text removed in a later incremental save", async () => {
    const original = await makePdf([{ text: `Witness: Jane Q Example`, x: 72, y: 700 }]);
    const updated = await withIncrementalContentUpdate(original, "Witness: [withheld]");
    const reopened = await PDFDocument.load(updated);
    expect(reopened.getPageCount()).toBe(1);

    const report = await checkRedaction(updated);
    expect(report.pages[0].textUnderRects).toEqual([]);
    expect(report.earlierVersions.count).toBe(1);
    expect(report.earlierVersions.removedText.join(" ")).toContain("Jane Q Example");
    expect(report.verdict).toBe("leak");
  });

  it("reports a named term found in the text layer, and only on its page", async () => {
    const bytes = await makePdf([{ text: "Prepared for Jane Q Example", x: 72, y: 700 }]);
    const report = await checkRedaction(bytes, { terms: ["jane q example", "Nobody Else"] });
    expect(report.termHitsByPage).toEqual({ "jane q example": [1] });
    expect(report.termsInBytes).toEqual([]);
    expect(report.verdict).toBe("leak");
  });

  it("warns when the Author metadata survives", async () => {
    const doc = await PDFDocument.load(await makePdf([{ text: "Public text", x: 72, y: 700 }]));
    doc.setAuthor("Jane Q Example");
    const report = await checkRedaction(await doc.save());
    expect(report.metadata).toContainEqual({ key: "Author", value: "Jane Q Example" });
    expect(report.verdict).toBe("warn");
  });

  it("rejects bytes that are not a PDF", async () => {
    await expect(checkRedaction(new TextEncoder().encode("not a pdf"))).rejects.toThrow();
  });
});
