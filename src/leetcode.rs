use std::fs;
use std::io;
use std::net::TcpStream;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result, bail};
use reqwest::blocking::Client;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use tungstenite::client::IntoClientRequest;
use tungstenite::stream::MaybeTlsStream;
use tungstenite::{Message, WebSocket, connect};
use url::Url;

const BROWSER_TIMEOUT: Duration = Duration::from_secs(12);
const SOCKET_READ_POLL_TIMEOUT: Duration = Duration::from_secs(1);
const SOCKET_WRITE_TIMEOUT: Duration = Duration::from_secs(8);
const EVALUATION_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_CODE_BYTES: usize = 1_000_000;
const MAX_DATA_INPUT_BYTES: usize = 1_000_000;
const MAX_SEARCH_CHARS: usize = 200;
const MAX_TOPIC_CHARS: usize = 80;
const DEVTOOLS_ACTIVE_PORT_FILE: &str = "DevToolsActivePort";
const SINGLETON_MARKERS: [&str; 3] = ["SingletonLock", "SingletonSocket", "SingletonCookie"];

const STATUS_QUERY: &str = r#"
  query leetcodexUserStatus {
    userStatus { isSignedIn username realName avatar }
  }
"#;

const PROBLEMS_QUERY: &str = r#"
  query leetcodexProblemset($limit: Int, $skip: Int, $filters: QuestionFilterInput, $searchKeyword: String) {
    problemsetQuestionList: problemsetQuestionListV2(limit: $limit, skip: $skip, filters: $filters, searchKeyword: $searchKeyword) {
      total: totalLength
      questions {
        acRate
        difficulty
        frontendQuestionId: questionFrontendId
        paidOnly
        status
        title
        titleSlug
        topicTags { name slug }
      }
    }
  }
"#;

const QUESTION_QUERY: &str = r#"
  query leetcodexQuestion($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      questionId
      questionFrontendId
      title
      titleSlug
      content
      difficulty
      isPaidOnly
      codeSnippets { lang langSlug code }
      sampleTestCase
      exampleTestcases
      metaData
      topicTags { name slug }
    }
  }
"#;

const SOLUTION_QUERY: &str = r#"
  query leetcodexSolution($titleSlug: String!) {
    question(titleSlug: $titleSlug) {
      solution {
        id
        title
        content
        canSeeDetail
      }
    }
  }
"#;

const PLAYGROUND_QUERY: &str = r#"
  query leetcodexPlayground($uuid: String!) {
    playground(uuid: $uuid) {
      name
      selectedLangSlug
    }
    allPlaygroundCodes(uuid: $uuid) {
      code
      langSlug
    }
  }
"#;

#[derive(Clone, Copy, Debug, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Site {
    Global,
    China,
}

impl Site {
    pub fn parse(value: &str) -> Result<Self> {
        match value {
            "global" => Ok(Self::Global),
            "china" => Ok(Self::China),
            _ => bail!("unsupported LeetCode site: {value}"),
        }
    }

    fn host(self) -> &'static str {
        match self {
            Self::Global => "leetcode.com",
            Self::China => "leetcode.cn",
        }
    }

    fn origin(self) -> String {
        format!("https://{}", self.host())
    }

    fn login_url(self) -> String {
        match self {
            Self::Global => format!("{}/accounts/login/", self.origin()),
            Self::China => format!("{}/accounts/login/", self.origin()),
        }
    }

    fn profile_name(self) -> &'static str {
        match self {
            Self::Global => "global-profile",
            Self::China => "china-profile",
        }
    }
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetInfo {
    id: String,
    #[serde(rename = "type")]
    target_type: String,
    url: String,
    web_socket_debugger_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct VersionInfo {
    web_socket_debugger_url: String,
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct PairedEndpoint {
    port: u16,
    browser_path: String,
}

pub fn launch_login(site: Site) -> Result<Value> {
    let profile = profile_directory(site)?;
    prepare_pairing_profile_directory(&profile)?;
    let client = http_client()?;
    if let Ok(endpoint) = paired_endpoint(&client, site) {
        open_or_activate_site_tab(&client, site, endpoint.port, &site.login_url())?;
        return Ok(json!({ "site": site, "opened": true, "reused": true }));
    }

    let executable = pairing_browser_executable()?;
    remove_stale_active_port_file(&profile)?;
    let mut command = Command::new(&executable);
    command
        .arg("--remote-debugging-address=127.0.0.1")
        .arg("--remote-debugging-port=0")
        .arg(format!("--user-data-dir={}", profile.display()))
        .arg("--no-first-run")
        .arg("--no-default-browser-check")
        .arg("about:blank")
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null());
    isolate_pairing_browser_process(&mut command);
    command
        .spawn()
        .with_context(|| format!("failed to launch {}", executable.display()))?;

    let deadline = Instant::now() + BROWSER_TIMEOUT;
    while Instant::now() < deadline {
        if let Ok(endpoint) = paired_endpoint(&client, site) {
            open_or_activate_site_tab(&client, site, endpoint.port, &site.login_url())?;
            return Ok(json!({ "site": site, "opened": true, "reused": false }));
        }
        thread::sleep(Duration::from_millis(250));
    }
    bail!("login browser did not expose its local debugging endpoint")
}

pub fn secure_existing_pairing_profiles() -> Result<()> {
    for site in [Site::Global, Site::China] {
        secure_existing_pairing_profile(&profile_directory(site)?)?;
    }
    Ok(())
}

fn prepare_pairing_profile_directory(profile: &Path) -> Result<()> {
    let parent = pairing_data_parent(profile)?;
    prepare_private_pairing_directory(parent, "Leetcodex data directory")?;
    prepare_private_pairing_directory(profile, "pairing profile")?;
    validate_real_directory(parent, "Leetcodex data directory")?;
    validate_real_directory(profile, "pairing profile")?;
    restrict_pairing_profile_directory(profile)
}

fn secure_existing_pairing_profile(profile: &Path) -> Result<bool> {
    if !real_directory_exists(pairing_data_parent(profile)?, "Leetcodex data directory")? {
        return Ok(false);
    }
    if !real_directory_exists(profile, "pairing profile")? {
        return Ok(false);
    }
    restrict_pairing_profile_directory(profile)?;
    Ok(true)
}

#[cfg(unix)]
fn restrict_pairing_profile_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("failed to secure pairing profile {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_pairing_profile_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn isolate_pairing_browser_process(command: &mut Command) {
    use std::os::unix::process::CommandExt;
    command.process_group(0);
}

#[cfg(windows)]
fn isolate_pairing_browser_process(command: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    command.creation_flags(CREATE_NEW_PROCESS_GROUP);
}

#[cfg(not(any(unix, windows)))]
fn isolate_pairing_browser_process(_command: &mut Command) {}

pub fn user_status(site: Site) -> Result<Value> {
    graphql(site, STATUS_QUERY, json!({}), "leetcodexUserStatus")
}

pub fn pairing_diagnostic(site: Site) -> Value {
    let profile = match profile_directory(site) {
        Ok(profile) => profile,
        Err(error) => {
            return json!({
                "status": "unavailable",
                "detail": format!("{error:#}"),
            });
        }
    };
    match pairing_profile_path_is_safe(&profile) {
        Ok(_) => {}
        Err(error) => {
            return json!({
                "status": "unavailable",
                "profile": profile.to_string_lossy(),
                "detail": format!("{error:#}"),
            });
        }
    }
    let client = match http_client() {
        Ok(client) => client,
        Err(error) => {
            return json!({
                "status": "unavailable",
                "profile": profile.to_string_lossy(),
                "detail": format!("{error:#}"),
            });
        }
    };
    match paired_endpoint(&client, site) {
        Ok(endpoint) => json!({
            "status": "connected",
            "profile": profile.to_string_lossy(),
            "port": endpoint.port,
        }),
        Err(error) => json!({
            "status": "not_running",
            "profile": profile.to_string_lossy(),
            "detail": format!("{error:#}"),
        }),
    }
}

pub fn reset_pairing(site: Site) -> Result<Value> {
    let profile = profile_directory(site)?;
    if !secure_existing_pairing_profile(&profile)? {
        return Ok(json!({ "site": site, "reset": false }));
    }
    let client = http_client()?;
    if paired_endpoint(&client, site).is_ok() {
        bail!(
            "the dedicated {} browser is still running; close it completely before resetting pairing",
            site.host()
        );
    }
    clear_stale_profile_markers(&profile, "pairing profile")?;
    let backup_root = pairing_backup_root(&profile)?;
    let backup = backup_pairing_profile(&profile, &backup_root, site.profile_name())?;
    Ok(json!({
        "site": site,
        "reset": true,
        "backup": backup.to_string_lossy(),
    }))
}

pub fn list_pairing_backups(site: Site) -> Result<Value> {
    let profile = profile_directory(site)?;
    let backup_root = pairing_backup_root(&profile)?;
    list_pairing_backups_at(site, &backup_root)
}

fn list_pairing_backups_at(site: Site, backup_root: &Path) -> Result<Value> {
    let parent = pairing_data_parent(backup_root)?;
    if !real_directory_exists(parent, "Leetcodex data directory")? {
        return Ok(json!({ "site": site, "backups": [] }));
    }
    if !real_directory_exists(backup_root, "pairing backup root")? {
        return Ok(json!({ "site": site, "backups": [] }));
    }
    let mut backups = fs::read_dir(backup_root)
        .with_context(|| format!("failed to read pairing backups {}", backup_root.display()))?
        .filter_map(|entry| entry.ok())
        .filter_map(|entry| {
            let name = entry.file_name().to_string_lossy().into_owned();
            if validate_pairing_backup_name(site, &name).is_err() {
                return None;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).ok()?;
            if !is_real_directory(&metadata) {
                return None;
            }
            Some(json!({
                "name": name,
                "path": path.to_string_lossy(),
            }))
        })
        .collect::<Vec<_>>();
    backups.sort_by(|left, right| right["name"].as_str().cmp(&left["name"].as_str()));
    Ok(json!({ "site": site, "backups": backups }))
}

pub fn restore_pairing(site: Site, backup_name: &str) -> Result<Value> {
    let profile = profile_directory(site)?;
    let backup_root = pairing_backup_root(&profile)?;
    restore_pairing_profile(site, &profile, &backup_root, backup_name)?;
    Ok(json!({
        "site": site,
        "restored": true,
        "profile": profile.to_string_lossy(),
    }))
}

fn restore_pairing_profile(
    site: Site,
    profile: &Path,
    backup_root: &Path,
    backup_name: &str,
) -> Result<()> {
    validate_pairing_backup_name(site, backup_name)?;
    validate_shared_pairing_parent(profile, backup_root)?;
    validate_real_directory(pairing_data_parent(profile)?, "Leetcodex data directory")?;
    match fs::symlink_metadata(profile) {
        Ok(_) => {
            bail!(
                "the current {} pairing profile already exists; reset it before restoring a backup",
                site.host()
            );
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!("failed to inspect pairing profile {}", profile.display())
            });
        }
    }
    validate_real_directory(backup_root, "pairing backup root")?;
    let backup = backup_root.join(backup_name);
    validate_real_directory(&backup, "pairing backup")?;
    restrict_pairing_profile_directory(&backup)?;
    clear_stale_profile_markers(&backup, "pairing backup")?;
    fs::rename(&backup, profile).with_context(|| {
        format!(
            "failed to restore pairing backup {} to {}",
            backup.display(),
            profile.display()
        )
    })?;
    validate_real_directory(profile, "restored pairing profile")?;
    Ok(())
}

fn pairing_data_parent(path: &Path) -> Result<&Path> {
    path.parent()
        .context("pairing path has no Leetcodex data directory")
}

fn validate_shared_pairing_parent(profile: &Path, backup_root: &Path) -> Result<()> {
    if pairing_data_parent(profile)? != pairing_data_parent(backup_root)? {
        bail!("pairing profile and backup root must share the same Leetcodex data directory");
    }
    Ok(())
}

fn pairing_backup_root(profile: &Path) -> Result<PathBuf> {
    Ok(profile
        .parent()
        .context("pairing profile has no Leetcodex data directory")?
        .join("pairing-backups"))
}

fn validate_pairing_backup_name(site: Site, value: &str) -> Result<()> {
    if value.len() > 255 {
        bail!("pairing backup name is too long");
    }
    let prefix = format!("{}-", site.profile_name());
    let suffix = value
        .strip_prefix(&prefix)
        .context("pairing backup does not belong to the selected site")?;
    let mut parts = suffix.split('-');
    let timestamp = parts.next().unwrap_or_default();
    let pid = parts.next().unwrap_or_default();
    if parts.next().is_some()
        || timestamp.is_empty()
        || pid.is_empty()
        || !timestamp
            .chars()
            .all(|character| character.is_ascii_digit())
        || !pid.chars().all(|character| character.is_ascii_digit())
    {
        bail!("pairing backup name has an invalid format");
    }
    Ok(())
}

fn validate_real_directory(path: &Path, label: &str) -> Result<()> {
    if !real_directory_exists(path, label)? {
        bail!("{label} does not exist: {}", path.display());
    }
    Ok(())
}

fn real_directory_exists(path: &Path, label: &str) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_real_directory(&metadata) => Ok(true),
        Ok(_) => bail!("{label} must be a real directory: {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(error) => {
            Err(error).with_context(|| format!("failed to inspect {label} {}", path.display()))
        }
    }
}

fn is_real_directory(metadata: &fs::Metadata) -> bool {
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return false;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return false;
        }
    }
    true
}

fn pairing_profile_path_is_safe(profile: &Path) -> Result<bool> {
    if !real_directory_exists(pairing_data_parent(profile)?, "Leetcodex data directory")? {
        return Ok(false);
    }
    real_directory_exists(profile, "pairing profile")
}

fn prepare_private_pairing_directory(path: &Path, label: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_real_directory(&metadata) => return Ok(()),
        Ok(_) => bail!("{label} must be a real directory: {}", path.display()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect {label} {}", path.display()));
        }
    }
    private_pairing_directory_builder()
        .create(path)
        .with_context(|| format!("failed to create {label} {}", path.display()))?;
    validate_real_directory(path, label)
}

#[cfg(unix)]
fn private_pairing_directory_builder() -> fs::DirBuilder {
    use std::os::unix::fs::DirBuilderExt;
    let mut builder = fs::DirBuilder::new();
    builder.mode(0o700);
    builder
}

#[cfg(not(unix))]
fn private_pairing_directory_builder() -> fs::DirBuilder {
    fs::DirBuilder::new()
}

fn active_profile_marker(profile: &Path) -> Option<PathBuf> {
    SINGLETON_MARKERS
        .into_iter()
        .map(|name| profile.join(name))
        .find(|path| fs::symlink_metadata(path).is_ok())
}

#[cfg(unix)]
fn clear_stale_profile_markers(profile: &Path, label: &str) -> Result<bool> {
    clear_stale_profile_markers_at(profile, label, unix_process_is_running)
}

#[cfg(not(unix))]
fn clear_stale_profile_markers(profile: &Path, label: &str) -> Result<bool> {
    let Some(marker) = active_profile_marker(profile) else {
        return Ok(false);
    };
    bail!(
        "{label} still has Chromium marker {}; close the browser completely before continuing",
        marker.display()
    )
}

#[cfg(unix)]
fn clear_stale_profile_markers_at(
    profile: &Path,
    label: &str,
    process_is_running: impl Fn(u32) -> bool,
) -> Result<bool> {
    let Some(marker) = active_profile_marker(profile) else {
        return Ok(false);
    };
    let lock = profile.join("SingletonLock");
    let lock_metadata = fs::symlink_metadata(&lock).with_context(|| {
        format!(
            "{label} has Chromium marker {} but no inspectable SingletonLock",
            marker.display()
        )
    })?;
    if !lock_metadata.file_type().is_symlink() {
        bail!(
            "{label} SingletonLock is not a Chromium PID symlink: {}",
            lock.display()
        );
    }
    let expected_target = fs::read_link(&lock)
        .with_context(|| format!("failed to read Chromium lock {}", lock.display()))?;
    let pid = singleton_lock_pid(&expected_target).with_context(|| {
        format!(
            "{label} SingletonLock does not end in a valid PID: {}",
            lock.display()
        )
    })?;
    if process_is_running(pid) {
        bail!(
            "{label} belongs to active Chromium process {pid}; close the browser completely before continuing"
        );
    }

    for name in [
        "SingletonSocket",
        "SingletonCookie",
        DEVTOOLS_ACTIVE_PORT_FILE,
        "SingletonLock",
    ] {
        verify_singleton_lock_target(&lock, &expected_target)?;
        remove_stale_profile_marker(&profile.join(name), label)?;
    }
    Ok(true)
}

#[cfg(unix)]
fn singleton_lock_pid(target: &Path) -> Option<u32> {
    target
        .to_string_lossy()
        .rsplit_once('-')
        .and_then(|(_, value)| value.parse::<u32>().ok())
        .filter(|pid| *pid > 0)
}

#[cfg(unix)]
fn verify_singleton_lock_target(lock: &Path, expected: &Path) -> Result<()> {
    let current = fs::read_link(lock).with_context(|| {
        format!(
            "Chromium lock changed while being inspected: {}",
            lock.display()
        )
    })?;
    if current != expected {
        bail!(
            "Chromium lock changed while being inspected: {}",
            lock.display()
        );
    }
    Ok(())
}

#[cfg(unix)]
fn remove_stale_profile_marker(path: &Path, label: &str) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if metadata.file_type().is_file() || metadata.file_type().is_symlink() => {
            fs::remove_file(path).with_context(|| {
                format!("failed to remove stale {label} marker {}", path.display())
            })
        }
        Ok(_) => bail!(
            "refusing to remove non-file {label} marker {}",
            path.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error)
            .with_context(|| format!("failed to inspect {label} marker {}", path.display())),
    }
}

#[cfg(unix)]
fn unix_process_is_running(pid: u32) -> bool {
    Command::new("/bin/kill")
        .args(["-0", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

fn backup_pairing_profile(
    profile: &Path,
    backup_root: &Path,
    profile_name: &str,
) -> Result<PathBuf> {
    validate_shared_pairing_parent(profile, backup_root)?;
    validate_real_directory(pairing_data_parent(profile)?, "Leetcodex data directory")?;
    validate_real_directory(profile, "pairing profile")?;
    prepare_private_pairing_directory(backup_root, "pairing backup root")?;
    validate_real_directory(
        pairing_data_parent(backup_root)?,
        "Leetcodex data directory",
    )?;
    validate_real_directory(backup_root, "pairing backup root")?;
    restrict_pairing_backup_directory(backup_root)?;
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .context("system clock is before the Unix epoch")?
        .as_secs();
    let backup = backup_root.join(format!("{profile_name}-{timestamp}-{}", std::process::id()));
    match fs::symlink_metadata(&backup) {
        Ok(_) => bail!(
            "pairing backup destination already exists: {}",
            backup.display()
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(error).with_context(|| {
                format!(
                    "failed to inspect pairing backup destination {}",
                    backup.display()
                )
            });
        }
    }
    fs::rename(profile, &backup).with_context(|| {
        format!(
            "failed to move pairing profile {} to {}; make sure the dedicated browser is fully closed",
            profile.display(),
            backup.display()
        )
    })?;
    Ok(backup)
}

#[cfg(unix)]
fn restrict_pairing_backup_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700)).with_context(|| {
        format!(
            "failed to secure pairing backup directory {}",
            path.display()
        )
    })
}

#[cfg(not(unix))]
fn restrict_pairing_backup_directory(_path: &Path) -> Result<()> {
    Ok(())
}

pub fn problem_list(
    site: Site,
    skip: u64,
    limit: u64,
    difficulty: Option<&str>,
    search: Option<&str>,
    topic: Option<&str>,
) -> Result<Value> {
    let variables = problem_list_variables(skip, limit, difficulty, search, topic)?;
    graphql(site, PROBLEMS_QUERY, variables, "leetcodexProblemset")
}

fn problem_list_variables(
    skip: u64,
    limit: u64,
    difficulty: Option<&str>,
    search: Option<&str>,
    topic: Option<&str>,
) -> Result<Value> {
    if skip > 100_000 {
        bail!("problem list offset is too large");
    }
    let mut filters = serde_json::Map::new();
    filters.insert("filterCombineType".into(), json!("ALL"));
    if let Some(value) = difficulty.filter(|value| !value.is_empty() && *value != "all") {
        if !matches!(value, "easy" | "medium" | "hard") {
            bail!("unsupported difficulty: {value}");
        }
        filters.insert(
            "difficultyFilter".into(),
            json!({
                "difficulties": [value.to_ascii_uppercase()],
                "operator": "IS",
            }),
        );
    }
    let search_keyword = search.map(str::trim).filter(|value| !value.is_empty());
    if search_keyword.is_some_and(|value| value.chars().count() > MAX_SEARCH_CHARS) {
        bail!("problem search exceeds the {MAX_SEARCH_CHARS}-character limit");
    }
    let topic_slug = topic.map(str::trim).filter(|value| !value.is_empty());
    if let Some(value) = topic_slug {
        if value.len() > MAX_TOPIC_CHARS
            || !value.chars().all(|character| {
                character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
            })
            || value.starts_with('-')
            || value.ends_with('-')
        {
            bail!("topic contains unsupported characters");
        }
        filters.insert(
            "topicFilter".into(),
            json!({
                "topicSlugs": [value],
                "operator": "IS",
            }),
        );
    }
    Ok(json!({
        "skip": skip,
        "limit": limit.clamp(1, 100),
        "filters": filters,
        "searchKeyword": search_keyword,
    }))
}

pub fn question(site: Site, title_slug: &str) -> Result<Value> {
    validate_title_slug(title_slug)?;
    graphql(
        site,
        QUESTION_QUERY,
        json!({ "titleSlug": title_slug }),
        "leetcodexQuestion",
    )
}

pub fn official_solution(site: Site, title_slug: &str) -> Result<Value> {
    validate_title_slug(title_slug)?;
    graphql(
        site,
        SOLUTION_QUERY,
        json!({ "titleSlug": title_slug }),
        "leetcodexSolution",
    )
}

pub fn playground(site: Site, uuid: &str) -> Result<Value> {
    validate_playground_uuid(uuid)?;
    graphql(
        site,
        PLAYGROUND_QUERY,
        json!({ "uuid": uuid }),
        "leetcodexPlayground",
    )
}

pub fn submit(
    site: Site,
    title_slug: &str,
    question_id: &str,
    lang: &str,
    code: &str,
) -> Result<Value> {
    validate_submission_fields(title_slug, question_id, lang, code)?;
    browser_fetch(
        site,
        "POST",
        &format!("/problems/{title_slug}/submit/"),
        Some(json!({
            "lang": lang,
            "question_id": question_id,
            "typed_code": code,
        })),
    )
}

pub fn interpret(
    site: Site,
    title_slug: &str,
    question_id: &str,
    lang: &str,
    code: &str,
    data_input: &str,
) -> Result<Value> {
    validate_submission_fields(title_slug, question_id, lang, code)?;
    if data_input.len() > MAX_DATA_INPUT_BYTES {
        bail!("test input exceeds the {MAX_DATA_INPUT_BYTES}-byte limit");
    }
    browser_fetch(
        site,
        "POST",
        &format!("/problems/{title_slug}/interpret_solution/"),
        Some(json!({
            "lang": lang,
            "question_id": question_id,
            "typed_code": code,
            "data_input": data_input,
        })),
    )
}

pub fn check_submission(site: Site, submission_id: &str) -> Result<Value> {
    validate_submission_id(submission_id)?;
    browser_fetch(
        site,
        "GET",
        &format!("/submissions/detail/{submission_id}/check/"),
        None,
    )
}

fn validate_submission_id(submission_id: &str) -> Result<()> {
    if submission_id.is_empty()
        || submission_id.len() > 160
        || !submission_id
            .chars()
            .all(|value| value.is_ascii_alphanumeric() || matches!(value, '_' | '-'))
    {
        bail!("submissionId contains unsupported characters");
    }
    Ok(())
}

fn validate_title_slug(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 200
        || !value.chars().all(|character| {
            character.is_ascii_lowercase() || character.is_ascii_digit() || character == '-'
        })
        || value.starts_with('-')
        || value.ends_with('-')
    {
        bail!("titleSlug contains unsupported characters");
    }
    Ok(())
}

fn validate_playground_uuid(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 64
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        bail!("playground id contains unsupported characters");
    }
    Ok(())
}

fn validate_submission_fields(
    title_slug: &str,
    question_id: &str,
    lang: &str,
    code: &str,
) -> Result<()> {
    validate_title_slug(title_slug)?;
    if question_id.is_empty()
        || question_id.len() > 32
        || !question_id
            .chars()
            .all(|character| character.is_ascii_digit())
    {
        bail!("questionId contains unsupported characters");
    }
    if lang.is_empty()
        || lang.len() > 64
        || !lang
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        bail!("lang contains unsupported characters");
    }
    if code.is_empty() {
        bail!("code is required");
    }
    if code.len() > MAX_CODE_BYTES {
        bail!("code exceeds the {MAX_CODE_BYTES}-byte limit");
    }
    Ok(())
}

fn graphql(site: Site, query: &str, variables: Value, operation_name: &str) -> Result<Value> {
    browser_fetch(
        site,
        "POST",
        "/graphql/",
        Some(json!({
            "query": query,
            "variables": variables,
            "operationName": operation_name,
        })),
    )
}

fn browser_fetch(site: Site, method: &str, path: &str, body: Option<Value>) -> Result<Value> {
    let request = json!({ "method": method, "path": path, "body": body });
    let request_literal = serde_json::to_string(&request)?;
    let expression = format!(
        r#"(async () => {{
          const request = {request_literal};
          let csrf = '';
          try {{
            csrf = document.cookie.split('; ').find((item) => item.startsWith('csrftoken='))?.split('=').slice(1).join('=') || '';
          }} catch {{}}
          const options = {{
            method: request.method,
            credentials: 'include',
            headers: {{ 'Accept': 'application/json', 'Content-Type': 'application/json', 'x-csrftoken': decodeURIComponent(csrf) }}
          }};
          if (request.body !== null) options.body = JSON.stringify(request.body);
          const response = await fetch(request.path, options);
          const text = await response.text();
          let value;
          try {{ value = JSON.parse(text); }} catch {{ value = {{ message: text.slice(0, 500) }}; }}
          return {{ status: response.status, ok: response.ok, value }};
        }})()"#
    );
    let result = evaluate(site, &expression)?;
    let status = result.get("status").and_then(Value::as_u64).unwrap_or(0);
    if !(200..300).contains(&status) {
        let message = result
            .pointer("/value/message")
            .and_then(Value::as_str)
            .unwrap_or("LeetCode request failed");
        bail!("LeetCode returned HTTP {status}: {message}");
    }
    let value = result.get("value").cloned().unwrap_or(Value::Null);
    if let Some(errors) = value.get("errors") {
        bail!("LeetCode GraphQL error: {errors}");
    }
    Ok(value)
}

fn evaluate(site: Site, expression: &str) -> Result<Value> {
    let client = http_client()?;
    let endpoint = paired_endpoint(&client, site)
        .context("login browser is not running; choose Login first")?;
    let targets: Vec<TargetInfo> = client
        .get(format!("http://127.0.0.1:{}/json/list", endpoint.port))
        .send()
        .context("failed to read the paired login browser")?
        .error_for_status()
        .context("login browser debugging endpoint rejected the request")?
        .json()
        .context("login browser returned an invalid target list")?;
    let target = targets
        .iter()
        .find(|target| target.target_type == "page" && target_matches_site(&target.url, site))
        .context("no paired LeetCode tab is open; choose Login first")?;
    let debugger_url = target
        .web_socket_debugger_url
        .as_deref()
        .context("paired LeetCode tab has no debugger URL")?;
    validate_page_debugger_url(debugger_url, endpoint.port)?;
    let request = debugger_url.into_client_request()?;
    let (mut socket, _) = connect(request).context("failed to connect to paired LeetCode tab")?;
    set_socket_timeouts(&mut socket)?;
    socket.send(Message::Text(
        json!({
            "id": 1,
            "method": "Runtime.evaluate",
            "params": {
                "expression": expression,
                "awaitPromise": true,
                "returnByValue": true,
                "allowUnsafeEvalBlockedByCSP": true
            }
        })
        .to_string()
        .into(),
    ))?;
    read_evaluation_response(|| socket.read(), Instant::now() + EVALUATION_TIMEOUT)
}

fn read_evaluation_response<F>(mut read: F, deadline: Instant) -> Result<Value>
where
    F: FnMut() -> tungstenite::Result<Message>,
{
    loop {
        if Instant::now() >= deadline {
            bail!("paired LeetCode tab timed out while waiting for the page request");
        }
        let message = match read() {
            Ok(message) => message,
            Err(tungstenite::Error::Io(error))
                if matches!(
                    error.kind(),
                    io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error).context("paired LeetCode tab stopped responding"),
        };
        let Message::Text(text) = message else {
            continue;
        };
        let response: Value = serde_json::from_str(text.as_str())?;
        if response.get("id").and_then(Value::as_u64) != Some(1) {
            continue;
        }
        if let Some(error) = response.get("error") {
            bail!("LeetCode browser evaluation failed: {error}");
        }
        if let Some(exception) = response
            .get("result")
            .and_then(|value| value.get("exceptionDetails"))
        {
            bail!("LeetCode page request failed: {exception}");
        }
        return response
            .pointer("/result/result/value")
            .cloned()
            .context("LeetCode page returned no value");
    }
}

fn open_tab(client: &Client, port: u16, url: &str) -> Result<()> {
    let encoded: String = url::form_urlencoded::byte_serialize(url.as_bytes()).collect();
    client
        .put(format!("http://127.0.0.1:{}/json/new?{encoded}", port))
        .send()?
        .error_for_status()?;
    Ok(())
}

fn open_or_activate_site_tab(client: &Client, site: Site, port: u16, url: &str) -> Result<()> {
    let targets: Vec<TargetInfo> = client
        .get(format!("http://127.0.0.1:{port}/json/list"))
        .send()
        .context("failed to inspect the paired login browser")?
        .error_for_status()
        .context("paired login browser rejected its target list")?
        .json()
        .context("paired login browser returned an invalid target list")?;
    if let Some(target) = targets
        .iter()
        .find(|target| target.target_type == "page" && target_matches_site(&target.url, site))
    {
        validate_target_id(&target.id)?;
        client
            .get(format!(
                "http://127.0.0.1:{port}/json/activate/{}",
                target.id
            ))
            .send()
            .context("failed to activate the paired LeetCode tab")?
            .error_for_status()
            .context("paired login browser could not activate the LeetCode tab")?;
        return Ok(());
    }
    open_tab(client, port, url)
}

fn validate_target_id(value: &str) -> Result<()> {
    if value.is_empty()
        || value.len() > 128
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '-' | '_'))
    {
        bail!("paired browser returned an invalid target id");
    }
    Ok(())
}

fn target_matches_site(value: &str, site: Site) -> bool {
    Url::parse(value)
        .ok()
        .and_then(|url| url.host_str().map(str::to_owned))
        .is_some_and(|host| host == site.host() || host == format!("www.{}", site.host()))
}

fn validate_page_debugger_url(value: &str, port: u16) -> Result<()> {
    let url = Url::parse(value)?;
    if url.scheme() != "ws"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(port)
        || !url.path().starts_with("/devtools/page/")
    {
        bail!("paired browser returned an unsafe debugger URL");
    }
    Ok(())
}

fn paired_endpoint(client: &Client, site: Site) -> Result<PairedEndpoint> {
    let profile = profile_directory(site)?;
    let active_port_path = profile.join(DEVTOOLS_ACTIVE_PORT_FILE);
    let contents = fs::read_to_string(&active_port_path)
        .with_context(|| format!("failed to read {}", active_port_path.display()))?;
    let endpoint = parse_devtools_active_port(&contents)?;
    let version: VersionInfo = client
        .get(format!("http://127.0.0.1:{}/json/version", endpoint.port))
        .send()
        .context("paired browser debugging endpoint is unavailable")?
        .error_for_status()
        .context("paired browser debugging endpoint rejected the request")?
        .json()
        .context("paired browser returned invalid version metadata")?;
    validate_browser_debugger_url(
        &version.web_socket_debugger_url,
        endpoint.port,
        &endpoint.browser_path,
    )?;
    Ok(endpoint)
}

fn parse_devtools_active_port(contents: &str) -> Result<PairedEndpoint> {
    let mut lines = contents.lines();
    let port = lines
        .next()
        .context("DevToolsActivePort is missing its port")?
        .parse::<u16>()
        .context("DevToolsActivePort contains an invalid port")?;
    if port == 0 {
        bail!("DevToolsActivePort contains an invalid port");
    }
    let browser_path = lines
        .next()
        .context("DevToolsActivePort is missing its browser path")?;
    let browser_id = browser_path
        .strip_prefix("/devtools/browser/")
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 200
                && value.chars().all(|character| {
                    character.is_ascii_alphanumeric() || matches!(character, '-' | '_')
                })
        })
        .context("DevToolsActivePort contains an invalid browser path")?;
    Ok(PairedEndpoint {
        port,
        browser_path: format!("/devtools/browser/{browser_id}"),
    })
}

fn validate_browser_debugger_url(value: &str, port: u16, expected_path: &str) -> Result<()> {
    let url = Url::parse(value)?;
    if url.scheme() != "ws"
        || url.host_str() != Some("127.0.0.1")
        || url.port() != Some(port)
        || url.path() != expected_path
        || url.query().is_some()
        || url.fragment().is_some()
    {
        bail!("paired browser identity does not match its dedicated profile");
    }
    Ok(())
}

fn remove_stale_active_port_file(profile: &Path) -> Result<()> {
    let path = profile.join(DEVTOOLS_ACTIVE_PORT_FILE);
    match fs::remove_file(&path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error).with_context(|| format!("failed to remove {}", path.display())),
    }
}

fn set_socket_timeouts(socket: &mut WebSocket<MaybeTlsStream<TcpStream>>) -> Result<()> {
    let MaybeTlsStream::Plain(stream) = socket.get_mut() else {
        bail!("paired browser debugger must use a plain loopback socket");
    };
    stream.set_read_timeout(Some(SOCKET_READ_POLL_TIMEOUT))?;
    stream.set_write_timeout(Some(SOCKET_WRITE_TIMEOUT))?;
    Ok(())
}

fn http_client() -> Result<Client> {
    Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(5))
        .build()
        .context("failed to create loopback browser client")
}

fn profile_directory(site: Site) -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .context("HOME or USERPROFILE is required for the login browser profile")?;
    Ok(PathBuf::from(home)
        .join(".leetcodex")
        .join(site.profile_name()))
}

pub fn pairing_browser_executable() -> Result<PathBuf> {
    #[cfg(target_os = "macos")]
    let candidates = vec![
        PathBuf::from("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
        PathBuf::from("/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"),
        PathBuf::from("/Applications/Chromium.app/Contents/MacOS/Chromium"),
    ];

    #[cfg(windows)]
    let candidates = windows_browser_candidates(
        std::env::var_os("ProgramFiles").as_deref().map(Path::new),
        std::env::var_os("ProgramFiles(x86)")
            .as_deref()
            .map(Path::new),
        std::env::var_os("LOCALAPPDATA").as_deref().map(Path::new),
    );

    #[cfg(not(any(target_os = "macos", windows)))]
    let candidates = vec![
        PathBuf::from("/usr/bin/google-chrome"),
        PathBuf::from("/usr/bin/microsoft-edge"),
        PathBuf::from("/usr/bin/chromium"),
    ];

    candidates
        .into_iter()
        .find(|path| path.is_file())
        .context("Google Chrome, Microsoft Edge, or Chromium is required for account pairing")
}

#[cfg(any(windows, test))]
fn windows_browser_candidates(
    program_files: Option<&Path>,
    program_files_x86: Option<&Path>,
    local_app_data: Option<&Path>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();
    for root in [program_files, program_files_x86].into_iter().flatten() {
        candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
        candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
        candidates.push(root.join("Chromium/Application/chrome.exe"));
    }
    if let Some(root) = local_app_data {
        candidates.push(root.join("Google/Chrome/Application/chrome.exe"));
        candidates.push(root.join("Microsoft/Edge/Application/msedge.exe"));
        candidates.push(root.join("Chromium/Application/chrome.exe"));
    }
    candidates
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    fn evaluation_message(id: u64, value: Value) -> Message {
        Message::Text(
            json!({
                "id": id,
                "result": { "result": { "value": value } }
            })
            .to_string()
            .into(),
        )
    }

    #[test]
    fn evaluation_read_retries_transient_socket_timeouts() {
        let mut reads = VecDeque::from([
            Err(tungstenite::Error::Io(io::Error::from(
                io::ErrorKind::WouldBlock,
            ))),
            Ok(evaluation_message(99, json!("unrelated event"))),
            Err(tungstenite::Error::Io(io::Error::from(
                io::ErrorKind::TimedOut,
            ))),
            Ok(evaluation_message(1, json!({ "ok": true }))),
        ]);

        let response = read_evaluation_response(
            || reads.pop_front().expect("test read queue exhausted"),
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap();

        assert_eq!(response, json!({ "ok": true }));
    }

    #[test]
    fn evaluation_read_stops_at_the_total_deadline() {
        let error = read_evaluation_response(
            || {
                Err(tungstenite::Error::Io(io::Error::from(
                    io::ErrorKind::WouldBlock,
                )))
            },
            Instant::now() - Duration::from_millis(1),
        )
        .unwrap_err();

        assert!(error.to_string().contains("timed out"));
    }

    #[test]
    fn evaluation_read_fails_immediately_for_non_timeout_io_errors() {
        let mut read_count = 0;
        let error = read_evaluation_response(
            || {
                read_count += 1;
                Err(tungstenite::Error::Io(io::Error::from(
                    io::ErrorKind::ConnectionReset,
                )))
            },
            Instant::now() + Duration::from_secs(1),
        )
        .unwrap_err();

        assert_eq!(read_count, 1);
        assert!(error.to_string().contains("stopped responding"));
    }

    #[test]
    fn sites_use_separate_hosts_and_profiles() {
        assert_eq!(Site::Global.host(), "leetcode.com");
        assert_eq!(Site::China.host(), "leetcode.cn");
        assert_ne!(Site::Global.profile_name(), Site::China.profile_name());
    }

    #[test]
    fn active_port_parser_accepts_chromium_profile_metadata() {
        assert_eq!(
            parse_devtools_active_port("49152\n/devtools/browser/abc-123_DEF\n").unwrap(),
            PairedEndpoint {
                port: 49152,
                browser_path: "/devtools/browser/abc-123_DEF".into(),
            }
        );
    }

    #[test]
    fn active_port_parser_rejects_unsafe_metadata() {
        assert!(parse_devtools_active_port("0\n/devtools/browser/abc\n").is_err());
        assert!(parse_devtools_active_port("9340\n/devtools/page/abc\n").is_err());
        assert!(parse_devtools_active_port("9340\n/devtools/browser/../page\n").is_err());
        assert!(parse_devtools_active_port("not-a-port\n/devtools/browser/abc\n").is_err());
    }

    #[test]
    fn browser_identity_must_match_profile_metadata() {
        assert!(
            validate_browser_debugger_url(
                "ws://127.0.0.1:49152/devtools/browser/abc-123",
                49152,
                "/devtools/browser/abc-123"
            )
            .is_ok()
        );
        assert!(
            validate_browser_debugger_url(
                "ws://127.0.0.1:9340/devtools/browser/other",
                49152,
                "/devtools/browser/abc-123"
            )
            .is_err()
        );
        assert!(
            validate_browser_debugger_url(
                "ws://example.test:49152/devtools/browser/abc-123",
                49152,
                "/devtools/browser/abc-123"
            )
            .is_err()
        );
    }

    #[test]
    fn target_validation_rejects_lookalike_domains() {
        assert!(target_matches_site(
            "https://leetcode.com/problems/two-sum/",
            Site::Global
        ));
        assert!(target_matches_site(
            "https://leetcode.cn/problemset/",
            Site::China
        ));
        assert!(!target_matches_site(
            "https://leetcode.com.example.test/",
            Site::Global
        ));
        assert!(!target_matches_site(
            "https://leetcode.cn.example.test/",
            Site::China
        ));
    }

    #[test]
    fn target_ids_cannot_escape_the_activation_route() {
        assert!(validate_target_id("ABCDEF0123456789").is_ok());
        assert!(validate_target_id("target_123-abc").is_ok());
        assert!(validate_target_id("../json/new").is_err());
        assert!(validate_target_id("target/id").is_err());
        assert!(validate_target_id("").is_err());
    }

    #[test]
    fn submission_ids_allow_interpret_ids_without_allowing_paths() {
        assert!(validate_submission_id("123456789").is_ok());
        assert!(validate_submission_id("runcode_123-abc").is_ok());
        assert!(validate_submission_id("../other").is_err());
        assert!(validate_submission_id("id with spaces").is_err());
        assert!(validate_submission_id("").is_err());
    }

    #[test]
    fn title_slugs_cannot_escape_the_problem_route() {
        assert!(validate_title_slug("two-sum").is_ok());
        assert!(validate_title_slug("100-same-tree").is_ok());
        assert!(validate_title_slug("../submissions").is_err());
        assert!(validate_title_slug("two_sum").is_err());
        assert!(validate_title_slug("-two-sum").is_err());
    }

    #[test]
    fn playground_ids_are_bounded_and_path_safe() {
        assert!(validate_playground_uuid("4KK3DMtw").is_ok());
        assert!(validate_playground_uuid("answer-1_shared").is_ok());
        assert!(validate_playground_uuid("").is_err());
        assert!(validate_playground_uuid("../shared").is_err());
        assert!(validate_playground_uuid("answer?lang=cpp").is_err());
        assert!(validate_playground_uuid(&"a".repeat(65)).is_err());
    }

    #[test]
    fn problem_filters_combine_search_difficulty_and_topic() {
        let variables = problem_list_variables(
            100,
            250,
            Some("medium"),
            Some("  two sum  "),
            Some("dynamic-programming"),
        )
        .unwrap();
        assert_eq!(variables["skip"], 100);
        assert_eq!(variables["limit"], 100);
        assert_eq!(variables["searchKeyword"], "two sum");
        assert_eq!(
            variables["filters"]["difficultyFilter"]["difficulties"][0],
            "MEDIUM"
        );
        assert_eq!(
            variables["filters"]["topicFilter"]["topicSlugs"][0],
            "dynamic-programming"
        );
        assert_eq!(variables["filters"]["topicFilter"]["operator"], "IS");

        assert!(problem_list_variables(0, 50, None, None, Some("../array")).is_err());
        assert!(problem_list_variables(0, 50, None, None, Some("Array")).is_err());
        assert!(problem_list_variables(100_001, 50, None, None, None).is_err());
    }

    #[test]
    fn submission_fields_are_bounded_and_structured() {
        assert!(validate_submission_fields("two-sum", "1", "cpp", "class Solution {};").is_ok());
        assert!(validate_submission_fields("two-sum", "../1", "cpp", "code").is_err());
        assert!(validate_submission_fields("two-sum", "1", "../../cpp", "code").is_err());
        assert!(
            validate_submission_fields("two-sum", "1", "cpp", &"x".repeat(MAX_CODE_BYTES + 1))
                .is_err()
        );
    }

    #[test]
    fn windows_browser_candidates_include_per_user_installs() {
        let candidates = windows_browser_candidates(
            Some(Path::new(r"C:\Program Files")),
            Some(Path::new(r"C:\Program Files (x86)")),
            Some(Path::new(r"C:\Users\tester\AppData\Local")),
        );
        assert!(candidates.contains(&PathBuf::from(
            r"C:\Users\tester\AppData\Local/Google/Chrome/Application/chrome.exe"
        )));
        assert!(candidates.contains(&PathBuf::from(
            r"C:\Program Files/Microsoft/Edge/Application/msedge.exe"
        )));
    }

    #[test]
    fn pairing_profile_backup_roundtrip_is_site_scoped_and_preserves_data() {
        let root = std::env::temp_dir().join(format!(
            "leetcodex-pairing-reset-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let profile = root.join("global-profile");
        let other = root.join("china-profile");
        let backups = root.join("pairing-backups");
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(&other).unwrap();
        fs::write(profile.join("Cookies"), "session data").unwrap();
        fs::write(other.join("Cookies"), "china data").unwrap();

        let backup = backup_pairing_profile(&profile, &backups, "global-profile").unwrap();
        let backup_name = backup.file_name().unwrap().to_str().unwrap().to_owned();
        assert!(!profile.exists());
        assert_eq!(
            fs::read_to_string(backup.join("Cookies")).unwrap(),
            "session data"
        );
        assert_eq!(
            fs::read_to_string(other.join("Cookies")).unwrap(),
            "china data"
        );

        let listed = list_pairing_backups_at(Site::Global, &backups).unwrap();
        assert_eq!(listed["backups"].as_array().unwrap().len(), 1);
        assert_eq!(listed["backups"][0]["name"], backup_name);

        restore_pairing_profile(Site::Global, &profile, &backups, &backup_name).unwrap();
        assert_eq!(
            fs::read_to_string(profile.join("Cookies")).unwrap(),
            "session data"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(
                fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert_eq!(
            fs::read_to_string(other.join("Cookies")).unwrap(),
            "china data"
        );
        assert!(
            list_pairing_backups_at(Site::Global, &backups).unwrap()["backups"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pairing_restore_refuses_to_overwrite_an_existing_profile() {
        let root = std::env::temp_dir().join(format!(
            "leetcodex-pairing-restore-existing-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let profile = root.join("global-profile");
        let backups = root.join("pairing-backups");
        let backup_name = "global-profile-123-456";
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(backups.join(backup_name)).unwrap();

        let error =
            restore_pairing_profile(Site::Global, &profile, &backups, backup_name).unwrap_err();
        assert!(error.to_string().contains("already exists"));
        assert!(profile.exists());
        assert!(backups.join(backup_name).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pairing_backup_names_are_strictly_site_scoped() {
        assert!(validate_pairing_backup_name(Site::Global, "global-profile-1-2").is_ok());
        assert!(validate_pairing_backup_name(Site::Global, "../global-profile-1-2").is_err());
        assert!(validate_pairing_backup_name(Site::Global, "china-profile-1-2").is_err());
        assert!(validate_pairing_backup_name(Site::Global, "global-profile-abc-2").is_err());
        assert!(validate_pairing_backup_name(Site::Global, "global-profile-1-2-extra").is_err());
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_pairing_backups_are_not_listed_or_restored() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "leetcodex-pairing-symlink-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let profile = root.join("global-profile");
        let backups = root.join("pairing-backups");
        let external = root.join("external-profile");
        let backup_name = "global-profile-123-456";
        fs::create_dir_all(&backups).unwrap();
        fs::create_dir_all(&external).unwrap();
        symlink(&external, backups.join(backup_name)).unwrap();

        assert!(
            list_pairing_backups_at(Site::Global, &backups).unwrap()["backups"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let error =
            restore_pairing_profile(Site::Global, &profile, &backups, backup_name).unwrap_err();
        assert!(error.to_string().contains("must be a real directory"));
        assert!(!profile.exists());
        assert!(external.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pairing_profiles_are_private_and_symbolic_link_roots_are_rejected() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let root = std::env::temp_dir().join(format!(
            "leetcodex-pairing-permissions-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let profile = root.join("global-profile");
        let new_profile = root.join("china-profile");
        let external = root.join("external-profile");
        let linked = root.join("linked-profile");
        fs::create_dir_all(&profile).unwrap();
        fs::set_permissions(&profile, fs::Permissions::from_mode(0o755)).unwrap();

        assert!(secure_existing_pairing_profile(&profile).unwrap());
        assert_eq!(
            fs::metadata(&profile).unwrap().permissions().mode() & 0o777,
            0o700
        );
        assert!(!secure_existing_pairing_profile(&new_profile).unwrap());

        prepare_pairing_profile_directory(&new_profile).unwrap();
        assert_eq!(
            fs::metadata(&new_profile).unwrap().permissions().mode() & 0o777,
            0o700
        );

        fs::create_dir_all(&external).unwrap();
        symlink(&external, &linked).unwrap();
        assert!(secure_existing_pairing_profile(&linked).is_err());
        assert!(prepare_pairing_profile_directory(&linked).is_err());
        assert!(external.is_dir());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linked_pairing_data_parent_cannot_redirect_profile_creation() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!(
            "leetcodex-pairing-parent-link-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let data = base.join(".leetcodex");
        let external = base.join("external");
        let profile = data.join("global-profile");
        fs::create_dir_all(&base).unwrap();
        fs::create_dir_all(&external).unwrap();
        symlink(&external, &data).unwrap();

        assert!(prepare_pairing_profile_directory(&profile).is_err());
        assert!(secure_existing_pairing_profile(&profile).is_err());
        assert!(pairing_profile_path_is_safe(&profile).is_err());
        assert!(!external.join("global-profile").exists());
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn linked_pairing_backup_root_cannot_redirect_reset_or_restore() {
        use std::os::unix::fs::symlink;

        let base = std::env::temp_dir().join(format!(
            "leetcodex-pairing-backup-link-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        let data = base.join(".leetcodex");
        let profile = data.join("global-profile");
        let restore_target = data.join("restored-global-profile");
        let backups = data.join("pairing-backups");
        let external = base.join("external-backups");
        let backup_name = "global-profile-123-456";
        fs::create_dir_all(&profile).unwrap();
        fs::create_dir_all(external.join(backup_name)).unwrap();
        fs::write(profile.join("Cookies"), "current session").unwrap();
        fs::write(external.join(backup_name).join("Cookies"), "old session").unwrap();
        symlink(&external, &backups).unwrap();

        assert!(list_pairing_backups_at(Site::Global, &backups).is_err());
        assert!(backup_pairing_profile(&profile, &backups, "global-profile").is_err());
        assert!(
            restore_pairing_profile(Site::Global, &restore_target, &backups, backup_name).is_err()
        );
        assert_eq!(
            fs::read_to_string(profile.join("Cookies")).unwrap(),
            "current session"
        );
        assert_eq!(
            fs::read_to_string(external.join(backup_name).join("Cookies")).unwrap(),
            "old session"
        );
        assert!(!restore_target.exists());
        assert!(
            fs::symlink_metadata(&backups)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn singleton_markers_block_pairing_profile_reset() {
        let root = std::env::temp_dir().join(format!(
            "leetcodex-pairing-marker-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join("SingletonLock"), "active").unwrap();
        assert_eq!(
            active_profile_marker(&root),
            Some(root.join("SingletonLock"))
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn dead_singleton_pid_markers_are_removed_without_following_symlinks() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "leetcodex-stale-marker-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&root).unwrap();
        symlink("test-host-424242", root.join("SingletonLock")).unwrap();
        symlink("cookie", root.join("SingletonCookie")).unwrap();
        symlink(root.join("missing-socket"), root.join("SingletonSocket")).unwrap();
        fs::write(
            root.join(DEVTOOLS_ACTIVE_PORT_FILE),
            "49152\n/devtools/browser/stale",
        )
        .unwrap();

        assert!(clear_stale_profile_markers_at(&root, "test profile", |_| false).unwrap());
        for name in SINGLETON_MARKERS
            .into_iter()
            .chain([DEVTOOLS_ACTIVE_PORT_FILE])
        {
            assert!(fs::symlink_metadata(root.join(name)).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn live_or_unverifiable_singleton_markers_are_preserved() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "leetcodex-active-marker-{}-{}",
            std::process::id(),
            rand::random::<u64>()
        ));
        fs::create_dir_all(&root).unwrap();
        symlink("test-host-424242", root.join("SingletonLock")).unwrap();
        let error = clear_stale_profile_markers_at(&root, "test profile", |_| true).unwrap_err();
        assert!(error.to_string().contains("active Chromium process"));
        assert!(fs::symlink_metadata(root.join("SingletonLock")).is_ok());

        fs::remove_file(root.join("SingletonLock")).unwrap();
        fs::write(root.join("SingletonLock"), "not-a-symlink").unwrap();
        assert!(clear_stale_profile_markers_at(&root, "test profile", |_| false).is_err());
        assert!(root.join("SingletonLock").is_file());
        fs::remove_dir_all(root).unwrap();
    }
}
