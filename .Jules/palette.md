## 2024-05-18 - Dynamically updating ARIA attributes
**Learning:** When adding ARIA attributes to indicate expanded states in custom UI elements (like folder toggles), it's important to keep them synchronized with the CSS classes representing the state (e.g., `collapsed`) using JavaScript event listeners.
**Action:** When adding stateful ARIA properties, trace all interactions that change that state and ensure the ARIA property is updated alongside the visual change.
