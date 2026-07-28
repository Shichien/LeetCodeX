import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const css = await fs.readFile(path.join(here, "src", "styles.css"), "utf8");
const problems = JSON.parse(await fs.readFile(path.join(here, "src", "problems.json"), "utf8"));
const manifest = await fs.readFile(path.join(root, "Cargo.toml"), "utf8");
const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version) throw new Error("Could not read the Leetcodex version from Cargo.toml");
const output = path.join(root, "dist", "leetcodex.user.js");

await fs.mkdir(path.dirname(output), { recursive: true });
await build({
  entryPoints: [path.join(here, "src", "index.js")],
  outfile: output,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  legalComments: "none",
  banner: {
    js: `/* Leetcodex ${version} - local coding practice for Codex */`,
  },
  plugins: [{
    name: "leetcodex-assets",
    setup(builder) {
      builder.onResolve({ filter: /^virtual:leetcodex-assets$/ }, () => ({
        path: "leetcodex-assets",
        namespace: "leetcodex",
      }));
      builder.onLoad({ filter: /.*/, namespace: "leetcodex" }, () => ({
        contents: `export const APP_VERSION = ${JSON.stringify(version)};\nexport const CSS_TEXT = ${JSON.stringify(css)};\nexport const PROBLEMS = ${JSON.stringify(problems)};`,
        loader: "js",
      }));
    },
  }],
});

console.log(`Built ${output}`);
