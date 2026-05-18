# Roam Attribute Columns

Roam Attribute Columns is a Roam Research extension that displays attribute blocks as horizontal rows.

When an attribute block has child blocks, the attribute label stays in a fixed left column and the child blocks move into a right column. The right side remains native Roam: bullets, nested blocks, vertical bars, editing, and wrapping stay intact.

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
- Uses an `18rem` left property column.
- Keeps multiple child blocks stacked vertically on the right.
- Keeps folded attribute rows aligned and shows a display-only count such as `11 folded blocks`.
- Counts all folded descendant blocks, not only direct children.
- Refreshes folded counts from Roam graph changes while the row stays folded when Roam's pull-watch API is available.
- Adds a native-looking trailing body bullet when the visible page ends with horizontal attributes.
- Wraps long property labels inside the fixed left column.
- Adds subtle row dividers by default.
- Falls back to normal Roam layout below `900px` viewport width.
- Does not modify graph data for layout. The trailing body bullet creates and focuses a real empty top-level block only when clicked or activated with Enter.

## Settings

The extension adds a `Roam Attribute Columns` settings panel:

- Enable horizontal attributes
- Label column width
- Show row dividers

It also adds this command palette command:

`Roam Attribute Columns: Toggle horizontal attributes`

No default hotkey is assigned.

## Theming

Roam Attribute Columns keeps Roam's original classes on every block and only adds low-specificity helper classes for the horizontal layout:

- `rc-attribute-row`
- `rc-attribute-label`
- `rc-attribute-values`

Themes can keep styling normal Roam classes like `.rm-block-text`, `.rm-block-children`, `.rm-multibar`, and `.roam-block-container`. Folded count placeholders are inserted with those normal Roam classes, so themes do not need extension-specific selectors for typography, color, bullets, or outline bars. Roam Attribute Columns uses `:where(...)` selectors and targets Roam's native direct children for layout, so helper classes are not required for rows to stay horizontal during Roam rerenders.

The trailing body bullet is also built from normal Roam block classes. Themes can style it the same way they style ordinary empty top-level blocks.

Folded summaries use Roam's native tag color class, so their color follows the same theme rules as tags like `#rolodex/person`.

Optional custom properties:

```css
body {
  --rc-label-width: var(--rc-label-width-setting, 18rem);
  --rc-column-gap: var(--rm-block-spacing, 1.5rem);
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
