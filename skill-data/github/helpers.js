// GitHub site helpers for `agent-browser run`. Loaded with skills.load("github").
// Reads use stable URLs plus DOM extraction that tolerates both the classic and
// the React-based GitHub UI. Mutations only submit when opts.confirm === true.

const BASE = "https://github.com";

// Run a page-side function with JSON arguments and return its result.
function pageCall(fn, ...args) {
  return evalPage(`(${fn.toString()})(...${JSON.stringify(args)})`);
}

function splitRepo(ownerRepo) {
  const m = String(ownerRepo || "").replace(/^https?:\/\/github\.com\//, "").match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new AbError(`Expected "owner/repo", got "${ownerRepo}"`, "invalid_args", []);
  return `${m[1]}/${m[2].replace(/\.git$/, "")}`;
}

function clampLimit(limit, def, max) {
  const n = Number(limit) || def;
  return Math.max(1, Math.min(n, max));
}

// Navigate, wait for content, and fail clearly on login walls or 404 pages.
function go(target, { requireLogin = false } = {}) {
  open(target);
  wait({ load: "domcontentloaded" });
  const here = String(url() || "");
  if (/github\.com\/(login|session)/.test(here)) {
    throw new AbError(`GitHub redirected to the login page for ${target}. Log in once with --profile or --auto-connect.`, "not_logged_in", []);
  }
  const state = pageCall(() => ({
    login: (document.querySelector('meta[name="user-login"]') || {}).content || "",
    notFound: /^Page not found/.test(document.title) || !!document.querySelector('img[alt^="404"]'),
  })) || {};
  if (state.notFound) throw new AbError(`GitHub page not found: ${target}. Check the repo name or whether it is private and you are not logged in.`, "not_found", []);
  if (requireLogin && state.login === "") {
    throw new AbError(`This GitHub page needs a signed in session: ${target}. Log in once with --profile or --auto-connect.`, "not_logged_in", []);
  }
  return here;
}

function repo(ownerRepo) {
  const r = splitRepo(ownerRepo);
  go(`${BASE}/${r}`);
  const info = pageCall(() => {
    const t = (sel) => ((document.querySelector(sel) || {}).textContent || "").trim();
    const readme = document.querySelector("article.markdown-body");
    return {
      description: t('[itemprop="about"]') || t(".BorderGrid p.f4") || ((document.querySelector('meta[name="description"]') || {}).content || ""),
      stars: t("#repo-stars-counter-star") || null,
      forks: t("#repo-network-counter") || null,
      topics: Array.from(document.querySelectorAll("a.topic-tag")).map((a) => a.textContent.trim()),
      languages: Array.from(document.querySelectorAll('.BorderGrid a[href*="/search?l="] span.text-bold')).map((s) => s.textContent.trim()),
      readme: readme ? readme.innerText.slice(0, 4000) : "",
    };
  }) || {};
  return { repo: r, url: `${BASE}/${r}`, ...info };
}

// Collect issue/PR rows by link shape, so it works on the old and new list UIs.
function extractRows(kind, limit) {
  return pageCall((kind, limit) => {
    const re = new RegExp(`/([^/]+/[^/]+)/${kind}/(\\d+)$`);
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/' + kind + '/"]')) {
      const m = a.pathname.match(re);
      const label = a.textContent.trim();
      if (!m || !label || seen.has(m[2]) || /^#?\d+$/.test(label)) continue;
      seen.add(m[2]);
      const row = a.closest('[id^="issue_"], li, [role="listitem"], .js-issue-row') || a.parentElement;
      const author = row && row.querySelector('a[data-hovercard-type="user"], [data-testid="created-by-link"]');
      const time = row && row.querySelector("relative-time, time");
      out.push({
        number: Number(m[2]),
        title: label,
        url: a.href,
        author: author ? author.textContent.trim() : null,
        updated: time ? time.getAttribute("datetime") : null,
        labels: row ? Array.from(row.querySelectorAll('a[href*="label%3A"], a[href*="label:"], .IssueLabel')).map((l) => l.textContent.trim()).filter(Boolean) : [],
        meta: row ? row.innerText.replace(/\s+/g, " ").trim().slice(0, 300) : "",
      });
      if (out.length >= limit) break;
    }
    return out;
  }, kind, limit) || [];
}

function listPullRequests(ownerRepo, opts = {}) {
  const r = splitRepo(ownerRepo);
  const state = opts.state || "open";
  const q = ["is:pr", state === "all" ? "" : `is:${state}`, opts.query || ""].filter(Boolean).join(" ");
  go(`${BASE}/${r}/pulls?q=${encodeURIComponent(q)}`);
  wait({ load: "networkidle" });
  return extractRows("pull", clampLimit(opts.limit, 25, 100));
}

function listIssues(ownerRepo, opts = {}) {
  const r = splitRepo(ownerRepo);
  const state = opts.state || "open";
  const q = ["is:issue", state === "all" ? "" : `is:${state}`, opts.query || ""].filter(Boolean).join(" ");
  go(`${BASE}/${r}/issues?q=${encodeURIComponent(q)}`);
  wait({ load: "networkidle" });
  return extractRows("issues", clampLimit(opts.limit, 25, 100));
}

// Shared header/body extraction for issue and PR pages.
function readThreadPage() {
  return pageCall(() => {
    const t = (sel) => {
      for (const s of sel.split("|")) {
        const el = document.querySelector(s);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
      return null;
    };
    const body = document.querySelector('[data-testid="issue-body"] .markdown-body, .js-comment-body, .comment-body');
    const checks = document.querySelector('[aria-label="Checks"], .merge-status-list, .mergeability-details');
    const checkHeading = Array.from(document.querySelectorAll("h3, .status-heading"))
      .map((h) => h.textContent.trim())
      .find((s) => /checks? (have|has|were|was|are)|checks? (passed|failed|pending)|successful checks/i.test(s));
    return {
      title: t('[data-testid="issue-title"]|.js-issue-title|h1 bdi|h1'),
      state: t('[data-testid="header-state"]|.gh-header-meta .State|span.State'),
      author: t('[data-testid="issue-body-header-author"]|.gh-header-meta .author|.timeline-comment .author'),
      body: body ? body.innerText.trim().slice(0, 8000) : "",
      labels: Array.from(document.querySelectorAll('.js-issue-labels a, [data-testid="issue-labels"] a')).map((a) => a.textContent.trim()),
      commentCount: document.querySelectorAll(".timeline-comment, [data-testid='comment-viewer-outer-box']").length,
      filesChanged: t("#files_tab_counter|a[href$='/files'] .Counter"),
      checks: checkHeading || (checks ? checks.innerText.replace(/\s+/g, " ").trim().slice(0, 500) : null),
    };
  }) || {};
}

function readPullRequest(ownerRepo, number) {
  const r = splitRepo(ownerRepo);
  go(`${BASE}/${r}/pull/${Number(number)}`);
  wait({ load: "networkidle" });
  const data = readThreadPage();
  if (!data.title) throw new AbError(`Could not find PR #${number} in ${r}. The layout may have changed; fall back to snapshot -i.`, "not_found", []);
  return { repo: r, number: Number(number), url: `${BASE}/${r}/pull/${Number(number)}`, ...data };
}

function readIssue(ownerRepo, number) {
  const r = splitRepo(ownerRepo);
  go(`${BASE}/${r}/issues/${Number(number)}`);
  wait({ load: "networkidle" });
  const data = readThreadPage();
  delete data.filesChanged;
  delete data.checks;
  if (!data.title) throw new AbError(`Could not find issue #${number} in ${r}. The layout may have changed; fall back to snapshot -i.`, "not_found", []);
  return { repo: r, number: Number(number), url: `${BASE}/${r}/issues/${Number(number)}`, ...data };
}

// Code search requires a signed in session.
function searchCode(query, opts = {}) {
  go(`${BASE}/search?q=${encodeURIComponent(query)}&type=code`, { requireLogin: true });
  wait({ load: "networkidle" });
  const limit = clampLimit(opts.limit, 20, 100);
  return pageCall((limit) => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('a[href*="/blob/"]')) {
      const m = a.pathname.match(/^\/([^/]+\/[^/]+)\/blob\/[^/]+\/(.+)$/);
      if (!m || seen.has(a.pathname)) continue;
      seen.add(a.pathname);
      const box = a.closest('[data-testid="results-list"] > div, .code-list-item, li') || a.parentElement;
      const code = box && box.querySelector("pre, table, .code-list");
      out.push({ repo: m[1], path: decodeURIComponent(m[2]), url: a.href, snippet: code ? code.innerText.trim().slice(0, 500) : "" });
      if (out.length >= limit) break;
    }
    return out;
  }, limit) || [];
}

function notifications(opts = {}) {
  go(`${BASE}/notifications`, { requireLogin: true });
  const limit = clampLimit(opts.limit, 25, 100);
  return pageCall((limit) => {
    return Array.from(document.querySelectorAll(".notifications-list-item, li[data-notification-id]"))
      .slice(0, limit)
      .map((li) => {
        const link = li.querySelector("a.notification-list-item-link, a[href]");
        const title = li.querySelector(".markdown-title, p");
        const repo = li.querySelector(".f6.color-fg-muted, .text-small");
        const time = li.querySelector("relative-time, time");
        return {
          title: title ? title.textContent.trim() : "",
          repo: repo ? repo.textContent.replace(/\s+/g, " ").trim() : null,
          url: link ? link.href : null,
          unread: li.classList.contains("notification-unread"),
          updated: time ? time.getAttribute("datetime") : null,
        };
      });
  }, limit) || [];
}

// Fills the comment box. Only clicks the Comment button when opts.confirm === true.
function commentOnIssue(ownerRepo, number, body, opts = {}) {
  const r = splitRepo(ownerRepo);
  const target = `${BASE}/${r}/issues/${Number(number)}`;
  const preview = { repo: r, number: Number(number), url: target, body: String(body), posted: false };
  go(target, { requireLogin: true });
  const box = pageCall(() => {
    const sels = ["#new_comment_field", 'textarea[aria-label="Markdown value"]', 'textarea[placeholder*="comment" i]', "textarea[name='comment[body]']"];
    return sels.find((s) => document.querySelector(s)) || null;
  });
  if (!box) throw new AbError(`No comment box on ${target}. The thread may be locked, or you are not logged in.`, "not_found", []);
  fill(box, String(body));
  if (opts.confirm !== true) return { ...preview, drafted: true, note: "Comment typed but not posted. Call again with { confirm: true } after the user approves." };
  find("role", "button", "click", { name: "Comment", exact: true });
  wait({ load: "networkidle" });
  return { ...preview, posted: true };
}

module.exports = { repo, listPullRequests, listIssues, readPullRequest, readIssue, searchCode, notifications, commentOnIssue, splitRepo };
