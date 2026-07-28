# Security Policy

## Supported Versions

The latest `0.2.x` release receives security fixes. Older development archives are not supported and should not be redistributed.

## Reporting A Vulnerability

Use the repository's GitHub Security Advisory form to report vulnerabilities privately. Include the affected version, operating system, reproduction steps, impact, and any suggested mitigation.

Do not publish credentials, cookies, session data, private source code, or working exploit details in a public issue. If private advisories are unavailable, open a public issue containing only a request for a private reporting channel.

## Security Boundaries

- Leetcodex connects only to explicitly selected loopback CDP endpoints.
- LeetCode credentials and cookies remain in the dedicated browser profile.
- Dedicated browser profile roots are restricted to the current user on Unix and symbolic-link profile roots are rejected before launch, reset, or restore.
- Draft backups are plaintext source files in the current user's `~/.leetcodex/drafts/v1/` directory. Native loads and saves reject symbolic links and Windows reparse points in every managed directory component before accessing a draft.
- Launcher locks under `~/.leetcodex/runtime/` reject symbolic-link directories or files and Windows reparse points. Lock metadata is bounded and accessed through a no-follow verified file handle.
- Online code is transmitted to the selected official LeetCode site when the user chooses Run or Submit.
- The offline JavaScript judge runs code in a Web Worker with a time limit; it is not a hardened operating-system sandbox.

## Dependency Response

CI checks production npm advisories and RustSec advisories. A release must not be published while a configured high-severity gate is failing. Dependency notices are generated from the committed lock files and included in release artifacts.
