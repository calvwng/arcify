## 2024-05-24 - Add ARIA expanded state to Advanced Options Toggle
**Learning:** Found an accessibility gap where a custom collapsible "Advanced Options" toggle lacked ARIA attributes, leaving screen readers unaware of its state changes.
**Action:** Always ensure custom collapsible toggles define `aria-controls` for their target containers and dynamically update `aria-expanded` in JavaScript to reflect visibility states.
