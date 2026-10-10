// Google Docs, Sheets, Drive and Calendar helpers for `agent-browser run`.
// Loaded with skills.load("google-workspace"). Reads prefer export URLs fetched
// from the signed in page; writes only happen with { confirm: true }.

function pageCall(fn, ...args) {
  return evalPage(`(${fn.toString()})(...${JSON.stringify(args)})`);
}

// Accepts a bare id or any Docs/Sheets/Drive URL (/d/<id>/, ?id=<id>, /folders/<id>).
function parseId(urlOrId) {
  const s = String(urlOrId || "").trim();
  const m = s.match(/\/d\/([a-zA-Z0-9_-]{10,})/) || s.match(/[?&]id=([a-zA-Z0-9_-]{10,})/) || s.match(/\/folders\/([a-zA-Z0-9_-]{10,})/);
  if (m) return m[1];
  if (/^[a-zA-Z0-9_-]{10,}$/.test(s)) return s;
  throw new AbError(`Could not find a Google file id in "${s}"`, "invalid_args", []);
}

function checkLogin(target) {
  const here = String(url() || "");
  if (/accounts\.google\.com|\/ServiceLogin/.test(here)) {
    throw new AbError(`Google redirected to sign-in while opening ${target}. Log in once with --profile or --auto-connect.`, "not_logged_in", []);
  }
}

function go(target, readySelector) {
  open(target);
  checkLogin(target);
  if (readySelector) {
    try {
      wait(readySelector);
    } catch (e) {
      checkLogin(target);
      throw new AbError(`${target} did not render ${readySelector}. You may lack access to this file. Fall back to snapshot -i.`, "not_found", []);
    }
  }
}

// Fetch a same-origin export URL with the page's cookies. Returns { ok, status, text }.
function fetchText(exportUrl) {
  return pageCall((u) => fetch(u, { credentials: "include" })
    .then((r) => r.text().then((text) => ({ ok: r.ok, status: r.status, text })))
    .catch((e) => ({ ok: false, status: 0, text: String(e) })), exportUrl) || {};
}

// Small RFC 4180 CSV parser: quoted fields, escaped quotes, CRLF.
function parseCsv(src) {
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); rows.push(row); }
  return rows;
}

const docs = {
  read(docIdOrUrl) {
    const id = parseId(docIdOrUrl);
    // View-only and public docs never render the editor chrome, so wait for
    // the page load only; the export fetch below is what proves access.
    go(`https://docs.google.com/document/d/${id}/edit`);
    try { wait({ load: "load" }); } catch (_) {}
    const title = pageCall(() => document.title.replace(/ - Google Docs$/, ""));
    const res = fetchText(`https://docs.google.com/document/d/${id}/export?format=txt`);
    if (res.ok && typeof res.text === "string") return { id, title, text: res.text.replace(/^﻿/, "") };
    // Fallback: the lightweight HTML rendering of the doc.
    go(`https://docs.google.com/document/d/${id}/mobilebasic`, "body");
    if (/Sign in|You need access|Request access/i.test(String(title))) {
      throw new AbError(`No access to document ${id}. Log in with --profile or ask the owner to share it.`, "not_found", []);
    }
    return { id, title, text: text("body") };
  },
  // Types text at the end of the doc. Without confirm, returns a preview only.
  append(docIdOrUrl, textToAdd, opts = {}) {
    const id = parseId(docIdOrUrl);
    const preview = { id, text: String(textToAdd), appended: false };
    if (opts.confirm !== true) return { ...preview, drafted: true, note: "Nothing typed. Call again with { confirm: true } after the user approves." };
    go(`https://docs.google.com/document/d/${id}/edit`, ".kix-appview-editor");
    click(".kix-appview-editor");
    const mac = pageCall(() => /Mac/.test(navigator.platform)) === true;
    press(mac ? "Meta+ArrowDown" : "Control+End");
    ab("keyboard", "inserttext", String(textToAdd));
    sleep(1500);
    return { ...preview, appended: true };
  },
};

const sheets = {
  readCsv(sheetIdOrUrl, opts = {}) {
    const id = parseId(sheetIdOrUrl);
    const gidMatch = String(sheetIdOrUrl).match(/[#&?]gid=(\d+)/);
    const gid = opts.gid !== undefined ? opts.gid : gidMatch ? gidMatch[1] : 0;
    go(`https://docs.google.com/spreadsheets/d/${id}/edit#gid=${gid}`, "#t-name-box, .docs-sheet-tab");
    let res = fetchText(`https://docs.google.com/spreadsheets/d/${id}/export?format=csv&gid=${gid}`);
    if (!res.ok) res = fetchText(`https://docs.google.com/spreadsheets/d/${id}/gviz/tq?tqx=out:csv&gid=${gid}`);
    if (!res.ok) throw new AbError(`Could not export sheet ${id} (gid ${gid}), HTTP ${res.status}. Check access or fall back to snapshot.`, "not_found", []);
    const rows = parseCsv(res.text || "");
    return opts.header ? rows.slice(1).map((r) => Object.fromEntries(rows[0].map((h, i) => [h, r[i]]))) : rows;
  },
  // Writes one cell through the Name Box. Without confirm, returns a preview only.
  setCell(sheetIdOrUrl, cell, val, opts = {}) {
    const id = parseId(sheetIdOrUrl);
    const preview = { id, cell: String(cell), value: String(val), gid: opts.gid, written: false };
    if (opts.confirm !== true) return { ...preview, drafted: true, note: "Nothing written. Call again with { confirm: true } after the user approves." };
    const gid = opts.gid !== undefined ? `#gid=${opts.gid}` : "";
    go(`https://docs.google.com/spreadsheets/d/${id}/edit${gid}`, "#t-name-box");
    click("#t-name-box");
    fill("#t-name-box", String(cell));
    press("Enter");
    ab("keyboard", "inserttext", String(val));
    press("Enter");
    sleep(1000);
    return { ...preview, written: true };
  },
  parseCsv,
};

const drive = {
  search(query, opts = {}) {
    go(`https://drive.google.com/drive/search?q=${encodeURIComponent(query)}`, "[role=main]");
    wait({ load: "networkidle" });
    const limit = Math.max(1, Math.min(Number(opts.limit) || 25, 100));
    return pageCall((limit) => {
      const seen = new Set();
      const out = [];
      for (const el of document.querySelectorAll("[role=main] [data-id]")) {
        const id = el.getAttribute("data-id");
        if (!id || id.length < 10 || seen.has(id)) continue;
        seen.add(id);
        const name = el.querySelector("[data-tooltip]") || el;
        const label = (name.getAttribute("data-tooltip") || name.getAttribute("aria-label") || el.innerText.split("\n")[0] || "").trim();
        out.push({ id, name: label, url: `https://drive.google.com/open?id=${id}`, meta: el.innerText.replace(/\s+/g, " ").trim().slice(0, 200) });
        if (out.length >= limit) break;
      }
      return out;
    }, limit) || [];
  },
};

// Formats Date | ISO string | "YYYY-MM-DD" for Calendar's dates= param.
function calDate(v, allDay) {
  if (allDay) return String(v).slice(0, 10).replace(/-/g, "");
  const d = v instanceof Date ? v : new Date(v);
  if (isNaN(d.getTime())) throw new AbError(`Invalid date: ${v}`, "invalid_args", []);
  return d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

const calendar = {
  agenda(opts = {}) {
    go("https://calendar.google.com/calendar/r/agenda", "[role=main]");
    wait({ load: "networkidle" });
    const days = Math.max(1, Math.min(Number(opts.days) || 7, 60));
    return pageCall((days) => {
      const out = [];
      const dayRows = Array.from(document.querySelectorAll("[role=main] [role=row], [role=main] [data-datekey]"));
      for (const row of dayRows) {
        const events = Array.from(row.querySelectorAll("[data-eventid]"));
        if (!events.length) continue;
        const heading = row.querySelector("[role=rowheader], h2, [aria-level]");
        out.push({
          day: heading ? heading.innerText.replace(/\s+/g, " ").trim() : null,
          events: events.map((e) => ({ id: e.getAttribute("data-eventid"), text: e.innerText.replace(/\s+/g, " ").trim() })),
        });
        if (out.length >= days) break;
      }
      return out;
    }, days) || [];
  },
  // Opens a prefilled event editor. Only clicks Save with confirm === true.
  createEvent({ title, start, end, details, location, allDay, confirm } = {}) {
    if (!title || !start) throw new AbError("createEvent needs at least { title, start }", "invalid_args", []);
    const isAllDay = allDay === true || /^\d{4}-\d{2}-\d{2}$/.test(String(start));
    let endVal = end;
    if (!endVal) {
      const s = new Date(start);
      endVal = isAllDay ? new Date(s.getTime() + 86400000).toISOString().slice(0, 10) : new Date(s.getTime() + 3600000);
    }
    const dates = `${calDate(start, isAllDay)}/${calDate(endVal, isAllDay)}`;
    const params = [["text", title], ["dates", dates], ["details", details], ["location", location]]
      .filter(([, v]) => v)
      .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
      .join("&");
    const target = `https://calendar.google.com/calendar/r/eventedit?${params}`;
    go(target, "[role=main]");
    const preview = { title, dates, details, location, url: target, saved: false };
    if (confirm !== true) return { ...preview, drafted: true, note: "Editor open but not saved. Call again with { confirm: true } after the user approves." };
    find("role", "button", "click", { name: "Save", exact: true });
    wait({ load: "networkidle" });
    return { ...preview, saved: true };
  },
};

module.exports = { parseId, docs, sheets, drive, calendar };
