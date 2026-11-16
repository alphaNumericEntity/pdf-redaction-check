import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy, PDFPageProxy } from "pdfjs-dist/types/src/display/api.js";
import type { TextBox } from "./analysis.js";

export type { PDFDocumentProxy };

const pdfjsRoot = dirname(createRequire(import.meta.url).resolve("pdfjs-dist/package.json"));

export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return pdfjs.getDocument({
    data: bytes.slice(),
    cMapUrl: join(pdfjsRoot, "cmaps") + "/",
    cMapPacked: true,
    standardFontDataUrl: join(pdfjsRoot, "standard_fonts") + "/",
    wasmUrl: join(pdfjsRoot, "wasm") + "/",
    iccUrl: join(pdfjsRoot, "iccs") + "/",
    verbosity: pdfjs.VerbosityLevel.ERRORS,
  }).promise;
}

export async function closePdf(doc: PDFDocumentProxy): Promise<void> {
  await doc.loadingTask.destroy();
}

type RenderParameters = Parameters<PDFPageProxy["render"]>[0];

type CanvasAndContext = {
  canvas: unknown;
  context: {
    fillStyle: string;
    fillRect(x: number, y: number, w: number, h: number): void;
    getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
  };
};

type CanvasFactory = {
  create(width: number, height: number): CanvasAndContext;
  destroy(target: CanvasAndContext): void;
};

export async function pageTextBoxes(doc: PDFDocumentProxy, pageNumber: number): Promise<TextBox[]> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale: 1 });
  const content = await page.getTextContent();
  const boxes: TextBox[] = [];
  for (const item of content.items) {
    if (!("str" in item) || item.str.trim().length === 0) continue;
    const tx = pdfjs.Util.transform(viewport.transform, item.transform);
    const fontH = Math.hypot(tx[2], tx[3]);
    boxes.push({
      str: item.str,
      x: tx[4] / viewport.width,
      y: (tx[5] - fontH * 0.8) / viewport.height,
      w: (item.width * viewport.scale) / viewport.width,
      h: fontH / viewport.height,
    });
  }
  return boxes;
}

export async function textItems(doc: PDFDocumentProxy): Promise<string[]> {
  const items: string[] = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent();
    for (const item of content.items) {
      if ("str" in item && item.str.trim().length > 0) items.push(item.str);
    }
  }
  return items;
}

export type RenderedPage = { data: Uint8ClampedArray; width: number; height: number };

export async function renderPage(
  doc: PDFDocumentProxy,
  pageNumber: number,
  scale: number,
): Promise<RenderedPage> {
  const page = await doc.getPage(pageNumber);
  const viewport = page.getViewport({ scale });
  const width = Math.ceil(viewport.width);
  const height = Math.ceil(viewport.height);
  const factory = doc.canvasFactory as CanvasFactory;
  const target = factory.create(width, height);
  try {
    target.context.fillStyle = "#ffffff";
    target.context.fillRect(0, 0, width, height);
    await page.render({
      canvas: target.canvas as RenderParameters["canvas"],
      canvasContext: target.context as unknown as RenderParameters["canvasContext"],
      viewport,
    }).promise;
    const image = target.context.getImageData(0, 0, width, height);
    return { data: image.data, width, height };
  } finally {
    factory.destroy(target);
    page.cleanup();
  }
}
