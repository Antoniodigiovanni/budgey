import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
const base = process.env.TEST_API_URL;
if (base !== "http://127.0.0.1:3102")
  throw Error(
    "Require disposable test server TEST_API_URL=http://127.0.0.1:3102",
  );
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ||
    "/home/hermes/workspace/papertrail/node_modules/playwright/index.mjs"
);
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  extraHTTPHeaders: { "X-Hermes-Verified-Email": "test@example.com" },
  viewport: { width: 1280, height: 900 },
});
const page = await context.newPage();
const assertions = [];
const check = (name, value) => {
  assert.ok(value, name);
  assertions.push({ name, pass: true });
};
const unique = "Browser " + Date.now();
async function form(title, values) {
  const details = page
    .locator("details")
    .filter({ has: page.locator("summary", { hasText: title }) });
  await details.locator("summary").click();
  const f = details.locator("form");
  for (const [label, value] of Object.entries(values)) {
    const field = f.getByLabel(label, { exact: true });
    if (await field.evaluate((x) => x.tagName === "SELECT"))
      await field.selectOption(value);
    else await field.fill(value);
  }
  await f.getByRole("button").click();
  await page
    .getByRole("status")
    .filter({ hasText: title + " saved." })
    .waitFor();
  return f;
}
try {
  await page.goto(base);
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Balance sheet", exact: true })
    .click();
  await page.getByLabel("As of date").fill("2026-01-31");
  await form("Add asset or debt", {
    "Record name": unique,
    "Record type": "property",
  });
  await page.getByText("Incomplete valuation:", { exact: false }).waitFor();
  check("missing valuation is explicit", true);
  const api = async (path) =>
    (await context.request.get(base + "/api" + path)).json();
  let s = await api("/wealth?date=2026-01-31");
  const asset = s.data.assets.find((a) => a.name === unique);
  check("created named asset persisted", asset);
  await form("Record valuation", {
    "Asset or debt": asset.id,
    "Valuation date": "2026-01-15",
    "Value owed or owned (positive, zero allowed)": "1234.56",
  });
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Balance sheet", exact: true })
    .click();
  await page.getByLabel("As of date").fill("2026-01-31");
  s = await api("/wealth?date=2026-01-31");
  check(
    "exact valuation survives reload",
    s.snapshot.rows.find((a) => a.id === asset.id).value === 123456,
  );
  await page.getByLabel("As of date").fill("2026-01-01");
  s = await api("/wealth?date=2026-01-01");
  check(
    "as-of excludes later value",
    s.snapshot.rows.find((a) => a.id === asset.id).value === null,
  );
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Investments", exact: true })
    .click();
  await form("Create portfolio", {
    "Portfolio name": unique + " portfolio",
    "Opening date": "2026-01-01",
    "Opening cash": "100.00",
  });
  await form("Create security", { "Security name": unique + " security" });
  s = await api("/wealth?date=2026-01-31");
  const p = s.data.portfolios.find((p) => p.name === unique + " portfolio");
  const i = s.data.instruments.find((i) => i.name === unique + " security");
  await page.getByLabel("As of date").fill("2026-01-31");
  await form("Record investment activity", {
    Portfolio: p.id,
    "Activity type": "buy",
    "Activity date": "2026-01-02",
    "Total consideration or cash amount": "25.00",
    "Trade security": i.id,
    "Units (up to six decimals)": "1.25",
    "Trade fees": "0.25",
  });
  await page
    .getByText("Missing price: total value is unknown.", { exact: true })
    .waitFor();
  check("missing security price visible", true);
  await form("Record price", {
    Security: i.id,
    "Price date": "2026-01-03",
    "Price per unit (zero allowed)": "21.01",
  });
  s = await api("/wealth?date=2026-01-31");
  check(
    "fractional holding exact value",
    s.snapshot.portfolios.find((x) => x.id === p.id).value === 10101,
  );
  const details = page.locator("details").filter({
    has: page.locator("summary", { hasText: "Record investment activity" }),
  });
  if (!(await details.evaluate((x) => x.open)))
    await details.locator("summary").click();
  const f = details.locator("form");
  await f.getByLabel("Portfolio", { exact: true }).selectOption(p.id);
  await f.getByLabel("Activity type", { exact: true }).selectOption("sell");
  await f.getByLabel("Activity date", { exact: true }).fill("2026-01-04");
  await f
    .getByLabel("Total consideration or cash amount", { exact: true })
    .fill("50");
  await f.getByLabel("Trade security", { exact: true }).selectOption(i.id);
  await f.getByLabel("Units (up to six decimals)", { exact: true }).fill("9");
  await f.getByLabel("Trade fees", { exact: true }).fill("0");
  await f.getByRole("button").click();
  await page.getByRole("alert").filter({ hasText: "Cannot sell" }).waitFor();
  check(
    "field validation retains draft",
    (await f
      .getByLabel("Units (up to six decimals)", { exact: true })
      .inputValue()) === "9",
  );
  await page.reload();
  await page
    .getByRole("navigation")
    .getByRole("button", { name: "Investments", exact: true })
    .click();
  s = await api("/wealth?date=2026-01-31");
  check(
    "one saved trade after rejected oversell",
    s.data.events.filter((e) => e.portfolio_id === p.id).length === 1,
  );
  check(
    "desktop fits 1280px",
    await page.evaluate(() => document.documentElement.scrollWidth <= 1280),
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await mkdir("docs/evidence", { recursive: true });
  for (const tab of ["Balance sheet", "Investments"]) {
    await page
      .getByRole("navigation")
      .getByRole("button", { name: tab, exact: true })
      .click();
    await page.getByLabel("As of date").waitFor();
    check(
      tab + " fits 390px",
      await page.evaluate(() => document.documentElement.scrollWidth <= 390),
    );
    await page
      .getByText("Loading wealth records…", { exact: true })
      .waitFor({ state: "hidden" });
    await page.screenshot({
      path:
        "docs/evidence/wealth-" +
        tab.toLowerCase().replaceAll(" ", "-") +
        "-mobile.png",
      fullPage: true,
    });
  }
  console.log(JSON.stringify(assertions, null, 2));
} finally {
  await mkdir("docs/evidence", { recursive: true });
  await writeFile(
    "docs/evidence/wealth-browser-assertions.json",
    JSON.stringify(assertions, null, 2),
  );
  await browser.close();
}
