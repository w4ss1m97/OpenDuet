import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { CvMaster } from "./cv-schema";

/** A tailored CV as one self-contained HTML page (A4, one column, no images). Pure. */

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

const CSS = `@page{size:A4;margin:16mm 15mm}
*{box-sizing:border-box}
body{font-family:Helvetica,Arial,sans-serif;font-size:10pt;line-height:1.4;color:#1a1a1a;margin:0}
h1{font-size:20pt;margin:0 0 2pt}
h2{font-size:11pt;text-transform:uppercase;letter-spacing:.05em;border-bottom:1px solid #888;padding-bottom:2pt;margin:14pt 0 6pt}
.title{font-size:12pt;color:#333;margin:0 0 4pt}
.contact{color:#444;font-size:9pt;margin:0}
.exp{margin-bottom:8pt;break-inside:avoid}
.exp-head{display:flex;justify-content:space-between;font-weight:bold}
.dates{font-weight:normal;color:#444;white-space:nowrap}
.context{font-style:italic;margin:2pt 0}
ul{margin:3pt 0 0 14pt;padding:0}
li{margin-bottom:2pt}
p{margin:0 0 4pt}
.env{font-size:9pt;color:#444}`;

const month = (value: string) => `${value.slice(5, 7)}/${value.slice(0, 4)}`;

export function renderCvHtml(cv: CvMaster, opts: { highlight?: string[] } = {}): string {
  const highlight = new Set((opts.highlight ?? []).map((h) => h.toLowerCase()));
  const e = escapeHtml;
  const h = cv.header;
  const contact = [h.email, h.phone, h.location, h.linkedin && /^https:\/\//i.test(h.linkedin) ? h.linkedin : undefined]
    .filter((v): v is string => Boolean(v))
    .map(e)
    .join(" · ");

  const parts: string[] = [`<h1>${e(h.name)}</h1>`];
  if (cv.titles[0]) parts.push(`<p class="title">${e(cv.titles[0])}</p>`);
  parts.push(`<p class="contact">${contact}</p>`);

  if (cv.profiles[0]) parts.push(`<h2>Profil</h2>`, `<p>${e(cv.profiles[0])}</p>`);
  if (cv.certifications.length) {
    parts.push(`<h2>Certifications</h2>`, `<ul>${cv.certifications.map((c) => `<li>${e(String(c.year))} : ${e(c.name)}</li>`).join("")}</ul>`);
  }
  parts.push(`<h2>Expérience professionnelle</h2>`);
  for (const x of cv.experiences) {
    parts.push(
      `<div class="exp"><div class="exp-head"><span>${e(x.role)}, ${e(x.company)}</span><span class="dates">${e(month(x.start))} - ${x.end ? e(month(x.end)) : "Présent"}</span></div>`,
      x.context ? `<div class="context">${e(x.context)}</div>` : "",
      `<ul>${x.bullets.map((b) => `<li>${e(b.text)}</li>`).join("")}</ul>`,
      x.environment.length ? `<div class="env">Environnement : ${e(x.environment.join(", "))}</div>` : "",
      `</div>`,
    );
  }
  parts.push(`<h2>Compétences techniques</h2>`);
  for (const g of cv.skills) {
    const items = g.items.map((i) => (highlight.has(i.toLowerCase()) ? `<b>${e(i)}</b>` : e(i))).join(", ");
    parts.push(`<p><b>${e(g.group)} :</b> ${items}</p>`);
  }
  if (cv.languages.length) {
    parts.push(`<h2>Langues</h2>`, `<p>${cv.languages.map((l) => `${e(l.name)} (${e(l.level)})`).join(", ")}</p>`);
  }

  return `<!doctype html>
<html lang="fr"><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><meta charset="utf-8"><title>${e(`CV ${h.name}`)}</title><style>${CSS}</style></head>
<body>${parts.filter(Boolean).join("\n")}</body></html>`;
}

export class PdfUnavailable extends Error {
  override name = "PdfUnavailable";
}
export class PdfBusy extends Error {
  override name = "PdfBusy";
}

export type PdfRenderer = (html: string) => Promise<Uint8Array>;

const MAX_CONCURRENT_RENDERS = 2;
const RENDER_CAP_MS = 30_000;
let running = 0;

/** One real render: a browser per call, no network, no script, closed in `finally`. */
async function renderWithChrome(bin: string, html: string): Promise<Uint8Array> {
  const { chromium } = await import("playwright-core");
  let browser: Awaited<ReturnType<typeof chromium.launch>>;
  try {
    browser = await chromium.launch({ executablePath: bin, headless: true, timeout: 15_000 });
  } catch {
    throw new PdfUnavailable("The browser could not be started.");
  }
  try {
    const context = await browser.newContext({ javaScriptEnabled: false, offline: true });
    const page = await context.newPage();
    await page.route("**/*", (route) => route.abort());
    await page.setContent(html, { waitUntil: "load", timeout: 5_000 });
    return await page.pdf({ format: "A4", printBackground: true });
  } finally {
    await browser.close().catch(() => undefined);
  }
}

/**
 * Renders HTML to a PDF with the Chrome at `bin` (absolute path). At most 2 renders at once (a third is
 * PdfBusy), 30 s overall. A missing, relative or unusable binary is PdfUnavailable. Never `--no-sandbox`.
 * `render` replaces the browser step (tests).
 */
export function createPdfRenderer(
  bin: string | undefined,
  render: (bin: string, html: string) => Promise<Uint8Array> = renderWithChrome,
): PdfRenderer {
  return async (html) => {
    if (!bin || !isAbsolute(bin) || !existsSync(bin)) throw new PdfUnavailable("No browser is configured.");
    if (running >= MAX_CONCURRENT_RENDERS) throw new PdfBusy("Too many PDFs are being made.");
    running += 1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cap = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new PdfUnavailable("The PDF took too long.")), RENDER_CAP_MS);
      });
      return await Promise.race([render(bin, html), cap]);
    } finally {
      clearTimeout(timer);
      running -= 1;
    }
  };
}
