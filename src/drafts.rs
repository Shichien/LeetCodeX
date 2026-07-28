use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};
use rand::RngCore;
use serde_json::{Value, json};

const MAX_DRAFT_BYTES: usize = 1_000_000;

pub fn load(site: &str, problem: &str, language: &str) -> Result<Value> {
    load_at(&draft_root()?, site, problem, language)
}

fn load_at(root: &Path, site: &str, problem: &str, language: &str) -> Result<Value> {
    let path = draft_path(root, site, problem, language)?;
    recover_draft_backup(&path)?;
    let metadata = match fs::symlink_metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return Ok(json!({ "code": null }));
        }
        Err(error) => {
            return Err(error)
                .with_context(|| format!("failed to inspect draft {}", path.display()));
        }
    };
    if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
        bail!("draft must be a regular file: {}", path.display());
    }
    if metadata.len() > MAX_DRAFT_BYTES as u64 {
        bail!("saved draft exceeds the {MAX_DRAFT_BYTES}-byte limit");
    }
    let code = fs::read_to_string(&path)
        .with_context(|| format!("failed to read draft {}", path.display()))?;
    Ok(json!({ "code": code }))
}

pub fn save(site: &str, problem: &str, language: &str, code: &str) -> Result<Value> {
    save_at(&draft_root()?, site, problem, language, code)?;
    Ok(json!({ "saved": true }))
}

pub fn diagnostic() -> Value {
    match draft_root() {
        Ok(root) => diagnostic_at(&root),
        Err(error) => json!({
            "status": "error",
            "detail": format!("{error:#}"),
        }),
    }
}

fn diagnostic_at(root: &Path) -> Value {
    let path = root.to_string_lossy().into_owned();
    for candidate in root.ancestors().take(3) {
        match fs::symlink_metadata(candidate) {
            Ok(metadata) if metadata.file_type().is_symlink() || !metadata.file_type().is_dir() => {
                return json!({
                    "status": "invalid",
                    "path": path,
                    "detail": format!(
                        "draft path component must be a real directory: {}",
                        candidate.display()
                    ),
                });
            }
            Ok(_) => {}
            Err(error) if error.kind() == ErrorKind::NotFound => {}
            Err(error) => {
                return json!({
                    "status": "error",
                    "path": path,
                    "detail": format!(
                        "failed to inspect draft path component {}: {error}",
                        candidate.display()
                    ),
                });
            }
        }
    }

    let metadata = match fs::symlink_metadata(root) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == ErrorKind::NotFound => {
            return json!({ "status": "not_created", "path": path });
        }
        Err(error) => {
            return json!({
                "status": "error",
                "path": path,
                "detail": format!("failed to inspect draft directory: {error}"),
            });
        }
    };
    if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
        return json!({
            "status": "invalid",
            "path": path,
            "detail": "draft directory must be a real directory",
        });
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        if metadata.permissions().mode() & 0o077 != 0 {
            return json!({
                "status": "insecure",
                "path": path,
                "detail": "draft directory permissions must not grant group or other access",
            });
        }
    }

    match fs::read_dir(root) {
        Ok(_) => json!({ "status": "ready", "path": path }),
        Err(error) => json!({
            "status": "error",
            "path": path,
            "detail": format!("failed to read draft directory: {error}"),
        }),
    }
}

fn save_at(root: &Path, site: &str, problem: &str, language: &str, code: &str) -> Result<()> {
    if code.len() > MAX_DRAFT_BYTES {
        bail!("draft exceeds the {MAX_DRAFT_BYTES}-byte limit");
    }
    let destination = draft_path(root, site, problem, language)?;
    let directory = destination
        .parent()
        .context("draft destination has no parent directory")?;
    fs::create_dir_all(directory)
        .with_context(|| format!("failed to create draft directory {}", directory.display()))?;
    secure_draft_directories(root, site, directory)?;
    recover_draft_backup(&destination)?;
    validate_existing_draft(&destination)?;

    let mut random = [0_u8; 8];
    rand::rng().fill_bytes(&mut random);
    let suffix = u64::from_le_bytes(random);
    let temporary = directory.join(format!(".draft-{}-{suffix}.tmp", std::process::id()));
    let write_result = (|| {
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
        file.write_all(code.as_bytes())?;
        file.sync_all()?;
        replace_file(&temporary, &destination)?;
        sync_directory(directory)
    })();
    if write_result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write_result
}

fn draft_backup_path(destination: &Path) -> PathBuf {
    destination.with_extension("txt.leetcodex-backup")
}

fn recover_draft_backup(destination: &Path) -> Result<()> {
    let backup = draft_backup_path(destination);
    let destination_metadata = fs::symlink_metadata(destination);
    let backup_metadata = fs::symlink_metadata(&backup);
    match (destination_metadata, backup_metadata) {
        (Ok(destination_metadata), Ok(backup_metadata)) => {
            if !destination_metadata.file_type().is_file()
                || destination_metadata.file_type().is_symlink()
            {
                bail!("draft must be a regular file: {}", destination.display());
            }
            if !backup_metadata.file_type().is_file() || backup_metadata.file_type().is_symlink() {
                bail!("draft backup must be a regular file: {}", backup.display());
            }
            fs::remove_file(&backup).with_context(|| {
                format!("failed to remove stale draft backup {}", backup.display())
            })
        }
        (Err(error), Ok(metadata)) if error.kind() == ErrorKind::NotFound => {
            if !metadata.file_type().is_file() || metadata.file_type().is_symlink() {
                bail!("draft backup must be a regular file: {}", backup.display());
            }
            fs::rename(&backup, destination).with_context(|| {
                format!(
                    "failed to recover draft backup {} into {}",
                    backup.display(),
                    destination.display()
                )
            })
        }
        (Err(error), _) if error.kind() != ErrorKind::NotFound => {
            Err(error).with_context(|| format!("failed to inspect draft {}", destination.display()))
        }
        (_, Err(error)) if error.kind() != ErrorKind::NotFound => Err(error)
            .with_context(|| format!("failed to inspect draft backup {}", backup.display())),
        _ => Ok(()),
    }
}

fn validate_existing_draft(destination: &Path) -> Result<()> {
    match fs::symlink_metadata(destination) {
        Ok(metadata) if metadata.file_type().is_file() && !metadata.file_type().is_symlink() => {
            Ok(())
        }
        Ok(_) => bail!("draft must be a regular file: {}", destination.display()),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(()),
        Err(error) => {
            Err(error).with_context(|| format!("failed to inspect draft {}", destination.display()))
        }
    }
}

#[cfg(unix)]
fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    fs::rename(source, destination)
        .with_context(|| format!("failed to replace draft {}", destination.display()))
}

#[cfg(not(unix))]
fn replace_file(source: &Path, destination: &Path) -> Result<()> {
    if !destination.exists() {
        return fs::rename(source, destination)
            .with_context(|| format!("failed to install draft {}", destination.display()));
    }
    let backup = draft_backup_path(destination);
    if backup.exists() {
        bail!("stale draft backup exists at {}", backup.display());
    }
    fs::rename(destination, &backup)
        .with_context(|| format!("failed to stage draft {}", destination.display()))?;
    match fs::rename(source, destination) {
        Ok(()) => {
            let _ = fs::remove_file(&backup);
            Ok(())
        }
        Err(error) => {
            let _ = fs::rename(&backup, destination);
            Err(error).with_context(|| format!("failed to install draft {}", destination.display()))
        }
    }
}

fn secure_draft_directories(root: &Path, site: &str, directory: &Path) -> Result<()> {
    for path in [root.to_path_buf(), root.join(site), directory.to_path_buf()] {
        let metadata = fs::symlink_metadata(&path)
            .with_context(|| format!("failed to inspect draft directory {}", path.display()))?;
        if !metadata.file_type().is_dir() || metadata.file_type().is_symlink() {
            bail!(
                "draft directory must be a real directory: {}",
                path.display()
            );
        }
        restrict_draft_directory(&path)?;
    }
    Ok(())
}

#[cfg(unix)]
fn restrict_draft_directory(path: &Path) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
        .with_context(|| format!("failed to secure draft directory {}", path.display()))
}

#[cfg(not(unix))]
fn restrict_draft_directory(_path: &Path) -> Result<()> {
    Ok(())
}

#[cfg(unix)]
fn sync_directory(path: &Path) -> Result<()> {
    fs::File::open(path)
        .and_then(|directory| directory.sync_all())
        .with_context(|| format!("failed to sync draft directory {}", path.display()))
}

#[cfg(not(unix))]
fn sync_directory(_path: &Path) -> Result<()> {
    Ok(())
}

fn draft_root() -> Result<PathBuf> {
    let home = std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .context("HOME or USERPROFILE is required for native draft backup")?;
    Ok(PathBuf::from(home)
        .join(".leetcodex")
        .join("drafts")
        .join("v1"))
}

fn draft_path(root: &Path, site: &str, problem: &str, language: &str) -> Result<PathBuf> {
    validate_component("site", site, 16)?;
    if !matches!(site, "global" | "china") {
        bail!("unsupported draft site");
    }
    validate_component("problem", problem, 200)?;
    validate_component("language", language, 64)?;
    Ok(root
        .join(site)
        .join(problem)
        .join(format!("{language}.txt")))
}

fn validate_component(name: &str, value: &str, maximum: usize) -> Result<()> {
    if value.is_empty()
        || value.len() > maximum
        || value.starts_with('.')
        || !value
            .chars()
            .all(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
    {
        bail!("draft {name} contains unsupported characters");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temporary_root() -> PathBuf {
        let mut random = [0_u8; 8];
        rand::rng().fill_bytes(&mut random);
        std::env::temp_dir().join(format!(
            "leetcodex-drafts-test-{}-{}",
            std::process::id(),
            u64::from_le_bytes(random)
        ))
    }

    #[test]
    fn drafts_are_saved_and_replaced_by_context() {
        let root = temporary_root();
        save_at(&root, "global", "two-sum", "cpp", "first").unwrap();
        save_at(&root, "global", "two-sum", "cpp", "second").unwrap();
        save_at(&root, "china", "two-sum", "cpp", "china").unwrap();
        assert_eq!(
            fs::read_to_string(draft_path(&root, "global", "two-sum", "cpp").unwrap()).unwrap(),
            "second"
        );
        assert_eq!(
            fs::read_to_string(draft_path(&root, "china", "two-sum", "cpp").unwrap()).unwrap(),
            "china"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn draft_paths_reject_directory_traversal() {
        let root = temporary_root();
        assert!(draft_path(&root, "global", "../secret", "cpp").is_err());
        assert!(draft_path(&root, "global", "two-sum", "../../txt").is_err());
        assert!(draft_path(&root, "other", "two-sum", "cpp").is_err());
    }

    #[test]
    fn draft_diagnostic_accepts_a_missing_or_ready_private_root() {
        let base = temporary_root();
        fs::create_dir_all(&base).unwrap();
        let root = base.join("drafts").join("v1");
        assert_eq!(diagnostic_at(&root)["status"], "not_created");

        fs::create_dir_all(&root).unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700)).unwrap();
        }
        assert_eq!(diagnostic_at(&root)["status"], "ready");
        fs::remove_dir_all(base).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn draft_diagnostic_rejects_public_permissions_and_symbolic_links() {
        use std::os::unix::fs::{PermissionsExt, symlink};

        let base = temporary_root();
        let root = base.join("drafts").join("v1");
        fs::create_dir_all(&root).unwrap();
        fs::set_permissions(&root, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(diagnostic_at(&root)["status"], "insecure");

        fs::remove_dir_all(base.join("drafts")).unwrap();
        let external = base.join("external");
        fs::create_dir_all(&external).unwrap();
        symlink(&external, base.join("drafts")).unwrap();
        assert_eq!(diagnostic_at(&root)["status"], "invalid");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn interrupted_draft_replacement_recovers_the_previous_file() {
        let root = temporary_root();
        save_at(&root, "global", "two-sum", "cpp", "previous").unwrap();
        let destination = draft_path(&root, "global", "two-sum", "cpp").unwrap();
        let backup = draft_backup_path(&destination);
        fs::rename(&destination, &backup).unwrap();

        assert_eq!(
            load_at(&root, "global", "two-sum", "cpp").unwrap()["code"],
            "previous"
        );
        assert!(destination.exists());
        assert!(!backup.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn draft_directories_and_files_are_private() {
        use std::os::unix::fs::PermissionsExt;

        let root = temporary_root();
        save_at(&root, "global", "two-sum", "cpp", "private").unwrap();
        let destination = draft_path(&root, "global", "two-sum", "cpp").unwrap();
        for directory in [&root, &root.join("global"), destination.parent().unwrap()] {
            assert_eq!(
                fs::metadata(directory).unwrap().permissions().mode() & 0o777,
                0o700
            );
        }
        assert_eq!(
            fs::metadata(destination).unwrap().permissions().mode() & 0o777,
            0o600
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symbolic_link_drafts_are_rejected() {
        use std::os::unix::fs::symlink;

        let root = temporary_root();
        let directory = root.join("global").join("two-sum");
        fs::create_dir_all(&directory).unwrap();
        let external = root.join("external.txt");
        fs::write(&external, "outside").unwrap();
        symlink(&external, directory.join("cpp.txt")).unwrap();

        assert!(load_at(&root, "global", "two-sum", "cpp").is_err());
        assert!(save_at(&root, "global", "two-sum", "cpp", "replacement").is_err());
        assert_eq!(fs::read_to_string(external).unwrap(), "outside");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn invalid_draft_destination_does_not_discard_recovery_backup() {
        use std::os::unix::fs::symlink;

        let root = temporary_root();
        let directory = root.join("global").join("two-sum");
        fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("cpp.txt");
        let backup = draft_backup_path(&destination);
        let external = root.join("external.txt");
        fs::write(&external, "outside").unwrap();
        fs::write(&backup, "recoverable").unwrap();
        symlink(&external, &destination).unwrap();

        assert!(load_at(&root, "global", "two-sum", "cpp").is_err());
        assert_eq!(fs::read_to_string(&backup).unwrap(), "recoverable");
        assert_eq!(fs::read_to_string(external).unwrap(), "outside");
        fs::remove_dir_all(root).unwrap();
    }
}
