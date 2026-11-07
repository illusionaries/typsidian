#set page(paper: "a4", margin: 2.5cm, numbering: "1")
#set text(size: 10.5pt)
#set par(justify: true)

= Typst showcase

A grab bag of things the renderer handles, useful for poking at the editor.

== Headings and inline markup

*Bold*, _italic_, `raw code`, #underline[underline], #smallcaps[Small Caps],
#text(fill: rgb("#7c3aed"))[colored text], and a #link("https://typst.app")[link].

== Lists

+ First ordered item
+ Second ordered item
  - Nested bullet
  - Another nested bullet
+ Third ordered item

/ Term: A definition of the term.
/ Another term: And its definition.

== Mathematics

Inline: $sum_(k=1)^n k = (n(n+1))/2$.

Display:

$ e^(i pi) + 1 = 0 $

Aligned:

$ x &= 2y + 1 \
  3x &= 6y + 3 $

== Code

```
#let fib(n) = if n < 2 { n } else { fib(n - 1) + fib(n - 2) }
#range(10).map(fib).join(", ")
```

== Figures and boxes

#align(center)[
  #rect(width: 60%, inset: 14pt, stroke: 0.6pt + rgb("#c7c7cc"), radius: 6pt)[
    *A box.* Blocks can contain arbitrary layout, and still be clicked and
    edited as one unit in visual mode.
  ]
]

#figure(
  table(
    columns: 3,
    inset: 5pt,
    [*Name*], [*Value*], [*Unit*],
    [speed of light], [$299 792 458$], [m/s],
    [Planck constant], [$6.626 070 15 times 10^(-34)$], [J·s],
  ),
  caption: [Some physical constants.],
) <constants>

See @constants for a table rendered inside a figure.

== Long-form wrapping

#lorem(90)
