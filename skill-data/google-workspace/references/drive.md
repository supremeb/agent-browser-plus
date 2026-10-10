# Google Drive

## Searching

`drive.search(query)` opens `https://drive.google.com/drive/search?q=<query>` and returns `{ id, name, url, meta }` for each result row (rows carry a `data-id` attribute). Drive search operators work in `query`:

| Operator | Example |
|---|---|
| File type | `type:document`, `type:spreadsheet`, `type:pdf`, `type:folder` |
| Owner | `owner:me`, `owner:alex@example.com` |
| Title only | `title:"Q3 plan"` |
| Date | `after:2026-01-01`, `before:2026-06-30` |
| Shared | `sharedwith:me` |

## Opening results

The `id` works with the other helpers directly:

```js
const gw = skills.load('google-workspace');
const [hit] = gw.drive.search('type:spreadsheet title:"budget"', { limit: 1 });
return hit ? gw.sheets.readCsv(hit.id, { header: true }) : null;
```

## Folders

Folder pages live at `https://drive.google.com/drive/folders/<id>` and render the same `data-id` rows, so the extraction in `drive.search` works there too. `parseId` accepts folder URLs.

## Gotchas

- Results load lazily; scroll the main list (`scroll('down', 1000)`) and re-extract for more than the first page.
- Shortcuts and shared drives show the same row shape but may open a different target id.
- Downloading files saves them to disk. Ask the user before downloading.
