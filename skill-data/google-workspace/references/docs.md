# Google Docs

## Reading

`docs.read(id)` opens the doc in the editor (to land on the `docs.google.com` origin with cookies) and fetches `https://docs.google.com/document/d/<id>/export?format=txt` from inside the page. Other export formats work the same way if you need structure:

| Format | URL suffix | Notes |
|---|---|---|
| Plain text | `export?format=txt` | Default for `docs.read` |
| HTML | `export?format=html` | Keeps headings, lists, links |
| Markdown | `export?format=md` | Available on most accounts |

```js
const gw = skills.load('google-workspace');
const id = gw.parseId('https://docs.google.com/document/d/<id>/edit');
open(`https://docs.google.com/document/d/${id}/edit`);
wait('.kix-appview-editor');
return evalPage(`fetch('/document/d/${id}/export?format=md').then(r => r.text())`);
```

If export is disabled by the owner, `docs.read` falls back to `/mobilebasic`, a plain HTML rendering whose `body` text is readable.

## Writing

The editor renders to a canvas and listens on a hidden input, so `fill` on page elements does not work. `docs.append` clicks into the editor, jumps to the end (`Control+End`, or `Meta+ArrowDown` on macOS), and uses `agent-browser keyboard type`. For edits in the middle of a doc:

1. Use Find (`Control+F` / `Meta+F`) to locate the text, then `Escape` to leave the cursor on the match.
2. Type with `ab('keyboard', 'type', '...')`.

Always draft first and confirm with the user. Docs keeps version history (File > Version history), which the user can use to undo.

## Comments and suggestions

Suggesting mode and comments are reachable through the toolbar by role: `find('role', 'button', 'click', { name: 'Add comment' })`. Snapshot the comment panel with `snapshot({ interactive: true, selector: '.docos-stream-view' })`.
