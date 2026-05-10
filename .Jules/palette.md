## 2024-05-10 - Synchronize ARIA state for hover menus
**Learning:** CSS `:hover` menus in this app (like the space options dropdown) require manual JS synchronization of `aria-expanded` and explicit `aria-controls` links because screen readers are otherwise unaware when the visual state changes.
**Action:** When implementing or modifying hover-based interactions, ensure JavaScript event listeners (`mouseenter` / `mouseleave`) update the accessible state attributes accordingly.
