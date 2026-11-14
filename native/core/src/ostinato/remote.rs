//! Which GitHub repo a folder is the main checkout of, so a run record
//! (named by `owner/repo`) finds its workspace's card (issue #390,
//! option a). No git process runs for it: git run in a folder obeys that
//! repo's own config (`core.fsmonitor`, a pager, aliases), which a
//! cloned repo may set to run anything. The runner instead finds the
//! folder's `.git` itself, once per folder: a directory is a main
//! checkout, whose `config` file it hands here (`checkout_repo`); a
//! `.git` file is a linked worktree, which matches nothing. A folder with
//! no `.git`, no `origin` or one that is not GitHub's matches no record
//! either; none of that is an error.
//!
//! Only the config file itself is read: an `include` or `includeIf`, or
//! a `url.<base>.insteadOf` rewrite, is not followed, and an ssh host
//! alias (`git@github.com-work:owner/repo`, named in ~/.ssh/config) is
//! not GitHub's host, so it matches nothing either.

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

/// One value from a git config line: quotes taken off, `\\`, `\"`,
/// `\n`, `\t` and `\b` read, and a `#` or `;` outside quotes ending it.
fn config_value(raw: &str) -> String {
    let mut out = String::new();
    let mut quoted = false;
    // Spaces outside quotes are kept only once something follows them.
    let mut spaces = String::new();
    let mut chars = raw.trim_start().chars();
    while let Some(c) = chars.next() {
        match c {
            '"' => quoted = !quoted,
            '\\' => {
                let escaped = match chars.next() {
                    Some('n') => '\n',
                    Some('t') => '\t',
                    Some('b') => '\u{8}',
                    Some(other) => other,
                    None => break,
                };
                out.push_str(&std::mem::take(&mut spaces));
                out.push(escaped);
            }
            '#' | ';' if !quoted => break,
            c if c.is_whitespace() && !quoted => spaces.push(c),
            c => {
                out.push_str(&std::mem::take(&mut spaces));
                out.push(c);
            }
        }
    }
    out
}

/// Whether a section header's insides (between `[` and `]`) name the
/// `origin` remote: `remote "origin"`, the section's name in any case
/// and the subsection's exactly, or the old `remote.origin`.
fn is_origin_section(header: &str) -> bool {
    let header = header.trim();
    if let Some((name, sub)) = header.split_once(char::is_whitespace) {
        let sub = sub.trim();
        return name.eq_ignore_ascii_case("remote") && sub == "\"origin\"";
    }
    header.eq_ignore_ascii_case("remote.origin")
}

/// The `url` of `[remote "origin"]` in a git config file's text: the
/// first one, as `git remote get-url origin` gives. None with no origin.
pub fn origin_url(config: &str) -> Option<String> {
    let mut in_origin = false;
    for line in config.lines() {
        let mut line = line.trim();
        if let Some(rest) = line.strip_prefix('[') {
            // No closing bracket: no header git would take, so not one.
            let Some((header, after)) = rest.split_once(']') else {
                continue;
            };
            in_origin = is_origin_section(header);
            // A variable may follow the header on the same line.
            line = after.trim();
        }
        if !in_origin || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        let (key, value) = line.split_once('=').unwrap_or((line, ""));
        if key.trim().eq_ignore_ascii_case("url") {
            let url = config_value(value);
            if !url.is_empty() {
                return Some(url);
            }
        }
    }
    None
}

/// The GitHub repo a main checkout's config file, `.git/config`, names
/// as its `origin`, lower case; None with no origin or another host.
pub fn checkout_repo(config: &str) -> Option<String> {
    github_repo(&origin_url(config)?)
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
    fn reads_the_origin_url_from_a_config_file() {
        let config = r#"[core]
	repositoryformatversion = 0
	bare = false
[remote "upstream"]
	url = git@github.com:other/app-one.git
[Remote "origin"]
	; a comment
	URL = git@github.com:Example/App-One.git
	fetch = +refs/heads/*:refs/remotes/origin/*
	url = https://github.com/second/url.git
[branch "main"]
	remote = origin
"#;
        assert_eq!(
            origin_url(config).as_deref(),
            Some("git@github.com:Example/App-One.git")
        );
        assert_eq!(checkout_repo(config).as_deref(), Some("example/app-one"));
    }

    #[test]
    fn reads_quoted_values_comments_and_the_old_header_form() {
        let quoted = "[remote \"origin\"]\n\turl = \"https://github.com/example/app-one\" # main\n";
        assert_eq!(checkout_repo(quoted).as_deref(), Some("example/app-one"));
        let old = "[remote.origin]\nurl=https://github.com/example/app-one.git\n";
        assert_eq!(checkout_repo(old).as_deref(), Some("example/app-one"));
        let same_line = "[remote \"origin\"] url = git@github.com:example/app-one\n";
        assert_eq!(checkout_repo(same_line).as_deref(), Some("example/app-one"));
        let odd =
            "[core]\n[odd line\n[remote \"origin\"]\n\turl = git@github.com:example/app-one\n";
        assert_eq!(checkout_repo(odd).as_deref(), Some("example/app-one"));
        assert_eq!(config_value(r#" "a b" c\"d ;x"#), r#"a b c"d"#);
    }

    #[test]
    fn a_config_with_no_github_origin_names_no_repo() {
        for config in [
            "",
            "[core]\n\tbare = false\n",
            "[remote \"upstream\"]\n\turl = git@github.com:example/app-one.git\n",
            "[remote \"Origin\"]\n\turl = git@github.com:example/app-one.git\n",
            "[remote \"origin\"]\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n",
            "[remote \"origin\"]\n\turl = https://gitlab.com/example/app-one.git\n",
            "[remote \"origin\"]\n\t# url = git@github.com:example/app-one.git\n",
            "[remote \"origin\"\n\turl = git@github.com:example/app-one.git\n",
            "[remote \"origin\"]\n\turl = git@github.com-work:example/app-one.git\n",
        ] {
            assert_eq!(checkout_repo(config), None, "{config}");
        }
    }
}
