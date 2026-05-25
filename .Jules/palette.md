## 2024-05-18 - Added ARIA labels to Arcify Sidebar
**Learning:** Found an accessibility issue pattern specific to this app's components, where multiple dynamically and statically generated icon-only buttons lacked proper ARIA attributes, rendering them unfriendly to screen readers despite having visual clues or titles.
**Action:** When implementing or updating custom toolbars and sidebars in the future, always remember to add explicit `aria-label` attributes to interactive icon-only elements (e.g. '.placeholder-close-btn', '.add-space-toggle').
