# CotypeX Source Snapshot

This directory contains the CotypeX 0.5.5 source and test suite integrated into Leetcodex. It was copied from the current `Shichien/CotypeX` working tree on 2026-07-29 without modifying that repository.

Leetcodex supplies its release version, CSS, and corpus through the build-time `virtual:cotypex-assets` module. The combined userscript exposes the original `window.__COTYPEX__` API alongside `window.__LEETCODEX__`; activation is mutually exclusive and each toolbar can switch to the other mode.

CotypeX is distributed under the MIT License in [LICENSE](LICENSE).
