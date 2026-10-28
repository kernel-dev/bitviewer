//! Reads CHANGELOG.md (Keep a Changelog format), as the web app's
//! core/changelog.ts: release headings look like `## [2.1.0] - 2026-10-19`;
//! `[Unreleased]` and the link lines at the bottom are skipped.

#[derive(Clone, Debug, PartialEq)]
pub struct ChangelogSection {
    /// "Added", "Changed", "Fixed"… (empty for items before any `###`).
    pub title: String,
    pub items: Vec<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ChangelogRelease {
    pub version: String,
    /// "YYYY-MM-DD", or "" when the heading has no date.
    pub date: String,
    pub sections: Vec<ChangelogSection>,
}

/// "## [2.1.0] - 2026-10-19" → ("2.1.0", "2026-10-19").
fn release_heading(line: &str) -> Option<(String, String)> {
    let rest = line.strip_prefix("##")?;
    if !rest.starts_with(char::is_whitespace) {
        return None;
    }
    let rest = rest.trim_start().strip_prefix('[')?;
    let (version, after) = rest.split_once(']')?;
    let parts: Vec<&str> = version.splitn(3, '.').collect();
    let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
    let patch_ok = parts.len() == 3 && {
        let patch_digits: String = parts[2].chars().take_while(char::is_ascii_digit).collect();
        !patch_digits.is_empty()
    };
    if !(parts.len() == 3 && digits(parts[0]) && digits(parts[1]) && patch_ok) || version.contains(char::is_whitespace) {
        return None;
    }
    let after = after.trim_end();
    if after.trim().is_empty() {
        return Some((version.into(), String::new()));
    }
    let date = after.trim_start().strip_prefix('-')?.trim();
    let valid = date.len() == 10 && date.chars().enumerate().all(|(i, c)| if i == 4 || i == 7 { c == '-' } else { c.is_ascii_digit() });
    let spaced = after.starts_with(char::is_whitespace) && after.trim_start()[1..].starts_with(char::is_whitespace);
    (valid && spaced).then(|| (version.into(), date.into()))
}

fn link_reference(line: &str) -> bool {
    line.strip_prefix('[')
        .and_then(|rest| rest.split_once("]:"))
        .is_some_and(|(label, after)| !label.is_empty() && !label.contains(']') && after.starts_with(char::is_whitespace))
}

pub fn parse_changelog(text: &str) -> Vec<ChangelogRelease> {
    let mut releases: Vec<ChangelogRelease> = Vec::new();
    let mut in_release = false;
    let mut item: Option<usize> = None;
    for raw in text.split('\n') {
        let line = raw.trim_end();
        if line.starts_with("## ") {
            in_release = false;
            if let Some((version, date)) = release_heading(line) {
                releases.push(ChangelogRelease { version, date, sections: Vec::new() });
                in_release = true;
            }
            item = None;
        } else if !in_release || link_reference(line) {
            // outside a release (preamble, [Unreleased]) or a link line
        } else if let Some(title) = line.strip_prefix("### ") {
            releases.last_mut().unwrap().sections.push(ChangelogSection { title: title.trim().into(), items: Vec::new() });
            item = None;
        } else if line.starts_with("- ") || line.starts_with("* ") || line.starts_with("-\t") || line.starts_with("*\t") {
            let release = releases.last_mut().unwrap();
            if release.sections.is_empty() {
                release.sections.push(ChangelogSection { title: String::new(), items: Vec::new() });
            }
            let section = release.sections.last_mut().unwrap();
            section.items.push(line[2..].trim().into());
            item = Some(section.items.len() - 1);
        } else if !line.trim().is_empty()
            && let Some(index) = item
            && let Some(section) = releases.last_mut().and_then(|release| release.sections.last_mut())
        {
            // wrapped continuation of the bullet above
            section.items[index].push(' ');
            section.items[index].push_str(line.trim());
        }
    }
    releases
}

/// The entry for `version`, if the changelog has one.
pub fn find_release(text: &str, version: &str) -> Option<ChangelogRelease> {
    parse_changelog(text).into_iter().find(|release| release.version == version)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_releases_sections_and_wrapped_items() {
        let text = "# Changelog\n\n## [Unreleased]\n- skip\n\n## [2.1.3] - 2026-10-26\n\n### Added\n- One\n  continued\n* Two\n\n### Fixed\n- Three\n\n## [2.0.0]\n- Loose\n\n[2.1.3]: https://example.com\n";
        let releases = parse_changelog(text);
        assert_eq!(releases.len(), 2);
        assert_eq!(releases[0].date, "2026-10-26");
        assert_eq!(releases[0].sections[0].items, ["One continued", "Two"]);
        assert_eq!(releases[0].sections[1].title, "Fixed");
        assert_eq!(releases[1].sections[0].title, "");
        assert_eq!(releases[1].sections[0].items, ["Loose"]);
        assert!(find_release(include_str!("../../CHANGELOG.md"), "2.1.3").is_some());
    }
}
