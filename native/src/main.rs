//! Typsidian native parser helper.
//!
//! Reads a Typst source document on stdin and writes JSON on stdout. Two modes
//! are supported (first CLI argument, default `blocks`):
//!
//! * `blocks` — split the markup into top-level, layout-safe blocks. Output:
//!   `{"ok":true,"blocks":[{"from":0,"to":12,"kind":"heading","level":1}, ...]}`
//!   Offsets are UTF-16 code unit indices, exactly like JavaScript string
//!   indices, so the TypeScript side can slice the source directly.
//! * `dump` — emit the top-level syntax tree (debugging only, unstable).
//!
//! The binary is deliberately dependency light (only `typst-syntax`, no
//! serde): JSON is emitted by hand because the only dynamic values are numbers
//! and a small fixed set of kind strings.

use std::io::Read;
use std::process::ExitCode;

use typst_syntax::ast;
use typst_syntax::{LinkedNode, Lines, SyntaxKind, SyntaxNode};

/// One block in UTF-16 code units after trimming.
#[derive(Debug, Clone, Copy)]
struct Block {
    from: usize,
    to: usize,
    kind: Kind,
    level: Option<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Heading,
    Paragraph,
    List,
    Quote,
    Code,
    Math,
    Table,
    Figure,
    Other,
}

impl Kind {
    fn as_str(self) -> &'static str {
        match self {
            Kind::Heading => "heading",
            Kind::Paragraph => "paragraph",
            Kind::List => "list",
            Kind::Quote => "quote",
            Kind::Code => "code",
            Kind::Math => "math",
            Kind::Table => "table",
            Kind::Figure => "figure",
            Kind::Other => "other",
        }
    }
}

fn main() -> ExitCode {
    let mode = std::env::args().nth(1).unwrap_or_else(|| "blocks".into());
    let mut source = String::new();
    if let Err(err) = std::io::stdin().read_to_string(&mut source) {
        eprintln!("typsidian-parser: cannot read stdin: {err}");
        return ExitCode::FAILURE;
    }

    match mode.as_str() {
        "blocks" => {
            let blocks = split_blocks(&source);
            print!("{{\"ok\":true,\"blocks\":[");
            for (index, block) in blocks.iter().enumerate() {
                if index > 0 {
                    print!(",");
                }
                print!(
                    "{{\"from\":{},\"to\":{},\"kind\":\"{}\"",
                    block.from,
                    block.to,
                    block.kind.as_str()
                );
                if let Some(level) = block.level {
                    print!(",\"level\":{level}");
                }
                print!("}}");
            }
            print!("]}}");
        }
        "dump" => {
            let root = typst_syntax::parse(&source);
            let root = LinkedNode::new(&root);
            for child in root.children() {
                let range = child.range();
                println!(
                    "{}..{} {:?} {:?}",
                    range.start,
                    range.end,
                    child.get().kind(),
                    child.get().leaf_text()
                );
            }
        }
        other => {
            eprintln!("typsidian-parser: unknown mode {other:?} (expected `blocks` or `dump`)");
            return ExitCode::FAILURE;
        }
    }
    ExitCode::SUCCESS
}

/// Split the source into top-level blocks that are safe to instrument with an
/// invisible marker line right in front of them.
///
/// Rules (deliberately conservative, mirroring the heuristic fallback):
/// * a heading, a block equation, a fenced raw block always start a new block;
/// * a paragraph break (blank line) starts a new block;
/// * consecutive list items of the same family stay in one `list` block;
/// * anything else extends the current block, so runs of `#set` / `#show` /
///   `#let` statements stay inside the paragraph that follows them and only one
///   marker line is inserted in front of the whole run;
/// * comments and `#` tokens are attached to the block that follows them.
fn split_blocks(source: &str) -> Vec<Block> {
    let parsed = typst_syntax::parse(source);
    let root = LinkedNode::new(&parsed);
    let lines = Lines::new(source.to_string());

    let mut blocks: Vec<Block> = Vec::new();
    let mut open: Option<Block> = None;
    let mut separated = true; // the start of the document acts like a blank line
    let mut last_content: Option<SyntaxKind> = None;
    let mut pending_comment: Option<usize> = None;
    let mut pending_attach: Option<usize> = None;

    for child in root.children() {
        let range = child.range();
        if range.start == range.end {
            continue;
        }
        let kind = child.get().kind();
        match kind {
            // Trivia never becomes a block; it only decides where the next one
            // starts (paragraph breaks) or which block owns it (comments).
            SyntaxKind::Space => continue,
            SyntaxKind::Parbreak => {
                separated = true;
                continue;
            }
            SyntaxKind::LineComment | SyntaxKind::BlockComment | SyntaxKind::Shebang => {
                if pending_comment.is_none() {
                    pending_comment = Some(range.start);
                }
                continue;
            }
            // The `#` token in front of a code expression is a separate leaf
            // at the top level; it belongs to the block of the expression.
            SyntaxKind::Hash => {
                if pending_attach.is_none() {
                    pending_attach = Some(range.start);
                }
                continue;
            }
            _ => {}
        }

        let reset = starts_new_block(child.get(), kind, &open, separated, last_content);
        if reset {
            if let Some(done) = open.take() {
                blocks.push(done);
            }
            let from = pending_comment
                .take()
                .into_iter()
                .chain(pending_attach.take())
                .fold(range.start, usize::min);
            open = Some(Block {
                from,
                to: range.end,
                kind: block_kind(child.get(), kind),
                level: heading_level(child.get(), kind),
            });
        } else if let Some(open) = open.as_mut() {
            open.to = range.end;
            // A statement / inline node extended the block past the trivia that
            // preceded it, so that trivia is now owned by this block.
            pending_comment = None;
            pending_attach = None;
        } else {
            open = Some(Block {
                from: range.start,
                to: range.end,
                kind: block_kind(child.get(), kind),
                level: heading_level(child.get(), kind),
            });
        }
        separated = false;
        last_content = Some(kind);
    }

    if let Some(done) = open.take() {
        blocks.push(done);
    }

    // Trivia with no content on either side: a document that only contains
    // comments still needs one addressable block (it renders as an empty page).
    let mut trailing = pending_comment;
    if blocks.is_empty() {
        if let Some(from) = trailing.take() {
            blocks.push(Block { from, to: source.len(), kind: Kind::Paragraph, level: None });
        }
    }
    // A trailing comment with no content after it stays with the last block.
    if let (Some(from), Some(last)) = (trailing, blocks.last_mut()) {
        let trimmed = trim(source, from, source.len());
        if trimmed.1 > trimmed.0 {
            last.to = last.to.max(trimmed.1);
        }
    }
    blocks
        .into_iter()
        .filter_map(|block| {
            let (from, to) = trim(source, block.from, block.to);
            if to <= from {
                return None;
            }
            Some(Block {
                from: lines.byte_to_utf16(from)?,
                to: lines.byte_to_utf16(to)?,
                kind: block.kind,
                level: block.level,
            })
        })
        .collect()
}

/// Whether a new block must start in front of `node`.
fn starts_new_block(
    node: &SyntaxNode,
    kind: SyntaxKind,
    open: &Option<Block>,
    separated: bool,
    last_content: Option<SyntaxKind>,
) -> bool {
    if separated {
        return true;
    }
    let Some(open) = open else {
        return true;
    };
    match kind {
        SyntaxKind::Heading => true,
        SyntaxKind::Equation => is_block_equation(node),
        SyntaxKind::Raw => is_block_raw(node),
        SyntaxKind::ListItem | SyntaxKind::EnumItem | SyntaxKind::TermItem => {
            // Consecutive items of the same family form one list block: a
            // marker line between list items must not split the list in two.
            !(open.kind == Kind::List && last_content == Some(kind))
        }
        // Any non-list content after a list starts a new block.
        _ => open.kind == Kind::List,
    }
}

fn block_kind(node: &SyntaxNode, kind: SyntaxKind) -> Kind {
    match kind {
        SyntaxKind::Heading => Kind::Heading,
        SyntaxKind::Equation => {
            if is_block_equation(node) {
                Kind::Math
            } else {
                Kind::Paragraph
            }
        }
        SyntaxKind::Raw => {
            if is_block_raw(node) {
                Kind::Code
            } else {
                Kind::Paragraph
            }
        }
        SyntaxKind::ListItem | SyntaxKind::EnumItem | SyntaxKind::TermItem => Kind::List,
        _ => classify_call(node).unwrap_or(Kind::Paragraph),
    }
}

/// Classify a bare top-level call like `#table(...)`, `#figure(...)`.
fn classify_call(node: &SyntaxNode) -> Option<Kind> {
    let ast::Expr::FuncCall(call) = node.cast::<ast::Expr>()? else {
        return None;
    };
    let name = match call.callee() {
        ast::Expr::Ident(ident) => ident.get().clone(),
        ast::Expr::FieldAccess(access) => access.field().get().clone(),
        _ => return None,
    };
    Some(match name.as_str() {
        "table" | "grid" => Kind::Table,
        "figure" | "image" => Kind::Figure,
        "quote" => Kind::Quote,
        "raw" => Kind::Code,
        "list" | "enum" | "terms" => Kind::List,
        "heading" => Kind::Heading,
        "rect" | "circle" | "ellipse" | "line" | "polygon" => Kind::Other,
        _ => return None,
    })
}

fn heading_level(node: &SyntaxNode, kind: SyntaxKind) -> Option<u8> {
    if kind != SyntaxKind::Heading {
        return None;
    }
    let heading = node.cast::<ast::Heading>()?;
    Some(heading.depth().get().min(6) as u8)
}

fn is_block_equation(node: &SyntaxNode) -> bool {
    node.cast::<ast::Equation>()
        .map(|equation| equation.block())
        .unwrap_or(false)
}

fn is_block_raw(node: &SyntaxNode) -> bool {
    node.cast::<ast::Raw>()
        .map(|raw| raw.block())
        .unwrap_or(false)
}

/// Trim surrounding whitespace from a byte range.
fn trim(source: &str, mut from: usize, mut to: usize) -> (usize, usize) {
    let bytes = source.as_bytes();
    while from < to && bytes[from].is_ascii_whitespace() {
        from += 1;
    }
    while to > from && bytes[to - 1].is_ascii_whitespace() {
        to -= 1;
    }
    (from, to)
}
