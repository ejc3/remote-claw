// Compile app/theme/remote-claw.ts into app/theme/built/ — run via `pnpm run theme:build`.
//
// Two reasons this isn't just the bare CLI call.
//
// 1. `--out`. Left to its default, `astryx theme build` writes remote-claw.{css,js,d.ts,variants.d.ts}
//    NEXT TO the .ts source, leaving a remote-claw.js twin of remote-claw.ts in one directory.
//    next.config.ts sets `extensionAlias: { ".js": [".ts", ".tsx", ".js"] }` (so clawsec's raw-TypeScript
//    exports resolve), which tries `.ts` FIRST — so `import "./theme/remote-claw.js"` would silently
//    resolve to the SOURCE theme (the runtime <style>-injection path) instead of the built one, with no
//    error. `--out` names the CSS path but relocates the WHOLE set (the CLI derives the .js/.d.ts paths
//    from its dirname), so built/ never has a twin and the import is unambiguous.
// 2. The timestamp. Every emitted file carries a `Generated: <ISO 8601>` header, so an otherwise
//    identical rebuild always produces a diff — which makes the committed artifacts unreviewable and
//    makes `pnpm run theme:check` (the drift gate) impossible. The CLI has no flag to suppress it, so
//    we strip the line. Nothing reads it; `Source:` and `Command:` carry the useful provenance.
//
// The built artifacts ARE committed: CI and the Vercel build consume them directly, so a deploy never
// runs the Astryx CLI. Re-run this whenever remote-claw.ts changes.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const builtDir = join(webRoot, "app", "theme", "built");

// Start from an empty built/ so an artifact the CLI STOPS emitting (variants.d.ts is only produced when
// the theme declares custom component prop values) can't linger as a stale committed file.
rmSync(builtDir, { recursive: true, force: true });
mkdirSync(builtDir, { recursive: true });

execFileSync(
  "pnpm",
  ["exec", "astryx", "theme", "build", "app/theme/remote-claw.ts", "--out", "app/theme/built/remote-claw.css"],
  { cwd: webRoot, stdio: "inherit" },
);

const emitted = readdirSync(builtDir);
// The three the app actually consumes: providers.tsx imports the .js, globals.css imports the .css, and
// tsc needs the .d.ts. A silent partial write would otherwise surface much later as a confusing build
// error rather than here, pointing at the CLI.
for (const required of ["remote-claw.css", "remote-claw.js", "remote-claw.d.ts"]) {
  if (!emitted.includes(required)) {
    throw new Error(
      `astryx theme build did not emit ${required} into ${builtDir} (got: ${emitted.join(", ") || "nothing"}).`,
    );
  }
}

for (const name of emitted) {
  const p = join(builtDir, name);
  writeFileSync(p, readFileSync(p, "utf8").replace(/^[ *]*Generated: .*\n/m, ""));
}
console.log(`\n✓ built theme → ${builtDir}`);
