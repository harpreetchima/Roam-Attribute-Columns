# Changelog

## 2026-05-16

- Initial public release as Roam Attribute Columns.
- Display Roam attribute blocks as fixed-label, two-column rows while preserving native child blocks.
- Keep folded attribute rows aligned with Roam-tag-colored folded summaries such as `11 folded blocks`.
- Refresh folded summary counts with Roam pull watches while rows remain folded.
- Add a native-looking trailing body bullet when a page ends with horizontal attribute rows.
- Fall back to visible page/block metadata when creating the trailing body block if Roam's open-page UID helper is unavailable.
- Add theme-friendly CSS that keeps typography, colors, bullets, and outline visuals under Roam/theme control.
- Fix row divider color on light Roam themes when the operating system prefers dark mode.
