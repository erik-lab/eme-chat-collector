import { build } from "esbuild";
import { execSync } from "node:child_process";
import { cp, mkdir, rm } from "node:fs/promises";

// Stamped into the bundle and reported with every sync.
//
// `dist/` is not in git, so `git pull` does not update the extension — it has
// to be rebuilt and reloaded. That is easy to forget, and the symptom is
// yesterday's bug reported against today's code, which wastes a whole round
// trip. With the stamp in the report, a stale build is obvious on sight.
function buildId() {
  let revision = "unknown";
  try {
    const sha = execSync("git rev-parse --short HEAD", { encoding: "utf8" }).trim();
    const dirty = execSync("git status --porcelain", { encoding: "utf8" }).trim() !== "";
    revision = dirty ? `${sha}-dirty` : sha;
  } catch {
    // Built outside a checkout. Nothing to say, so say nothing.
  }
  return `${revision} built ${new Date().toISOString()}`;
}

// One bundle per extension entry point. No framework, no CSS pipeline: the
// extension's main claim is that a sceptical person can read it in an
// afternoon, and every build step is something they would have to trust
// instead of read.
const ENTRY_POINTS = ["src/background.ts", "src/options.ts"];

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });

await build({
  entryPoints: ENTRY_POINTS,
  outdir: "dist",
  bundle: true,
  format: "esm",
  target: "chrome120",
  // Kept readable on purpose. A minified bundle in a public repo whose point
  // is auditability defeats the point — and the whole thing is a few
  // kilobytes either way.
  minify: false,
  sourcemap: true,
  define: { __BUILD_ID__: JSON.stringify(buildId()) },
});

await cp("manifest.json", "dist/manifest.json");
await cp("options.html", "dist/options.html");

console.log("built dist/");
