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

const { RATES_ENDPOINT, RATES_API_TOKEN, RATES_SOURCE_URL, DEBUG } = process.env;

if (!RATES_ENDPOINT) throw new Error("Missing env: RATES_ENDPOINT");
if (!RATES_API_TOKEN) throw new Error("Missing env: RATES_API_TOKEN");
if (!RATES_SOURCE_URL) throw new Error("Missing env: RATES_SOURCE_URL");

const debug = !!DEBUG;

function log(...args) {
  if (debug) console.log(...args);
}

function parsePercentToNumber(v) {
  if (v == null) return null;
  const s = String(v).trim();
  const cleaned = s.replace(/[%\s]/g, "").replace(/,/g, "");
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function normalizeDateText(s) {
  if (!s) return null;
  return String(s).trim().replace(/\s+/g, " ");
}

function firstDateLike(text) {
  // matches "20 Jan 2026" etc
  const m = String(text || "").match(/\b\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\b/);
  return m ? normalizeDateText(m[0]) : null;
}

async function findCardRootByHeading(page, headingText) {
  // Find the element containing the heading text, then climb to a parent that contains a table
  const heading = page.locator(`text=${headingText}`).first();
  await heading.waitFor({ state: "visible", timeout: 30000 });

  const cardHandle = await heading.evaluateHandle((el) => {
    let cur = el;
    for (let i = 0; i < 16; i++) {
      if (!cur) break;
      // "card-like" container that contains a table
      const hasTable = !!cur.querySelector?.("table");
      if (hasTable) return cur;
      cur = cur.parentElement;
    }
    return null;
  });

  const card = cardHandle.asElement();
  if (!card) throw new Error(`Could not find card root for heading: ${headingText}`);
  return card;
}

async function findTableWithin(cardEl) {
  const tableHandle = await cardEl.evaluateHandle((card) => card.querySelector("table") || null);
  const table = tableHandle.asElement();
  if (!table) throw new Error("Could not find table inside card");
  return table;
}

async function extractThreeHeaderDates(tableEl) {
  // Pull THEAD th text first (most reliable for column order)
  const headerDates = await tableEl.evaluate((table) => {
    const ths = Array.from(table.querySelectorAll("thead th")).map((th) =>
      (th.textContent || "").trim()
    );

    const looksLikeDate = (t) => /\b\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\b/.test(t);

    // Many tables: first th is "Term", next three are the dates
    // Keep order as displayed.
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

  // Fallback: scan only the table header area text (avoid footer "Updated ..." as much as possible)
  const fallback = await tableEl.evaluate((table) => {
    const head = table.querySelector("thead");
    const text = (head ? head.textContent : table.textContent) || "";
    const matches = text.match(/\b\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\b/g) || [];
    const uniq = [];
    for (const m of matches) {
      const v = m.trim();
      if (!uniq.includes(v)) uniq.push(v);
      if (uniq.length === 3) break;
    }
    return uniq;
  });

  if (fallback.length === 3) {
    return {
      col1: normalizeDateText(fallback[0]),
      col2: normalizeDateText(fallback[1]),
      col3: normalizeDateText(fallback[2]),
    };
  }

  throw new Error("Could not extract 3 header dates from table");
}

async function extractUpdatedDateFromCard(cardEl) {
  // Card contains a footer like: "Updated 21 Jan 2026 | 18:45 ET"
  // We grab the first date-like string in the entire card text that appears near "Updated".
  const updatedText = await cardEl.evaluate((card) => {
    const full = (card.textContent || "").replace(/\s+/g, " ").trim();
    // Narrow to substring around "Updated" if present
    const idx = full.toLowerCase().lastIndexOf("updated");
    if (idx >= 0) return full.slice(idx, Math.min(full.length, idx + 120));
    return full; // fallback
  });

  const d = firstDateLike(updatedText);
  if (!d) throw new Error(`Could not find Updated date in card text: ${updatedText}`);
  return d;
}

async function extractRatesFromTreasuryTable(tableEl) {
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
      if (tds.length >= 4) {
        out.push({ termLabel: tds[0], col1: tds[1], col2: tds[2], col3: tds[3] });
      }
    }
    return out;
  });

  const treasury = {};
  for (const r of rows) {
    const key = mapKey(r.termLabel);
    if (!key) continue;

    const c1 = parsePercentToNumber(r.col1);
    const c2 = parsePercentToNumber(r.col2);
    const c3 = parsePercentToNumber(r.col3);

    if (c1 == null || c2 == null || c3 == null) continue;

    treasury[key] = { col1: c1, col2: c2, col3: c3 };
  }

  const required = ["1y", "2y", "3y", "5y", "7y", "10y", "30y"];
  for (const k of required) {
    if (!treasury[k]) throw new Error(`Missing treasury row for term_key: ${k}`);
  }

  return treasury;
}

async function extractRatesFromSofrTable(tableEl) {
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
      if (tds.length >= 4) {
        out.push({ termLabel: tds[0], col1: tds[1], col2: tds[2], col3: tds[3] });
      }
    }
    return out;
  });

  const sofr = {};
  for (const r of rows) {
    const key = mapKey(r.termLabel);
    if (!key) continue;

    const c1 = parsePercentToNumber(r.col1);
    const c2 = parsePercentToNumber(r.col2);
    const c3 = parsePercentToNumber(r.col3);

    if (c1 == null || c2 == null || c3 == null) continue;

    sofr[key] = { col1: c1, col2: c2, col3: c3 };
  }

  const required = ["sofr", "30d-avg", "90d-avg", "1m-term", "3m-term"];
  for (const k of required) {
    if (!sofr[k]) throw new Error(`Missing SOFR row for term_key: ${k}`);
  }

  return sofr;
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setViewportSize({ width: 1400, height: 900 });

  log("Navigating to:", RATES_SOURCE_URL);
  await page.goto(RATES_SOURCE_URL, { waitUntil: "networkidle", timeout: 60000 });

  // Some pages lazy-load; give it a beat
  await page.waitForTimeout(1500);

  // Find each card root and its table
  const treasuryCard = await findCardRootByHeading(page, "U.S. Treasuries");
  const sofrCard = await findCardRootByHeading(page, "Secured Overnight Financing Rate (SOFR)");

  const treasuryTable = await findTableWithin(treasuryCard);
  const sofrTable = await findTableWithin(sofrCard);

  // 3 column header dates (these should power your UI column headers)
  const treasury_dates = await extractThreeHeaderDates(treasuryTable);
  const sofr_dates = await extractThreeHeaderDates(sofrTable);

  // "Updated ..." dates (metadata; your edge function currently requires these)
  const treasuryUpdated = await extractUpdatedDateFromCard(treasuryCard);
  const sofrUpdated = await extractUpdatedDateFromCard(sofrCard);

  const treasury = await extractRatesFromTreasuryTable(treasuryTable);
  const sofr = await extractRatesFromSofrTable(sofrTable);

  // Payload includes BOTH:
  // - dates: required by edge function (Updated dates)
  // - treasury_dates/sofr_dates: needed for UI column headers
  const payload = {
    dates: {
      treasury: treasuryUpdated,
      sofr: sofrUpdated,
    },
    treasury_dates,
    sofr_dates,
    treasury,
    sofr,
  };

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
