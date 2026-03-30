
## 2024-05-18 - Added ARIA labels to icon-only buttons
**Learning:** Icon-only buttons, particularly within `sidebar.html` templates and dynamically generated elements in `domManager.js` and `sidebar.js`, must be explicitly provided with descriptive `aria-label` attributes, as `title` tags or inner visual symbols alone are insufficient for screen readers.
**Action:** Always ensure any icon-only button created or modified in templates or dynamically via JS has a corresponding `aria-label` applied to match its intended function.
