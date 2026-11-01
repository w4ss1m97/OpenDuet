import { expect, test } from "bun:test";
import { PdfBusy, PdfUnavailable, createPdfRenderer, renderCvHtml } from "../src/openduet/job-offers/cv-render";
import { cvMasterFixture } from "./fixtures/cv-master";

/** The PDF step: a real Chrome when OPENDUET_CHROME_BIN is set, stubs otherwise. */

const bin = process.env.OPENDUET_CHROME_BIN;

test.skipIf(!bin)("renders a real PDF", async () => {
  const pdf = await createPdfRenderer(bin)(renderCvHtml(cvMasterFixture));
  expect(new TextDecoder().decode(pdf.slice(0, 5))).toBe("%PDF-");
}, 40_000);

test("a missing, relative or unknown binary is PdfUnavailable", async () => {
  for (const wrong of [undefined, "", "chrome", "./chrome", "/nonexistent/chrome"]) {
    await expect(createPdfRenderer(wrong)("<p>x</p>")).rejects.toBeInstanceOf(PdfUnavailable);
  }
});

test("a third concurrent render is PdfBusy, and a slot frees up afterwards", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  const render = createPdfRenderer(process.execPath, async () => {
    await gate;
    return new Uint8Array([1]);
  });
  const first = render("a");
  const second = render("b");
  await expect(render("c")).rejects.toBeInstanceOf(PdfBusy);
  release();
  await Promise.all([first, second]);
  expect((await render("d")).length).toBe(1);
});

test("a render that throws frees its slot", async () => {
  const render = createPdfRenderer(process.execPath, async () => {
    throw new Error("boom");
  });
  for (let i = 0; i < 4; i++) await expect(render("x")).rejects.toThrow("boom");
});
