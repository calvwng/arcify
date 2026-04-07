## 2024-06-25 - Ensuring clear ARIA labels for icon-only buttons
**Learning:** Found multiple instances where icon-only buttons (both hardcoded in HTML and dynamically generated in JavaScript) miss `aria-label`s, which decreases accessibility for screen readers. Since custom CSS should not be added, the focus should be on HTML/JS-based accessibility improvements like `aria-label`s.
**Action:** Next time when introducing or modifying icon-only buttons, prioritize providing clear `aria-label`s explicitly, especially for components that are dynamically added to the DOM.
