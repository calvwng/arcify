## 2024-05-24 - [Add ARIA labels to Arcify tab controls]
**Learning:** Found an accessibility issue pattern specific to this app's dynamically generated sidebar tab components (in `domManager.js` and `sidebar.js`). The close, restore, and option buttons relied solely on visual icons or title attributes without `aria-label` or `role` bindings.
**Action:** Always ensure any dynamically inserted DOM elements inside loops include `aria-label` attributes for icon-only components and appropriate `role="switch"` for custom `input[type="checkbox"]` toggles.
