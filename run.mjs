import { chromium } from "playwright";

const ENDPOINT = process.env.RATES_ENDPOINT;
const TOKEN = process.env.RATES_API_TOKEN;

if (!ENDPOINT || !TOKEN) {
  throw new Error("Missing RATES_ENDPOINT or RATES_API_TOKEN env vars");
}

function toNumber(s) {
  const cleaned = String(s).replace(/[%\s,]/g, "").trim();
  const n = Number(cleaned);
  if (Number.isNaN(n)) throw new Error(`Could not parse number from: ${s}`);
  return n;
}

function normalizeKey(label) {
  const m = label.match(/^(\d+)\s*Year$/i);
  if (m) return `${m[1]}y`;
  return label.toLowerCase();
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

await page.goto("https://www.chathamfinancial.com/rates", {
  waitUntil: "networkidle",
  timeout: 120000,
});

await page.locator("text=U.S. Treasuries").first().waitFor({ timeout: 120000 });
await page.locator("text=SOFR").first().waitFor({ timeout: 120000 });

async function scrapeTable(afterText) {
  const table = page
    .locator(`xpath=//*[contains(normalize-space(.), "${afterText}")]/following::table[1]`)
    .first();
  await table.waitFor({ timeout: 120000 });

  const rows = table.locator("tbody tr");
  const count = await rows.count();
  if (!count) throw new Error(`No rows for ${afterText}`);

  const out = [];
  for (let i = 0; i < count; i++) {
    const cells = rows.nth(i).locator("td");
    if ((await cells.count()) < 2) continue;
    out.push({
      label: (await cells.nth(0).innerText()).trim(),
      value: (await cells.nth(1).innerText()).trim(),
    });
  }
  return out;
}

const treasuryRows = await scrapeTable("U.S. Treasuries");
const treasury = {};
for (const r of treasuryRows) {
  const k = normalizeKey(r.label);
  if (["1y", "2y", "3y", "5y", "7y", "10y", "30y"].includes(k)) {
    treasury[k] = toNumber(r.value);
  }
}

const sofrRows = await scrapeTable("SOFR");
const sofr = {};
for (const r of sofrRows) {
  const l = r.label.toLowerCase();
  if (l === "sofr") sofr["sofr"] = toNumber(r.value);
  if (l.includes("30-day")) sofr["30d-avg"] = toNumber(r.value);
  if (l.includes("90-day")) sofr["90d-avg"] = toNumber(r.value);
  if (l.includes("1-month")) sofr["1m-term"] = toNumber(r.value);
  if (l.includes("3-month")) sofr["3m-term"] = toNumber(r.value);
}

await browser.close();

const payload = { date: todayISO(), treasury, sofr };

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify(payload),
});

const text = await res.text();
if (!res.ok) throw new Error(text);
console.log(text);
