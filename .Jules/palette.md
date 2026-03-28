## 2026-03-28 - Found missing aria-labels on buttons
**Learning:** The sidebar.html and dynamically generated DOM elements have multiple icon-only buttons with `title` attributes, but missing `aria-label`s for proper screen reader accessibility. Also `aria-expanded` is missing for collapsible sections like folders and pinned tabs.
**Action:** Add `aria-label` to icon-only buttons, and `aria-expanded` to toggle elements to improve keyboard accessibility and screen reader support.
