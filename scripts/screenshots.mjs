/**
 * Captures the screenshots used in the README.
 *
 * Kept in the repo rather than run ad hoc: the UI moves, and a caption that no
 * longer matches the picture is worse than no picture. Needs the app running on
 * :3000 with the samples seeded.
 *
 *   npm start & npm run seed && node scripts/screenshots.mjs
 */

import { chromium } from "playwright";

const OUT = "docs/screenshots";
const BASE = process.env.BASE_URL ?? "http://localhost:3000";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 });

const shot = async (name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${OUT}/${name}.png` });
  console.log(`  ${name}.png`);
};

/** Sends a question and waits for the stream to open and then close. */
const ask = async (question) => {
  await page.getByPlaceholder(/Ask about|Load or upload/).fill(question);
  await page.keyboard.press("Enter");
  const stop = page.getByRole("button", { name: "Stop" });
  await stop.waitFor({ state: "visible", timeout: 30_000 });
  await stop.waitFor({ state: "detached", timeout: 180_000 });
  await page.waitForTimeout(600);
};

const newConversation = async () => {
  await page.getByRole("button", { name: /New conversation/i }).click();
  await page.waitForTimeout(300);
};

await page.goto(BASE, { waitUntil: "networkidle" });
await shot("01-workspace");

// Spans two meetings a month apart, which is the part worth showing.
await ask("Did we reverse any earlier architecture decision, and what forced it?");
await shot("02-answer-with-sources");

await page.getByRole("button", { name: /^trace$/i }).click();
await shot("03-trace-inspector");

// The brief is per-meeting, so narrow the selection to one before opening the tab.
// The postmortem, because its brief is the one carrying a `reversed` decision.
const postmortem = page.getByRole("checkbox").nth(3);
await postmortem.check();
await page.getByRole("button", { name: /^brief$/i }).click();
await page.waitForTimeout(1500);
await shot("04-meeting-brief");
await postmortem.uncheck();

await page.getByRole("button", { name: /sources/i }).click();
await page.getByRole("button", { name: /Open in\s+transcript/i }).first().click();
await page.waitForTimeout(700);
await shot("05-transcript-viewer");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

await page.getByRole("button", { name: "+ Add meetings" }).click();
await page.waitForTimeout(500);
await shot("06-upload");
await page.keyboard.press("Escape");
await page.waitForTimeout(300);

await newConversation();
await ask("What is the company's parental leave policy?");
await shot("07-declined");

await newConversation();
await ask("Who owns the webhook fix and when is it due?");
await shot("08-noisy-transcript");

await browser.close();
console.log("done");
