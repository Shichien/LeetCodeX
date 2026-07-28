$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
$PSNativeCommandUseErrorActionPreference = $true

$Root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
Set-Location $Root

foreach ($Command in @("node", "pnpm", "cargo", "rustup")) {
    if (-not (Get-Command $Command -ErrorAction SilentlyContinue)) {
        throw "Required command is missing: $Command"
    }
}

$Manifest = Get-Content (Join-Path $Root "Cargo.toml") -Raw
$VersionMatch = [regex]::Match($Manifest, '(?m)^version\s*=\s*"([^"]+)"')
if (-not $VersionMatch.Success) {
    throw "Could not read the package version from Cargo.toml."
}

$Version = $VersionMatch.Groups[1].Value
$Target = "x86_64-pc-windows-msvc"
node scripts/check-release-version.mjs
node scripts/check-launchers.mjs
$PackageName = "Leetcodex-$Version-windows-x64"
$ReleaseRoot = Join-Path $Root "release"
$Package = Join-Path $ReleaseRoot $PackageName
$Archive = Join-Path $ReleaseRoot "$PackageName.zip"
$ArchiveChecksum = "$Archive.sha256"

if ((Test-Path $Package) -or (Test-Path $Archive) -or (Test-Path $ArchiveChecksum)) {
    throw "Release output already exists. Remove $Package, $Archive, and $ArchiveChecksum before rebuilding."
}

pnpm --dir web install --frozen-lockfile
node scripts/generate-third-party-notices.mjs --check
pnpm --dir web test
pnpm --dir web build
cargo fmt --check
cargo test --all-targets --locked
cargo clippy --all-targets --locked -- -D warnings
rustup target add $Target
cargo build --release --locked --target $Target

try {
    $Binary = Join-Path $Root "target\$Target\release\leetcodex.exe"
    $ActualVersion = (& $Binary --version | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $ActualVersion -ne "leetcodex $Version") {
        throw "Packaged binary reported an unexpected version: $ActualVersion"
    }

    New-Item -ItemType Directory -Path $Package -Force | Out-Null
    Copy-Item $Binary (Join-Path $Package "leetcodex.exe")
    Copy-Item (Join-Path $Root "dist\leetcodex.user.js") (Join-Path $Package "leetcodex.user.js")
    Copy-Item (Join-Path $Root "windows\Start Leetcodex.cmd") (Join-Path $Package "Start Leetcodex.cmd")
    Copy-Item (Join-Path $Root "windows\README.md") (Join-Path $Package "README.md")
    Copy-Item (Join-Path $Root "LICENSE") (Join-Path $Package "LICENSE")
    Copy-Item (Join-Path $Root "CHANGELOG.md") (Join-Path $Package "CHANGELOG.md")
    Copy-Item (Join-Path $Root "THIRD_PARTY_NOTICES.md") (Join-Path $Package "THIRD_PARTY_NOTICES.md")
    Copy-Item (Join-Path $Root "SECURITY.md") (Join-Path $Package "SECURITY.md")

    $ChecksumLines = Get-ChildItem $Package -File | Sort-Object Name | ForEach-Object {
        $Hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
        "$Hash  $($_.Name)"
    }
    Set-Content -Path (Join-Path $Package "SHA256SUMS.txt") -Value $ChecksumLines -Encoding ascii

    foreach ($Line in $ChecksumLines) {
        if ($Line -notmatch '^([0-9a-f]{64})  (.+)$') {
            throw "Invalid checksum line: $Line"
        }
        $File = Join-Path $Package $Matches[2]
        $ActualHash = (Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($ActualHash -ne $Matches[1]) {
            throw "Checksum verification failed for $($Matches[2])"
        }
    }

    Compress-Archive -Path $Package -DestinationPath $Archive -CompressionLevel Optimal
    $VerificationRoot = Join-Path ([System.IO.Path]::GetTempPath()) "leetcodex-$Version-$PID"
    try {
        Expand-Archive -Path $Archive -DestinationPath $VerificationRoot
        $ExpandedPackage = Join-Path $VerificationRoot $PackageName
        foreach ($Line in (Get-Content (Join-Path $ExpandedPackage "SHA256SUMS.txt"))) {
            if ($Line -notmatch '^([0-9a-f]{64})  (.+)$') {
                throw "Invalid archived checksum line: $Line"
            }
            $File = Join-Path $ExpandedPackage $Matches[2]
            $ActualHash = (Get-FileHash $File -Algorithm SHA256).Hash.ToLowerInvariant()
            if ($ActualHash -ne $Matches[1]) {
                throw "Archived checksum verification failed for $($Matches[2])"
            }
        }
    } finally {
        Remove-Item $VerificationRoot -Recurse -Force -ErrorAction SilentlyContinue
    }
    $ArchiveHash = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    Set-Content -Path $ArchiveChecksum -Value "$ArchiveHash  $PackageName.zip" -Encoding ascii
    $VerifiedArchiveHash = (Get-FileHash $Archive -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($VerifiedArchiveHash -ne $ArchiveHash) {
        throw "Release archive checksum verification failed"
    }
    Write-Host "Built $Archive"
} catch {
    Remove-Item $Package -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $Archive -Force -ErrorAction SilentlyContinue
    Remove-Item $ArchiveChecksum -Force -ErrorAction SilentlyContinue
    throw
}
