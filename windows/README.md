# Leetcodex for Windows

Leetcodex adds coding practice, a VS Code-style editor, and LeetCode submission controls to the official Codex composer.

## Start

1. Fully quit every Codex window.
2. Double-click `Start Leetcodex.cmd`, or run `leetcodex.exe run` in PowerShell. On failure, the launcher keeps the original exit code and pauses so the error remains visible.
3. When Codex opens, press `Ctrl+Alt+L` to enter or leave Leetcodex.

Use `Ctrl+Enter` to run examples, `Ctrl+F` to search code, and the Vim toolbar switch to enable Vim bindings. Inside Vim mode, `Esc` returns to NORMAL mode. Use `Ctrl+Alt+L` to leave Leetcodex.

Choose `leetcode.com` or `leetcode.cn`, then select `Login` to pair a dedicated Chrome or Edge profile. Passwords and cookies remain in that browser profile.

## Explicit Codex path

If automatic discovery is unavailable, pass the absolute executable path:

```powershell
.\leetcodex.exe run --codex-path "C:\path\to\ChatGPT.exe"
```

The launcher forwards additional arguments, for example `Start Leetcodex.cmd --port 9444`.

## Codex++

```powershell
.\leetcodex.exe install-codex-plus-plus
.\leetcodex.exe uninstall-codex-plus-plus
```

The default script path is `%APPDATA%\Codex++\user_scripts\leetcodex.js`.
Both commands only replace or remove scripts carrying the Leetcodex marker. An unrelated file with the same name is preserved and reported as an error.

## Diagnostics and drafts

Run `.\leetcodex.exe doctor` to inspect Codex discovery, the account browser, the CDP port, renderer injection version and instance health, and the draft directory. JSON output includes a top-level `healthy` value and structured `drafts` status; launcher diagnostics reject linked runtime directories, lock-file links, and Windows reparse points. Malformed or wrong-port lock metadata reports `invalid_metadata`, while a different launcher version reports `version_mismatch`. The draft check only reads path type and directory readability. Use `.\leetcodex.exe doctor --strict --json` when automation needs a nonzero exit code for an unhealthy full stack. Renderer diagnostics do not read conversations or draft contents, and LeetCode sign-in is not required for a healthy result.

Drafts are stored in Codex and backed up under `%USERPROFILE%\.leetcodex\drafts\v1\`. Leetcodex restores the matching site, problem, and language draft if Codex local storage is cleared. Native draft access validates every managed directory and rejects symbolic links and Windows reparse points so a junction cannot redirect backups outside this root.

To repair an account browser profile, fully close that browser and run `.\leetcodex.exe reset-pairing --site global --yes`, or use `china`. The previous profile is retained under `%USERPROFILE%\.leetcodex\pairing-backups\`. Profiles, backups, and their shared data parent reject symbolic links, junctions, and other Windows reparse points before Cookie data is moved.

Use `.\leetcodex.exe list-pairing-backups --site global` to list backups, then `.\leetcodex.exe restore-pairing --site global --backup <name> --yes` to restore one. Restore never overwrites an existing profile.

## Security notice

Community release artifacts are not Microsoft Store-signed. Verify `SHA256SUMS.txt` before running the package.
