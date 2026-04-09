## 2024-05-18 - [Add aria-expanded to collapsible elements]
**Learning:** Found multiple collapsible components (folders, pinned section, option menus) that toggle classes like `.collapsed` but lack native `aria-expanded` attributes. This leaves screen readers unaware of the component state. Modifying JS class toggles to also update the ARIA attribute ensures semantic parity with the visual state.
**Action:** Always sync `aria-expanded` with `classList.toggle('collapsed')` in dynamic interactions.
