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

const DATE_RE = /\b\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\b/g;

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
  const m = String(text || "").match(/\b\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\b/);
  return m ? normalizeDateText(m[0]) : null;
}

/**
 * IMPORTANT: The previous bug was that the "card root" returned
 * a parent container that included BOTH tables (Treasuries + SOFR).
 * Then "Updated ..." could be taken from the wrong card.
 *
 * Fix: climb until we find an ancestor that contains EXACTLY ONE table.
 */
async function findCardRootByHeading(page, headingText) {
  const heading = page.locator(`text=${headingText}`).first();
  await heading.waitFor({ state: "visible", timeout: 30000 });

  const cardHandle = await heading.evaluateHandle((el) => {
    let cur = el;
    for (let i = 0; i < 24; i++) {
      if (!cur) break;

      const tables = cur.querySelectorAll?.("table")?.length ?? 0;
      if (tables === 1) {
        return cur;
      }

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

/**
 * Extract the 3 COLUMN HEADER DATES as displayed above the table.
 *
 * On Chatham, these dates are often NOT inside <thead>.
 * The most robust method is:
 * - find the <table>
 * - walk the DOM within the card, collecting date-like text that appears BEFORE the table
 * - take the first 3 unique dates in DOM order
 */
async function extractThreeHeaderDatesFromCard(cardEl) {
  const dates = await cardEl.evaluate((card) => {
    const DATE_RE = /\b\d{1,2}\s+[A-Za-z]{3}\s+\d{4}\b/g;

    const table = card.querySelector("table");
    if (!table) return [];

    // Helper: does node appear before table in DOM order?
    const isBeforeTable = (node) => {
      const pos = node.compareDocumentPosition(table);
      // DOCUMENT_POSITION_FOLLOWING means node is before table
      return !!(pos & Node.DOCUMENT_POSITION_FOLLOWING);
    };

    // Collect candidate text chunks before table
    const chunks = [];
    const walker = document.createTreeWalker(card, NodeFilter.SHOW_ELEMENT, null);
    let n = walker.currentNode;

    while (n) {
      // stop traversing once we’ve reached the table element itself
      if (n === table) break;

      // only consider elements that are before the table
      if (isBeforeTable(n)) {
        const t = (n.textContent || "").replace(/\s+/g, " ").trim();
        if (t && DATE_RE.test(t)) {
          // reset regex state (because /g)
          DATE_RE.lastIndex = 0;
          chunks.push(t);
        } else {
          DATE_RE.lastIndex = 0;
        }
      }

      n = walker.nextNode();
    }

    // From those chunks, pull date matches in order, unique
    const out = [];
    for (const c of chunks) {
      const matches = c.match(DATE_RE) || [];
      for (const m of matches) {
        const v = m.trim().replace(/\s+/g, " ");
        if (!out.includes(v)) out.push(v);
        if (out.length === 3) return out;
      }
    }

    return out;
  });

  if (!dates || dates.length !== 3) {
    throw new Error(`Could not extract 3 header dates from card. Got: ${JSON.stringify(dates)}`);
  }

  return {
    col1: normalizeDateText(dates[0]),
    col2: normalizeDateText(dates[1]),
    col3: normalizeDateText(dates[2]),
  };
}

/**
 * Extract the "Updated ..." date from the card footer.
 * We look specifically for the substring starting at "Updated"
 * INSIDE THIS CARD (now that card scoping is correct).
 */
async function extractUpdatedDateFromCard(cardEl) {
  const updatedText = await cardEl.evaluate((card) => {
    const full = (card.textContent || "").replace(/\s+/g, " ").trim();
    const idx = full.toLowerCase().lastIndexOf("updated");
    if (idx >= 0) return full.slice(idx, Math.min(full.length, idx + 140));
    return full;
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

/**
 * Optional: sanity checks so we fail loudly if Chatham DOM changes.
 */
function assert3UniqueDates(label, d) {
  const arr = [d.col1, d.col2, d.col3].map(normalizeDateText);
  const uniq = new Set(arr);
  if (uniq.size !== 3) {
    throw new Error(`${label} header dates are not 3 unique values: ${JSON.stringify(arr)}`);
  }
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  await page.setViewportSize({ width: 1400, height: 900 });

  log("Navigating to:", RATES_SOURCE_URL);
  await page.goto(RATES_SOURCE_URL, { waitUntil: "networkidle", timeout: 60000 });
  await page.waitForTimeout(1500);

  const treasuryCard = await findCardRootByHeading(page, "U.S. Treasuries");
  const sofrCard = await findCardRootByHeading(page, "Secured Overnight Financing Rate (SOFR)");

  const treasuryTable = await findTableWithin(treasuryCard);
  const sofrTable = await findTableWithin(sofrCard);

  // Column header dates for UI (these must align with the visible columns)
  const treasury_dates = await extractThreeHeaderDatesFromCard(treasuryCard);
  const sofr_dates = await extractThreeHeaderDatesFromCard(sofrCard);

  assert3UniqueDates("Treasury", treasury_dates);
  assert3UniqueDates("SOFR", sofr_dates);

  // "Updated ..." dates (required by your edge function contract)
  const treasuryUpdated = await extractUpdatedDateFromCard(treasuryCard);
  const sofrUpdated = await extractUpdatedDateFromCard(sofrCard);

  const treasury = await extractRatesFromTreasuryTable(treasuryTable);
  const sofr = await extractRatesFromSofrTable(sofrTable);

  const payload = {
    dates: { treasury: treasuryUpdated, sofr: sofrUpdated },
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
  if (!res.ok) throw new Error(`Edge function error ${res.status}: ${text}`);

  console.log("Success:", text);
  await browser.close();
}

main().catch((err) => {
  console.error("FAILED:", err);
  process.exit(1);
});
