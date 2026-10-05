//! The home folder (src/shared/home.ts), so a folder typed as "~/dev/app"
//! becomes the absolute path a project matches on. The sidebar has it
//! baked in by the build; here it is the session's `home`, None until the
//! shell sets it, and every reading below has an answer with none.

/// `path` with any trailing "/" taken off.
pub fn trim_slash(path: &str) -> &str {
    path.trim_end_matches('/')
}

fn under_home(path: &str) -> bool {
    path == "~" || path.starts_with("~/")
}

/// `path` trimmed, with a leading "~" expanded; None when it starts with
/// "~" and no home is known.
pub fn expand_home(path: &str, home: Option<&str>) -> Option<String> {
    let p = path.trim();
    if !under_home(p) {
        return Some(p.to_string());
    }
    let home = home.map(trim_slash).filter(|h| !h.is_empty())?;
    Some(format!("{home}{}", &p[1..]))
}

/// Whether `dir` is the home folder itself, which would swallow every
/// session as one project. Any case, as macOS folders are.
pub fn is_home(dir: Option<&str>, home: Option<&str>) -> bool {
    let Some(home) = home.map(trim_slash).filter(|h| !h.is_empty()) else {
        return false;
    };
    trim_slash(dir.unwrap_or_default()).to_lowercase() == home.to_lowercase()
}

/// An absolute path under home as "~/...", for showing; any other path as it is.
pub fn tilde_home(path: &str, home: Option<&str>) -> String {
    let Some(home) = home.map(trim_slash).filter(|h| !h.is_empty()) else {
        return path.to_string();
    };
    if path == home {
        return "~".to_string();
    }
    match path.strip_prefix(home) {
        Some(rest) if rest.starts_with('/') => format!("~{rest}"),
        _ => path.to_string(),
    }
}
