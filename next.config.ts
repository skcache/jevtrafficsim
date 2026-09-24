import type { NextConfig } from "next";
import { execFileSync } from "node:child_process";

function buildCommitSha(): string {
  const vercel = process.env.VERCEL_GIT_COMMIT_SHA;
  if (vercel && /^[a-f0-9]{40}$/i.test(vercel)) return vercel;
  try {
    const local = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return /^[a-f0-9]{40}$/i.test(local) ? local : "unknown";
  } catch {
    return "unknown";
  }
}

const nextConfig: NextConfig = {
  // A commit identifier is public, not a credential. Freeze it into the build
  // so a preview/prod diagnosis can identify the code actually deployed.
  env: { BUILD_COMMIT_SHA: buildCommitSha() },
};

export default nextConfig;
