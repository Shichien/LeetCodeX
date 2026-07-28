import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const manifest = await fs.readFile(path.join(root, "Cargo.toml"), "utf8");
const version = manifest.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
if (!version || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error("Cargo.toml must contain a valid semantic package version");
}

const changelog = await fs.readFile(path.join(root, "CHANGELOG.md"), "utf8");
if (!new RegExp(`^## \\[${version.replaceAll(".", "\\.")}\\]\\s+-\\s+\\d{4}-\\d{2}-\\d{2}$`, "m").test(changelog)) {
  throw new Error(`CHANGELOG.md has no dated [${version}] release heading`);
}

const tagIndex = process.argv.indexOf("--tag");
if (tagIndex >= 0) {
  const tag = process.argv[tagIndex + 1];
  if (!tag) throw new Error("--tag requires a value");
  if (tag !== `v${version}`) {
    throw new Error(`release tag ${tag} does not match Cargo.toml version v${version}`);
  }
}

console.log(`Release version ${version} is consistent.`);
