## 2026-05-18 - Added ARIA labels to icon-only buttons
**Learning:** Icon-only buttons or those relying solely on `title` attributes need explicit `aria-label` attributes for full screen reader accessibility. This is a recurring pattern across static HTML and dynamic DOM generation.
**Action:** Always verify accessibility attributes when introducing new UI elements that depend purely on icons, particularly in dynamically generated components.
