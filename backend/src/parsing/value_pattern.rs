//! Accepted values of a field filter (`domain`, `thread`, ...): an exact value, or a
//! pattern in which `*` stands for any run of characters.
//!
//! A pattern that ends in `.*` also matches the name before the dot, so `ui.*` selects
//! the `ui` domain and every domain below it (`ui.button`, `ui.peripheral.usb`), and
//! `ui.peripheral.*` selects `ui.peripheral` and everything below it.

/// `*`-glob: the literal pieces between the stars.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Glob {
    parts: Vec<String>,
}

impl Glob {
    fn new(p: &str) -> Self {
        Self { parts: p.split('*').map(str::to_string).collect() }
    }

    fn is_match(&self, v: &str) -> bool {
        let (first, rest) = self.parts.split_first().expect("split yields one part at least");
        let Some(mut v) = v.strip_prefix(first.as_str()) else {
            return false;
        };
        let Some((last, middle)) = rest.split_last() else {
            return v.is_empty(); // no star: exact
        };
        for m in middle {
            match v.find(m.as_str()) {
                Some(i) => v = &v[i + m.len()..],
                None => return false,
            }
        }
        v.len() >= last.len() && v.ends_with(last.as_str())
    }
}

/// One accepted value of a field filter.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ValuePattern {
    Exact(String),
    Glob {
        glob: Glob,
        /// For `a.b.*`: `a.b` itself (which may hold stars too)
        parent: Option<Glob>,
        /// The text before the first star (empty if the pattern starts with one)
        prefix: String,
        /// The longest literal piece, for the byte pre-check
        longest: String,
    },
}

impl ValuePattern {
    pub fn new(p: &str) -> Self {
        if !p.contains('*') {
            return Self::Exact(p.to_string());
        }
        let glob = Glob::new(p);
        let parent = p.strip_suffix(".*").filter(|s| !s.is_empty()).map(Glob::new);
        let prefix = glob.parts[0].clone();
        let longest = glob.parts.iter().max_by_key(|s| s.len()).cloned().unwrap_or_default();
        Self::Glob { glob, parent, prefix, longest }
    }

    /// Whether `p` is a pattern rather than an exact value.
    pub fn is_pattern(p: &str) -> bool {
        p.contains('*')
    }

    pub fn is_match(&self, v: &str) -> bool {
        match self {
            Self::Exact(s) => s == v,
            Self::Glob { glob, parent, .. } => glob.is_match(v) || parent.as_ref().is_some_and(|g| g.is_match(v)),
        }
    }

    /// Text every matching line must contain, given the characters around the field in
    /// the line format (`[` and `]` in `[%n]`); `None` if there is none worth checking.
    pub fn needle(&self, affixes: (Option<char>, Option<char>)) -> Option<String> {
        let mut n = String::new();
        match self {
            Self::Exact(s) => {
                n.extend(affixes.0);
                n.push_str(s);
                n.extend(affixes.1);
            }
            Self::Glob { parent, prefix, longest, .. } => {
                // `ui.*` also matches `ui`: only `ui` is sure to be in the line
                let prefix = match parent {
                    Some(_) => prefix.strip_suffix('.').unwrap_or(prefix),
                    None => prefix,
                };
                if !prefix.is_empty() {
                    n.extend(affixes.0);
                    n.push_str(prefix);
                } else if !longest.is_empty() {
                    n.push_str(longest);
                } else {
                    return None; // `*`
                }
            }
        }
        Some(n)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(p: &str, v: &str) -> bool {
        ValuePattern::new(p).is_match(v)
    }

    #[test]
    fn exact_values() {
        assert!(m("ui", "ui"));
        assert!(!m("ui", "ui.button"));
        assert!(!m("ui.button", "ui"));
    }

    #[test]
    fn subtree_patterns_include_the_parent() {
        for v in ["ui", "ui.button", "ui.peripheral", "ui.peripheral.usb"] {
            assert!(m("ui.*", v), "{v}");
        }
        for v in ["uix", "uix.a", "core.ui", "u"] {
            assert!(!m("ui.*", v), "{v}");
        }
        assert!(m("ui.peripheral.*", "ui.peripheral"));
        assert!(m("ui.peripheral.*", "ui.peripheral.usb.hid"));
        assert!(!m("ui.peripheral.*", "ui"));
        assert!(!m("ui.peripheral.*", "ui.peripherals"));
    }

    #[test]
    fn stars_anywhere() {
        assert!(m("*", "anything"));
        assert!(m("*", ""));
        assert!(m("ui*", "ui"));
        assert!(m("ui*", "uix.y"));
        assert!(m("*.http", "net.http"));
        assert!(!m("*.http", "net.https"));
        assert!(m("*.http*", "net.https"));
        assert!(m("net.*.tls", "net.http.tls"));
        assert!(!m("net.*.tls", "net.tls"));
        assert!(m("a*b*c", "abc"));
        assert!(m("a*b*c", "a_b_b_c"));
        assert!(!m("a*b*c", "acb"));
        // the end piece must not overlap the start piece
        assert!(!m("ab*ba", "aba"));
        // `*.net.*` also matches what `*.net` does
        assert!(m("*.net.*", "core.net"));
        assert!(m("*.net.*", "core.net.tcp"));
    }

    #[test]
    fn needles_are_in_every_matching_line() {
        let b = (Some('['), Some(']'));
        assert_eq!(ValuePattern::new("ui").needle(b).as_deref(), Some("[ui]"));
        assert_eq!(ValuePattern::new("ui.*").needle(b).as_deref(), Some("[ui"));
        assert_eq!(ValuePattern::new("ui*").needle(b).as_deref(), Some("[ui"));
        assert_eq!(ValuePattern::new("*.http").needle(b).as_deref(), Some(".http"));
        assert_eq!(ValuePattern::new("*").needle(b), None);
    }
}
