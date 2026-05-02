## 2024-05-18 - ARIA Labels for Icon-Only Buttons
**Learning:** In templates (`sidebar.html`) and dynamically generated elements (`domManager.js`), icon-only buttons often lack accessible names for screen readers because they just have structural tags like `svg` or `&times;` inside them.
**Action:** Always verify that icon-only buttons created either in static HTML templates or dynamically in JS files have an explicit `aria-label` attribute (using `setAttribute('aria-label', '...')` in JS).
