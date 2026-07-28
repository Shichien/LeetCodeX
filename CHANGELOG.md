# Changelog

All notable changes to Leetcodex are documented here. Versions follow Semantic Versioning.

## [0.2.51] - 2026-07-28

### Fixed

- Completed official catalogs are retained in an eight-entry, criteria-scoped in-memory LRU cache for five minutes, so repeatedly leaving and reopening Leetcodex does not immediately fetch every problem page again.
- An empty later problem page is now treated as a recoverable pagination failure instead of incorrectly reporting a partial catalog as complete.

## [0.2.50] - 2026-07-28

### Fixed

- Official problem pagination now retries the same offset through a bounded 2/4/8/16/30-second recovery schedule after its fast request retries are exhausted, preventing a transient later-page failure from permanently leaving only part of the catalog available.
- Background page recovery is cancelled when the active site, filter, search, or Leetcodex session changes, and the existing compact result line reports partial progress and the next retry delay.

## [0.2.49] - 2026-07-28

### Fixed

- Transient LeetCode status or initial problem-list failures now recover through a bounded 2/4/8/16/30-second reconnect schedule instead of leaving the session permanently reduced to the six-problem offline bank.
- Reconnect work is scoped to the active site generation, cancelled on deactivation or site changes, and reset as soon as the first official problem page succeeds.

## [0.2.48] - 2026-07-28

### Fixed

- Vim mode now exits while its CodeMirror view is still mounted before editor destruction, preventing third-party cleanup races during deactivation, reinjection, and Codex composer replacement.
- Editor destruction is idempotent, and Vim state detection uses the adapter's live state instead of treating a stale adapter reference as an active Vim session.

## [0.2.47] - 2026-07-28

### Added

- `doctor` now performs a read-only renderer diagnostic and reports the injected version, active state, panel/editor instance counts, and pending Bridge request count for every eligible Codex target.
- Renderer diagnostics classify missing injection, launcher-version mismatch, duplicate or incomplete editor mounts, and evaluation failures instead of treating a reachable CDP port as sufficient proof of health.

## [0.2.46] - 2026-07-28

### Fixed

- The macOS double-click launcher now preserves a failed process exit code and keeps an interactive Terminal window open long enough to read the diagnostic instead of losing it through `exec`.
- The Windows launcher now preserves the native launcher's failure code after pausing, so scripts and support tooling cannot mistake a failed start for success.
- Both packaged launchers forward additional command-line arguments such as `--port` and `--codex-path`.
- CI and every release builder exercise launcher argument and exit-status invariants, including macOS paths containing spaces and Unicode.

## [0.2.45] - 2026-07-28

### Security

- Release archives now include independently downloadable and self-verified SHA-256 sidecar files, allowing the zip itself to be checked before extraction.
- GitHub Actions dependencies are pinned to immutable commits, and non-publishing jobs now have read-only repository permissions.
- Tagged release archives receive GitHub build-provenance attestations before publication.

## [0.2.44] - 2026-07-28

### Fixed

- Native Bridge activation now enters a consistent Connecting state immediately instead of briefly presenting the local bank and stale offline control reasons.
- Official problem list and starter-template loading share one loading lifecycle, keeping language, reset, Run, and Submit disabled with the correct reason until the selected question is ready.
- Account connection updates immediately recompute control availability rather than waiting for a later question response to refresh the toolbar.

## [0.2.43] - 2026-07-28

### Fixed

- Codex++ without the native launcher now clearly presents itself as Offline practice instead of incorrectly asking the user to log in, and no longer emits an error for that expected mode.
- A running native Bridge that cannot reach the selected LeetCode site now reports LeetCode unavailable with the connection diagnostic in its tooltip.
- Login is disabled when no native Bridge exists, and offline Run/Submit are disabled for languages that require the official judge instead of failing only after a click.
- Language changes immediately recompute Run/Submit availability and report whether the selected language can run offline instead of retaining stale JavaScript control state.

## [0.2.42] - 2026-07-28

### Fixed

- Composer replacement now runs its first attachment check directly from the MutationObserver callback, avoiding Chromium's one-second background timer throttling while retaining bounded timed retries when no composer exists yet.

## [0.2.41] - 2026-07-28

### Fixed

- Composer replacement is now checked on the next event-loop turn, while failed attachment still uses bounded retry backoff.
- Leetcodex's managed stylesheet is excluded from composer-change observation, so its own style refresh no longer restarts a pending remount.

## [0.2.40] - 2026-07-28

### Fixed

- Composer remount observation now ignores DOM changes wholly owned by Leetcodex itself, preventing its panel and editor insertion from restarting the remount backoff and delaying recovery after Codex replaces its composer.

## [0.2.39] - 2026-07-28

### Fixed

- Editor search, draft save, and run shortcuts now take priority over Vim mappings, so Windows `Ctrl+F`, `Ctrl+S`, and `Ctrl+Enter` keep their VS Code behavior while Vim mode is enabled.
- Search and Escape handling now use one highest-priority CodeMirror keymap instead of competing DOM and keymap handlers, preventing duplicate command dispatch and preserving Vim Escape after the search panel closes.

## [0.2.38] - 2026-07-28

### Fixed

- Disabled toolbar controls now expose the actual reason in their tooltip while an official problem is loading, an account is not signed in, a login window is opening, or another judge action is active.
- Run restores its current Run/Stop title after controls unlock, and all other controls restore their original title instead of retaining stale disabled-state text.
- Disabled controls use a `not-allowed` cursor instead of incorrectly suggesting that every disabled state is an active wait operation.

## [0.2.37] - 2026-07-28

### Fixed

- Official compiler, runtime, testcase, expected, and output diagnostics are bounded before rendering while retaining both the beginning and end of useful error context.
- Every result message, including errors created by offline user code, is capped at 24,000 Unicode code points so a very large exception cannot stall the Codex renderer or inflate the composer DOM.
- Diagnostic truncation operates on Unicode code points and never splits an emoji or surrogate pair.

## [0.2.36] - 2026-07-28

### Fixed

- Pairing reset and restore on Unix now recognize Chromium `SingletonLock` targets ending in a dead PID and remove only those proven-stale singleton and debugging markers.
- A live singleton PID, malformed lock, changed lock target, directory marker, or platform without reliable PID marker semantics remains blocked, preserving the existing protection against moving an active browser profile.

## [0.2.35] - 2026-07-28

### Fixed

- `run` now acquires the per-port launcher lock before checking or starting Codex, so rapid repeated launches fail before a second Codex process can be created.
- The startup lock is passed into the shared attach core rather than reacquired after CDP appears, preserving single-instance ownership throughout the entire launch timeout window.
- `--timeout-seconds` now rejects zero and values above five minutes instead of launching Codex with an immediate failure or an effectively unbounded wait.

## [0.2.34] - 2026-07-28

### Changed

- Windows release builds now explicitly target `x86_64-pc-windows-msvc`, execute the packaged binary's version check, verify every SHA-256 entry, and expand the final zip for a second integrity check.
- macOS release builds now verify the packaged binary version, package checksums, and final zip from inside the build script instead of relying on manual post-build checks.
- A macOS MinGW cross-release script can produce a clearly labeled Windows GNU x64 validation package and rejects non-system GCC runtime DLL dependencies.

## [0.2.33] - 2026-07-28

### Fixed

- Native draft loads and saves now use a dedicated FIFO Bridge worker, preventing an older concurrent save from completing after newer code and overwriting it on disk.
- Renderer session cleanup now closes and drains its draft queue before release, preserving queued native backups during normal launcher shutdown while LeetCode network work remains concurrent.

## [0.2.32] - 2026-07-28

### Fixed

- A renderer Bridge socket failure now removes the broken session after one error and triggers discovery on the next event-loop pass, avoiding repeated log floods and multi-second recovery delays.
- Bridge responses are capped at 1.5 MB before they are embedded into Codex `Runtime.evaluate`; oversized LeetCode or draft responses become bounded structured errors instead of consuming unbounded renderer memory.

## [0.2.31] - 2026-07-28

### Fixed

- LeetCode and native draft Bridge requests now run outside the CDP event loop, so a slow paired browser request cannot freeze injection health checks, target cleanup, or unrelated renderer events.
- Per-renderer Bridge work is bounded to eight concurrent requests; duplicate IDs, overload, worker startup failures, and worker panics return structured errors instead of blocking or silently losing a request.
- Async Bridge responses are pumped every 100ms while renderer discovery remains rate-limited to roughly once per second, avoiding added latency across large official problem sets.

## [0.2.30] - 2026-07-28

### Fixed

- Stopping an official Run now immediately releases its pending account Bridge request and judge polling timer instead of retaining them until a response or timeout.
- Leaving practice mode, replacing the injection, or remounting the Codex composer now cancels pending official Run and Submit waits without allowing stale responses to affect the restored editor.

## [0.2.29] - 2026-07-28

### Fixed

- Stop now aborts and terminates the active offline Worker immediately instead of merely ignoring its eventual result while it continues consuming CPU until timeout.
- Leaving practice mode or remounting the Codex composer also aborts the current offline execution and releases its timer and Blob URL.

## [0.2.28] - 2026-07-28

### Fixed

- Offline runs now report synchronous Worker creation or messaging failures instead of leaving the Run control permanently locked.
- Worker timers, processes, and Blob URLs are cleaned up across constructor failures, message failures, runtime errors, normal results, and timeouts; handled Worker errors no longer leak into the host console.

## [0.2.27] - 2026-07-28

### Fixed

- Composer expansion now respects the current viewport height and recalculates immediately after a window resize, keeping the toolbar and its buttons visible in low-height desktop windows.
- The code editor and problem preview use a compact vertical layout below 640 pixels without changing the normal desktop presentation.

## [0.2.26] - 2026-07-28

### Security

- Existing and newly created dedicated LeetCode browser profile roots are restricted to the current user on Unix before the launcher or login flow uses them.
- Symbolic-link profile roots are rejected across launcher startup, login, reset, and restore paths instead of being passed to Chromium as trusted account storage.

## [0.2.25] - 2026-07-28

### Fixed

- Persisted problem searches are restored into the visible toolbar after activation or composer remount, eliminating invisible filters that made the official problem list appear incomplete.
- Persisted settings now retain only bounded, type-safe site, difficulty, problem, language, Vim, and search values before they can affect rendering or account requests.

## [0.2.24] - 2026-07-28

### Fixed

- Intentionally empty and whitespace-only drafts are restored exactly instead of being replaced by the current language starter template.
- Site-scoped Accepted markers for official problems now survive Codex page reloads alongside local problem progress.

## [0.2.23] - 2026-07-28

### Fixed

- Vim support is now installed and removed through a CodeMirror compartment instead of manually leaving an always-present plugin.
- Destroying or remounting an editor with Vim disabled no longer performs duplicate Vim cleanup or emits a CodeMirror plugin crash.

## [0.2.22] - 2026-07-28

### Security

- Official Run and Submit are unavailable until the selected LeetCode account has completed login; public problem browsing and local drafts remain available without login.
- The execution path independently rejects unsigned official requests, preventing user code from being sent if a stale or forged UI event bypasses disabled controls.

## [0.2.21] - 2026-07-28

### Fixed

- Active drafts are flushed immediately when the Codex page becomes hidden, enters the Chromium frozen state, or is being discarded.
- Closing or backgrounding Codex no longer leaves the native backup waiting on the normal 600 ms edit debounce.

## [0.2.20] - 2026-07-28

### Fixed

- Draft writes now remain bound to the problem and language that supplied the visible editor contents until replacement code has actually loaded.
- Startup restoration and asynchronous site, problem, or language switches can no longer copy the previous editor contents into the incoming problem's draft.

## [0.2.19] - 2026-07-28

### Fixed

- Official problem numbers now render correctly when a LeetCode endpoint returns `questionFrontendId` instead of the aliased `frontendQuestionId` field.
- Problem-list and loaded-question labels share the same bounded frontend-ID normalization.

## [0.2.18] - 2026-07-28

### Added

- A compact `+` control expands the complete problem statement and example area without adding another toolbar group.

### Fixed

- Official problem HTML now preserves paragraph, list, heading, preformatted, and line-break structure when converted to safe plain text.
- Expanded problem details use bounded scrolling, while the default two-line layout remains unchanged.

## [0.2.17] - 2026-07-28

### Added

- The existing Run button becomes Stop while examples are running, allowing cancellation without adding another toolbar control.

### Fixed

- Cancelling a Run immediately releases the controls and invalidates any late Bridge or judge response.
- Submit remains locked while in progress because an official submission cannot be withdrawn after dispatch.

## [0.2.16] - 2026-07-28

### Fixed

- Official problem pages now retry transient Bridge or LeetCode failures up to three times with bounded exponential backoff.
- Server pagination offsets advance by the raw batch size instead of the locally deduplicated problem count.
- Cross-page duplicate entries no longer cause repeated page requests or premature termination of the full problem load.

## [0.2.15] - 2026-07-28

### Fixed

- Background official-problem pagination can no longer overwrite Run, Submit, save, question, or error results.
- Result messages now carry a revision owner, so background progress updates stop as soon as foreground activity publishes a newer result.
- Failed question loading still allows silent problem pagination without replacing the visible error.

## [0.2.14] - 2026-07-28

### Fixed

- Native draft replacement now keeps a recoverable previous file on Windows instead of deleting it before the new draft is installed.
- Interrupted draft replacements are recovered automatically on the next load or save.
- Draft directory entries are synced after replacement on Unix, and draft directories are restricted to the current user.

### Security

- Native draft loading and replacement now reject symbolic links and non-regular destination files.

## [0.2.13] - 2026-07-28

### Fixed

- Official judge polling now uses a real 60-second wall-clock deadline instead of counting requests that could each wait another 20 seconds.
- Each judge Bridge request and polling delay is capped by the remaining deadline, producing a predictable timeout.
- Other account and problem requests retain their independent 20-second Bridge timeout.

## [0.2.12] - 2026-07-28

### Fixed

- Late online Run/Submit responses can no longer mark a problem solved after the practice session was closed or remounted.
- Superseded local and official judge tasks cannot overwrite newer result text or unlock controls belonging to a newer run.
- Judge work is now scoped to its exact site, problem, language, and request generation.

## [0.2.11] - 2026-07-28

### Fixed

- Official Run results no longer treat `run_success` alone as Accepted when LeetCode reports Wrong Answer.
- Judge failures now show the complete compile/runtime diagnostic plus failing input, expected output, and actual output when available.
- Incomplete judge responses continue polling instead of being rendered as a premature failure.

## [0.2.10] - 2026-07-28

### Fixed

- Active practice mode now survives launcher restarts after the old injected instance has already been destroyed.
- Active-session intent is scoped to the current Codex page session, while an explicit user close remains respected.

## [0.2.9] - 2026-07-28

### Fixed

- Replacing an injected older version now preserves an active practice session and remounts it automatically.
- Hot upgrades retain the selected site, language, Vim mode, and current draft without requiring the toggle shortcut again.

## [0.2.8] - 2026-07-28

### Added

- `list-pairing-backups --site <global|china>` lists recoverable backups for one site.
- `restore-pairing --site <global|china> --backup <name> --yes` atomically restores a selected profile.

### Security

- Pairing backup names, site prefixes, directory types, and Chromium singleton markers are validated before restore.
- Restore refuses to overwrite an existing profile or follow a symbolic-link backup entry.

## [0.2.7] - 2026-07-28

### Added

- `reset-pairing --site <global|china> --yes` safely resets one account browser profile without affecting the other site.
- Reset profiles are atomically moved to `~/.leetcodex/pairing-backups/` instead of being permanently deleted.

### Security

- Pairing reset refuses to touch a connected browser or a profile carrying active Chromium singleton markers.

## [0.2.6] - 2026-07-28

### Fixed

- Active practice sessions now remount automatically when Codex replaces or rerenders its composer DOM.
- Composer remounts save the current draft before cleanup and invalidate stale account, problem, login, and judge work.
- Temporary periods without a composer use bounded retry delays instead of silently exiting Leetcodex.

## [0.2.5] - 2026-07-28

### Added

- Cross-platform per-port instance locking with diagnostic metadata under `~/.leetcodex/runtime/`.
- `doctor` reports whether the requested launcher port is active or available, including safe lock metadata.

### Fixed

- Repeated launcher starts can no longer inject competing bridge tokens into the same Codex CDP endpoint.
- Stopping or restarting the Leetcodex launcher no longer sends the terminal interrupt to the dedicated account browser.

## [0.2.4] - 2026-07-28

### Changed

- Account pairing browsers now use Chromium-assigned loopback debugging ports owned by each dedicated profile instead of fixed global ports.
- `doctor` now reports independent `leetcode.com` and `leetcode.cn` pairing health, profile location, and active dynamic port.
- Repeated Login actions activate the existing site tab instead of opening duplicate login tabs.
- Pairing browser diagnostics no longer inherit and flood the Leetcodex launcher terminal.

### Security

- Paired browser reuse now verifies the profile's `DevToolsActivePort` identity before opening tabs or issuing authenticated LeetCode requests.

## [0.2.3] - 2026-07-28

### Added

- CI and release gates for high-severity npm production advisories and RustSec advisories.
- Weekly grouped Dependabot updates for Cargo, npm, and GitHub Actions.
- Security support and private vulnerability reporting policy.

## [0.2.2] - 2026-07-28

### Added

- Generated third-party dependency inventory with authors, source links, SPDX expressions, and bundled license or notice texts.

### Changed

- CI and both release builders now reject stale third-party notices and include them in release checksums.

## [0.2.1] - 2026-07-28

### Added

- Safe `uninstall-codex-plus-plus` command with the same optional directory override as installation.

### Changed

- Codex++ installation now writes through a temporary file and replaces managed scripts atomically.

### Security

- Installation and removal refuse to overwrite or delete an existing `leetcodex.js` that is not recognizably managed by Leetcodex.

## [0.2.0] - 2026-07-28

### Added

- Official `leetcode.com` and `leetcode.cn` problem loading, language templates, Run, Submit, and result polling.
- VS Code-style CodeMirror editor with search, draft saving, language switching, and optional Vim mode.
- Native draft backup under `~/.leetcodex/drafts/v1/` with automatic recovery after WebView storage loss.
- macOS universal and Windows x64 release scripts, cross-platform CI, and the `doctor` diagnostics command.

### Changed

- Responsive controls now follow the composer width instead of the outer Codex window width.
- Official LeetCode snippets take priority over local fallback templates.
- Long examples, compiler output, and judge results wrap or scroll instead of being truncated.

### Fixed

- Drafts no longer cross problem, site, or language boundaries.
- Stale problem, question, login, and submission responses cannot overwrite the current selection.
- Login polling no longer cancels draft backup or restore work.
- Run and Submit controls stay locked during incompatible loading and judging states.
- Search closing, Vim Escape handling, dark-theme selects, Windows discovery, C signatures, and worker variable isolation.

### Security

- Added random bridge tokens, loopback CDP validation, route allowlisting, payload limits, and strict submission field validation.
- Rejected unsafe debugger URLs, lookalike LeetCode domains, path-style slugs, and malformed submission identifiers.

## [0.1.0] - 2026-07-26

- Initial local typing and offline JavaScript practice prototype.
