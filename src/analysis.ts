export type Rect = { x: number; y: number; w: number; h: number };

export type TextBox = { str: string; x: number; y: number; w: number; h: number };

const DARK_LUMA = 48;
const MIN_FILL = 0.85;
const MAX_PAGE_FRACTION = 0.6;
const MIN_REMOVED_CHARS = 3;
const REVISION_END = /startxref\s+(\d+)\s+%%EOF/g;

export function latin1(bytes: Uint8Array): string {
  let out = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    out += String.fromCharCode(...bytes.subarray(i, Math.min(i + chunk, bytes.length)));
  }
  return out;
}

export function bytesContainText(bytes: Uint8Array, term: string): boolean {
  return latin1(bytes).toLowerCase().includes(term.trim().toLowerCase());
}

// A linearized file's first-page section also ends in startxref/%%EOF, and no real xref sits at offset 0; neither is an earlier version.
export function earlierRevisionEnds(raw: string): number[] {
  const matches = [...raw.matchAll(REVISION_END)];
  if (/\/Linearized\b/.test(raw.slice(0, 1024))) matches.shift();
  const ends = matches.filter((m) => Number(m[1]) !== 0).map((m) => (m.index ?? 0) + m[0].length);
  return ends.slice(0, -1);
}

function squash(text: string): string {
  return text.replace(/\s+/g, "").toLowerCase();
}

export function removedText(earlierItems: string[], currentItems: string[]): string[] {
  const current = currentItems.map(squash);
  const exact = new Set(current);
  const whole = current.join("");
  const out = new Map<string, string>();
  for (const item of earlierItems) {
    const key = squash(item);
    if (key.length < MIN_REMOVED_CHARS || out.has(key) || exact.has(key) || whole.includes(key)) {
      continue;
    }
    out.set(key, item.replace(/\s+/g, " ").trim().slice(0, 80));
  }
  return [...out.values()];
}

export function darkMask(data: Uint8ClampedArray, width: number, height: number): Uint8Array {
  const dark = new Uint8Array(width * height);
  for (let i = 0, p = 0; i < dark.length; i++, p += 4) {
    const luma = 0.299 * data[p] + 0.587 * data[p + 1] + 0.114 * data[p + 2];
    if (luma < DARK_LUMA && data[p + 3] > 127) dark[i] = 1;
  }
  return dark;
}

export function findDarkRects(
  dark: Uint8Array,
  width: number,
  height: number,
  minWidthPx = 10,
  minHeightPx = 5,
): Rect[] {
  const seen = new Uint8Array(width * height);
  const rects: Rect[] = [];
  const stack: number[] = [];
  for (let start = 0; start < dark.length; start++) {
    if (!dark[start] || seen[start]) continue;
    let minX = width;
    let maxX = -1;
    let minY = height;
    let maxY = -1;
    let count = 0;
    stack.push(start);
    seen[start] = 1;
    while (stack.length > 0) {
      const idx = stack.pop() as number;
      const x = idx % width;
      const y = (idx - x) / width;
      count++;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
      const neighbours = [idx - 1, idx + 1, idx - width, idx + width];
      if (x === 0) neighbours[0] = -1;
      if (x === width - 1) neighbours[1] = -1;
      for (const n of neighbours) {
        if (n >= 0 && n < dark.length && dark[n] && !seen[n]) {
          seen[n] = 1;
          stack.push(n);
        }
      }
    }
    const w = maxX - minX + 1;
    const h = maxY - minY + 1;
    if (w < minWidthPx || h < minHeightPx) continue;
    if (count / (w * h) < MIN_FILL) continue;
    if ((w * h) / (width * height) > MAX_PAGE_FRACTION) continue;
    rects.push({ x: minX / width, y: minY / height, w: w / width, h: h / height });
  }
  return rects;
}

function darkFraction(
  dark: Uint8Array,
  width: number,
  height: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): number {
  const px0 = Math.max(0, Math.floor(x0 * width));
  const px1 = Math.min(width, Math.ceil(x1 * width));
  const py0 = Math.max(0, Math.floor(y0 * height));
  const py1 = Math.min(height, Math.ceil(y1 * height));
  const total = (px1 - px0) * (py1 - py0);
  if (total < 12) return 0;
  let count = 0;
  for (let y = py0; y < py1; y++) {
    for (let x = px0; x < px1; x++) count += dark[y * width + x];
  }
  return count / total;
}

function coveredSubstring(str: string, from: number, to: number): string {
  let start = Math.max(0, Math.floor(from * str.length));
  let end = Math.min(str.length, Math.ceil(to * str.length));
  while (start > 0 && str[start - 1] !== " ") start--;
  while (end < str.length && str[end] !== " ") end++;
  return str.slice(start, end).trim();
}

// Covered text sits on uniformly dark pixels; visible light-on-dark text leaves light glyph pixels, so it is not a leak.
export function hiddenText(
  items: TextBox[],
  rects: Rect[],
  dark: Uint8Array,
  width: number,
  height: number,
): string[] {
  const out: string[] = [];
  for (const item of items) {
    if (item.w <= 0 || item.h <= 0) continue;
    for (const r of rects) {
      const x0 = Math.max(item.x, r.x);
      const x1 = Math.min(item.x + item.w, r.x + r.w);
      const y0 = Math.max(item.y, r.y);
      const y1 = Math.min(item.y + item.h, r.y + r.h);
      if (x1 - x0 < item.w * 0.15 || y1 - y0 < item.h * 0.5) continue;
      if (darkFraction(dark, width, height, x0, y0, x1, y1) < 0.97) continue;
      const text = coveredSubstring(item.str, (x0 - item.x) / item.w, (x1 - item.x) / item.w).slice(
        0,
        80,
      );
      if (text.length > 0) out.push(text);
    }
  }
  return [...new Set(out)];
}
