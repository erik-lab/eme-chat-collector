import { build } from "esbuild";
import { cp, mkdir, rm } from "node:fs/promises";

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
});

await cp("manifest.json", "dist/manifest.json");
await cp("options.html", "dist/options.html");

console.log("built dist/");
