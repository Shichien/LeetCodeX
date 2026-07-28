import assert from "node:assert/strict";
import { chmod, copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const macLauncher = path.join(root, "macos", "Start Leetcodex.command");
const windowsLauncher = path.join(root, "windows", "Start Leetcodex.cmd");
const macSource = await readFile(macLauncher, "utf8");
const windowsSource = await readFile(windowsLauncher, "utf8");

assert.match(macSource, /"\$ROOT\/leetcodex" run "\$@"/);
assert.match(macSource, /exit "\$status"/);
assert.match(windowsSource, /"%~dp0leetcodex\.exe" run %\*/i);
assert.match(windowsSource, /set "status=%errorlevel%"/i);
assert.match(windowsSource, /exit \/b %status%/i);

if (process.platform !== "win32") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "Leetcodex launch space-\u6d4b\u8bd5-"));
  try {
    const launcher = path.join(temporary, "Start Leetcodex.command");
    const executable = path.join(temporary, "leetcodex");
    const argumentsFile = path.join(temporary, "arguments.txt");
    await copyFile(macLauncher, launcher);
    await chmod(launcher, 0o755);
    await writeFile(executable, `#!/bin/bash\nprintf '%s\\n' "$@" > ${JSON.stringify(argumentsFile)}\nexit 7\n`);
    await chmod(executable, 0o755);

    const failure = spawnSync(launcher, ["--port", "9444"], {
      encoding: "utf8",
      input: "",
      timeout: 5_000,
    });
    assert.equal(failure.status, 7);
    assert.deepEqual((await readFile(argumentsFile, "utf8")).trim().split("\n"), ["run", "--port", "9444"]);
    assert.match(failure.stderr, /failed with exit code 7/i);

    await writeFile(executable, "#!/bin/bash\nexit 0\n");
    await chmod(executable, 0o755);
    const success = spawnSync(launcher, [], { encoding: "utf8", input: "", timeout: 5_000 });
    assert.equal(success.status, 0);
    assert.doesNotMatch(success.stderr, /failed with exit code/i);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

console.log("Packaged launchers preserve arguments and exit status.");
