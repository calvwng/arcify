## 2024-03-24 - Icon-only Accessibility
**Learning:** Icon-only buttons (like `chevron-icon`, `svg-icon`, and standard HTML elements like `&times;`) in `sidebar.html` do not provide screen-reader contexts natively, even when given visual styling or `title` tags.
**Action:** When adding or auditing icon-only components across Arcify's minimalist sidebar UI, explicitly ensure `aria-label` tags are applied.
