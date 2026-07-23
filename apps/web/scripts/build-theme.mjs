// Compile app/theme/remote-claw.ts into app/theme/built/ — run via `pnpm run theme:build`.
//
// `astryx theme build` emits remote-claw.{css,js,d.ts,variants.d.ts} NEXT TO the .ts source, which would
// leave a remote-claw.js twin of remote-claw.ts in the same directory. next.config.ts sets
// `extensionAlias: { ".js": [".ts", ".tsx", ".js"] }` (so clawsec's raw-TypeScript exports resolve), which
// tries `.ts` first — so an `import "./theme/remote-claw.js"` would resolve to the SOURCE theme (runtime
// <style> injection) instead of the built one, silently, with no error. Moving the artifacts into built/
// removes the twin and makes the import unambiguous.
//
// The built artifacts ARE committed: CI and the Vercel build consume them directly, so a deploy never has
// to run the Astryx CLI. Re-run this whenever remote-claw.ts changes; `pnpm run theme:check` fails the
// gate if the committed output has drifted from the source.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const themeDir = join(webRoot, "app", "theme");
const builtDir = join(themeDir, "built");
// The three the app actually imports/typechecks against — a missing one is a build break, not a nuance.
const REQUIRED = ["remote-claw.css", "remote-claw.js", "remote-claw.d.ts"];
// Only emitted when the theme declares custom component prop values; absence is legitimate.
const OPTIONAL = ["remote-claw.variants.d.ts"];

// Start from a clean built/ so an artifact the CLI stops emitting (e.g. variants.d.ts once no custom
// component variants remain) doesn't linger as a stale committed file.
rmSync(builtDir, { recursive: true, force: true });
mkdirSync(builtDir, { recursive: true });

execFileSync("pnpm", ["exec", "astryx", "theme", "build", "app/theme/remote-claw.ts"], {
  cwd: webRoot,
  stdio: "inherit",
});

for (const name of [...REQUIRED, ...OPTIONAL]) {
  const from = join(themeDir, name);
  const to = join(builtDir, name);
  try {
    renameSync(from, to);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    // Swallowing ENOENT for EVERY artifact would let this script print "✓ built theme" while the CSS or
    // the module the app imports is missing — a green build script and a broken app. Only the optional
    // one may go missing.
    if (!OPTIONAL.includes(name)) {
      throw new Error(
        `astryx theme build did not emit ${name}. Expected it at ${from}; the CLI's output filenames may have changed.`,
      );
    }
    continue;
  }
  // Strip the CLI's `Generated: <ISO timestamp>` header line. Without this every rebuild produces a diff
  // even when the theme is unchanged, which makes the committed artifacts un-reviewable and defeats the
  // `theme:check` drift gate. Nothing reads the line.
  writeFileSync(
    to,
    readFileSync(to, "utf8").replace(/^[ *]*Generated: .*\n/m, ""),
  );
}
console.log(`\n✓ built theme → ${builtDir}`);
