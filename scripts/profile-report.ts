/**
 * Parses a V8 .cpuprofile into self-time ranked functions (Issue #40, Phase 1).
 *
 *   node --cpu-prof --cpu-prof-dir=/tmp/j40 node_modules/.bin/tsx scripts/profile-simulation.ts
 *   python3 scripts/profile-report.py /tmp/j40/*.cpuprofile
 */
import { readFileSync } from "node:fs";

interface CpuProfileNode {
  readonly id: number;
  readonly callFrame: { readonly functionName: string; readonly url: string; readonly lineNumber: number };
  readonly hitCount?: number;
}

interface CpuProfile {
  readonly nodes: readonly CpuProfileNode[];
  readonly samples: readonly number[];
  readonly timeDeltas: readonly number[];
}

function main(): void {
  const path = process.argv[2];
  if (path === undefined) {
    throw new Error("usage: profile-report.py <file.cpuprofile>");
  }
  const profile = JSON.parse(readFileSync(path, "utf8")) as CpuProfile;
  const byId = new Map<number, CpuProfileNode>();
  for (const node of profile.nodes) {
    byId.set(node.id, node);
  }

  // Self time = sum of the sample deltas whose sample lands on this node.
  const selfUs = new Map<string, number>();
  for (let index = 0; index < profile.samples.length; index += 1) {
    const node = byId.get(profile.samples[index]);
    if (node === undefined) continue;
    const delta = profile.timeDeltas[index] ?? 0;
    const key = `${node.callFrame.functionName || "(anonymous)"} @ ${node.callFrame.url.replace(/^.*\//, "")}:${node.callFrame.lineNumber + 1}`;
    selfUs.set(key, (selfUs.get(key) ?? 0) + delta);
  }

  const ranked = [...selfUs.entries()].sort((a, b) => b[1] - a[1]);
  const total = ranked.reduce((sum, [, value]) => sum + value, 0);
  console.log(`total sampled ${(total / 1000).toFixed(0)} ms across ${ranked.length} functions\n`);
  console.log("self time   share   function");
  for (const [key, value] of ranked.slice(0, 30)) {
    console.log(
      `${(value / 1000).toFixed(1).padStart(9)} ms  ${((value / total) * 100).toFixed(1).padStart(5)}%   ${key}`,
    );
  }

  const byFile = new Map<string, number>();
  for (const [key, value] of ranked) {
    const file = key.split(" @ ")[1]?.split(":")[0] ?? "?";
    byFile.set(file, (byFile.get(file) ?? 0) + value);
  }
  console.log("\nby file");
  for (const [file, value] of [...byFile.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`${(value / 1000).toFixed(1).padStart(9)} ms  ${((value / total) * 100).toFixed(1).padStart(5)}%   ${file}`);
  }
}

main();
