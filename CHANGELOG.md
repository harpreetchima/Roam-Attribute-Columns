# Changelog

## 2026-11-23

- Hide vertical bars between attribute labels and values at every nesting depth. The resize guide appears in the middle of the gap on hover or drag. Ordinary value outlines keep their bars.
- Keep `roam/meta::`, Roam `:attr/proxy` pages, and custom **Pass-through attributes** configured in extension settings as collapsible headers without increasing column depth. Attributes ending in only `#.class` or `#[[.class]]` keep their child-value layout while viewing and editing.
- Read Roam’s derived `:harc/_a-source` relationships when available to distinguish inline values from child values. Classic graphs continue to use label detection. Themes can identify harc-backed rows, their harc UIDs, relationship attributes, and pass-through headers through `data-rc-*` attributes.
- Display attribute columns at any nesting depth and keep labels aligned while editing.
- Reclaim unused label space and wrap text at word boundaries across the full column width.
- Drag dividers to save a width for each attribute nesting depth. Double-click to reset that depth, or use **Reset column widths** in Settings to restore all defaults.

## 2026-05-16

- Initial public release as Roam Attribute Columns.
- Display Roam attribute blocks as fixed-label, two-column rows while preserving native child blocks.
- Keep folded attribute rows aligned with Roam-tag-colored folded summaries such as `11 folded blocks`.
- Refresh folded summary counts with Roam pull watches while rows remain folded.
- Add a native-looking trailing body bullet when a page ends with horizontal attribute rows.
- Fall back to visible page/block metadata when creating the trailing body block if Roam's open-page UID helper is unavailable.
- Add theme-friendly CSS that keeps typography, colors, bullets, and outline visuals under Roam/theme control.
- Fix row divider color on light Roam themes when the operating system prefers dark mode.
- Use Roam/theme border tokens first, then derive divider color from inherited text color instead of hard-coded colors.
