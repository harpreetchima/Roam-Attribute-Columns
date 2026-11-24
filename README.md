# Roam Attribute Columns

Roam Attribute Columns is a Roam Research extension that displays attribute blocks as horizontal rows.

An attribute such as `Status::` displays its children in the next column. Native bullets and editors stay in place. The space between columns is clear until you hover over or drag the resize handle. Ordinary outlines within a value keep their vertical bars.

## Install From GitHub

Clone the extension:

```bash
git clone https://github.com/harpreetchima/Roam-Attribute-Columns.git
```

Then load it in Roam:

1. Open Roam Research.
2. Go to Settings > Extensions.
3. Enable Developer Mode.
4. Choose Load Extension.
5. Select the cloned `Roam-Attribute-Columns` folder.

Roam can reload developer extensions with `control-d control-r`.

## Remote Developer Extension

After the GitHub Pages deployment finishes, this extension can be loaded in Roam's remote developer extension field with:

```text
https://harpreetchima.github.io/Roam-Attribute-Columns/
```

Use the URL exactly as shown. GitHub Pages project paths are case-sensitive, and the trailing slash is important for tools that append file names to the URL.

Roam will load the required files from:

- `https://harpreetchima.github.io/Roam-Attribute-Columns/README.md`
- `https://harpreetchima.github.io/Roam-Attribute-Columns/extension.js`
- `https://harpreetchima.github.io/Roam-Attribute-Columns/extension.css`

## Install Locally

1. Open Roam Research.
2. Go to Settings > Extensions.
3. Enable Developer Mode.
4. Choose Load Extension.
5. Select `/Users/chima/code/github/Roam Attribute Columns`.

Roam can reload developer extensions with `control-d control-r`.

## Behavior

- Enabled globally by default.
- A blank attribute tail or one containing only Roam class tags (`#.wide` or `#[[.wide]]`) keeps child blocks in the value column, including while editing. An inline value such as `Owner:: [[Jane Doe]]` keeps its native outline. Its child attributes can form their own rows.
- `roam/meta::`, pages marked as pass-through attributes in Roam’s Attribute Settings (`:attr/proxy true`), and any names listed under **Pass-through attributes** in Settings stay collapsible headers, even with an annotation after `::`. Their child attributes use the enclosing column depth.
- Attribute rows work at any outline depth, including beneath ordinary child blocks. A label such as `Version History::` stays in its column while you edit it.
- The top-level label column starts at `18rem`. Nested label widths scale with the space available. Drag a divider to resize all rows at its nesting depth. Double-click it to reset that depth, or press Escape during a drag to cancel.
- Keeps multiple child blocks stacked vertically on the right.
- Keeps folded attribute rows aligned and shows a display-only count such as `11 folded blocks`.
- Counts all folded descendant blocks, not only direct children.
- Refreshes folded counts from Roam graph changes while the row stays folded when Roam's pull-watch API is available.
- Adds a native-looking trailing body bullet when the visible page ends with horizontal attributes.
- Labels use the space between the bullet and divider and wrap at word boundaries. Long unbroken words can wrap within the column.
- Adds subtle row dividers by default.
- Falls back to normal Roam layout below `900px` viewport width.
- Does not modify graph data for layout. The trailing body bullet creates and focuses a real empty top-level block only when clicked or activated with Enter.

## Settings

The extension adds a `Roam Attribute Columns` settings panel:

- Enable horizontal attributes
- Label column width (top-level rows)
- Reset column widths (restores all depths)
- Pass-through attributes (comma-separated header names, layered on top of `roam/meta` and `:attr/proxy`)
- Show row dividers

It also adds this command palette command:

`Roam Attribute Columns: Toggle horizontal attributes`

No default hotkey is assigned.

## Theming

Roam Attribute Columns adds these classes alongside Roam's original classes.

- `rc-attribute-row`
- `rc-attribute-label`
- `rc-attribute-values`
- `rc-column-resizer`

Each row has a `data-rc-depth` attribute. Outermost attribute rows have depth `0`, and each enclosing attribute row adds one level.

When Roam provides a derived relationship (a *harc*) through `:harc/_a-source`, the extension reads its value sources to determine whether the value comes from the attribute block itself. Graphs without harcs use the rendered label or active editor. Layout reads leave Roam’s derived relationships and page settings intact. [Roam’s Attributes Data Model](https://roamdocs.fyi/developer-documentation/attributes-data-model-new.md)

Harc-backed rows expose `data-rc-attr-model="harc"` and `data-rc-harc-uid`. A row describing another relationship also has `data-rc-attr-role="relationship"`. Pass-through headers have `data-rc-passthrough="true"`.

Themes can keep styling normal Roam classes like `.rm-block-text`, `.rm-block-children`, `.rm-multibar`, and `.roam-block-container`. Folded count placeholders are inserted with those normal Roam classes, so themes do not need extension-specific selectors for typography, color, bullets, or outline bars. The stylesheet uses `:where(...)` selectors and targets each row’s native label and child container directly.

The trailing body bullet is also built from normal Roam block classes. Themes can style it the same way they style ordinary empty top-level blocks.

Folded summaries use Roam's native tag color class, so their color follows the same theme rules as tags like `#rolodex/person`.

Optional custom properties:

```css
body {
  --rc-label-width: var(--rc-label-width-setting, 18rem);
  --rc-column-gap: 0.75rem;
  --rc-row-padding-block: 6px;
  --rc-row-border-color: var(
    --rm-border-color,
    color-mix(in srgb, currentColor 12%, transparent)
  );
}
```

Blueprint-style example:

```css
.bp3-dark {
  --rc-row-border-color: #394b59;
}

.rc-attribute-values.rm-block-children .rm-block-text {
  line-height: inherit;
}
```

## Files

- `extension.js`: extension lifecycle, settings, command, DOM observer, row marking
- `extension.css`: two-column layout and responsive behavior
- `CHANGELOG.md`: release notes
- `roam-depot-template.json`: metadata starter for a Roam Depot submission

## Roam Depot

This repository is ready for a Roam Depot submission. Copy `roam-depot-template.json` into a Roam Depot fork as `extensions/harpreetchima/Roam-Attribute-Columns.json`, replace `source_commit` with the commit being submitted, and open the Depot pull request.
