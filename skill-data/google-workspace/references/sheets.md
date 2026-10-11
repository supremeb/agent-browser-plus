# Google Sheets

## Reading

`sheets.readCsv(id, { gid })` fetches `https://docs.google.com/spreadsheets/d/<id>/export?format=csv&gid=<gid>` from inside the signed in page, and falls back to `gviz/tq?tqx=out:csv&gid=<gid>` if export is blocked. `gid` is the tab id shown in the URL after `#gid=`.

Read only a range with the gviz endpoint:

```js
open(`https://docs.google.com/spreadsheets/d/${id}/edit`);
wait('#t-name-box');
const csv = evalPage(`fetch('/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&sheet=Sheet1&range=A1:D50').then(r => r.text())`);
return skills.load('google-workspace').sheets.parseCsv(csv);
```

Tabs and their gids:

```js
return evalPage(`Array.from(document.querySelectorAll('.docs-sheet-tab')).map(t => t.innerText.trim())`);
```

Exports return displayed values, not formulas. To read a formula, select the cell through the Name Box and read the formula bar: `text('#t-formula-bar-input')`.

## Writing

`sheets.setCell(id, 'B2', 'value', { confirm: true })` focuses the Name Box (`#t-name-box`), types the cell reference, presses Enter, types the value, and presses Enter again. A value starting with `=` is entered as a formula. Use `Sheet2!B2` to target another tab.

For several cells in a row, write the first cell then use `press('Tab')` between values with `ab('keyboard', 'type', v)`. Draft the full change set first, show it to the user, and only then run it with `confirm: true`.

## Gotchas

- Large sheets can take seconds to export; the fetch is awaited by `evalPage`.
- Protected ranges reject edits silently. Read the cell back afterwards to verify.
- Locale affects number and date formatting in CSV output.
