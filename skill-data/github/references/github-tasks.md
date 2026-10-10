# GitHub task recipes

Recipes that combine the `github` helpers in one `agent-browser run` script. Each returns JSON so the agent can summarize without extra round trips.

## Triage open PRs with failing checks

```js
const gh = skills.load('github');
const prs = gh.listPullRequests('owner/repo', { limit: 10 });
const out = [];
for (const pr of prs) {
  const d = gh.readPullRequest('owner/repo', pr.number);
  if (d.checks && /fail|not successful/i.test(d.checks)) out.push({ number: d.number, title: d.title, checks: d.checks });
  sleep(500);
}
return out;
```

## Find my review requests

```js
const gh = skills.load('github');
return gh.listPullRequests('owner/repo', { query: 'review-requested:@me', limit: 20 });
```

`query` accepts the same qualifiers as the GitHub search box: `author:`, `assignee:`, `label:`, `milestone:`, `review:approved`, `draft:false`, `sort:updated-desc`.

## Summarize an issue thread

```js
const gh = skills.load('github');
const issue = gh.readIssue('owner/repo', 42);
return { title: issue.title, state: issue.state, labels: issue.labels, body: issue.body.slice(0, 1500), comments: issue.commentCount };
```

For the full comment history, extract it directly:

```js
open('https://github.com/owner/repo/issues/42');
wait({ load: 'networkidle' });
return evalPage(`Array.from(document.querySelectorAll('.markdown-body')).map(e => e.innerText.slice(0, 1000))`);
```

## Draft, review, then post a comment

```js
// Step 1: draft. Show the returned body to the user.
const gh = skills.load('github');
return gh.commentOnIssue('owner/repo', 42, 'Reproduced on main, fix in progress.');
```

```js
// Step 2: only after the user approves.
const gh = skills.load('github');
return gh.commentOnIssue('owner/repo', 42, 'Reproduced on main, fix in progress.', { confirm: true });
```

## Read the diff of a PR

The files tab is heavy. Read file names first, then specific files:

```js
open('https://github.com/owner/repo/pull/123/files');
wait({ load: 'networkidle' });
return evalPage(`Array.from(document.querySelectorAll('[data-tagsearch-path], [data-path]')).map(e => e.getAttribute('data-tagsearch-path') || e.getAttribute('data-path'))`);
```

For a full diff, `gh pr diff 123` or opening `https://github.com/owner/repo/pull/123.diff` and reading `text('body')` is far cheaper than walking the UI.

## Useful stable URLs

| Page | URL |
|---|---|
| PR list with search | `https://github.com/o/r/pulls?q=is:pr+is:open+label:bug` |
| Issue list with search | `https://github.com/o/r/issues?q=is:issue+is:open` |
| Plain diff / patch | `https://github.com/o/r/pull/N.diff`, `.patch` |
| Checks for a PR | `https://github.com/o/r/pull/N/checks` |
| Global PR search | `https://github.com/pulls?q=is:open+is:pr+author:@me` |
| Code search | `https://github.com/search?q=<query>&type=code` |
| Raw file | `https://raw.githubusercontent.com/o/r/<branch>/<path>` |
