use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result, bail};

#[derive(Debug)]
pub struct CodexApplication {
    path: PathBuf,
    kind: LaunchKind,
}

#[derive(Debug)]
enum LaunchKind {
    Executable,
    #[cfg(target_os = "macos")]
    MacosBundle,
}

impl CodexApplication {
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn launch(&self, native_args: &[String]) -> Result<()> {
        match self.kind {
            LaunchKind::Executable => {
                Command::new(&self.path)
                    .args(native_args)
                    .spawn()
                    .with_context(|| format!("failed to launch {}", self.path.display()))?;
            }
            #[cfg(target_os = "macos")]
            LaunchKind::MacosBundle => {
                Command::new("/usr/bin/open")
                    .args(["-na"])
                    .arg(&self.path)
                    .arg("--args")
                    .args(native_args)
                    .spawn()
                    .with_context(|| format!("failed to launch {}", self.path.display()))?;
            }
        }
        Ok(())
    }
}

pub fn resolve_codex_application(explicit: Option<&Path>) -> Result<CodexApplication> {
    if let Some(path) = explicit {
        return validate_explicit_path(path);
    }

    #[cfg(windows)]
    {
        resolve_windows_application()
    }

    #[cfg(target_os = "macos")]
    {
        resolve_macos_application()
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        bail!("automatic Codex discovery is supported only on Windows and macOS")
    }
}

fn validate_explicit_path(path: &Path) -> Result<CodexApplication> {
    if !path.is_absolute() {
        bail!(
            "Codex application path must be absolute: {}",
            path.display()
        );
    }

    #[cfg(target_os = "macos")]
    if path.extension().is_some_and(|extension| extension == "app") {
        return validate_macos_bundle(path.to_path_buf());
    }

    validate_executable(path.to_path_buf())
}

#[cfg(windows)]
fn resolve_windows_application() -> Result<CodexApplication> {
    let script = r#"
$package = Get-AppxPackage -Name OpenAI.Codex |
  Sort-Object Version -Descending |
  Select-Object -First 1
if ($null -eq $package) { exit 2 }
$manifest = Get-AppxPackageManifest -Package $package
$executables = @($manifest.Package.Applications.Application | ForEach-Object { $_.Executable })
$path = $executables |
  ForEach-Object { Join-Path $package.InstallLocation $_ } |
  Where-Object { Test-Path -LiteralPath $_ -PathType Leaf } |
  Select-Object -First 1
if ($null -eq $path) { exit 3 }
$path
"#;
    let output = Command::new("powershell.exe")
        .args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            script,
        ])
        .output()
        .context("failed to query the installed OpenAI.Codex package")?;

    if !output.status.success() {
        bail!(
            "OpenAI.Codex is not installed or its package location could not be read (exit code {})",
            output.status.code().unwrap_or(-1)
        );
    }

    let path = String::from_utf8(output.stdout)
        .context("PowerShell returned a non-UTF-8 Codex path")?
        .trim()
        .to_string();
    if path.is_empty() {
        bail!("OpenAI.Codex package lookup returned an empty executable path");
    }
    validate_executable(PathBuf::from(path))
}

#[cfg(target_os = "macos")]
fn resolve_macos_application() -> Result<CodexApplication> {
    let home = std::env::var_os("HOME").map(PathBuf::from);
    for candidate in macos_candidate_bundles(home.as_deref()) {
        if let Ok(application) = validate_macos_bundle(candidate) {
            return Ok(application);
        }
    }

    let output = Command::new("/usr/bin/mdfind")
        .arg("kMDItemCFBundleIdentifier == 'com.openai.codex'")
        .output()
        .context("failed to query the macOS application index")?;
    if output.status.success() {
        let candidates = String::from_utf8(output.stdout)
            .context("the macOS application index returned a non-UTF-8 path")?;
        for candidate in candidates
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Ok(application) = validate_macos_bundle(PathBuf::from(candidate)) {
                return Ok(application);
            }
        }
    }

    bail!(
        "the official Codex app bundle (com.openai.codex) was not found in /Applications or ~/Applications"
    )
}

#[cfg(any(target_os = "macos", test))]
fn macos_candidate_bundles(home: Option<&Path>) -> Vec<PathBuf> {
    const NAMES: [&str; 4] = [
        "Codex.app",
        "OpenAI Codex.app",
        "OpenAI.Codex.app",
        "ChatGPT.app",
    ];
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Some(home) = home {
        roots.push(home.join("Applications"));
    }
    roots
        .into_iter()
        .flat_map(|root| NAMES.map(|name| root.join(name)))
        .collect()
}

#[cfg(target_os = "macos")]
fn validate_macos_bundle(bundle: PathBuf) -> Result<CodexApplication> {
    use std::os::unix::fs::PermissionsExt;

    if !bundle.is_absolute() {
        bail!(
            "Codex application path must be absolute: {}",
            bundle.display()
        );
    }
    if !bundle.is_dir() {
        bail!("Codex app bundle does not exist: {}", bundle.display());
    }
    let plist = bundle.join("Contents").join("Info.plist");
    let identifier = plist_value(&plist, "CFBundleIdentifier")?;
    if identifier != "com.openai.codex" {
        bail!(
            "unexpected app bundle identifier {identifier} at {}",
            bundle.display()
        );
    }
    let executable_name = plist_value(&plist, "CFBundleExecutable")?;
    let executable = bundle.join("Contents").join("MacOS").join(executable_name);
    let metadata = executable
        .metadata()
        .with_context(|| format!("Codex executable does not exist: {}", executable.display()))?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        bail!(
            "Codex executable is not executable: {}",
            executable.display()
        );
    }
    Ok(CodexApplication {
        path: bundle,
        kind: LaunchKind::MacosBundle,
    })
}

#[cfg(target_os = "macos")]
fn plist_value(plist: &Path, key: &str) -> Result<String> {
    let output = Command::new("/usr/bin/plutil")
        .args(["-extract", key, "raw", "-o", "-"])
        .arg(plist)
        .output()
        .with_context(|| format!("failed to read {}", plist.display()))?;
    if !output.status.success() {
        bail!("{} does not contain {key}", plist.display());
    }
    let value = String::from_utf8(output.stdout)
        .with_context(|| format!("{key} in {} is not UTF-8", plist.display()))?
        .trim()
        .to_string();
    if value.is_empty() {
        bail!("{key} in {} is empty", plist.display());
    }
    Ok(value)
}

fn validate_executable(path: PathBuf) -> Result<CodexApplication> {
    if !path.is_absolute() {
        bail!(
            "Codex application path must be absolute: {}",
            path.display()
        );
    }
    if !path.is_file() {
        bail!("Codex executable does not exist: {}", path.display());
    }
    Ok(CodexApplication {
        path,
        kind: LaunchKind::Executable,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_explicit_path_is_rejected() {
        let error = resolve_codex_application(Some(Path::new("ChatGPT.exe"))).unwrap_err();
        assert!(error.to_string().contains("must be absolute"));
    }

    #[test]
    fn macos_candidates_cover_system_and_user_application_directories() {
        let candidates = macos_candidate_bundles(Some(Path::new("/Users/tester")));
        assert_eq!(candidates.len(), 8);
        assert!(candidates.contains(&PathBuf::from("/Applications/Codex.app")));
        assert!(candidates.contains(&PathBuf::from("/Applications/ChatGPT.app")));
        assert!(candidates.contains(&PathBuf::from("/Users/tester/Applications/Codex.app")));
    }
}
