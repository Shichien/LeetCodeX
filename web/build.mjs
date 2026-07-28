import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const css = await fs.readFile(path.join(here, "src", "styles.css"), "utf8");
const problems = JSON.parse(await fs.readFile(path.join(here, "src", "problems.json"), "utf8"));
const typingCss = await fs.readFile(path.join(here, "typing", "src", "styles.css"), "utf8");
const typingCorpus = JSON.parse(
  await fs.readFile(path.join(here, "typing", "src", "corpus.json"), "utf8"),
);
const manifest = await fs.readFile(path.join(root, "Cargo.toml"), "utf8");
const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version) throw new Error("Could not read the Leetcodex version from Cargo.toml");
const outputDirectory = path.join(root, "dist");
const coreOutput = path.join(outputDirectory, "leetcodex-core.user.js");
const typingOutput = path.join(outputDirectory, "cotypex.user.js");
const output = path.join(outputDirectory, "leetcodex.user.js");

await fs.mkdir(outputDirectory, { recursive: true });
await build({
  entryPoints: [path.join(here, "src", "index.js")],
  outfile: coreOutput,
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

await build({
  entryPoints: [path.join(here, "typing", "src", "index.js")],
  outfile: typingOutput,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome120",
  legalComments: "none",
  banner: {
    js: `/* CotypeX ${version} - integrated typing practice for Leetcodex */`,
  },
  plugins: [{
    name: "cotypex-assets",
    setup(builder) {
      builder.onResolve({ filter: /^virtual:cotypex-assets$/ }, () => ({
        path: "cotypex-assets",
        namespace: "cotypex",
      }));
      builder.onLoad({ filter: /.*/, namespace: "cotypex" }, () => ({
        contents: `export const APP_VERSION = ${JSON.stringify(version)};\nexport const CSS_TEXT = ${JSON.stringify(typingCss)};\nexport const CORPUS = ${JSON.stringify(typingCorpus)};`,
        loader: "js",
      }));
    },
  }],
});

const combined = `${await fs.readFile(coreOutput, "utf8")}\n${await fs.readFile(typingOutput, "utf8")}`;
await fs.writeFile(output, combined, "utf8");
await fs.rm(coreOutput);

console.log(`Built ${output} with integrated CotypeX`);
