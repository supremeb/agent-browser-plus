// LinkedIn helpers for `agent-browser run`. Loaded with skills.load("linkedin").
// Small, paced, single-user helpers. Limits are capped on purpose; there is no
// bulk scraping or mass outreach here. Messages and invitations only go out
// with { confirm: true }.

const LI = "https://www.linkedin.com";
const PACE_MS = 2000;

function pageCall(fn, ...args) {
  return evalPage(`(${fn.toString()})(...${JSON.stringify(args)})`);
}

function clampLimit(limit, def, max) {
  return Math.max(1, Math.min(Number(limit) || def, max));
}

function checkLogin(target) {
  const here = String(url() || "");
  if (/linkedin\.com\/(login|uas\/login|authwall|checkpoint|signup)/.test(here)) {
    throw new AbError(`LinkedIn showed a login or checkpoint page for ${target}. Log in once with --profile or --auto-connect.`, "not_logged_in", []);
  }
}

// Navigate, pause like a person would, and wait for the main area.
function go(target, readySelector = "main") {
  open(target);
  checkLogin(target);
  try {
    wait(readySelector);
  } catch (e) {
    checkLogin(target);
    throw new AbError(`LinkedIn page did not render ${readySelector}: ${target}. Fall back to snapshot -i.`, "not_found", []);
  }
  sleep(PACE_MS);
}

function profileUrl(urlOrSlug) {
  const s = String(urlOrSlug || "").trim();
  const m = s.match(/linkedin\.com\/in\/([^/?#]+)/);
  const slug = m ? m[1] : s.replace(/^\/?in\//, "").replace(/\/$/, "");
  if (!slug || /[\s/]/.test(slug)) throw new AbError(`Expected a LinkedIn profile URL or slug, got "${s}"`, "invalid_args", []);
  return `${LI}/in/${slug}/`;
}

function profile(urlOrSlug) {
  const target = profileUrl(urlOrSlug);
  go(target, "main h1");
  const data = pageCall(() => {
    const t = (el) => (el ? el.innerText.replace(/\s+/g, " ").trim() : null);
    const section = (id) => {
      const anchor = document.getElementById(id);
      return anchor ? anchor.closest("section") : null;
    };
    const top = document.querySelector("main section");
    const about = section("about");
    const exp = section("experience");
    const items = exp ? Array.from(exp.querySelectorAll("li.artdeco-list__item, ul > li")).filter((li) => !li.parentElement.closest("li")) : [];
    return {
      name: t(document.querySelector("main h1")),
      headline: t(top && top.querySelector(".text-body-medium")),
      location: t(top && top.querySelector(".text-body-small.inline, span.text-body-small")),
      about: about ? t(about.querySelector(".inline-show-more-text span[aria-hidden=true], .inline-show-more-text")) : null,
      experience: items.slice(0, 5).map((li) => {
        const lines = Array.from(li.querySelectorAll("span[aria-hidden=true]")).map((s) => s.textContent.trim()).filter(Boolean);
        return lines.slice(0, 4).join(" | ");
      }),
    };
  }) || {};
  return { url: target, ...data };
}

function searchPeople(keywords, opts = {}) {
  const limit = clampLimit(opts.limit, 10, 25);
  go(`${LI}/search/results/people/?keywords=${encodeURIComponent(keywords)}`);
  return pageCall((limit) => {
    const seen = new Set();
    const out = [];
    for (const a of document.querySelectorAll('main a[href*="/in/"]')) {
      const m = a.href.match(/\/in\/([^/?#]+)/);
      if (!m || seen.has(m[1])) continue;
      const card = a.closest("li, [data-chameleon-result-urn], [data-view-name='search-entity-result-universal-template']");
      if (!card) continue;
      seen.add(m[1]);
      const name = card.querySelector("span[aria-hidden=true]") || a;
      const sub = (sel) => (card.querySelector(sel) || {}).textContent;
      out.push({
        name: name.textContent.trim(),
        url: `https://www.linkedin.com/in/${m[1]}/`,
        headline: (sub(".entity-result__primary-subtitle") || "").trim() || null,
        location: (sub(".entity-result__secondary-subtitle") || "").trim() || null,
        summary: card.innerText.replace(/\s+/g, " ").trim().slice(0, 300),
      });
      if (out.length >= limit) break;
    }
    return out;
  }, limit) || [];
}

function feed(opts = {}) {
  const limit = clampLimit(opts.limit, 10, 20);
  go(`${LI}/feed/`);
  const read = () => pageCall((limit) => {
    const posts = Array.from(document.querySelectorAll('[data-urn^="urn:li:activity"], div.feed-shared-update-v2'));
    const seen = new Set();
    return posts.filter((p) => {
      const k = p.getAttribute("data-urn") || p;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    }).slice(0, limit).map((p) => {
      const actor = p.querySelector(".update-components-actor__title span[aria-hidden=true], .update-components-actor__name");
      const body = p.querySelector(".update-components-text, .feed-shared-text");
      return {
        urn: p.getAttribute("data-urn"),
        author: actor ? actor.textContent.trim() : null,
        text: body ? body.innerText.trim().slice(0, 1500) : "",
      };
    });
  }, limit) || [];
  let posts = read();
  if (posts.length < limit) {
    scroll("down", 1500);
    sleep(PACE_MS);
    posts = read();
  }
  return posts;
}

function messages(opts = {}) {
  const limit = clampLimit(opts.limit, 10, 20);
  go(`${LI}/messaging/`);
  return pageCall((limit) => Array.from(document.querySelectorAll("li.msg-conversation-listitem, .msg-conversations-container__conversations-list > li"))
    .slice(0, limit)
    .map((li) => {
      const t = (sel) => ((li.querySelector(sel) || {}).textContent || "").replace(/\s+/g, " ").trim() || null;
      const link = li.querySelector("a[href*='/messaging/thread/']");
      return {
        with: t(".msg-conversation-listitem__participant-names, h3"),
        snippet: t(".msg-conversation-card__message-snippet, p"),
        time: t("time, .msg-conversation-listitem__time-stamp"),
        unread: !!li.querySelector(".msg-conversation-card__convo-item-container--unread, .notification-badge"),
        url: link ? link.href : null,
      };
    }), limit) || [];
}

// Opens the message box from a profile and types the text. Never sends.
function draftMessage(profileUrlOrSlug, textToSend) {
  const target = profileUrl(profileUrlOrSlug);
  go(target, "main h1");
  const btn = pageCall(() => {
    const b = Array.from(document.querySelectorAll("main button, main a")).find((el) => /^Message\b/i.test((el.getAttribute("aria-label") || el.textContent || "").trim()));
    if (!b) return false;
    b.click();
    return true;
  });
  if (!btn) throw new AbError(`No Message button on ${target}. You may need to be connected first.`, "not_found", []);
  const box = ".msg-form__contenteditable";
  try {
    wait(box);
  } catch (e) {
    throw new AbError("LinkedIn message box did not open. Fall back to snapshot -i.", "not_found", []);
  }
  click(box);
  ab("keyboard", "type", String(textToSend));
  return { profileUrl: target, text: String(textToSend), drafted: true, sent: false };
}

function sendMessage(profileUrlOrSlug, textToSend, opts = {}) {
  const draftResult = draftMessage(profileUrlOrSlug, textToSend);
  if (opts.confirm !== true) return { ...draftResult, note: "Typed but not sent. Call again with { confirm: true } after the user approves." };
  sleep(PACE_MS);
  click("button.msg-form__send-button");
  sleep(PACE_MS);
  return { ...draftResult, drafted: false, sent: true };
}

// Sends a connection invitation. Without confirm, nothing is clicked.
function connect(profileUrlOrSlug, opts = {}) {
  const target = profileUrl(profileUrlOrSlug);
  const note = opts.note ? String(opts.note).slice(0, 300) : null;
  const preview = { profileUrl: target, note, sent: false };
  if (opts.confirm !== true) return { ...preview, drafted: true, message:"No invitation sent. Call again with { confirm: true } after the user approves." };
  go(target, "main h1");
  const opened = pageCall(() => {
    const byLabel = (re) => Array.from(document.querySelectorAll("main button, main [role=button], [role=menu] [role=button], .artdeco-dropdown__content [role=button]"))
      .find((el) => re.test(el.getAttribute("aria-label") || el.textContent.trim()));
    let b = byLabel(/^Invite .* to connect$/i) || byLabel(/^Connect$/i);
    if (!b) {
      const more = byLabel(/^More actions$/i) || byLabel(/^More$/i);
      if (more) more.click();
      b = byLabel(/^Invite .* to connect$/i) || byLabel(/^Connect$/i);
    }
    if (!b) return false;
    b.click();
    return true;
  });
  if (!opened) throw new AbError(`No Connect action on ${target}. You may already be connected or have a pending invite.`, "not_found", []);
  wait("[role=dialog]");
  sleep(1000);
  if (note) {
    find("role", "button", "click", { name: "Add a note" });
    wait("[role=dialog] textarea");
    fill("[role=dialog] textarea", note);
    find("role", "button", "click", { name: "Send" });
  } else {
    find("role", "button", "click", { name: "Send without a note" });
  }
  sleep(PACE_MS);
  return { ...preview, sent: true };
}

module.exports = { profile, searchPeople, feed, messages, draftMessage, sendMessage, connect, profileUrl };
