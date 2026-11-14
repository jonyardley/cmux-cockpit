//! Which GitHub repo a folder is the main checkout of, so a run record
//! (named by `owner/repo`) finds its workspace's card (issue #390,
//! option a). The runner asks git in the folder, once per folder
//! (`rev_parse_args`, `remote_args`), and reads the answers here. A
//! folder that is not a git checkout, is a linked worktree, or has no
//! GitHub `origin` matches no record; none of that is an error.

/// `git rev-parse` asking for the folder's own git dir and the common one
/// its checkouts share, as absolute paths, one to a line.
pub const REV_PARSE_ARGS: [&str; 4] = [
    "rev-parse",
    "--path-format=absolute",
    "--git-dir",
    "--git-common-dir",
];

/// `git remote get-url origin`.
pub const REMOTE_ARGS: [&str; 3] = ["remote", "get-url", "origin"];

/// Whether `rev_parse`, git's answer to `REV_PARSE_ARGS`, is a main
/// checkout's: its git dir is the common one. A linked worktree's git dir
/// sits under the common one's `worktrees/`.
pub fn is_main_checkout(rev_parse: &str) -> bool {
    let mut lines = rev_parse.lines().map(str::trim);
    match (lines.next(), lines.next()) {
        (Some(own), Some(common)) => !own.is_empty() && own == common,
        _ => false,
    }
}

/// The hosts that are GitHub itself, not an enterprise server.
fn is_github(host: &str) -> bool {
    ["github.com", "www.github.com", "ssh.github.com"]
        .iter()
        .any(|h| host.eq_ignore_ascii_case(h))
}

/// An owner or repo name: letters, digits, dots, dashes and underscores,
/// never `.` or `..`.
fn is_name(s: &str) -> bool {
    !s.is_empty()
        && s != "."
        && s != ".."
        && s.bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// The host and path of a remote URL: `scheme://[user@]host[:port]/path`
/// or the scp form `[user@]host:path`.
fn host_and_path(url: &str) -> Option<(&str, &str)> {
    if let Some((scheme, rest)) = url.split_once("://") {
        if !["https", "http", "ssh", "git", "git+ssh"].contains(&scheme) {
            return None;
        }
        let (authority, path) = rest.split_once('/')?;
        let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
        let host = host.split_once(':').map_or(host, |(h, _)| h);
        return Some((host, path));
    }
    let (authority, path) = url.split_once(':')?;
    let host = authority.rsplit_once('@').map_or(authority, |(_, h)| h);
    // A local path with a colon later on is no scp form.
    (!host.contains('/')).then_some((host, path))
}

/// The GitHub `owner/repo` a remote URL names, in lower case, from the
/// https and ssh forms git takes, with or without `.git`; None for any
/// other host or shape.
pub fn github_repo(url: &str) -> Option<String> {
    let (host, path) = host_and_path(url.trim())?;
    if !is_github(host) {
        return None;
    }
    let path = path.trim_start_matches('/').trim_end_matches('/');
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, repo) = path.split_once('/')?;
    (is_name(owner) && is_name(repo)).then(|| format!("{owner}/{repo}").to_ascii_lowercase())
}

/// The repo a folder is the main checkout of, from git's answers there:
/// None for a linked worktree, a folder with no `origin`, or one that is
/// not GitHub's.
pub fn checkout_repo(rev_parse: &str, remote: Option<&str>) -> Option<String> {
    if !is_main_checkout(rev_parse) {
        return None;
    }
    github_repo(remote?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_owner_and_repo_from_https_and_ssh_remotes() {
        for url in [
            "https://github.com/Example/App-One.git",
            "https://github.com/example/app-one",
            "https://github.com/example/app-one/",
            "https://token@github.com/example/app-one.git",
            "http://www.github.com/example/app-one.git",
            "git@github.com:Example/app-one.git",
            "git@github.com:example/app-one",
            "ssh://git@github.com/example/app-one.git",
            "ssh://git@ssh.github.com:443/example/app-one.git",
            "git://github.com/example/app-one.git\n",
        ] {
            assert_eq!(
                github_repo(url).as_deref(),
                Some("example/app-one"),
                "{url}"
            );
        }
        assert_eq!(
            github_repo("git@github.com:a/b.c.git").as_deref(),
            Some("a/b.c")
        );
    }

    #[test]
    fn another_host_or_shape_names_no_repo() {
        for url in [
            "",
            "https://gitlab.com/example/app-one.git",
            "https://github.example.com/example/app-one.git",
            "https://github.com.evil.io/example/app-one.git",
            "git@bitbucket.org:example/app-one.git",
            "https://github.com/example",
            "https://github.com/example/app-one/tree/main",
            "https://github.com/example/../x",
            "file:///Users/me/dev/app-one",
            "/Users/me/dev/app-one",
            "ftp://github.com/example/app-one",
        ] {
            assert_eq!(github_repo(url), None, "{url}");
        }
    }

    #[test]
    fn only_a_main_checkout_counts() {
        let main = "/dev/app-one/.git\n/dev/app-one/.git\n";
        let worktree = "/dev/app-one/.git/worktrees/feat\n/dev/app-one/.git\n";
        let remote = Some("git@github.com:example/app-one.git");
        assert!(is_main_checkout(main));
        assert!(!is_main_checkout(worktree));
        assert!(!is_main_checkout(""));
        assert!(!is_main_checkout("/dev/app-one/.git\n"));
        assert_eq!(
            checkout_repo(main, remote).as_deref(),
            Some("example/app-one")
        );
        assert_eq!(checkout_repo(worktree, remote), None);
        assert_eq!(checkout_repo(main, None), None, "no origin");
        assert_eq!(
            checkout_repo(main, Some("https://gitlab.com/example/app-one")),
            None
        );
    }
}
