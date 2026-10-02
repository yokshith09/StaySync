# Design System: StaySync

## Visual theme

An editorial fashion catalogue: dark cypress ink over sun-warmed limestone, moss as the sole accent,
restrained motion, and asymmetric content rhythm. Density 5, variance 7, motion 4.

## Palette

- Limestone Canvas `#f4f0e8` — primary background
- Paper Surface `#fffdf8` — elevated content
- Cypress Ink `#17342c` — type and dark bands
- Clay Detail `#a65e43` — quiet metadata, not an interaction color
- Moss Accent `#627a48` — single actionable accent
- Fog Line `#d8d0c2` — structure
- Danger `#9d3a2f` — destructive actions and error states only

## Typography and components

- Display: `Arial Narrow`, `Helvetica Neue`, sans-serif; tight tracking, large but controlled.
- Body: `Helvetica Neue`, Arial, sans-serif; 1.55 line-height.
- Meta: monospace for SKUs, order references, prices-per-unit and operational labels.
- Inputs have labels above; buttons use Cypress or Moss, with a 1px tactile translate on press.
- Product and row surfaces use 1px outlines and hairline grid gaps rather than shadows.
- State is carried by outlined badges, colour-coded per status, never by colour alone — the status
  word is always present.

## Product imagery

Each piece is a flat illustrated plate (`public/img/<product-id>.svg`), drawn in the palette above on
a warm paper ground at 4:5. Garments are rendered as clean silhouettes with cypress line work and a
single accent fill — deliberately illustrative rather than photographic, so the catalogue reads as
one designed system and carries no external image dependency, licensing question or network cost.
A plate is referenced by product id; a missing file degrades to the empty frame rather than breaking
the card.

## Layout and responsive rules

Hero uses a two-column asymmetric grid. Checkout is a two-column layout with a sticky summary.
Content collapses to one column under 760px and the summary unsticks under 980px. All interactive
targets are at least 44px. No gradients, neon glows, overlapping content, emojis, generic serif, or
three equal feature cards.
