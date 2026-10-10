// Gmail helpers for `agent-browser run`. Loaded with skills.load("gmail").
// Reads use the hash routes of the web UI and extract rows from the DOM.
// Nothing is sent unless send() is called with { confirm: true }.

const MAIL = "https://mail.google.com/mail/u/0/";

function pageCall(fn, ...args) {
  return evalPage(`(${fn.toString()})(...${JSON.stringify(args)})`);
}

function clampLimit(limit, def, max) {
  return Math.max(1, Math.min(Number(limit) || def, max));
}

// A signed-in profile can still pass through accounts.google.com on a silent
// cookie-refresh redirect, so only treat sign-in as final if it persists.
function checkLogin(target) {
  const onSignIn = () => /accounts\.google\.com|workspace\.google\.com\/.*gmail|\/ServiceLogin/.test(String(url() || ""));
  if (!onSignIn()) return;
  for (let i = 0; i < 16 && onSignIn(); i++) sleep(500);
  // The first visit in a fresh or copied profile can stop on sign-in while
  // Google refreshes its cookies; the retry then lands signed in.
  if (onSignIn()) {
    open(target);
    for (let i = 0; i < 6 && onSignIn(); i++) sleep(500);
  }
  if (onSignIn()) {
    throw new AbError(`Gmail redirected to a Google sign-in page while opening ${target}. Log in once with --profile or --auto-connect.`, "not_logged_in", []);
  }
}

// Open a Gmail route and wait until the list pane (or main area) is rendered.
function goList(hash) {
  const target = MAIL + hash;
  open(target);
  checkLogin(target);
  // A cold Gmail load shows a "Loading Gmail" splash that can outlast a single
  // wait, so poll for the list (rows, the empty-list cell, or the list body).
  // Ready means real rows, or Gmail's "no conversations" cell; the empty list
  // container alone appears before results arrive.
  const ready = "!!(document.querySelector('[role=main] tr.zA') || document.querySelector('[role=main] td.TC'))";
  const deadline = Date.now() + 45000;
  while (evalPage(ready) !== true) {
    checkLogin(target);
    if (Date.now() > deadline) {
      throw new AbError(`Gmail list did not render for ${target}. Fall back to snapshot -i.`, "not_found", []);
    }
    sleep(500);
  }
  return target;
}

// Extract visible thread rows in the current list view.
function readRows(limit) {
  return pageCall((limit) => {
    const main = document.querySelector("[role=main]") || document;
    return Array.from(main.querySelectorAll("tr.zA"))
      .filter((tr) => tr.offsetParent !== null)
      .slice(0, limit)
      .map((tr, index) => {
        const sender = tr.querySelector(".yW [email], .yW .zF, .yW .yP");
        const subj = tr.querySelector(".bog");
        const snip = tr.querySelector(".y2");
        const date = tr.querySelector("td.xW span[title], td.xW span");
        const tid = tr.querySelector("[data-legacy-thread-id], [data-thread-id]");
        return {
          index,
          from: sender ? sender.getAttribute("name") || sender.textContent.trim() : null,
          email: sender ? sender.getAttribute("email") : null,
          subject: subj ? subj.textContent.trim() : "",
          snippet: snip ? snip.textContent.replace(/^\s*[-–]\s*/, "").trim() : "",
          date: date ? date.getAttribute("title") || date.textContent.trim() : null,
          unread: tr.classList.contains("zE"),
          threadId: tid ? tid.getAttribute("data-legacy-thread-id") || tid.getAttribute("data-thread-id") : null,
        };
      });
  }, limit) || [];
}

function inbox(opts = {}) {
  goList("#inbox");
  return readRows(clampLimit(opts.limit, 20, 100));
}

function search(query, opts = {}) {
  goList("#search/" + encodeURIComponent(String(query)));
  return readRows(clampLimit(opts.limit, 20, 100));
}

// Open a thread by row index in the current list, or by subject text, then read it.
function readThread(indexOrSubject) {
  const here = String(url() || "");
  if (!/mail\.google\.com/.test(here) || typeof indexOrSubject === "string") {
    if (typeof indexOrSubject === "string") goList("#search/" + encodeURIComponent(`subject:(${indexOrSubject})`));
    else goList("#inbox");
  }
  const clicked = pageCall((key) => {
    const rows = Array.from(document.querySelectorAll("[role=main] tr.zA")).filter((tr) => tr.offsetParent !== null);
    const row = typeof key === "number"
      ? rows[key]
      : rows.find((tr) => (tr.querySelector(".bog") || {}).textContent && tr.querySelector(".bog").textContent.toLowerCase().includes(key.toLowerCase())) || null;
    if (!row) return false;
    row.click();
    return true;
  }, indexOrSubject);
  if (!clicked) throw new AbError(`No Gmail thread matched ${JSON.stringify(indexOrSubject)}. Check the list with inbox() or search().`, "not_found", []);
  wait("h2.hP");
  return pageCall(() => {
    const subject = (document.querySelector("h2.hP") || {}).textContent || "";
    const messages = Array.from(document.querySelectorAll("[role=main] .adn")).map((m) => {
      const from = m.querySelector(".gD");
      const date = m.querySelector(".g3");
      const body = m.querySelector(".a3s");
      const to = Array.from(m.querySelectorAll(".g2")).map((e) => e.getAttribute("email") || e.textContent.trim());
      return {
        from: from ? from.getAttribute("name") || from.textContent.trim() : null,
        email: from ? from.getAttribute("email") : null,
        to,
        date: date ? date.getAttribute("title") || date.textContent.trim() : null,
        body: body ? body.innerText.trim().slice(0, 8000) : "",
      };
    });
    return { subject: subject.trim(), url: location.href, messages };
  }) || {};
}

// Open the full-screen compose view prefilled with recipients, subject and body.
function compose({ to, cc, bcc, subject, body } = {}) {
  const params = [["view", "cm"], ["fs", "1"], ["to", to], ["cc", cc], ["bcc", bcc], ["su", subject], ["body", body]]
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${encodeURIComponent(Array.isArray(v) ? v.join(",") : String(v))}`)
    .join("&");
  const target = `${MAIL}?${params}`;
  open(target);
  checkLogin(target);
  try {
    wait('div[role="dialog"] [name="subjectbox"], input[name="subjectbox"]');
  } catch (e) {
    checkLogin(target);
    throw new AbError("Gmail compose window did not open. Fall back to snapshot -i and the Compose button.", "not_found", []);
  }
  return { to, cc, bcc, subject, body };
}

// Compose a message and leave it as a draft. Gmail autosaves open compose windows.
function draft(msg = {}) {
  const fields = compose(msg);
  sleep(2500);
  return { drafted: true, sent: false, ...fields, note: "Draft saved by Gmail autosave. Nothing was sent." };
}

// Compose and, only with confirm === true, click Send.
function send(msg = {}) {
  const fields = compose(msg);
  if (msg.confirm !== true) {
    sleep(2500);
    return { drafted: true, sent: false, ...fields, note: "Not sent. Call send({ ..., confirm: true }) after the user approves." };
  }
  // The Send button tooltip is "Send (Ctrl-Enter)"; "More send options" does not match.
  click('div[role="button"][data-tooltip^="Send"]');
  // The send has already happened once Send is clicked. The confirmation toast
  // is English-only and short-lived, so a missed toast must not report failure
  // (a retry would send the message twice).
  let verified = true;
  try {
    wait({ text: "Message sent" });
  } catch (_) {
    verified = false;
  }
  return { drafted: false, sent: true, verified, ...fields };
}

module.exports = { inbox, search, readThread, draft, send };
