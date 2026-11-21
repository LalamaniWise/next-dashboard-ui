import "server-only";
import { readFile } from "fs/promises";
import path from "path";
import { readStoredFile } from "./fileStore";
import prisma from "./prisma";

// The logo and fonts used on generated pictures and PDFs (video covers, fee
// statements, study-material cover pages)

export const BRAND_YELLOW = "#FFCD03";
export const BRAND_BLUE = "#007AC7";

export type Logo = { bytes: Uint8Array; type: "png" | "jpg" };

const DEFAULT_LOGO = () => path.join(process.cwd(), "public", "logo.png");

// PDFs and covers can only use PNG or JPG; a WebP upload falls back to the
// built-in logo
const typeOf = (file: string): Logo["type"] | null => {
  const ext = path.extname(file).toLowerCase();
  return ext === ".png" ? "png" : ext === ".jpg" || ext === ".jpeg" ? "jpg" : null;
};

export const loadLogo = async (): Promise<Logo | null> => {
  const setting = await prisma.setting
    .findUnique({ where: { id: 1 }, select: { logoFile: true } })
    .catch(() => null);
  const uploaded = setting?.logoFile ? path.basename(setting.logoFile) : null;
  if (uploaded && typeOf(uploaded)) {
    const bytes = await readStoredFile("branding", uploaded);
    if (bytes) return { bytes, type: typeOf(uploaded)! };
  }
  const bytes = await readFile(DEFAULT_LOGO()).catch(() => null);
  return bytes ? { bytes: new Uint8Array(bytes), type: "png" } : null;
};

export const logoDataUrl = (logo: Logo) =>
  `data:image/${logo.type === "png" ? "png" : "jpeg"};base64,${Buffer.from(logo.bytes).toString("base64")}`;

const fontCache = new Map<string, Promise<Buffer>>();

// Inter (assets/fonts, SIL Open Font License)
export const loadFont = (weight: "Regular" | "SemiBold" | "Bold" | "ExtraBold") => {
  if (!fontCache.has(weight)) {
    fontCache.set(weight, readFile(path.join(process.cwd(), "assets", "fonts", `Inter-${weight}.otf`)));
  }
  return fontCache.get(weight)!;
};

// "Grade 12", "Grades 10–12", "Grades 8, 10 & 12"; empty means all grades
export const gradesLabel = (levels: number[]) => {
  const g = [...new Set(levels)].sort((a, b) => a - b);
  if (g.length === 0) return "All grades";
  if (g.length === 1) return `Grade ${g[0]}`;
  const consecutive = g.every((v, i) => i === 0 || v === g[i - 1] + 1);
  if (consecutive && g.length > 2) return `Grades ${g[0]}–${g[g.length - 1]}`;
  return `Grades ${g.slice(0, -1).join(", ")} & ${g[g.length - 1]}`;
};
