# Palette's Journal

## 2024-03-22 - Missing ARIA Labels on Icon-Only Buttons
**Learning:** Several icon-only buttons throughout the app (`sidebar.html`, `domManager.js`) relied solely on `title` attributes or visual symbols (like SVG icons or HTML entities) for meaning. This is insufficient for screen readers and breaks accessibility standards.
**Action:** When adding new icon-only buttons (especially in templates or dynamically generated via DOM manipulation), always explicitly set a descriptive `aria-label` attribute in addition to visual indicators or tooltips.
