// run.mjs
import { chromium } from "playwright";

/**
 * ENV required in GitHub Actions:
 * - RATES_ENDPOINT      (your Supabase edge function endpoint)
 * - RATES_API_TOKEN     (Bearer token)
 * - RATES_SOURCE_URL    (the web page that shows BOTH tables)
 *
 * Optional:
 * - DEBUG=1
 */

const {
  RATES_ENDPOINT,
  RATES_API_TOKEN,
  RATES_SOURCE_URL,
  DEBUG,
} = process.env;

if (!RATES_ENDPOINT) throw new Error("Missing env: RATES_ENDPOINT");
if (!RATES_API_TOKEN) throw new Error("Missing env: RATES_API_TOKEN");
if (!RATES_SOURCE_URL) throw new Error("Missing env: RATES_SOURCE_URL");

const debug = !!DEBUG;

function log(...args) {
  if (debug) console.log(...args);
}

function parsePercentToNumber(v) {
  // accepts "3.528%", "3.65000%", "4.07237%", "3.53" etc
  if (v == null) return null;
  const s = String(v).trim();
  const cleaned = s.replace(/[%\s]/g, "").replace(/,/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeDateText(s) {
  // Keep display style like "16 Jan 2026"
  if (!s) return null;
  return String(s).trim();
}

async function findCardTableByHeading(page, headingText) {
  const heading = page.locator(`text=${headingText}`).first();
  await heading.waitFor({ state: "visible", timeout: 30000 });

  const tableHandle = await heading.evaluateHandle((el) => {
    let cur = el;
    for (let i = 0; i < 14; i++) {
      if (!cur) break;
      const t = cur.querySelector?.("table");
      if (t) return t;
      cur = cur.parentElement;
    }
    return null;
  });

  const table = tableHandle.asElement();
  if (!table) throw new Error(`Could not find table for heading: ${headingText}`);
  return table;
}

async function extractThreeDatesFromTable(tableEl) {
  const headerDates = await tableEl.evaluate((table) => {
    const ths = Array.from(table.querySelectorAll("thead th")).map((th) =>
      (th.textContent || "").trim()
    );

    const looksLikeDate = (t) =>
      /\b\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\b/.test(t);

    const dateCandidates = ths.filter(looksLikeDate);
    return dateCandidates.slice(0, 3);
  });

  if (headerDates && headerDates.length === 3) {
    return {
      col1: normalizeDateText(headerDates[0]),
      col2: normalizeDateText(headerDates[1]),
      col3: normalizeDateText(headerDates[2]),
    };
  }

  const fallbackDates = await tableEl.evaluate((table) => {
    const text = (table.textContent || "").trim();
    const matches = text.match(/\b\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\b/g) || [];
    const uniq = [];
    for (const m of matches) {
      if (!uniq.includes(m)) uniq.push(m);
      if (uniq.length === 3) break;
    }
    return uniq;
  });

  if (fallbackDates.length === 3) {
    return {
      col1: normalizeDateText(fallbackDates[0]),
      col2: normalizeDateText(fallbackDates[1]),
      col3: normalizeDateText(fallbackDates[2]),
    };
  }

  throw new Error("Could not extract 3 dates from table");
}

async function extractLatestRatesFromTreasuryTable(tableEl) {
  // Map row label -> term_key
  const mapKey = (label) => {
    const t = label.toLowerCase().replace(/\s+/g, "");
    if (t.startsWith("1year")) return "1y";
    if (t.startsWith("2year")) return "2y";
    if (t.startsWith("3year")) return "3y";
    if (t.startsWith("5year")) return "5y";
    if (t.startsWith("7year")) return "7y";
    if (t.startsWith("10year")) return "10y";
    if (t.startsWith("30year")) return "30y";
    return null;
  };

  const rows = await tableEl.evaluate((table) => {
    const out = [];
    const trs = Array.from(table.querySelectorAll("tbody tr"));
    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll("td")).map((td) =>
        (td.textContent || "").trim()
      );
      // Expected: [TermLabel, col1, col2, col3]
      if (tds.length >= 4) {
        out.push({
          termLabel: tds[0],
          col1: tds[1],
          col2: tds[2],
          col3: tds[3],
        });
      }
    }
    return out;
  });

  // NEW CONTRACT: only send latest (col1) numbers
  const treasury = {};
  for (const r of rows) {
    const key = mapKey(r.termLabel);
    if (!key) continue;

    const latest = parsePercentToNumber(r.col1);
    if (latest == null) continue;

    treasury[key] = latest;
  }

  const required = ["1y", "2y", "3y", "5y", "7y", "10y", "30y"];
  for (const k of required) {
    if (treasury[k] == null) throw new Error(`Missing treasury term: ${k}`);
  }

  return treasury;
}

async function extractLatestRatesFromSofrTable(tableEl) {
  const mapKey = (label) => {
    const t = label.toLowerCase().trim();
    if (t === "sofr") return "sofr";
    if (t.includes("30-day") && t.includes("average")) return "30d-avg";
    if (t.includes("90-day") && t.includes("average")) return "90d-avg";
    if (t.includes("1-month") && t.includes("term")) return "1m-term";
    if (t.includes("3-month") && t.includes("term")) return "3m-term";
    return null;
  };

  const rows = await tableEl.evaluate((table) => {
    const out = [];
    const trs = Array.from(table.querySelectorAll("tbody tr"));
    for (const tr of trs) {
      const tds = Array.from(tr.querySelectorAll("td")).map((td) =>
        (td.textContent || "").trim()
      );
      // Expected: [TermLabel, col1, col2, col3]
      if (tds.length >= 4) {
        out.push({
          termLabel: tds[0],
          col1: tds[1],
          col2: tds[2],
          col3: tds[3],
        });
      }
    }
    return out;
  });

  // NEW CONTRACT: only send latest (col1) numbers
  const sofr = {};
  for (const r of rows) {
    const key = mapKey(r.termLabel);
    if (!key) continue;

    const latest = parsePercentToNumber(r.col1);
    if (latest == null) continue;

    sofr[key] = latest;
  }

  const required = ["sofr", "30d-avg", "90d-avg", "1m-term", "3m-term"];
  for (const k of required) {
    if (sofr[k] == null) throw new Error(`Missing SOFR term: ${k}`);
  }

  return sofr;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setViewportSize({ width: 1400, height: 900 });

  log("Navigating to:", RATES_SOURCE_URL);
  await page.goto(RATES_SOURCE_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Lazy-load buffer
  await page.waitForTimeout(1500);

  const treasuryTable = await findCardTableByHeading(page, "U.S. Treasuries");
  const sofrTable = await findCardTableByHeading(
    page,
    "Secured Overnight Financing Rate (SOFR)"
  );

  const treasuryDates3 = await extractThreeDatesFromTable(treasuryTable);
  const sofrDates3 = await extractThreeDatesFromTable(sofrTable);

  // NEW CONTRACT: "dates" object with one string each (use latest/col1)
  const dates = {
    treasury: treasuryDates3.col1,
    sofr: sofrDates3.col1,
  };

  const treasury = await extractLatestRatesFromTreasuryTable(treasuryTable);
  const sofr = await extractLatestRatesFromSofrTable(sofrTable);

  const payload = { dates, treasury, sofr };

  console.log("Posting:", JSON.stringify(payload, null, 2));

  const res = await fetch(RATES_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${RATES_API_TOKEN}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Edge function error ${res.status}: ${text}`);
  }

  console.log("Success:", text);

  await browser.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
