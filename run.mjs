import { chromium } from "playwright";

const ENDPOINT = process.env.RATES_ENDPOINT;
const TOKEN = process.env.RATES_API_TOKEN;

if (!ENDPOINT || !TOKEN) {
  throw new Error("Missing RATES_ENDPOINT or RATES_API_TOKEN env vars");
}

function toNumber(s) {
  // Handles "3.650%" → 3.65 and trims whitespace
  const cleaned = String(s).replace(/[%\s,]/g, "").trim();
  const n = Number(cleaned);
  if (Number.isNaN(n)) throw new Error(`Could not parse number from: ${s}`);
  return n;
}

function normalizeTreasuryKey(label) {
  // "1 Year" -> "1y"
  const m = label.match(/^(\d+)\s*Year$/i);
  if (m) return `${m[1]}y`;
  return null;
}

async function scrapeCardTable(page, titleText) {
  // First table after a heading containing titleText
  const table = page
    .locator(`xpath=//*[contains(normalize-space(.), "${titleText}")]/following::table[1]`)
    .first();
  await table.waitFor({ timeout: 120000 });

  // Expect 4 headers: Term + 3 date columns
  const ths = table.locator("thead tr th");
  const thCount = await ths.count();
  if (thCount < 4) throw new Error(`Unexpected header count for ${titleText}: ${thCount}`);

  const date1 = (await ths.nth(1).innerText()).trim();
  const date2 = (await ths.nth(2).innerText()).trim();
  const date3 = (await ths.nth(3).innerText()).trim();

  const rows = table.locator("tbody tr");
  const rowCount = await rows.count();
  if (!rowCount) throw new Error(`No rows for ${titleText}`);

  const data = [];
  for (let i = 0; i < rowCount; i++) {
    const tds = rows.nth(i).locator("td");
    const c = await tds.count();
    if (c < 4) continue;

    const term = (await tds.nth(0).innerText()).trim();
    const v1 = (await tds.nth(1).innerText()).trim();
    const v2 = (await tds.nth(2).innerText()).trim();
    const v3 = (await tds.nth(3).innerText()).trim();

    data.push({ term, v1, v2, v3 });
  }

  return { dates: { col1: date1, col2: date2, col3: date3 }, data };
}

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });

await page.goto("https://www.chathamfinancial.com/rates", {
  waitUntil: "networkidle",
  timeout: 120000,
});

await page.locator("text=U.S. Treasuries").first().waitFor({ timeout: 120000 });
await page.locator("text=SOFR").first().waitFor({ timeout: 120000 });

// --- Treasuries ---
const treas = await scrapeCardTable(page, "U.S. Treasuries");
const treasury = {};
for (const r of treas.data) {
  const key = normalizeTreasuryKey(r.term);
  if (!key) continue;
  if (["1y", "2y", "3y", "5y", "7y", "10y", "30y"].includes(key)) {
    treasury[key] = {
      col1: toNumber(r.v1),
      col2: toNumber(r.v2),
      col3: toNumber(r.v3),
    };
  }
}

// --- SOFR ---
const sofrTable = await scrapeCardTable(page, "SOFR");
const sofr = {};
for (const r of sofrTable.data) {
  const label = r.term.toLowerCase();
  const payload = {
    col1: toNumber(r.v1),
    col2: toNumber(r.v2),
    col3: toNumber(r.v3),
  };

  if (label === "sofr") sofr["sofr"] = payload;
  else if (label.includes("30-day") && label.includes("average")) sofr["30d-avg"] = payload;
  else if (label.includes("90-day") && label.includes("average")) sofr["90d-avg"] = payload;
  else if (label.includes("1-month") && label.includes("term")) sofr["1m-term"] = payload;
  else if (label.includes("3-month") && label.includes("term")) sofr["3m-term"] = payload;
}

await browser.close();

// Use SOFR dates if present; otherwise Treasuries dates
const dates = sofrTable?.dates || treas.dates;

const body = { dates, treasury, sofr };

console.log("Posting:", JSON.stringify(body, null, 2));

const res = await fetch(ENDPOINT, {
  method: "POST",
  headers: {
    Authorization: `Bearer ${TOKEN}`,
    "Content-Type": "application/json",
    "x-debug-payload": "1", // <— enables echo in response (per Lovable)
  },
  body: JSON.stringify(body),
});

const text = await res.text();
if (!res.ok) {
  throw new Error(`POST failed ${res.status}: ${text}`);
}

console.log("Success:", text);
