import "server-only";
import { PDFDocument, PDFFont, PDFPage, rgb, StandardFonts } from "pdf-lib";
import type { Logo } from "./brandAssets";

// A branded first page for PDF study materials: school logo, what the
// document is, subject, grade and year. The uploaded file itself is never
// changed; the cover is added to the copy that's downloaded.

export type CoverPageInfo = {
  school: string;
  kind: string; // "Question paper", "Study material", ...
  title: string;
  description?: string | null;
  subject: string;
  grade?: number | null; // empty = every grade
  year?: number | null;
};

const INK = rgb(0.07, 0.09, 0.15);
const GREY = rgb(0.4, 0.42, 0.47);
const YELLOW = rgb(1, 0.804, 0.012);
const BLUE = rgb(0, 0.478, 0.78);

// The built-in PDF fonts only cover Western European characters
const WIN_ANSI_EXTRAS = "–—‘’“”•…€";
const safe = (text: string) =>
  text
    .replace(/[   ]/g, " ")
    .replace(/./gu, (ch) => (ch.charCodeAt(0) < 256 || WIN_ANSI_EXTRAS.includes(ch) ? ch : "?"));

const wrap = (text: string, font: PDFFont, size: number, width: number, maxLines: number) => {
  const lines: string[] = [];
  let cur = "";
  for (const word of safe(text).split(/\s+/).filter(Boolean)) {
    const trial = cur ? `${cur} ${word}` : word;
    if (font.widthOfTextAtSize(trial, size) <= width || !cur) cur = trial;
    else {
      lines.push(cur);
      cur = word;
    }
  }
  if (cur) lines.push(cur);
  if (lines.length > maxLines) {
    lines.length = maxLines;
    lines[maxLines - 1] = `${lines[maxLines - 1].replace(/\s+\S*$/, "")}…`;
  }
  return lines;
};

const centred = (page: PDFPage, text: string, y: number, font: PDFFont, size: number, color = INK) => {
  page.drawText(text, { x: (page.getWidth() - font.widthOfTextAtSize(text, size)) / 2, y, size, font, color });
};

// Returns the PDF with the cover in front, or null if the file can't take
// one (e.g. password-protected); then the original is sent as it is.
export const withCoverPage = async (
  original: Uint8Array,
  info: CoverPageInfo,
  logo: Logo | null
): Promise<Uint8Array | null> => {
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(original, { updateMetadata: false });
  } catch {
    return null;
  }
  try {
    const first = doc.getPageCount() > 0 ? doc.getPage(0) : null;
    const portrait = first && first.getHeight() >= first.getWidth();
    // Same size as the document's pages (A4 when unsure)
    const [w, h] = first && portrait ? [first.getWidth(), first.getHeight()] : [595.28, 841.89];
    const page = doc.insertPage(0, [w, h]);
    const regular = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const margin = w * 0.1;
    const width = w - margin * 2;

    // Brand stripe along the top
    page.drawRectangle({ x: 0, y: h - 14, width: w / 2, height: 14, color: YELLOW });
    page.drawRectangle({ x: w / 2, y: h - 14, width: w / 2, height: 14, color: BLUE });

    let y = h - 70;
    if (logo) {
      try {
        const img = logo.type === "png" ? await doc.embedPng(logo.bytes) : await doc.embedJpg(logo.bytes);
        const size = Math.min(h * 0.26, width);
        const lw = (img.width / img.height) * size;
        page.drawImage(img, { x: (w - lw) / 2, y: y - size, width: lw, height: size });
        y -= size + 30;
      } catch {
        // a damaged logo shouldn't stop the download
      }
    }

    centred(page, safe(info.school), y, bold, 16);
    y -= 60;

    // What it is, in a coloured band
    const kind = safe(info.kind.toUpperCase());
    const kw = bold.widthOfTextAtSize(kind, 12) + 32;
    page.drawRectangle({ x: (w - kw) / 2, y: y - 8, width: kw, height: 28, color: BLUE });
    centred(page, kind, y + 1, bold, 12, rgb(1, 1, 1));
    y -= 56;

    for (const line of wrap(info.title, bold, 28, width, 4)) {
      centred(page, line, y, bold, 28);
      y -= 36;
    }
    y -= 14;

    const facts = [
      info.subject,
      info.grade ? `Grade ${info.grade}` : "All grades",
      ...(info.year ? [String(info.year)] : []),
    ].join("   •   ");
    for (const line of wrap(facts, regular, 15, width, 2)) {
      centred(page, line, y, regular, 15, BLUE);
      y -= 22;
    }

    if (info.description?.trim()) {
      y -= 18;
      for (const line of wrap(info.description, regular, 12, width * 0.85, 6)) {
        centred(page, line, y, regular, 12, GREY);
        y -= 17;
      }
    }

    const date = new Intl.DateTimeFormat("en-ZA", { day: "numeric", month: "long", year: "numeric" }).format(new Date());
    page.drawLine({ start: { x: margin, y: 70 }, end: { x: w - margin, y: 70 }, thickness: 0.6, color: rgb(0.85, 0.85, 0.88) });
    centred(page, safe(`${info.school} · Downloaded ${date}`), 50, regular, 10, GREY);

    return await doc.save();
  } catch {
    return null;
  }
};
