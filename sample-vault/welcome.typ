#set document(title: "Welcome to Typsidian", author: "you")
#set page(
  paper: "a4",
  margin: (x: 2.6cm, y: 2.4cm),
  numbering: "1",
)
#set text(font: ("New Computer Modern", "New Computer Modern Math"), size: 10.5pt)
#set par(justify: true, leading: 0.62em)
#set heading(numbering: "1.1")
#show heading.where(level: 1): it => block(above: 1.4em, below: 0.9em, {
  set text(size: 19pt, weight: 600)
  it
})
#show heading.where(level: 2): it => block(above: 1.1em, below: 0.5em, {
  set text(size: 13pt, weight: 600)
  it
})

#show link: set text(fill: rgb("#7c3aed"))

= Welcome to Typsidian

Typsidian is an Obsidian-like editor for *Typst*. It has three ways of working,
and you can switch between them with `⌘1`, `⌘2` and `⌘3`:

- *Split* — the markup on the left, the typeset page on the right.
- *Visual* — the page fills the screen; click any block to edit it in place.
- *Preview* — a clean, read-only view of the finished document.

Everything you see is real Typst output, compiled by Typst itself. Fonts are
your system's real fonts, so what you see here is what `typst compile` gives you.

== Try clicking around

In *visual* mode, click this paragraph. An inline editor opens over the block:
you are editing the very source that produced it, while the rest of the page
stays typeset. Press `Esc` when you are done.

In *split* mode, click anywhere in the preview to jump the text cursor to the
corresponding source block. Scroll either pane and the other follows.

== Typst, briefly

Inline math like $a^2 + b^2 = c^2$ works, and so do display equations:

$ integral_0^1 x^2 dif x = 1/3 $

Lists, tables, figures and code are all first class:

#table(
  columns: (auto, 1fr, auto),
  inset: 6pt,
  stroke: 0.5pt + rgb("#d4d4d8"),
  align: (left, left, right),
  table.header[*Feature*][*What it does*][*Shortcut*],
  [Split mode], [Source and preview side by side], [`⌘1`],
  [Visual mode], [Click a block to edit it], [`⌘2`],
  [Preview], [Read the typeset document], [`⌘3`],
  [Save], [Write the file to the vault], [`⌘S`],
  [Export PDF], [Download the compiled PDF], [`⌘P`],
)

```
#let diameter(circle) = 2 * circle.radius
#diameter((radius: 2))
```

== The universal document core

Typsidian does not hard-code Typst into its UI. Every language plugs into the
same small interface: it splits source into *blocks*, renders *pages*, reports
where every block landed on the page, and returns *diagnostics*. The UI only
knows about blocks, boxes and splices — which is why the same three modes can
drive Markdown, or any other markup language, later.

#quote(block: true, attribution: "the design goal")[
  Render a block, jump to its source, edit it in place — and the language
  stays an implementation detail.
]

== What next?

- Edit this text. It is a normal `.typ` file in `sample-vault/welcome.typ`.
- Open `showcase.typ` for more Typst features.
- Create a new note with the `+` button in the sidebar.
- Press `⌘P` to export the PDF.
