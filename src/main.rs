mod bridge;
mod cdp;
mod discovery;
mod drafts;
mod leetcode;

use std::fs;
use std::fs::{File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::thread;
use std::time::{Duration, Instant};

use anyhow::{Context, Result, bail};
use clap::{Parser, Subcommand};
use fs2::FileExt;
use rand::RngCore;

const LEETCODEX_SCRIPT: &str = include_str!("../dist/leetcodex.user.js");
const DEFAULT_PORT: u16 = 9337;
const MAX_INSTANCE_LOCK_BYTES: u64 = 4096;

#[derive(Parser)]
#[command(
    name = "leetcodex",
    version,
    about = "Run Leetcodex inside the Codex desktop composer"
)]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}

#[derive(Subcommand)]
enum Commands {
    /// Launch Codex with a loopback CDP port, then inject Leetcodex.
    Run {
        #[arg(long, value_name = "PATH")]
        codex_path: Option<PathBuf>,
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        #[arg(long, default_value_t = 45, value_parser = clap::value_parser!(u64).range(1..=300))]
        timeout_seconds: u64,
    },
    /// Attach to an already running Codex CDP endpoint.
    Attach {
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
    },
    /// Install the shared user script for Codex++.
    InstallCodexPlusPlus {
        #[arg(long, value_name = "DIRECTORY")]
        directory: Option<PathBuf>,
    },
    /// Remove the managed Codex++ user script.
    UninstallCodexPlusPlus {
        #[arg(long, value_name = "DIRECTORY")]
        directory: Option<PathBuf>,
    },
    /// Inspect the local installation without launching or changing anything.
    Doctor {
        #[arg(long, value_name = "PATH")]
        codex_path: Option<PathBuf>,
        #[arg(long, default_value_t = DEFAULT_PORT)]
        port: u16,
        #[arg(long)]
        json: bool,
        /// Exit unsuccessfully when the full launcher and renderer stack is not healthy.
        #[arg(long)]
        strict: bool,
    },
    /// Back up and reset one dedicated LeetCode account browser profile.
    ResetPairing {
        #[arg(long, value_parser = ["global", "china"])]
        site: String,
        #[arg(long)]
        yes: bool,
    },
    /// List recoverable account browser profile backups for one site.
    ListPairingBackups {
        #[arg(long, value_parser = ["global", "china"])]
        site: String,
        #[arg(long)]
        json: bool,
    },
    /// Restore one account browser profile backup.
    RestorePairing {
        #[arg(long, value_parser = ["global", "china"])]
        site: String,
        #[arg(long)]
        backup: String,
        #[arg(long)]
        yes: bool,
    },
}

fn main() {
    if let Err(error) = run_cli() {
        eprintln!("Leetcodex failed: {error:#}");
        std::process::exit(1);
    }
}

fn run_cli() -> Result<()> {
    let cli = Cli::parse();
    match cli.command {
        Commands::Run {
            codex_path,
            port,
            timeout_seconds,
        } => run_standalone(codex_path.as_deref(), port, timeout_seconds),
        Commands::Attach { port } => attach_and_watch(port),
        Commands::InstallCodexPlusPlus { directory } => install_codex_plus_plus(directory),
        Commands::UninstallCodexPlusPlus { directory } => uninstall_codex_plus_plus(directory),
        Commands::Doctor {
            codex_path,
            port,
            json,
            strict,
        } => run_doctor(codex_path.as_deref(), port, json, strict),
        Commands::ResetPairing { site, yes } => reset_pairing(&site, yes),
        Commands::ListPairingBackups { site, json } => list_pairing_backups(&site, json),
        Commands::RestorePairing { site, backup, yes } => restore_pairing(&site, &backup, yes),
    }
}

fn reset_pairing(site: &str, confirmed: bool) -> Result<()> {
    if !confirmed {
        bail!(
            "pairing reset requires --yes because it signs the selected dedicated browser profile out of LeetCode"
        );
    }
    let result = leetcode::reset_pairing(leetcode::Site::parse(site)?)?;
    if result["reset"].as_bool() == Some(true) {
        println!(
            "Reset {site} pairing. Previous profile backed up at {}",
            result["backup"].as_str().unwrap_or("unknown location")
        );
        println!("Choose Login in Leetcodex to create a fresh profile.");
    } else {
        println!("No {site} pairing profile exists; nothing changed.");
    }
    Ok(())
}

fn list_pairing_backups(site: &str, json_output: bool) -> Result<()> {
    let result = leetcode::list_pairing_backups(leetcode::Site::parse(site)?)?;
    if json_output {
        println!("{}", serde_json::to_string_pretty(&result)?);
        return Ok(());
    }
    let backups = result["backups"]
        .as_array()
        .context("pairing backup response is invalid")?;
    if backups.is_empty() {
        println!("No {site} pairing backups found.");
        return Ok(());
    }
    println!("{site} pairing backups:");
    for backup in backups {
        println!("  {}", backup["name"].as_str().unwrap_or("unknown"));
    }
    Ok(())
}

fn restore_pairing(site: &str, backup: &str, confirmed: bool) -> Result<()> {
    if !confirmed {
        bail!(
            "pairing restore requires --yes because it replaces the selected site's active profile state"
        );
    }
    let result = leetcode::restore_pairing(leetcode::Site::parse(site)?, backup)?;
    println!(
        "Restored {site} pairing profile at {}",
        result["profile"].as_str().unwrap_or("unknown location")
    );
    println!("Choose Login in Leetcodex to reopen the restored profile.");
    Ok(())
}

fn run_doctor(codex_path: Option<&Path>, port: u16, json_output: bool, strict: bool) -> Result<()> {
    validate_port(port)?;
    let codex = match discovery::resolve_codex_application(codex_path) {
        Ok(application) => serde_json::json!({
            "status": "found",
            "path": application.path().to_string_lossy(),
        }),
        Err(error) => serde_json::json!({ "status": "error", "detail": format!("{error:#}") }),
    };
    let account_browser = match leetcode::pairing_browser_executable() {
        Ok(path) => serde_json::json!({
            "status": "found",
            "path": path.to_string_lossy(),
        }),
        Err(error) => serde_json::json!({ "status": "error", "detail": format!("{error:#}") }),
    };
    let (cdp, renderer) = if cdp::endpoint_is_available(port) {
        match cdp::CdpClient::connect(port) {
            Ok(client) => (
                serde_json::json!({ "status": "connected", "port": port }),
                client.renderer_diagnostic(env!("CARGO_PKG_VERSION")),
            ),
            Err(error) => (
                serde_json::json!({
                    "status": "invalid_endpoint",
                    "port": port,
                    "detail": format!("{error:#}"),
                }),
                serde_json::json!({ "status": "unavailable" }),
            ),
        }
    } else if cdp::port_is_free(port) {
        (
            serde_json::json!({ "status": "not_running", "port": port }),
            serde_json::json!({ "status": "unavailable" }),
        )
    } else {
        (
            serde_json::json!({
                "status": "port_conflict",
                "port": port,
                "detail": "the port is occupied by a service that is not a verified Codex CDP endpoint",
            }),
            serde_json::json!({ "status": "unavailable" }),
        )
    };
    let drafts = drafts::diagnostic();
    let draft_directory = drafts["path"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            format!(
                "unavailable: {}",
                drafts["detail"]
                    .as_str()
                    .unwrap_or("draft directory could not be resolved")
            )
        });
    let leetcode = serde_json::json!({
        "global": leetcode::pairing_diagnostic(leetcode::Site::Global),
        "china": leetcode::pairing_diagnostic(leetcode::Site::China),
    });
    let launcher = instance_lock_diagnostic(port);
    let mut report = serde_json::json!({
        "application": "Leetcodex",
        "version": env!("CARGO_PKG_VERSION"),
        "platform": std::env::consts::OS,
        "architecture": std::env::consts::ARCH,
        "codex": codex,
        "accountBrowser": account_browser,
        "leetcode": leetcode,
        "launcher": launcher,
        "cdp": cdp,
        "renderer": renderer,
        "drafts": drafts,
        "draftDirectory": draft_directory,
    });
    let healthy = doctor_report_is_healthy(&report);
    report["healthy"] = serde_json::Value::Bool(healthy);

    if json_output {
        println!("{}", serde_json::to_string_pretty(&report)?);
    } else {
        println!("Leetcodex {} doctor", env!("CARGO_PKG_VERSION"));
        println!(
            "Platform: {} / {}",
            std::env::consts::OS,
            std::env::consts::ARCH
        );
        print_diagnostic("Codex", &report["codex"]);
        print_diagnostic("Account browser", &report["accountBrowser"]);
        print_diagnostic("leetcode.com pairing", &report["leetcode"]["global"]);
        print_diagnostic("leetcode.cn pairing", &report["leetcode"]["china"]);
        print_diagnostic("Launcher lock", &report["launcher"]);
        print_diagnostic("Codex CDP", &report["cdp"]);
        print_diagnostic("Leetcodex renderer", &report["renderer"]);
        print_diagnostic("Draft backup", &report["drafts"]);
        println!("Overall: {}", if healthy { "healthy" } else { "degraded" });
    }
    if strict && !healthy {
        bail!("doctor strict check failed because the full Leetcodex stack is not healthy");
    }
    Ok(())
}

fn doctor_report_is_healthy(report: &serde_json::Value) -> bool {
    [
        ("codex", "found"),
        ("accountBrowser", "found"),
        ("launcher", "active"),
        ("cdp", "connected"),
        ("renderer", "active"),
    ]
    .iter()
    .all(|(component, expected)| report[*component]["status"].as_str() == Some(*expected))
        && matches!(
            report["drafts"]["status"].as_str(),
            Some("ready" | "not_created")
        )
}

fn print_diagnostic(label: &str, value: &serde_json::Value) {
    let status = value
        .get("status")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("unknown");
    let detail = value
        .get("path")
        .or_else(|| value.get("detail"))
        .and_then(serde_json::Value::as_str);
    match detail {
        Some(detail) => println!("{label}: {status} ({detail})"),
        None => println!("{label}: {status}"),
    }
}

fn run_standalone(codex_path: Option<&Path>, port: u16, timeout_seconds: u64) -> Result<()> {
    validate_port(port)?;
    let instance_lock = acquire_instance_lock(port)?;
    if cdp::endpoint_is_available(port) {
        println!("Using the existing verified CDP endpoint on 127.0.0.1:{port}");
        return attach_and_watch_locked(port, instance_lock);
    }
    if !cdp::port_is_free(port) {
        bail!("port {port} is occupied by a service that is not a verified CDP endpoint");
    }

    let application = discovery::resolve_codex_application(codex_path)?;
    println!("Launching {}", application.path().display());
    let native_args = [
        "--remote-debugging-address=127.0.0.1".to_string(),
        format!("--remote-debugging-port={port}"),
        format!("--remote-allow-origins=http://127.0.0.1:{port}"),
    ];
    application.launch(&native_args)?;

    let deadline = Instant::now() + Duration::from_secs(timeout_seconds);
    while Instant::now() < deadline {
        if cdp::endpoint_is_available(port) {
            return attach_and_watch_locked(port, instance_lock);
        }
        thread::sleep(Duration::from_millis(400));
    }

    bail!(
        "Codex did not expose CDP on port {port} within {timeout_seconds} seconds. Close every existing Codex window and run Leetcodex again"
    )
}

fn attach_and_watch(port: u16) -> Result<()> {
    validate_port(port)?;
    let instance_lock = acquire_instance_lock(port)?;
    attach_and_watch_locked(port, instance_lock)
}

fn attach_and_watch_locked(port: u16, _instance_lock: InstanceLock) -> Result<()> {
    leetcode::secure_existing_pairing_profiles()
        .context("failed to secure the dedicated LeetCode browser profiles")?;
    let client = cdp::CdpClient::connect(port)
        .with_context(|| format!("no verified Codex CDP endpoint is available on port {port}"))?;
    let running = Arc::new(AtomicBool::new(true));
    let signal = Arc::clone(&running);
    ctrlc::set_handler(move || {
        signal.store(false, Ordering::SeqCst);
    })
    .context("failed to install the Ctrl+C handler")?;

    let bridge_token = bridge::generate_token();
    let script = LEETCODEX_SCRIPT.replace("__LEETCODEX_BRIDGE_TOKEN__", &bridge_token);
    println!("Leetcodex is active. Press Ctrl+Alt+L inside Codex to start coding practice.");
    println!("Account requests use the authenticated Codex CDP binding.");
    println!("Keep this process running; press Ctrl+C to remove the injected behavior.");
    client.watch_and_inject(&script, &bridge_token, &running)
}

struct InstanceLock {
    _file: File,
}

fn acquire_instance_lock(port: u16) -> Result<InstanceLock> {
    acquire_instance_lock_at(&runtime_directory()?, port)
}

fn runtime_directory() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .context("HOME or USERPROFILE is required for the Leetcodex runtime lock")?;
    Ok(PathBuf::from(home).join(".leetcodex").join("runtime"))
}

fn instance_lock_diagnostic(port: u16) -> serde_json::Value {
    match runtime_directory() {
        Ok(runtime) => instance_lock_diagnostic_at(&runtime, port),
        Err(error) => serde_json::json!({
            "status": "unavailable",
            "detail": format!("{error:#}"),
        }),
    }
}

fn instance_lock_diagnostic_at(runtime_directory: &Path, port: u16) -> serde_json::Value {
    let path = runtime_directory.join(format!("codex-{port}.lock"));
    match validate_runtime_directory_chain(runtime_directory) {
        Ok(true) => {}
        Ok(false) => {
            return serde_json::json!({
                "status": "available",
                "path": path.to_string_lossy(),
            });
        }
        Err(error) => {
            return serde_json::json!({
                "status": "unavailable",
                "path": path.to_string_lossy(),
                "detail": format!("{error:#}"),
            });
        }
    }
    match fs::symlink_metadata(&path) {
        Ok(metadata) if is_real_file(&metadata) => {}
        Ok(_) => {
            return serde_json::json!({
                "status": "unavailable",
                "path": path.to_string_lossy(),
                "detail": "instance lock must be a regular file without links or reparse points",
            });
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return serde_json::json!({
                "status": "available",
                "path": path.to_string_lossy(),
            });
        }
        Err(error) => {
            return serde_json::json!({
                "status": "unavailable",
                "path": path.to_string_lossy(),
                "detail": error.to_string(),
            });
        }
    }
    let file = match open_instance_lock_file(&path, false) {
        Ok(file) => file,
        Err(error) => {
            return serde_json::json!({
                "status": "unavailable",
                "path": path.to_string_lossy(),
                "detail": format!("{error:#}"),
            });
        }
    };
    match file.try_lock_exclusive() {
        Ok(()) => serde_json::json!({
            "status": "available",
            "path": path.to_string_lossy(),
        }),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
            classify_active_instance_lock(&file, &path, port)
        }
        Err(error) => serde_json::json!({
            "status": "unavailable",
            "path": path.to_string_lossy(),
            "detail": error.to_string(),
        }),
    }
}

fn read_instance_lock_metadata(file: &File) -> Result<serde_json::Value> {
    let metadata = file.metadata().context("failed to inspect instance lock")?;
    if metadata.len() > MAX_INSTANCE_LOCK_BYTES {
        bail!("instance lock metadata exceeds the {MAX_INSTANCE_LOCK_BYTES}-byte limit");
    }
    let mut reader = file.try_clone().context("failed to clone instance lock")?;
    reader.seek(SeekFrom::Start(0))?;
    let mut contents = String::new();
    reader
        .take(MAX_INSTANCE_LOCK_BYTES + 1)
        .read_to_string(&mut contents)
        .context("failed to read instance lock metadata")?;
    parse_instance_lock_metadata(&contents)
}

fn classify_active_instance_lock(
    file: &File,
    path: &Path,
    expected_port: u16,
) -> serde_json::Value {
    let metadata = match read_instance_lock_metadata(file) {
        Ok(metadata) => metadata,
        Err(error) => {
            return serde_json::json!({
                "status": "invalid_metadata",
                "path": path.to_string_lossy(),
                "detail": format!("{error:#}"),
            });
        }
    };
    let metadata_port = metadata["port"]
        .as_str()
        .and_then(|value| value.parse::<u16>().ok());
    if metadata_port != Some(expected_port) {
        return serde_json::json!({
            "status": "invalid_metadata",
            "path": path.to_string_lossy(),
            "metadata": metadata,
            "detail": format!("instance lock port does not match requested port {expected_port}"),
        });
    }
    if metadata["version"].as_str() != Some(env!("CARGO_PKG_VERSION")) {
        return serde_json::json!({
            "status": "version_mismatch",
            "path": path.to_string_lossy(),
            "metadata": metadata,
            "detail": format!("instance lock version does not match Leetcodex {}", env!("CARGO_PKG_VERSION")),
        });
    }
    serde_json::json!({
        "status": "active",
        "path": path.to_string_lossy(),
        "metadata": metadata,
    })
}

fn validate_runtime_directory_chain(runtime_directory: &Path) -> Result<bool> {
    let parent = runtime_directory
        .parent()
        .context("runtime directory has no Leetcodex data parent")?;
    let mut complete = true;
    for path in [parent, runtime_directory] {
        match fs::symlink_metadata(path) {
            Ok(metadata) if is_real_directory(&metadata) => {}
            Ok(_) => bail!("runtime path must be a real directory: {}", path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => complete = false,
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect runtime directory {}", path.display())
                });
            }
        }
    }
    Ok(complete)
}

fn prepare_runtime_directory(runtime_directory: &Path) -> Result<()> {
    let parent = runtime_directory
        .parent()
        .context("runtime directory has no Leetcodex data parent")?;
    for path in [parent, runtime_directory] {
        match fs::symlink_metadata(path) {
            Ok(metadata) if is_real_directory(&metadata) => {}
            Ok(_) => bail!("runtime path must be a real directory: {}", path.display()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                create_private_runtime_directory(path)?;
            }
            Err(error) => {
                return Err(error).with_context(|| {
                    format!("failed to inspect runtime directory {}", path.display())
                });
            }
        }
    }
    if !validate_runtime_directory_chain(runtime_directory)? {
        bail!("runtime directory chain changed while it was being prepared");
    }
    restrict_runtime_directory(runtime_directory)
}

fn create_private_runtime_directory(path: &Path) -> Result<()> {
    private_runtime_directory_builder()
        .create(path)
        .with_context(|| format!("failed to create runtime directory {}", path.display()))
}

#[cfg(unix)]
fn private_runtime_directory_builder() -> fs::DirBuilder {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    builder
}

#[cfg(not(unix))]
fn private_runtime_directory_builder() -> fs::DirBuilder {
    fs::DirBuilder::new()
}

fn is_real_directory(metadata: &fs::Metadata) -> bool {
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return false;
    }
    !metadata_is_windows_reparse_point(metadata)
}

fn is_real_file(metadata: &fs::Metadata) -> bool {
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        return false;
    }
    !metadata_is_windows_reparse_point(metadata)
}

#[cfg(windows)]
fn metadata_is_windows_reparse_point(metadata: &fs::Metadata) -> bool {
    use std::os::windows::fs::MetadataExt;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0
}

#[cfg(not(windows))]
fn metadata_is_windows_reparse_point(_metadata: &fs::Metadata) -> bool {
    false
}

fn open_instance_lock_file(path: &Path, create_new: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    if create_new {
        options.create_new(true);
    }
    configure_lock_open_options(&mut options);
    let file = options
        .open(path)
        .with_context(|| format!("failed to open Leetcodex instance lock {}", path.display()))?;
    let metadata = file.metadata().with_context(|| {
        format!(
            "failed to inspect Leetcodex instance lock {}",
            path.display()
        )
    })?;
    if !is_real_file(&metadata) {
        bail!(
            "instance lock must be a regular file without links or reparse points: {}",
            path.display()
        );
    }
    Ok(file)
}

#[cfg(unix)]
fn configure_lock_open_options(options: &mut OpenOptions) {
    use std::os::unix::fs::OpenOptionsExt;
    options.custom_flags(libc::O_NOFOLLOW);
}

#[cfg(windows)]
fn configure_lock_open_options(options: &mut OpenOptions) {
    use std::os::windows::fs::OpenOptionsExt;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
}

#[cfg(not(any(unix, windows)))]
fn configure_lock_open_options(_options: &mut OpenOptions) {}

fn lock_path_metadata(path: &Path) -> Result<Option<fs::Metadata>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_real_file(&metadata) => Ok(Some(metadata)),
        Ok(_) => bail!(
            "instance lock must be a regular file without links or reparse points: {}",
            path.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error)
            .with_context(|| format!("failed to inspect instance lock {}", path.display())),
    }
}

fn parse_instance_lock_metadata(contents: &str) -> Result<serde_json::Value> {
    let mut metadata = serde_json::Map::new();
    for line in contents.lines() {
        let (key, value) = line
            .split_once('=')
            .context("instance lock metadata line must contain '='")?;
        if !matches!(key, "pid" | "version" | "port") {
            bail!("instance lock metadata contains unsupported field {key}");
        }
        if value.is_empty() {
            bail!("instance lock metadata field {key} is empty");
        }
        if metadata
            .insert(
                key.to_string(),
                serde_json::Value::String(value.to_string()),
            )
            .is_some()
        {
            bail!("instance lock metadata field {key} is duplicated");
        }
    }
    for key in ["pid", "version", "port"] {
        if !metadata.contains_key(key) {
            bail!("instance lock metadata field {key} is missing");
        }
    }
    let pid = metadata["pid"]
        .as_str()
        .and_then(|value| value.parse::<u32>().ok())
        .filter(|value| *value > 0);
    if pid.is_none() {
        bail!("instance lock pid must be a positive integer");
    }
    if metadata["port"]
        .as_str()
        .and_then(|value| value.parse::<u16>().ok())
        .is_none()
    {
        bail!("instance lock port must be an integer between 0 and 65535");
    }
    Ok(serde_json::Value::Object(metadata))
}

fn acquire_instance_lock_at(runtime_directory: &Path, port: u16) -> Result<InstanceLock> {
    prepare_runtime_directory(runtime_directory)?;
    let path = runtime_directory.join(format!("codex-{port}.lock"));
    let create_new = lock_path_metadata(&path)?.is_none();
    let mut file = open_instance_lock_file(&path, create_new)?;
    restrict_lock_file(&file, &path)?;
    if let Err(error) = file.try_lock_exclusive() {
        if error.kind() == std::io::ErrorKind::WouldBlock {
            bail!(
                "another Leetcodex launcher is already attached to Codex CDP port {port}; keep the existing launcher running or stop it before starting a new one"
            );
        }
        return Err(error)
            .with_context(|| format!("failed to lock Leetcodex instance file {}", path.display()));
    }
    file.set_len(0)
        .with_context(|| format!("failed to reset Leetcodex instance lock {}", path.display()))?;
    file.seek(SeekFrom::Start(0))?;
    writeln!(
        file,
        "pid={}\nversion={}\nport={port}",
        std::process::id(),
        env!("CARGO_PKG_VERSION")
    )
    .with_context(|| format!("failed to write Leetcodex instance lock {}", path.display()))?;
    file.sync_data()
        .with_context(|| format!("failed to flush Leetcodex instance lock {}", path.display()))?;
    Ok(InstanceLock { _file: file })
}

#[cfg(unix)]
fn restrict_runtime_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("failed to secure runtime directory {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_runtime_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_lock_file(file: &File, path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    file.set_permissions(fs::Permissions::from_mode(0o600))
        .with_context(|| format!("failed to secure instance lock {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_lock_file(_file: &File, _path: &Path) -> Result<()> {
    Ok(())
}

fn install_codex_plus_plus(directory: Option<PathBuf>) -> Result<()> {
    let root = match directory {
        Some(path) => path,
        None => default_codex_plus_plus_directory()?,
    };
    let destination = install_managed_user_script(&root, LEETCODEX_SCRIPT)?;
    println!(
        "Installed the Codex++ user script at {}",
        destination.display()
    );
    println!("Enable user scripts in Codex++ and reload them or restart Codex++.");
    Ok(())
}

fn uninstall_codex_plus_plus(directory: Option<PathBuf>) -> Result<()> {
    let root = match directory {
        Some(path) => path,
        None => default_codex_plus_plus_directory()?,
    };
    let destination = root.join("leetcodex.js");
    if remove_managed_user_script(&root)? {
        println!(
            "Removed the Codex++ user script at {}",
            destination.display()
        );
        println!("Reload user scripts or restart Codex++ to finish unloading Leetcodex.");
    } else {
        println!("Leetcodex is not installed at {}", destination.display());
    }
    Ok(())
}

fn install_managed_user_script(root: &Path, script: &str) -> Result<PathBuf> {
    fs::create_dir_all(root).with_context(|| format!("failed to create {}", root.display()))?;
    let destination = root.join("leetcodex.js");
    if destination.exists() {
        ensure_managed_user_script(&destination)?;
    }

    let mut random = [0_u8; 8];
    rand::rng().fill_bytes(&mut random);
    let temporary = root.join(format!(
        ".leetcodex.js.{}-{}.tmp",
        std::process::id(),
        u64::from_le_bytes(random)
    ));
    let result = (|| {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .with_context(|| format!("failed to create {}", temporary.display()))?;
        file.write_all(script.as_bytes())?;
        file.sync_all()?;
        replace_managed_user_script(&temporary, &destination)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result?;
    Ok(destination)
}

fn ensure_managed_user_script(path: &Path) -> Result<()> {
    let mut file = fs::File::open(path)
        .with_context(|| format!("failed to inspect existing script {}", path.display()))?;
    let mut prefix = [0_u8; 128];
    let length = file.read(&mut prefix)?;
    let prefix = String::from_utf8_lossy(&prefix[..length]);
    if !prefix.starts_with("/* Leetcodex ") || !prefix.contains("local coding practice for Codex") {
        bail!(
            "refusing to replace or remove unmanaged file {}; move it first or choose another --directory",
            path.display()
        );
    }
    Ok(())
}

fn remove_managed_user_script(root: &Path) -> Result<bool> {
    let destination = root.join("leetcodex.js");
    if !destination.exists() {
        return Ok(false);
    }
    ensure_managed_user_script(&destination)?;
    fs::remove_file(&destination)
        .with_context(|| format!("failed to remove {}", destination.display()))?;
    Ok(true)
}

#[cfg(unix)]
fn replace_managed_user_script(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination)
        .with_context(|| format!("failed to replace {}", destination.display()))
}

#[cfg(not(unix))]
fn replace_managed_user_script(source: &Path, destination: &Path) -> Result<()> {
    if !destination.exists() {
        return fs::rename(source, destination)
            .with_context(|| format!("failed to install {}", destination.display()));
    }
    let backup = destination.with_extension("js.leetcodex-backup");
    if backup.exists() {
        bail!("stale installation backup exists at {}", backup.display());
    }
    fs::rename(destination, &backup)
        .with_context(|| format!("failed to stage existing {}", destination.display()))?;
    match fs::rename(source, destination) {
        Ok(()) => {
            fs::remove_file(&backup)
                .with_context(|| format!("failed to remove {}", backup.display()))?;
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&backup, destination);
            Err(error).with_context(|| format!("failed to install {}", destination.display()))
        }
    }
}

fn default_codex_plus_plus_directory() -> Result<PathBuf> {
    #[cfg(windows)]
    {
        let app_data = std::env::var_os("APPDATA")
            .context("APPDATA is not defined; pass --directory explicitly")?;
        Ok(PathBuf::from(app_data).join("Codex++").join("user_scripts"))
    }

    #[cfg(target_os = "macos")]
    {
        let config_root = match std::env::var_os("XDG_CONFIG_HOME") {
            Some(path) => PathBuf::from(path),
            None => {
                let home = std::env::var_os("HOME")
                    .context("HOME is not defined; pass --directory explicitly")?;
                PathBuf::from(home).join(".config")
            }
        };
        Ok(config_root.join("Codex++").join("user_scripts"))
    }

    #[cfg(not(any(windows, target_os = "macos")))]
    {
        bail!("the default Codex++ script directory is supported only on Windows and macOS")
    }
}

fn validate_port(port: u16) -> Result<()> {
    if port < 1024 {
        bail!("CDP port must be between 1024 and 65535");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_directory() -> PathBuf {
        let mut random = [0_u8; 8];
        rand::rng().fill_bytes(&mut random);
        std::env::temp_dir().join(format!(
            "leetcodex-install-test-{}-{}",
            std::process::id(),
            u64::from_le_bytes(random)
        ))
    }

    #[test]
    fn managed_user_scripts_can_be_upgraded_and_removed_idempotently() {
        let root = temporary_directory();
        let first = "/* Leetcodex 0.2.0 - local coding practice for Codex */\nfirst";
        let second = "/* Leetcodex 0.2.1 - local coding practice for Codex */\nsecond";
        let destination = install_managed_user_script(&root, first).unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), first);
        install_managed_user_script(&root, second).unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), second);
        assert!(remove_managed_user_script(&root).unwrap());
        assert!(!remove_managed_user_script(&root).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unmanaged_user_scripts_are_never_replaced_or_removed() {
        let root = temporary_directory();
        fs::create_dir_all(&root).unwrap();
        let destination = root.join("leetcodex.js");
        fs::write(&destination, "console.log('user script');").unwrap();
        let managed = "/* Leetcodex 0.2.1 - local coding practice for Codex */\nmanaged";
        assert!(install_managed_user_script(&root, managed).is_err());
        assert!(remove_managed_user_script(&root).is_err());
        assert_eq!(
            fs::read_to_string(&destination).unwrap(),
            "console.log('user script');"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn instance_lock_rejects_competing_launchers_and_recovers_after_drop() {
        let root = std::env::temp_dir().join(format!(
            "leetcodex-instance-lock-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let first = acquire_instance_lock_at(&root, 9337).unwrap();
        assert_eq!(instance_lock_diagnostic_at(&root, 9337)["status"], "active");
        assert_eq!(
            instance_lock_diagnostic_at(&root, 9337)["metadata"]["port"],
            "9337"
        );
        let metadata = fs::read_to_string(root.join("codex-9337.lock")).unwrap();
        assert!(metadata.contains(&format!("pid={}", std::process::id())));
        assert!(metadata.contains("version="));
        assert!(metadata.contains("port=9337"));
        let error = acquire_instance_lock_at(&root, 9337)
            .err()
            .expect("a second launcher must be rejected");
        assert!(error.to_string().contains("already attached"));
        let other_port = acquire_instance_lock_at(&root, 9444).unwrap();
        drop(other_port);
        drop(first);
        assert_eq!(
            instance_lock_diagnostic_at(&root, 9337)["status"],
            "available"
        );
        acquire_instance_lock_at(&root, 9337).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn instance_lock_diagnostic_requires_complete_matching_metadata() {
        let root = temporary_directory();
        prepare_runtime_directory(&root).unwrap();
        let cases = [
            (
                9560,
                "version=0.2.0\nport=9560\n".to_string(),
                "invalid_metadata",
            ),
            (
                9561,
                format!(
                    "pid={}\nversion={}\nport=9999\n",
                    std::process::id(),
                    env!("CARGO_PKG_VERSION")
                ),
                "invalid_metadata",
            ),
            (
                9562,
                format!("pid={}\nversion=0.0.0\nport=9562\n", std::process::id()),
                "version_mismatch",
            ),
            (
                9563,
                "x".repeat(MAX_INSTANCE_LOCK_BYTES as usize + 1),
                "invalid_metadata",
            ),
        ];

        for (port, contents, expected_status) in cases {
            let path = root.join(format!("codex-{port}.lock"));
            fs::write(&path, contents).unwrap();
            let file = open_instance_lock_file(&path, false).unwrap();
            file.try_lock_exclusive().unwrap();
            let diagnostic = instance_lock_diagnostic_at(&root, port);
            assert_eq!(diagnostic["status"], expected_status, "{diagnostic}");
            drop(file);
            fs::remove_file(path).unwrap();
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn instance_lock_rejects_linked_files_without_touching_the_target() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let base = temporary_directory();
        let runtime = base.join("runtime");
        let external = base.join("private.txt");
        let lock = runtime.join("codex-9555.lock");
        fs::create_dir_all(&runtime).unwrap();
        fs::write(&external, "do not overwrite").unwrap();
        fs::set_permissions(&external, fs::Permissions::from_mode(0o644)).unwrap();
        symlink(&external, &lock).unwrap();

        assert_eq!(
            instance_lock_diagnostic_at(&runtime, 9555)["status"],
            "unavailable"
        );
        assert!(acquire_instance_lock_at(&runtime, 9555).is_err());
        assert_eq!(fs::read_to_string(&external).unwrap(), "do not overwrite");
        assert_eq!(
            fs::metadata(&external).unwrap().permissions().mode() & 0o777,
            0o644
        );
        assert!(
            fs::symlink_metadata(&lock)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn instance_lock_rejects_a_linked_runtime_directory() {
        use std::os::unix::fs::symlink;

        let base = temporary_directory();
        let runtime = base.join("runtime");
        let external = base.join("external-runtime");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&external).unwrap();
        symlink(&external, &runtime).unwrap();

        assert_eq!(
            instance_lock_diagnostic_at(&runtime, 9556)["status"],
            "unavailable"
        );
        assert!(acquire_instance_lock_at(&runtime, 9556).is_err());
        assert!(!external.join("codex-9556.lock").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn pairing_reset_requires_explicit_confirmation() {
        let error = reset_pairing("global", false).unwrap_err();
        assert!(error.to_string().contains("requires --yes"));
    }

    #[test]
    fn pairing_restore_requires_explicit_confirmation() {
        let error = restore_pairing("global", "global-profile-1-2", false).unwrap_err();
        assert!(error.to_string().contains("requires --yes"));
    }

    #[test]
    fn standalone_timeout_is_bounded_by_the_cli() {
        assert!(Cli::try_parse_from(["leetcodex", "run", "--timeout-seconds", "0"]).is_err());
        assert!(Cli::try_parse_from(["leetcodex", "run", "--timeout-seconds", "301"]).is_err());
        assert!(Cli::try_parse_from(["leetcodex", "run", "--timeout-seconds", "45"]).is_ok());
    }

    #[test]
    fn doctor_strict_flag_is_explicit_and_composable_with_json() {
        assert!(Cli::try_parse_from(["leetcodex", "doctor"]).is_ok());
        assert!(Cli::try_parse_from(["leetcodex", "doctor", "--strict"]).is_ok());
        assert!(Cli::try_parse_from(["leetcodex", "doctor", "--strict", "--json"]).is_ok());
    }

    #[test]
    fn doctor_health_requires_the_full_stack_but_not_optional_pairing() {
        let mut report = serde_json::json!({
            "codex": { "status": "found" },
            "accountBrowser": { "status": "found" },
            "launcher": { "status": "active" },
            "cdp": { "status": "connected" },
            "renderer": { "status": "active" },
            "drafts": { "status": "ready" },
            "draftDirectory": "/tmp/leetcodex-drafts",
            "leetcode": {
                "global": { "status": "not_running" },
                "china": { "status": "not_running" }
            }
        });
        assert!(doctor_report_is_healthy(&report));

        for (component, status) in [
            ("codex", "error"),
            ("accountBrowser", "error"),
            ("launcher", "available"),
            ("launcher", "invalid_metadata"),
            ("launcher", "version_mismatch"),
            ("cdp", "not_running"),
            ("renderer", "degraded"),
        ] {
            let previous = report[component]["status"].clone();
            report[component]["status"] = serde_json::Value::String(status.to_owned());
            assert!(
                !doctor_report_is_healthy(&report),
                "{component} must affect health"
            );
            report[component]["status"] = previous;
        }

        report["drafts"]["status"] = serde_json::Value::String("insecure".to_owned());
        assert!(!doctor_report_is_healthy(&report));
    }
}
