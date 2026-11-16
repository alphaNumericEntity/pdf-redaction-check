import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFString, StandardFonts, rgb } from "pdf-lib";

type Line = { text: string; x: number; y: number; size?: number; color?: "black" | "white" };
type Box = { x: number; y: number; w: number; h: number };

export async function makePdf(
  lines: Line[],
  boxes: Box[] = [],
  boxesUnderText = false,
): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const drawBoxes = () => {
    for (const b of boxes) page.drawRectangle({ x: b.x, y: b.y, width: b.w, height: b.h, color: rgb(0, 0, 0) });
  };
  if (boxesUnderText) drawBoxes();
  for (const l of lines) {
    page.drawText(l.text, {
      x: l.x,
      y: l.y,
      size: l.size ?? 14,
      font,
      color: l.color === "white" ? rgb(1, 1, 1) : rgb(0, 0, 0),
    });
  }
  if (!boxesUnderText) drawBoxes();
  return doc.save({ useObjectStreams: false });
}

export async function withRedactAnnotation(bytes: Uint8Array, rect: [number, number, number, number]) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const annot = doc.context.obj({
    Type: "Annot",
    Subtype: "Redact",
    Rect: rect.map((n) => PDFNumber.of(n)),
    Contents: PDFString.of("pending"),
  });
  page.node.set(PDFName.of("Annots"), doc.context.obj([doc.context.register(annot)]));
  return doc.save({ useObjectStreams: false });
}

function latin1Bytes(text: string): Uint8Array {
  return Uint8Array.from(text, (c) => c.charCodeAt(0) & 0xff);
}

// Appends a real incremental update (new objects + xref + trailer with /Prev), the way editors save, so the original bytes stay in the file.
export async function withIncrementalContentUpdate(bytes: Uint8Array, newText: string) {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPages()[0];
  const raw = new TextDecoder("latin1").decode(bytes);
  const prevXref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(raw)![1]);
  const rootRef = doc.context.trailerInfo.Root!.toString();
  const size = doc.context.largestObjectNumber + 1;
  const contentNumber = size;
  const fonts = page.node.Resources()!.lookup(PDFName.of("Font"), PDFDict);
  const fontName = fonts.keys()[0].toString();
  const stream = `BT ${fontName} 14 Tf 72 700 Td (${newText}) Tj ET`;
  const pageNumber = page.ref.objectNumber;

  let out = raw.endsWith("\n") ? "" : "\n";
  const offsets: Record<number, number> = {};
  const base = bytes.length;
  const append = (s: string) => {
    out += s;
  };
  offsets[contentNumber] = base + out.length;
  append(`${contentNumber} 0 obj\n<< /Length ${stream.length} >>\nstream\n${stream}\nendstream\nendobj\n`);
  offsets[pageNumber] = base + out.length;
  const pageDict = page.node.toString().replace(/\/Contents\s+[^/>]+/, `/Contents ${contentNumber} 0 R `);
  append(`${pageNumber} 0 obj\n${pageDict}\nendobj\n`);
  const xrefOffset = base + out.length;
  const entry = (n: number) => `${String(offsets[n]).padStart(10, "0")} 00000 n \n`;
  append(`xref\n${pageNumber} 1\n${entry(pageNumber)}${contentNumber} 1\n${entry(contentNumber)}`);
  append(`trailer\n<< /Size ${size + 1} /Root ${rootRef} /Prev ${prevXref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`);

  const merged = new Uint8Array(bytes.length + out.length);
  merged.set(bytes, 0);
  merged.set(latin1Bytes(out), bytes.length);
  return merged;
}
