/**
 * Deployed smoke test: drives the PUBLIC experience in a real browser.
 *
 * Usage
 *   node --experimental-strip-types ... no: this repo runs TS via tsx
 *   npx tsx scripts/deployed-smoke.ts [url]
 *
 * Needs a Chromium CDP endpoint (default http://127.0.0.1:9223); see the
 * screenshot tooling for how to launch one. Nothing here writes to the
 * deployment — it only observes.
 *
 * Drives the PUBLIC experience in a real browser against production and asserts
 * what the release actually promises: the page loads without login, the Chicago
 * assets arrive, the challenge starts, the app calls its own relay successfully,
 * the run finishes, and the payoff shows Fixed, Adaptive and the visible run on
 * ONE scenario fingerprint with the third column named for whoever governed it.
 *
 * Reports facts only; nothing here writes to the deployment.
 */
import puppeteer from "puppeteer-core";

const URL = process.argv[2] ?? "https://jevtrafficsim.vercel.app";

interface RelayCall {
  status: number | null;
  ok: boolean;
  ms: number;
}

async function main(): Promise<void> {
  const browser = await puppeteer.connect({
    browserURL: "http://127.0.0.1:9223",
    protocolTimeout: 600_000,
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });

  const consoleErrors: string[] = [];
  const failedRequests: string[] = [];
  const relays: RelayCall[] = [];
  const relayStarted = new Map<string, number>();

  page.on("console", (message) => {
    if (message.type() === "error") {
      consoleErrors.push(message.text().slice(0, 200));
    }
  });
  page.on("requestfailed", (request) => {
    failedRequests.push(`${request.method()} ${request.url().slice(0, 120)}`);
  });
  page.on("request", (request) => {
    if (request.url().includes("/api/jev/policy")) {
      relayStarted.set(request.url(), Date.now());
    }
  });
  page.on("response", (response) => {
    const url = response.url();
    if (url.includes("/api/jev/policy")) {
      relays.push({
        status: response.status(),
        ok: response.ok(),
        ms: Date.now() - (relayStarted.get(url) ?? Date.now()),
      });
    }
  });

  console.log("--- load ---");
  const response = await page.goto(URL, { waitUntil: "networkidle2", timeout: 120_000 });
  console.log("page status:", response?.status());
  console.log("title:", await page.title());

  const text = async (): Promise<string> => page.evaluate(() => document.body.innerText);
  const start = await text();
  console.log("landing shows the thesis:", /three ways to run the city/i.test(start));
  console.log("chicago assets requested:", await page.evaluate(() =>
    performance
      .getEntriesByType("resource")
      .some((entry) => entry.name.includes("/chicago/")),
  ));

  console.log("--- start the challenge ---");
  const clickText = async (label: string): Promise<boolean> =>
    page.evaluate((wanted) => {
      const elements = Array.from(document.querySelectorAll("button, a")) as HTMLElement[];
      const target = elements.find((element) => element.innerText.trim() === wanted);
      if (!target) {
        return false;
      }
      target.click();
      return true;
    }, label);

  console.log("Start clicked:", await clickText("Start"));
  await new Promise((resolve) => setTimeout(resolve, 1_800));
  const setup = await text();
  console.log("setup shows Trip/Traffic/Driver:", /Trip/.test(setup) && /Traffic/.test(setup) && /Driver/.test(setup));
  console.log("setup shows no controller picker:", !/Fixed/.test(setup) && !/Adaptive/.test(setup));
  console.log("setup shows no raw seed:", !/Seed/.test(setup));

  console.log("Enter City clicked:", await clickText("Enter City"));
  // The challenge runs at 8x; a 600 s horizon is ~75 s of wall time.
  await new Promise((resolve) => setTimeout(resolve, 15_000));
  const live = await text();
  console.log("live chrome present:", live.includes("Jev Traffic · Chicago"));
  console.log("signals provenance line:", (live.match(/Signals\s*\n?\s*([^\n]+)/) ?? [])[1] ?? "(none)");
  console.log("scenario fingerprint shown:", /Scenario/.test(live));

  console.log("--- relay calls so far ---");
  console.log("requests:", relays.length, "| statuses:", relays.map((call) => call.status).join(","));
  const accepted = relays.filter((call) => call.ok).length;
  console.log("successful relay answers:", accepted);

  console.log("--- wait for the run to finish (the payoff) ---");
  // Up to 3 minutes: the horizon plus the baselines finishing in their worker.
  let comparison = "";
  for (let waited = 0; waited < 24; waited += 1) {
    await new Promise((resolve) => setTimeout(resolve, 7_500));
    const body = await text();
    if (body.includes("Same scenario") && body.includes("Fixed")) {
      comparison = body;
      break;
    }
  }
  if (comparison === "") {
    console.log("comparison panel: DID NOT APPEAR");
  } else {
    const columns = (comparison.match(/Same scenario · three runs\s*\n\s*([0-9a-f]{8})\s*\n\s*([^\n]*)\n([^\n]*)\n([^\n]*)/) ?? []).slice(1);
    console.log("payoff fingerprint:", columns[0] ?? "(none)");
    console.log("payoff column headers:", columns.slice(1).join(" | "));
    const rows = comparison.split("\n").filter((line) => /^(Arrived|Trip time|Stopped|Distance|Avg speed|Reroutes|Avg wait|P95 wait|Trips done|Throughput|Gridlock|Active cars)/.test(line));
    console.log("payoff rows found:", rows.length);
    for (const row of rows.slice(0, 6)) {
      console.log("   ", row.replace(/\s+/g, " "));
    }
    const fallbackLine = comparison.match(/(\d+% of the run on the adaptive fallback|[0-9]+ live policies?)/);
    console.log("provenance detail:", fallbackLine?.[0] ?? "(none)");
  }

  console.log("--- relay calls, whole run ---");
  const statuses = relays.map((call) => call.status);
  console.log("total:", relays.length, "| ok:", relays.filter((call) => call.ok).length, "| statuses:", statuses.join(","));
  if (relays.length > 0) {
    const slowest = relays.reduce((max, call) => Math.max(max, call.ms), 0);
    console.log("slowest relay round trip:", slowest, "ms");
  }

  console.log("--- console errors ---");
  console.log(consoleErrors.length === 0 ? "none" : consoleErrors.slice(0, 5).join(" \n"));
  console.log("--- failed requests ---");
  console.log(failedRequests.length === 0 ? "none" : failedRequests.slice(0, 5).join(" \n"));

  await context.close();
  browser.disconnect();
}

void main();
