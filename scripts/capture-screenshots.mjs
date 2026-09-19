#!/usr/bin/env node
/**
 * Visual history for the Chicago showcase.
 *
 * Screenshots are committed to git on purpose (until the final cleanup pass), so
 * a reviewer can pull the repo and see what each phase actually looked like
 * without running anything. Everything hangs off docs/screenshots/manifest.json:
 * it is the source of truth, and INDEX.md is generated from it so the two can
 * never drift.
 *
 * Usage
 *   # regenerate docs/screenshots/INDEX.md after editing the manifest by hand
 *   node scripts/capture-screenshots.mjs --index
 *
 *   # capture a phase against a running production build
 *   node scripts/capture-screenshots.mjs \
 *     --phase phase-3 --title "Phase 3 — final product UI" \
 *     --url http://localhost:3113 --list scripts/screenshots/phase-3.json
 *
 * Shot list format (JSON array; see scripts/screenshots/phase-3.example.json):
 *   {
 *     "slug": "metro-far",             // file becomes <phase>/NN-<slug>.png
 *     "view": "full Metro, z12.0",     // what the camera was pointed at
 *     "shows": "one line on what this proves",
 *     "center": [-87.6375, 41.881],    // map centre
 *     "zoom": 12.0,
 *     "settleMs": 3200,                // let the sim run before the shot
 *     "steps": [                       // optional UI setup, in order
 *       { "clickText": "Start" },
 *       { "clickText": "Enter City" },
 *       { "slider": 0, "arrowRight": 6 },
 *       { "eval": "window.__jevMapInstance.jumpTo({ zoom: 12 })" }
 *     ]
 *   }
 *
 * Requires a Chromium endpoint (CDP) and a built app. Nothing here runs in CI.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SHOT_DIR = join(ROOT, "docs", "screenshots");
const MANIFEST = join(SHOT_DIR, "manifest.json");
const INDEX = join(SHOT_DIR, "INDEX.md");

function args() {
  const out = {};
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith("--")) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    out[key] = next && !next.startsWith("--") ? ((i += 1), next) : true;
  }
  return out;
}

function readManifest() {
  return JSON.parse(readFileSync(MANIFEST, "utf8"));
}

function writeManifest(manifest) {
  manifest.updatedAt = new Date().toISOString().slice(0, 10);
  writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: ROOT })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

/** INDEX.md is generated, never hand-edited: one section per phase, one block per shot. */
function writeIndex(manifest) {
  const lines = [
    "# Screenshot history",
    "",
    "Generated from [`manifest.json`](manifest.json) by `scripts/capture-screenshots.mjs --index`.",
    "Do not hand-edit — edit the manifest and regenerate.",
    "",
    "Committed to git on purpose so a reviewer can pull the repo and see each phase",
    "without running anything. It gets removed at the final cleanup pass.",
    "",
    "Convention: `phase-N/NN-slug.png`, numbered in review order.",
    "",
  ];
  for (const phase of manifest.phases) {
    lines.push(`## ${phase.title}`);
    lines.push("");
    const meta = [`commit \`${phase.commit}\``, `captured ${phase.capturedAt}`];
    if (phase.task) meta.push(phase.task);
    lines.push(`*${meta.join(" · ")}*`);
    lines.push("");
    if (phase.note) {
      lines.push(phase.note);
      lines.push("");
    }
    lines.push("| # | shot | view | what it shows |");
    lines.push("| - | ---- | ---- | ------------- |");
    for (const shot of phase.shots) {
      lines.push(
        `| ${shot.id} | [${shot.slug}](${phase.id}/${shot.file}) | ${shot.view} | ${shot.shows} |`,
      );
    }
    lines.push("");
    for (const shot of phase.shots) {
      lines.push(`### ${shot.id} · ${shot.slug}`);
      lines.push("");
      lines.push(`![${shot.slug}](${phase.id}/${shot.file})`);
      lines.push("");
      lines.push(`${shot.view} — ${shot.shows}`);
      lines.push("");
    }
  }
  writeFileSync(INDEX, lines.join("\n"));
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** UI setup before a shot. Every step is awaited: focusing a slider and then
 *  pressing keys without waiting for the focus to land races. */
async function runSteps(page, steps) {
  for (const step of steps ?? []) {
    if (step.clickText) {
      await page.evaluate((text) => {
        const button = [...document.querySelectorAll("button")].find(
          (candidate) => candidate.textContent.trim() === text,
        );
        if (button) button.click();
      }, step.clickText);
    } else if (typeof step.slider === "number") {
      await page.evaluate((index) => {
        const sliders = [...document.querySelectorAll('[role="slider"]')];
        if (sliders[index]) sliders[index].focus();
      }, step.slider);
      for (let i = 0; i < (step.arrowRight ?? 0); i += 1) {
        await page.keyboard.press("ArrowRight");
      }
    } else if (step.eval) {
      await page.evaluate(step.eval);
    }
    await sleep(step.waitMs ?? 900);
  }
}

async function capture(options) {
  const { default: puppeteer } = await import("puppeteer-core");
  const list = JSON.parse(readFileSync(resolve(options.list), "utf8"));
  const phase = options.phase;
  const dir = join(SHOT_DIR, phase);
  mkdirSync(dir, { recursive: true });
  const browser = await puppeteer.connect({
    browserURL: options.browser ?? "http://127.0.0.1:9223",
    protocolTimeout: 600000,
  });
  const context = await browser.createBrowserContext();
  const page = await context.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.goto(options.url, { waitUntil: "networkidle2", timeout: 120000 });
  await sleep(3000);

  const shots = [];
  let index = 1;
  for (const shot of list) {
    await runSteps(page, shot.steps);
    if (shot.center) {
      await page.evaluate(
        ({ center, zoom }) => {
          const map = window.__jevMapInstance;
          if (!map) return;
          map.stop();
          map.jumpTo({ center, zoom });
        },
        { center: shot.center, zoom: shot.zoom ?? 15 },
      );
    }
    await sleep(shot.settleMs ?? 3000);
    const id = String(index).padStart(2, "0");
    const file = `${id}-${shot.slug}.png`;
    await page.screenshot({ path: join(dir, file) });
    shots.push({
      id,
      slug: shot.slug,
      file,
      view: shot.view,
      shows: shot.shows,
      center: shot.center,
      zoom: shot.zoom,
    });
    console.log(`captured ${phase}/${file}`);
    index += 1;
  }
  await context.close();
  await browser.disconnect();

  const manifest = readManifest();
  const entry = {
    id: phase,
    title: options.title ?? phase,
    task: options.task ?? "",
    commit: options.commit ?? gitHead(),
    capturedAt: new Date().toISOString().slice(0, 10),
    note: options.note ?? "",
    shots,
  };
  const existing = manifest.phases.findIndex((candidate) => candidate.id === phase);
  if (existing >= 0) manifest.phases[existing] = entry;
  else manifest.phases.push(entry);
  writeManifest(manifest);
  writeIndex(manifest);
  console.log(`updated manifest.json and INDEX.md (${shots.length} shots)`);
}

const options = args();
if (options.index) {
  writeIndex(readManifest());
  console.log("regenerated docs/screenshots/INDEX.md");
} else if (options.phase) {
  if (!options.list || !existsSync(resolve(options.list))) {
    console.error("--list <shots.json> is required and must exist");
    process.exit(1);
  }
  await capture(options);
} else {
  console.error("usage: --index | --phase <id> --title <t> --url <u> --list <shots.json>");
  process.exit(1);
}
