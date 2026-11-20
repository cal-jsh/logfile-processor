//! Log line formats.
//!
//! A format is written in spdlog's pattern syntax
//! (<https://github.com/gabime/spdlog/wiki/Custom-formatting>), for example
//! `[%Y-%m-%d %H:%M:%S.%e] [%t] [%l] %v`, and compiled into a short list of tokens that
//! split a line into named fields without a regex and without allocating.
//!
//! Supported flags:
//!
//! * time: `%Y %y %C %m %b %h %B %d %a %A %H %I %M %S %e %f %F %p %z %E`, and the
//!   shorthands `%D %x` (`%m/%d/%y`), `%T %X` (`%H:%M:%S`), `%R`, `%r`, `%c`.
//!   Consecutive time flags (with the literal text between them) form one `time` field.
//! * `%l` / `%L` level, `%n` logger name (shown as "Domain"), `%t` thread, `%P` process,
//!   `%s %g` source file, `%#` source line, `%!` function, `%@` file:line,
//!   `%o %i %u %O` elapsed time, `%v` the message, `%+` spdlog's default pattern.
//! * `%{name}`: any other field, free text, e.g. `[%{thread}]` for a thread name. The
//!   names `time`, `level`, `message` and `thread` get the meaning of the flags above
//!   (a `%{time}` field is free text that is parsed as `YYYY-MM-DD HH:MM:SS[.frac]`).
//! * `%^ %$` (color range) are ignored, `%%` is a literal `%`. Padding and truncation
//!   (`%-8l`, `%=10n`, `%8!t`) are accepted; padded values are trimmed.
//!
//! Matching rules, chosen to keep the original `[ts] [LEVEL] [domain] message` format
//! exactly as it was (see the tests against its old regex):
//!
//! * A space in the pattern matches exactly one whitespace character (after a padded
//!   field: the whole run of padding).
//! * A free-text field ends at the first occurrence of the first character of the
//!   literal that follows it and must not be empty; the message field may be empty and
//!   loses its leading whitespace when it ends the line.
//! * Time flags have fixed widths (`%e` is exactly 3 digits, `%f` 6, `%F` 9).

use crate::logfile::levels::{code, level_code};
use crate::logfile::timeline::{days_from_civil, parse_timestamp};
use serde::Serialize;

/// Most fields one format can have.
pub const MAX_FIELDS: usize = 16;

/// The original format of this app: free-text time, level and domain in brackets.
pub const LEGACY_PATTERN: &str = "[%{time}] [%l] [%n] %v";
/// Every line is a message: used when no known format fits the file.
pub const RAW_PATTERN: &str = "%v";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum FieldKind {
    Time,
    Level,
    Message,
    /// Any other field (domain, thread, process, source, custom ...)
    Text,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct FieldDef {
    /// Stable id, e.g. `thread`; used in filters and settings
    pub name: String,
    /// Shown in the UI, e.g. `Thread`
    pub label: String,
    pub kind: FieldKind,
    /// Offered as a filter (a list of values) in the UI
    pub filterable: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum TimePart {
    Lit(char),
    Year4,
    Year2,
    Month,
    MonthAbbr,
    MonthName,
    Day,
    Hour24,
    Hour12,
    Minute,
    Second,
    /// Fraction of a second with exactly this many digits
    Frac(u8),
    AmPm,
    WeekdayAbbr,
    WeekdayName,
    TzOffset,
    Epoch,
}

/// Where a free-text field ends, worked out once from the token after it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum End {
    /// At the end of the line
    Eol,
    /// At the first occurrence of this byte (an ASCII literal follows)
    Byte(u8),
    /// At the first occurrence of this character (a non-ASCII literal follows)
    Char(char),
    /// At the first whitespace character (a literal starting with a space follows)
    Space,
    /// At the first whitespace character or the end (another field follows)
    SpaceOrEol,
}

#[derive(Clone, Debug)]
enum Token {
    Lit(String),
    /// Free text up to the next literal. `field` is `None` for a repeated field.
    Field { field: Option<usize>, padded: bool, end: End, message: bool },
    /// A run of time flags. `shape` is set when all parts have a fixed width (checked
    /// first, it is faster).
    Time { field: Option<usize>, parts: Vec<TimePart>, shape: Option<Shape> },
}

/// A compiled log line format.
#[derive(Clone, Debug)]
pub struct LogFormat {
    pattern: String,
    tokens: Vec<Token>,
    fields: Vec<FieldDef>,
    time: Option<usize>,
    level: Option<usize>,
    message: Option<usize>,
    /// The time is a free-text `%{time}` field, parsed with [`parse_timestamp`]
    time_free: bool,
    /// Index of the token holding the time
    time_token: Option<usize>,
}

/// Where the fields of one matching line are: byte ranges into the line.
#[derive(Clone, Copy, Debug)]
pub struct Parsed {
    spans: [(u32, u32); MAX_FIELDS],
}

impl Parsed {
    /// The value of field `i` in `line` (the line that was parsed).
    pub fn get<'a>(&self, line: &'a str, i: usize) -> &'a str {
        let (s, e) = self.spans[i];
        &line[s as usize..e as usize]
    }
}

enum Item {
    Lit(char),
    Flag { c: char, padded: bool },
    Named { name: String, padded: bool },
}

fn is_time_flag(c: char) -> bool {
    "YyCmbhBdaAHIMSefFpzE".contains(c)
}

fn time_part(c: char) -> TimePart {
    match c {
        'Y' => TimePart::Year4,
        'y' | 'C' => TimePart::Year2,
        'm' => TimePart::Month,
        'b' | 'h' => TimePart::MonthAbbr,
        'B' => TimePart::MonthName,
        'd' => TimePart::Day,
        'a' => TimePart::WeekdayAbbr,
        'A' => TimePart::WeekdayName,
        'H' => TimePart::Hour24,
        'I' => TimePart::Hour12,
        'M' => TimePart::Minute,
        'S' => TimePart::Second,
        'e' => TimePart::Frac(3),
        'f' => TimePart::Frac(6),
        'F' => TimePart::Frac(9),
        'p' => TimePart::AmPm,
        'z' => TimePart::TzOffset,
        'E' => TimePart::Epoch,
        _ => unreachable!("not a time flag: {c}"),
    }
}

/// Composite flags, expanded before compiling.
fn expansion(c: char) -> Option<&'static str> {
    Some(match c {
        'D' | 'x' => "%m/%d/%y",
        'T' | 'X' => "%H:%M:%S",
        'R' => "%H:%M",
        'r' => "%I:%M:%S %p",
        'c' => "%a %b %d %H:%M:%S %Y",
        '+' => "[%Y-%m-%d %H:%M:%S.%e] [%n] [%l] %v",
        _ => return None,
    })
}

/// `(name, label, kind)` of a field flag.
fn field_flag(c: char) -> Option<(&'static str, &'static str, FieldKind)> {
    Some(match c {
        'l' | 'L' => ("level", "Level", FieldKind::Level),
        'n' => ("domain", "Domain", FieldKind::Text),
        't' => ("thread", "Thread", FieldKind::Text),
        'P' => ("process", "Process", FieldKind::Text),
        's' | 'g' => ("file", "File", FieldKind::Text),
        '#' => ("line", "Source line", FieldKind::Text),
        '!' => ("function", "Function", FieldKind::Text),
        '@' => ("source", "Source", FieldKind::Text),
        'o' | 'i' | 'u' | 'O' => ("elapsed", "Elapsed", FieldKind::Text),
        'v' => ("message", "Message", FieldKind::Message),
        _ => return None,
    })
}

fn tokenize(pattern: &str, out: &mut Vec<Item>, depth: u8) -> Result<(), String> {
    let mut chars = pattern.chars().peekable();
    while let Some(c) = chars.next() {
        if c != '%' {
            out.push(Item::Lit(c));
            continue;
        }
        // %[-|=][width][!]flag
        let mut padded = false;
        if matches!(chars.peek(), Some('-') | Some('=')) {
            chars.next();
        }
        while matches!(chars.peek(), Some(d) if d.is_ascii_digit()) {
            chars.next();
            padded = true;
        }
        if chars.peek() == Some(&'!') {
            chars.next();
        }
        let Some(f) = chars.next() else {
            return Err("The pattern ends with a lone %".into());
        };
        match f {
            '%' => out.push(Item::Lit('%')),
            '^' | '$' => {}
            '{' => {
                let name: String = chars.by_ref().take_while(|&c| c != '}').collect();
                let name = name.trim().to_string();
                if name.is_empty() || !name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '-') {
                    return Err(format!("Invalid field name %{{{name}}}: use letters, digits, _ or -"));
                }
                out.push(Item::Named { name, padded });
            }
            f => {
                if let Some(exp) = expansion(f) {
                    if depth > 2 {
                        return Err("Pattern nested too deeply".into());
                    }
                    tokenize(exp, out, depth + 1)?;
                } else if is_time_flag(f) || field_flag(f).is_some() {
                    out.push(Item::Flag { c: f, padded });
                } else {
                    return Err(format!("Unknown flag %{f}"));
                }
            }
        }
    }
    Ok(())
}

fn named_field(name: &str) -> (String, String, FieldKind) {
    let id = name.to_lowercase();
    let kind = match id.as_str() {
        "time" | "timestamp" | "datetime" => FieldKind::Time,
        "level" | "severity" => FieldKind::Level,
        "message" | "msg" => FieldKind::Message,
        _ => FieldKind::Text,
    };
    let id = match kind {
        FieldKind::Time => "time".to_string(),
        FieldKind::Level => "level".to_string(),
        FieldKind::Message => "message".to_string(),
        FieldKind::Text => id,
    };
    let mut label: String = id.replace(['_', '-'], " ");
    if let Some(f) = label.get(0..1) {
        label = f.to_uppercase() + &label[1..];
    }
    (id, label, kind)
}

impl LogFormat {
    /// Compile an spdlog-style pattern.
    pub fn compile(pattern: &str) -> Result<Self, String> {
        let mut items = Vec::new();
        tokenize(pattern, &mut items, 0)?;

        let mut fmt = LogFormat {
            pattern: pattern.to_string(),
            tokens: Vec::new(),
            fields: Vec::new(),
            time: None,
            level: None,
            message: None,
            time_free: false,
            time_token: None,
        };
        let mut lit = String::new();
        let mut i = 0;
        while i < items.len() {
            match &items[i] {
                Item::Lit(c) => {
                    lit.push(*c);
                    i += 1;
                }
                Item::Flag { c, .. } if is_time_flag(*c) => {
                    fmt.flush_lit(&mut lit);
                    let mut parts = vec![time_part(*c)];
                    i += 1;
                    // continue while more time flags follow, possibly after literal text
                    loop {
                        let mut j = i;
                        while matches!(items.get(j), Some(Item::Lit(_))) {
                            j += 1;
                        }
                        match items.get(j) {
                            Some(Item::Flag { c, .. }) if is_time_flag(*c) => {
                                for it in &items[i..j] {
                                    if let Item::Lit(l) = it {
                                        parts.push(TimePart::Lit(*l));
                                    }
                                }
                                parts.push(time_part(*c));
                                i = j + 1;
                            }
                            _ => break,
                        }
                    }
                    let field = fmt.add_field("time", "Time", FieldKind::Time);
                    let shape = Shape::new(&parts);
                    fmt.tokens.push(Token::Time { field, parts, shape });
                }
                Item::Flag { c, padded } => {
                    fmt.flush_lit(&mut lit);
                    let (name, label, kind) = field_flag(*c).expect("checked when tokenizing");
                    let field = fmt.add_field(name, label, kind);
                    fmt.tokens.push(Token::Field { field, padded: *padded, end: End::Eol, message: false });
                    i += 1;
                }
                Item::Named { name, padded } => {
                    fmt.flush_lit(&mut lit);
                    let (name, label, kind) = named_field(name);
                    let field = fmt.add_field(&name, &label, kind);
                    fmt.tokens.push(Token::Field { field, padded: *padded, end: End::Eol, message: false });
                    i += 1;
                }
            }
        }
        fmt.flush_lit(&mut lit);
        // `] %v`: the message loses its leading whitespace anyway, so the space before it
        // is optional (`\s*` in the original regex)
        let n = fmt.tokens.len();
        if n >= 2 && matches!(fmt.tokens[n - 1], Token::Field { field: Some(f), .. } if Some(f) == fmt.message) {
            if let Token::Lit(s) = &mut fmt.tokens[n - 2] {
                let kept = s.trim_end_matches(' ').len();
                s.truncate(kept);
                if s.is_empty() {
                    fmt.tokens.remove(n - 2);
                }
            }
        }
        fmt.time_token = fmt.time.and_then(|t| {
            fmt.tokens.iter().position(|tok| match tok {
                Token::Field { field, .. } | Token::Time { field, .. } => *field == Some(t),
                Token::Lit(_) => false,
            })
        });
        for i in 0..fmt.tokens.len() {
            let next_end = match fmt.tokens.get(i + 1) {
                None => End::Eol,
                Some(Token::Lit(s)) => match s.chars().next().expect("literals are not empty") {
                    ' ' => End::Space,
                    c if c.is_ascii() => End::Byte(c as u8),
                    c => End::Char(c),
                },
                Some(_) => End::SpaceOrEol,
            };
            let msg = fmt.message;
            if let Token::Field { field, end, message, .. } = &mut fmt.tokens[i] {
                *end = next_end;
                *message = field.is_some() && *field == msg;
            }
        }
        fmt.time_free = fmt.time_token.is_some_and(|i| matches!(fmt.tokens[i], Token::Field { .. }));
        if fmt.fields.is_empty() {
            return Err("The pattern has no fields; use %v for the message".into());
        }
        Ok(fmt)
    }

    fn flush_lit(&mut self, lit: &mut String) {
        if !lit.is_empty() {
            self.tokens.push(Token::Lit(std::mem::take(lit)));
        }
    }

    fn add_field(&mut self, name: &str, label: &str, kind: FieldKind) -> Option<usize> {
        if self.fields.iter().any(|f| f.name == name) || self.fields.len() >= MAX_FIELDS {
            return None;
        }
        let i = self.fields.len();
        let filterable = kind == FieldKind::Text && name != "elapsed" && name != "line";
        self.fields.push(FieldDef { name: name.into(), label: label.into(), kind, filterable });
        match kind {
            FieldKind::Time => self.time = Some(i),
            FieldKind::Level => self.level = Some(i),
            FieldKind::Message => self.message = Some(i),
            FieldKind::Text => {}
        }
        Some(i)
    }

    pub fn pattern(&self) -> &str {
        &self.pattern
    }

    pub fn fields(&self) -> &[FieldDef] {
        &self.fields
    }

    pub fn field_index(&self, name: &str) -> Option<usize> {
        self.fields.iter().position(|f| f.name == name)
    }

    pub fn level_field(&self) -> Option<usize> {
        self.level
    }

    pub fn message_field(&self) -> Option<usize> {
        self.message
    }

    pub fn time_field(&self) -> Option<usize> {
        self.time
    }

    /// The format matches every line (the raw fallback, `%v`).
    pub fn is_raw(&self) -> bool {
        matches!(self.tokens.as_slice(), [Token::Field { field: Some(f), .. }] if Some(*f) == self.message)
    }

    /// Characters that always surround a field's value in a line, e.g. `[` and `]` for
    /// `[%l]`, so a filter can pre-check lines for `[ERROR]` instead of `ERROR`.
    pub fn affixes(&self, field: usize) -> (Option<char>, Option<char>) {
        let Some(pos) = self.tokens.iter().position(
            |t| matches!(t, Token::Field { field: Some(f), padded: false, .. } if *f == field),
        ) else {
            return (None, None);
        };
        let lit_char = |t: Option<&Token>, last: bool| match t {
            Some(Token::Lit(s)) => {
                let c = if last { s.chars().last() } else { s.chars().next() };
                c.filter(|c| !c.is_whitespace())
            }
            _ => None,
        };
        let before = if pos == 0 { None } else { lit_char(self.tokens.get(pos - 1), true) };
        let after = lit_char(self.tokens.get(pos + 1), false);
        // the value ends at the first `after`, so `after` itself can't occur inside it;
        // `before` is only safe together with that
        if after.is_none() {
            return (None, None);
        }
        (before, after)
    }

    /// Split a line into its fields, or `None` if it does not have this format.
    pub fn parse(&self, line: &str) -> Option<Parsed> {
        let b = line.as_bytes();
        // lines never contain '\n' (kept from the original regex, where `.` stops there)
        if memchr::memchr(b'\n', b).is_some() {
            return None;
        }
        self.parse_tokens(line, self.tokens.len())
    }

    /// Like [`parse`](Self::parse), but only the first `upto` tokens: the line is not
    /// checked beyond them and later fields are not set.
    #[inline]
    fn parse_tokens(&self, line: &str, upto: usize) -> Option<Parsed> {
        if line.len() > u32::MAX as usize {
            return None;
        }
        let b = line.as_bytes();
        let mut out = Parsed { spans: [(0, 0); MAX_FIELDS] };
        let mut pos = 0usize;
        for tok in &self.tokens[..upto] {
            match tok {
                Token::Lit(s) => pos = match_lit(line, pos, s)?,
                Token::Time { field, parts, shape } => {
                    let end = match shape {
                        Some(sh) if sh.matches(b, pos) => pos + sh.len(),
                        _ => match_time(line, pos, parts)?.0,
                    };
                    if let Some(f) = field {
                        out.spans[*f] = (pos as u32, end as u32);
                    }
                    pos = end;
                }
                Token::Field { field, padded, end, message } => {
                    let mut start = pos;
                    if *padded {
                        start += line[start..].len() - line[start..].trim_start_matches(' ').len();
                    }
                    let first_space = || {
                        b[start..]
                            .iter()
                            .position(|&c| c >= 0x80 || matches!(c, b' ' | 0x09..=0x0d))
                            .and_then(|p| match b[start + p] {
                                c if c < 0x80 => Some(start + p),
                                // non-ASCII: fall back to char::is_whitespace from here
                                _ => line[start + p..].find(char::is_whitespace).map(|q| start + p + q),
                            })
                    };
                    let stop = match *end {
                        End::Eol => line.len(),
                        End::Byte(c) => start + memchr::memchr(c, &b[start..])?,
                        End::Char(c) => start + line[start..].find(c)?,
                        End::Space => first_space()?,
                        End::SpaceOrEol => first_space().unwrap_or(line.len()),
                    };
                    let mut next_pos = stop;
                    if *padded && *end == End::Space {
                        // the literal space takes the last of the padding
                        for (p, ch) in line[stop..].char_indices() {
                            if !ch.is_whitespace() {
                                break;
                            }
                            next_pos = stop + p;
                        }
                    }
                    let (mut vs, mut ve) = (start, stop);
                    if *message && *end == End::Eol {
                        vs = stop - line[start..stop].trim_start_matches(char::is_whitespace).len();
                    }
                    if *padded {
                        ve = vs + line[vs..ve].trim_end_matches(' ').len();
                    }
                    if ve == vs && !*message {
                        return None;
                    }
                    if let Some(f) = field {
                        out.spans[*f] = (vs as u32, ve as u32);
                    }
                    pos = next_pos;
                }
            }
        }
        Some(out)
    }

    /// Timestamp of a parsed line, as ns since 1970 in the log's own clock.
    pub fn time_ns(&self, line: &str, parsed: &Parsed) -> Option<i64> {
        self.value_time_ns(parsed.get(line, self.time?))
    }

    /// The time of a value of the time field, as ns since 1970 in the log's own clock.
    pub fn value_time_ns(&self, value: &str) -> Option<i64> {
        match &self.tokens[self.time_token?] {
            Token::Time { shape: Some(sh), .. } if sh.len() == value.len() => sh.time(value.as_bytes()),
            Token::Time { parts, .. } => match_time(value, 0, parts)?.1,
            _ => parse_timestamp(value),
        }
    }

    /// Timestamp of a line already known to have the format (e.g. from its level code),
    /// reading it only up to the time.
    pub fn time_of(&self, bytes: &[u8]) -> Option<i64> {
        let t = self.time_token?;
        let line = match std::str::from_utf8(bytes) {
            Ok(s) => std::borrow::Cow::Borrowed(s),
            Err(_) => String::from_utf8_lossy(bytes),
        };
        let p = self.parse_tokens(&line, t + 1)?;
        self.time_ns(&line, &p)
    }

    /// Severity code of a line ([`code::NONE`] when it does not have the format).
    pub fn level_code(&self, line: &str) -> u8 {
        match self.parse(line) {
            None => code::NONE,
            Some(p) => match self.level {
                Some(l) => level_code(p.get(line, l)),
                None => code::OTHER,
            },
        }
    }

    /// Severity code and timestamp of a raw line, decoding it as needed.
    pub fn code_and_time(&self, bytes: &[u8]) -> (u8, Option<i64>) {
        let line = match std::str::from_utf8(bytes) {
            Ok(s) => std::borrow::Cow::Borrowed(s),
            Err(_) => String::from_utf8_lossy(bytes),
        };
        match self.parse(&line) {
            None => (code::NONE, None),
            Some(p) => {
                let c = self.level.map_or(code::OTHER, |l| level_code(p.get(&line, l)));
                (c, self.time_ns(&line, &p))
            }
        }
    }
}

/// Match literal `s` at `pos`; a space matches one whitespace character.
#[inline]
fn match_lit(line: &str, pos: usize, s: &str) -> Option<usize> {
    let b = line.as_bytes();
    let mut p = pos;
    for &want in s.as_bytes() {
        let got = *b.get(p)?;
        if want == b' ' {
            p += whitespace_len(line, p)?;
        } else if got == want {
            // byte-wise is exact: UTF-8 has no character that is a prefix of another
            p += 1;
        } else {
            return None;
        }
    }
    Some(p)
}

/// Length of the whitespace character at `p` (`char::is_whitespace`), if there is one.
#[inline]
fn whitespace_len(line: &str, p: usize) -> Option<usize> {
    let got = *line.as_bytes().get(p)?;
    if got.is_ascii() {
        matches!(got, b' ' | 0x09..=0x0d).then_some(1)
    } else {
        let ch = line.get(p..)?.chars().next()?;
        ch.is_whitespace().then(|| ch.len_utf8())
    }
}

const MONTHS: [&str; 12] = [
    "january", "february", "march", "april", "may", "june", "july", "august", "september", "october",
    "november", "december",
];
const WEEKDAYS: [&str; 7] = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

/// A run of fixed-width time parts, e.g. `%Y-%m-%d %H:%M:%S.%e`: every position is a
/// digit or a known byte, so a line is checked with one branch-free loop, and the time
/// is read from fixed offsets.
#[derive(Clone, Debug)]
struct Shape {
    /// Allowed bytes at each position: `lo[i] ..= lo[i] + span[i]`
    lo: Box<[u8]>,
    span: Box<[u8]>,
    /// `(part, offset)` of the numeric parts
    numbers: Vec<(TimePart, usize)>,
}

impl Shape {
    fn new(parts: &[TimePart]) -> Option<Self> {
        let (mut lo, mut span, mut numbers) = (Vec::new(), Vec::new(), Vec::new());
        for part in parts {
            let width = match *part {
                // a space matches any whitespace; the shape takes ' ' only, others fall back
                TimePart::Lit(c) if c.is_ascii() => {
                    lo.push(c as u8);
                    span.push(0);
                    continue;
                }
                TimePart::Year4 => 4,
                TimePart::Year2 | TimePart::Month | TimePart::Day | TimePart::Hour24 | TimePart::Hour12 => 2,
                TimePart::Minute | TimePart::Second => 2,
                TimePart::Frac(n) => n as usize,
                _ => return None,
            };
            numbers.push((*part, lo.len()));
            lo.extend(std::iter::repeat(b'0').take(width));
            span.extend(std::iter::repeat(9).take(width));
        }
        Some(Self { lo: lo.into(), span: span.into(), numbers })
    }

    fn len(&self) -> usize {
        self.lo.len()
    }

    #[inline]
    fn matches(&self, b: &[u8], pos: usize) -> bool {
        let Some(s) = b.get(pos..pos + self.lo.len()) else {
            return false;
        };
        let mut bad = false;
        for i in 0..s.len() {
            bad |= s[i].wrapping_sub(self.lo[i]) > self.span[i];
        }
        !bad
    }

    /// The time of a value that matches the shape.
    fn time(&self, v: &[u8]) -> Option<i64> {
        let num = |at: usize, n: usize| v[at..at + n].iter().fold(0i64, |a, &c| a * 10 + (c - b'0') as i64);
        let (mut y, mut mo, mut d, mut h, mut mi, mut s, mut ns) = (1970i64, 1i64, 1i64, 0i64, 0i64, 0i64, 0i64);
        let mut clock = false;
        for &(part, at) in &self.numbers {
            match part {
                TimePart::Year4 => y = num(at, 4),
                TimePart::Year2 => y = 2000 + num(at, 2),
                TimePart::Month => mo = num(at, 2),
                TimePart::Day => d = num(at, 2),
                TimePart::Hour24 => {
                    h = num(at, 2);
                    clock = true;
                }
                // no %p in a shape: a 12-hour clock without AM/PM is read as is
                TimePart::Hour12 => {
                    h = num(at, 2);
                    clock = true;
                }
                TimePart::Minute => mi = num(at, 2),
                TimePart::Second => s = num(at, 2),
                TimePart::Frac(n) => ns = num(at, n as usize) * 10i64.pow(9 - n as u32),
                _ => {}
            }
        }
        if !clock || !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
            return None;
        }
        Some((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s) * 1_000_000_000 + ns)
    }
}

/// Match a run of time flags at `pos`. Returns the end and the time, if the parts
/// include at least a time of day or an epoch.
fn match_time(line: &str, pos: usize, parts: &[TimePart]) -> Option<(usize, Option<i64>)> {
    let b = line.as_bytes();
    let mut p = pos;
    let digits = |p: &mut usize, n: usize| -> Option<i64> {
        let s = b.get(*p..*p + n)?;
        let mut v = 0i64;
        for &c in s {
            if !c.is_ascii_digit() {
                return None;
            }
            v = v * 10 + (c - b'0') as i64;
        }
        *p += n;
        Some(v)
    };
    let letters = |p: &mut usize| -> &str {
        let n = b[*p..].iter().take_while(|c| c.is_ascii_alphabetic()).count();
        let s = &line[*p..*p + n];
        *p += n;
        s
    };
    let (mut y, mut mo, mut d, mut h, mut mi, mut s, mut ns) = (1970i64, 1i64, 1i64, 0i64, 0i64, 0i64, 0i64);
    let mut pm: Option<bool> = None;
    let mut epoch: Option<i64> = None;
    let mut has_clock = false;
    for part in parts {
        match *part {
            TimePart::Lit(c) => {
                if c == ' ' {
                    p += whitespace_len(line, p)?;
                } else if c.is_ascii() {
                    if b.get(p) != Some(&(c as u8)) {
                        return None;
                    }
                    p += 1;
                } else {
                    let mut buf = [0u8; 4];
                    p = match_lit(line, p, c.encode_utf8(&mut buf))?;
                }
            }
            TimePart::Year4 => y = digits(&mut p, 4)?,
            TimePart::Year2 => y = 2000 + digits(&mut p, 2)?,
            TimePart::Month => mo = digits(&mut p, 2)?,
            TimePart::MonthAbbr => {
                let w = b.get(p..p + 3)?;
                mo = 1 + MONTHS.iter().position(|m| m.as_bytes()[..3].eq_ignore_ascii_case(w))? as i64;
                p += 3;
            }
            TimePart::MonthName => {
                let w = letters(&mut p);
                mo = 1 + MONTHS.iter().position(|m| m.eq_ignore_ascii_case(w))? as i64;
            }
            TimePart::Day => d = digits(&mut p, 2)?,
            TimePart::Hour24 | TimePart::Hour12 => {
                h = digits(&mut p, 2)?;
                has_clock = true;
            }
            TimePart::Minute => mi = digits(&mut p, 2)?,
            TimePart::Second => s = digits(&mut p, 2)?,
            TimePart::Frac(n) => {
                let v = digits(&mut p, n as usize)?;
                ns = v * 10i64.pow(9 - n as u32);
            }
            TimePart::AmPm => {
                let w = b.get(p..p + 2)?;
                pm = Some(if w.eq_ignore_ascii_case(b"PM") {
                    true
                } else if w.eq_ignore_ascii_case(b"AM") {
                    false
                } else {
                    return None;
                });
                p += 2;
            }
            TimePart::WeekdayAbbr => {
                let w = b.get(p..p + 3)?;
                WEEKDAYS.iter().position(|d| d.as_bytes()[..3].eq_ignore_ascii_case(w))?;
                p += 3;
            }
            TimePart::WeekdayName => {
                let w = letters(&mut p);
                WEEKDAYS.iter().position(|d| d.eq_ignore_ascii_case(w))?;
            }
            TimePart::TzOffset => {
                // +hh:mm, -hh:mm or Z; the log's own clock is kept, the zone is ignored
                if b.get(p) == Some(&b'Z') {
                    p += 1;
                } else {
                    if !matches!(b.get(p), Some(b'+') | Some(b'-')) {
                        return None;
                    }
                    p += 1;
                    digits(&mut p, 2)?;
                    if b.get(p) == Some(&b':') {
                        p += 1;
                    }
                    digits(&mut p, 2)?;
                }
            }
            TimePart::Epoch => {
                let n = b[p..].iter().take_while(|c| c.is_ascii_digit()).count();
                if n == 0 || n > 12 {
                    return None;
                }
                epoch = Some(digits(&mut p, n)?);
            }
        }
    }
    // out-of-range values still match (as the fast shape check does), with no time
    if let Some(pm) = pm {
        if !(1..=12).contains(&h) {
            return Some((p, None));
        }
        h = h % 12 + if pm { 12 } else { 0 };
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 23 || mi > 59 || s > 60 {
        return Some((p, None));
    }
    let ts = if let Some(e) = epoch {
        Some(e * 1_000_000_000 + ns)
    } else if has_clock {
        Some((days_from_civil(y, mo, d) * 86_400 + h * 3600 + mi * 60 + s) * 1_000_000_000 + ns)
    } else {
        None
    };
    Some((p, ts))
}

// ------------------------------------------------------------------ detection

/// Lines looked at to detect the format.
pub const SAMPLE_LINES: usize = 500;

/// A format chosen for a file, and how well it fits the sample.
#[derive(Clone, Debug)]
pub struct Detection {
    pub format: LogFormat,
    /// Non-empty sample lines
    pub sample_lines: usize,
    /// Of those, the lines in the format
    pub matched_lines: usize,
}

/// Time layouts tried at the start of a line, most specific first (an earlier one wins
/// a tie, so `%F` beats `%e` on 9-digit fractions).
const TIME_LAYOUTS: &[&str] = &[
    "%Y-%m-%d %H:%M:%S.%F",
    "%Y-%m-%d %H:%M:%S.%f",
    "%Y-%m-%d %H:%M:%S.%e",
    "%Y-%m-%d %H:%M:%S,%e",
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S.%F%z",
    "%Y-%m-%dT%H:%M:%S.%f%z",
    "%Y-%m-%dT%H:%M:%S.%e%z",
    "%Y-%m-%dT%H:%M:%S%z",
    "%Y-%m-%dT%H:%M:%S.%F",
    "%Y-%m-%dT%H:%M:%S.%f",
    "%Y-%m-%dT%H:%M:%S.%e",
    "%Y-%m-%dT%H:%M:%S",
    "%Y/%m/%d %H:%M:%S.%e",
    "%Y/%m/%d %H:%M:%S",
    "%d.%m.%Y %H:%M:%S.%e",
    "%d.%m.%Y %H:%M:%S",
    "%m/%d/%y %H:%M:%S.%e",
    "%m/%d/%y %H:%M:%S",
    "%a %b %d %H:%M:%S %Y",
    "%H:%M:%S.%F",
    "%H:%M:%S.%f",
    "%H:%M:%S.%e",
    "%H:%M:%S",
];

/// Score of one candidate over the sample: lines in the format count most; a parseable
/// time, a known level name and a numeric thread id decide between formats that split
/// the same lines differently (e.g. `[%l] [%n]` versus `[%n] [%l]`).
fn score(fmt: &LogFormat, lines: &[&str]) -> (f64, usize) {
    let thread = fmt.field_index("thread");
    let mut points = 0f64;
    let mut matched = 0usize;
    for line in lines {
        let Some(p) = fmt.parse(line) else { continue };
        matched += 1;
        points += 4.0;
        if fmt.time.is_some() && fmt.time_ns(line, &p).is_some() {
            points += 1.0;
        }
        if let Some(l) = fmt.level {
            if level_code(p.get(line, l)) > code::OTHER {
                points += 2.0;
            }
        }
        if let Some(t) = thread {
            if looks_like_thread(p.get(line, t)) {
                points += 0.5;
            }
        }
        // a message that still starts with a bracket probably has a field we missed
        if let Some(m) = fmt.message {
            if !p.get(line, m).starts_with('[') {
                points += 0.25;
            }
        }
    }
    // more fields win a tie
    points += fmt.fields.len() as f64 * 0.001 * lines.len() as f64;
    (points, matched)
}

/// A thread id (`4711`, `0x1f3c`) or a typical thread name (`main`, `io-worker-1`,
/// `pool-2-thread-1`), to tell `[%t]` from `[%n]` (logger names rarely end in a number).
fn looks_like_thread(v: &str) -> bool {
    let b = v.as_bytes();
    if !b.is_empty() && b.iter().all(u8::is_ascii_digit) || v.starts_with("0x") || v.eq_ignore_ascii_case("main") {
        return true;
    }
    let digits = b.iter().rev().take_while(|c| c.is_ascii_digit()).count();
    digits > 0 && digits < b.len() && matches!(b[b.len() - digits - 1], b'-' | b'_' | b'#' | b' ')
}

/// The time layout (from [`TIME_LAYOUTS`]) that the most sample lines start with,
/// directly or after a `[`, and whether it is bracketed.
fn detect_time_layout(lines: &[&str]) -> Option<(&'static str, bool)> {
    let mut best: Option<(&'static str, bool, usize)> = None;
    for layout in TIME_LAYOUTS {
        for bracketed in [true, false] {
            let pat = if bracketed { format!("[{layout}]%v") } else { format!("{layout} %v") };
            let Ok(fmt) = LogFormat::compile(&pat) else { continue };
            let n = lines.iter().filter(|l| fmt.parse(l).is_some()).count();
            if n > 0 && best.map_or(true, |b| n > b.2) {
                best = Some((layout, bracketed, n));
            }
        }
    }
    best.map(|b| (b.0, b.1))
}

/// The candidate patterns for a sample.
fn candidates(lines: &[&str]) -> Vec<String> {
    // the fields after the time: level, logger name and thread in any order
    let roles = ["%l", "%n", "%t"];
    let mut seqs: Vec<Vec<&str>> = vec![vec![]];
    for a in roles {
        seqs.push(vec![a]);
        for b in roles.iter().filter(|&&b| b != a) {
            seqs.push(vec![a, b]);
            for c in roles.iter().filter(|&&c| c != a && c != *b) {
                seqs.push(vec![a, b, c]);
            }
        }
    }
    let bracketed = |seq: &[&str]| seq.iter().map(|r| format!("[{r}] ")).collect::<String>();

    let mut times: Vec<String> = Vec::new();
    if let Some((layout, br)) = detect_time_layout(lines) {
        times.push(if br { format!("[{layout}] ") } else { format!("{layout} ") });
    }
    times.push("[%{time}] ".into());

    let mut out = Vec::new();
    for t in &times {
        for seq in &seqs {
            if seq.is_empty() {
                continue;
            }
            out.push(format!("{t}{}%v", bracketed(seq)));
        }
        // an unbracketed (often padded) level after the time: `... INFO  [main] msg`
        if !t.starts_with("[%{") {
            for seq in &seqs {
                if !seq.contains(&"%l") {
                    out.push(format!("{t}%-5l {}%v", bracketed(seq)));
                    out.push(format!("{t}{}%-5l %v", bracketed(seq)));
                }
            }
        }
    }
    // the original format of this app, exactly
    out.push(LEGACY_PATTERN.into());
    out.dedup();
    out
}

/// Pick the format that fits the sample lines best. Falls back to [`RAW_PATTERN`] when
/// no candidate matches at least a tenth of them.
pub fn detect(sample: &[&str]) -> Detection {
    let lines: Vec<&str> = sample.iter().copied().filter(|l| !l.trim().is_empty()).collect();
    let mut best: Option<(LogFormat, f64, usize)> = None;
    for pat in candidates(&lines) {
        let Ok(fmt) = LogFormat::compile(&pat) else { continue };
        let (points, matched) = score(&fmt, &lines);
        if matched > 0 && best.as_ref().map_or(true, |b| points > b.1) {
            best = Some((fmt, points, matched));
        }
    }
    match best {
        Some((format, _, matched)) if matched * 10 >= lines.len() => {
            Detection { format, sample_lines: lines.len(), matched_lines: matched }
        }
        _ => {
            let format = LogFormat::compile(RAW_PATTERN).expect("valid");
            Detection { format, sample_lines: lines.len(), matched_lines: lines.len() }
        }
    }
}

/// How many of the sample lines a format matches (non-empty lines only).
pub fn sample_fit(fmt: &LogFormat, sample: &[&str]) -> (usize, usize) {
    let lines: Vec<&str> = sample.iter().copied().filter(|l| !l.trim().is_empty()).collect();
    let matched = lines.iter().filter(|l| fmt.parse(l).is_some()).count();
    (lines.len(), matched)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parsing::parser::split_regex;

    fn fields<'a>(fmt: &LogFormat, line: &'a str) -> Option<Vec<(&'a str, String)>> {
        let p = fmt.parse(line)?;
        Some((0..fmt.fields().len()).map(|i| (p.get(line, i), fmt.fields()[i].name.clone())).collect())
    }

    fn values<'a>(fmt: &LogFormat, line: &'a str) -> Option<Vec<&'a str>> {
        fields(fmt, line).map(|v| v.into_iter().map(|x| x.0).collect())
    }

    #[test]
    fn legacy_format_agrees_with_the_original_regex() {
        let fmt = LogFormat::compile(LEGACY_PATTERN).unwrap();
        let names: Vec<&str> = fmt.fields().iter().map(|f| f.name.as_str()).collect();
        assert_eq!(names, ["time", "level", "domain", "message"]);
        let cases = [
            "[2025-01-01 10:00:00] [INFO] [core] Starting process",
            "[t] [ERROR] [Net] x",
            "[t] [ERROR] [Net]x",
            "[t] [ERROR] [Net]    lots of space",
            "[t] [ERROR] [Net]\t\ttabbed",
            "[t] [ERROR] [Net]",
            "[t] [ERROR] [Net] ",
            "[t]  [ERROR] [Net] two spaces before level",
            "[t][ERROR] [Net] no space",
            "[t]\t[ERROR]\u{a0}[Net]\u{2003}unicode spaces",
            "[t] [ERROR] [Net]\u{a0}\u{a0}nbsp before message",
            "[t] [ERROR] [Net] é first char non-ascii",
            "[] [ERROR] [Net] empty ts",
            "[t] [] [Net] empty level",
            "[t] [ERROR] [] empty domain",
            "[t] [ERROR] [Net] msg with ] and [ brackets",
            "[t] [ERROR] [Net] carriage\rreturn inside",
            "[t] [ERROR] [Net] new\nline inside",
            "[[t]] [ERROR] [Net] nested",
            "[t [ERROR] [Net] unclosed",
            "  [t] [ERROR] [Net] leading space",
            "not a log line",
            "",
            "[",
            "[t]",
            "[t] ",
            "[t] [L]",
            "[t] [L] ",
            "[t] [L] [",
            "[t] [L] [d",
            "[t] [L] [d]",
            "[t]\u{85}[L]\u{85}[d]\u{85}next-line char",
            "[t]\u{b}[L]\u{c}[d]\u{b}vertical tab",
            "[ts with spaces] [WARN] [dom ain] m",
        ];
        for c in cases {
            let want = split_regex(c).map(|f| vec![f.ts, f.level, f.domain, f.message]);
            assert_eq!(values(&fmt, c), want, "{c:?}");
        }
    }

    #[test]
    fn spdlog_patterns() {
        let fmt = LogFormat::compile("[%Y-%m-%d %H:%M:%S.%e] [%t] [%l] %v").unwrap();
        let line = "[2026-11-20 09:39:45.123] [12345] [info] Started worker";
        assert_eq!(values(&fmt, line).unwrap(), ["2026-11-20 09:39:45.123", "12345", "info", "Started worker"]);
        let p = fmt.parse(line).unwrap();
        let want = crate::logfile::timeline::parse_timestamp("2026-11-20 09:39:45.123").unwrap();
        assert_eq!(fmt.time_ns(line, &p), Some(want));
        // %e is exactly three digits
        assert!(fmt.parse("[2026-11-20 09:39:45.123456] [1] [info] x").is_none());

        // spdlog's default, via %+
        let fmt = LogFormat::compile("%+").unwrap();
        assert_eq!(
            values(&fmt, "[2026-11-20 09:39:45.123] [app] [warning] Low disk").unwrap(),
            ["2026-11-20 09:39:45.123", "app", "warning", "Low disk"]
        );

        // unbracketed, padded level, thread name as a custom field
        let fmt = LogFormat::compile("%Y-%m-%d %H:%M:%S.%f %-8l [%{thread}] %v").unwrap();
        assert_eq!(
            values(&fmt, "2026-11-20 09:39:45.123456 info     [main worker] Ready").unwrap(),
            ["2026-11-20 09:39:45.123456", "info", "main worker", "Ready"]
        );
        assert_eq!(
            values(&fmt, "2026-11-20 09:39:45.123456 critical [io] Disk gone").unwrap(),
            ["2026-11-20 09:39:45.123456", "critical", "io", "Disk gone"]
        );

        // 12-hour clock, month names, short level
        let fmt = LogFormat::compile("%b %d %r %L %v").unwrap();
        let line = "Nov 20 02:55:02 PM W careful";
        let p = fmt.parse(line).unwrap();
        assert_eq!(values(&fmt, line).unwrap(), ["Nov 20 02:55:02 PM", "W", "careful"]);
        assert_eq!(fmt.time_ns(line, &p), crate::logfile::timeline::parse_timestamp("1970-11-20 14:55:02"));
        assert_eq!(fmt.level_code(line), code::WARN);

        // epoch seconds
        let fmt = LogFormat::compile("%E.%e %v").unwrap();
        let line = "1700000000.250 hi";
        let p = fmt.parse(line).unwrap();
        assert_eq!(fmt.time_ns(line, &p), Some(1_700_000_000_250_000_000));
    }

    #[test]
    fn pattern_errors() {
        assert!(LogFormat::compile("%q %v").unwrap_err().contains("%q"));
        assert!(LogFormat::compile("[x] %").is_err());
        assert!(LogFormat::compile("no fields").is_err());
        assert!(LogFormat::compile("%{bad name} %v").is_err());
        // %^ %$ and %% are accepted
        let fmt = LogFormat::compile("[%^%l%$] 100%% %v").unwrap();
        assert_eq!(values(&fmt, "[info] 100% done").unwrap(), ["info", "done"]);
    }

    #[test]
    fn affixes_for_prechecks() {
        let fmt = LogFormat::compile(LEGACY_PATTERN).unwrap();
        assert_eq!(fmt.affixes(1), (Some('['), Some(']')));
        let fmt = LogFormat::compile("%-5l [%t] %v").unwrap();
        assert_eq!(fmt.affixes(0), (None, None)); // padded
        assert_eq!(fmt.affixes(1), (Some('['), Some(']')));
    }

    fn detect_lines(text: &str) -> Detection {
        let lines: Vec<&str> = text.lines().collect();
        detect(&lines)
    }

    #[test]
    fn detects_the_original_format() {
        let d = detect_lines(
            "[2026-11-19 08:00:00.293291] [INFO] [core] Heartbeat ok [block 1]\n\
             [2026-11-19 08:00:00.394789] [ERROR] [network] Request failed\n\
             \tat some.stack.Frame\n\
             [2026-11-19 08:00:00.514473] [DEBUG] [data_acq] Job finished",
        );
        assert_eq!(d.format.pattern(), "[%Y-%m-%d %H:%M:%S.%f] [%l] [%n] %v");
        assert_eq!((d.sample_lines, d.matched_lines), (4, 3));

        // free-form times still work, like before
        let d = detect_lines("[t1] [INFO] [core] a\n[t2] [WARN] [net] b");
        assert_eq!(d.format.pattern(), LEGACY_PATTERN);
    }

    #[test]
    fn detects_spdlog_layouts() {
        let d = detect_lines(
            "[2026-11-20 09:39:45.123] [myapp] [info] Started\n\
             [2026-11-20 09:39:45.124] [myapp] [warning] Low disk\n\
             [2026-11-20 09:39:45.125] [net] [error] Timeout",
        );
        assert_eq!(d.format.pattern(), "[%Y-%m-%d %H:%M:%S.%e] [%n] [%l] %v");

        let d = detect_lines(
            "2026-11-20 09:39:45.123 [4711] [info] Started\n\
             2026-11-20 09:39:45.124 [4712] [debug] Tick\n\
             2026-11-20 09:39:45.125 [4711] [error] Timeout",
        );
        assert_eq!(d.format.pattern(), "%Y-%m-%d %H:%M:%S.%e [%t] [%l] %v");

        let d = detect_lines(
            "[2026-11-20 09:39:45.123] [info] [core] [4711] Started\n\
             [2026-11-20 09:39:45.124] [debug] [net] [4712] Tick",
        );
        assert_eq!(d.format.pattern(), "[%Y-%m-%d %H:%M:%S.%e] [%l] [%n] [%t] %v");
    }

    #[test]
    fn detects_the_generated_test_files() {
        // create_spdlog_logfile.py, both styles
        let d = detect_lines(
            "[2026-11-20 08:00:00.008] [ui] [debug] [4714] Cache miss for key user:121\n\
             [2026-11-20 08:00:00.039] [ui] [warning] [4711] Timeout after 215 ms waiting for lock\n\
             [2026-11-20 08:00:00.041] [app] [critical] [9001] Retrying operation, attempt 623\n\
             \x20   at Worker::run (worker.cpp:212)",
        );
        assert_eq!(d.format.pattern(), "[%Y-%m-%d %H:%M:%S.%e] [%n] [%l] [%t] %v");
        let d = detect_lines(
            "2026-11-20 08:00:00.003756 debug    [scheduler] Request served in 370 ms\n\
             2026-11-20 08:00:00.014887 info     [io-worker-1] Cache miss for key user:621\n\
             2026-11-20 08:00:00.054704 critical [db-pool-1] Queue depth is 698",
        );
        assert_eq!(d.format.pattern(), "%Y-%m-%d %H:%M:%S.%f %-5l [%t] %v");
        let line = "2026-11-20 08:00:00.003756 debug    [scheduler] Request served in 370 ms";
        assert_eq!(values(&d.format, line).unwrap(), ["2026-11-20 08:00:00.003756", "debug", "scheduler", "Request served in 370 ms"]);
    }

    #[test]
    fn unknown_files_fall_back_to_raw_lines() {
        let d = detect_lines("hello\nworld\nthis is not a log");
        assert!(d.format.is_raw());
        assert_eq!(values(&d.format, "anything at all").unwrap(), ["anything at all"]);
    }
}

#[cfg(test)]
mod micro {
    use super::*;
    use std::time::Instant;

    fn old_split(line: &str) -> Option<[&str; 4]> {
        let b = line.as_bytes();
        if memchr::memchr(b'\n', b).is_some() {
            return None;
        }
        let mut pos = 0usize;
        let mut fields = [""; 3];
        for (i, field) in fields.iter_mut().enumerate() {
            if b.get(pos) != Some(&b'[') {
                return None;
            }
            let close = memchr::memchr(b']', &b[pos + 1..])?;
            if close == 0 {
                return None;
            }
            *field = &line[pos + 1..pos + 1 + close];
            pos += close + 2;
            if i < 2 {
                let c = line[pos..].chars().next().filter(|c| c.is_whitespace())?;
                pos += c.len_utf8();
            }
        }
        let message = line[pos..].trim_start_matches(char::is_whitespace);
        Some([fields[0], fields[1], fields[2], message])
    }

    #[test]
    #[ignore]
    fn micro_parse() {
        let lines: Vec<String> = (0..1000)
            .map(|i| format!("[2026-11-19 08:00:00.{:06}] [INFO] [core] Heartbeat ok number {i} [block 1 startup, one lone ERROR in the middle]", i * 997 % 1000000))
            .collect();
        let n = 10_000;
        let t = Instant::now();
        let mut k = 0usize;
        for _ in 0..n { for l in &lines { k += old_split(std::hint::black_box(l)).map_or(0, |f| f[1].len()); } }
        println!("old split: {:.1} ns/line ({k})", t.elapsed().as_nanos() as f64 / (n * lines.len()) as f64);
        for pat in [LEGACY_PATTERN, "[%Y-%m-%d %H:%M:%S.%f] [%l] [%n] %v", "%v"] {
            let f = LogFormat::compile(pat).unwrap();
            let t = Instant::now();
            let mut k = 0usize;
            for _ in 0..n { for l in &lines { k += f.parse(std::hint::black_box(l)).map_or(0, |p| p.get(l, 1.min(f.fields().len() - 1)).len()); } }
            println!("{pat}: {:.1} ns/line ({k})", t.elapsed().as_nanos() as f64 / (n * lines.len()) as f64);
        }
    }
}
