# Space switcher icon backgrounds

The bottom sidebar Space switcher paints each chip from that Space's own named color, palette override or custom tint, using the existing validated light/dark theme palette. It no longer borrows the active Space background for every icon. The emoji, fallback dot, icon-only circle size, name-visible pill layout, separate + control, activation and reordering are retained. The selected Space keeps a high-contrast inset ring (white in Dark appearance); keyboard focus has its existing outline.

Palette and appearance changes repaint existing chip nodes without replacing focused or dragged elements. Invalid tints use the normal grey fallback. No Space metadata or preference is written by painting. Color emoji retain their platform rendering; contrast guarantees apply to labels, monochrome fallback, backgrounds, focus and selection markers.

This presentation-only change does not modify the Little Arc header/chooser or its diagnosed caret focus-scroll race. That flicker repair remains a separate proposal.
