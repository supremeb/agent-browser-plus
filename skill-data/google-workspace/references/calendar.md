# Google Calendar

## Reading the agenda

`calendar.agenda({ days })` opens `https://calendar.google.com/calendar/r/agenda` and returns days with their events, each event as `{ id, text }` where `text` is the visible summary (time, title, location). Agenda view starts at today. To start elsewhere, open a date path first:

```js
open('https://calendar.google.com/calendar/r/agenda/2026/11/2');
wait('[role=main]');
return evalPage(`Array.from(document.querySelectorAll('[data-eventid]')).map(e => e.innerText.replace(/\\s+/g, ' '))`);
```

Other useful views: `/r/day/YYYY/M/D`, `/r/week/YYYY/M/D`, `/r/month/YYYY/M/D`.

## Event details

Click an event to open its detail card, then read it:

```js
click('[data-eventid="<id>"]');
wait('[role=dialog]');
return text('[role=dialog]');
```

## Creating events

`calendar.createEvent({ title, start, end, details, location })` opens the event editor prefilled through the template URL:

```
https://calendar.google.com/calendar/r/eventedit?text=<title>&dates=<start>/<end>&details=<text>&location=<text>
```

`dates` uses `YYYYMMDDTHHMMSSZ` in UTC for timed events and `YYYYMMDD` for all-day events (end date exclusive). Without `confirm: true` the editor is left open and unsaved, so the user can look at it. With `confirm: true` the helper clicks Save.

Adding guests sends invitations as soon as the event is saved. If the user asks for guests, add them in the editor through refs (`snapshot -i`, the "Add guests" field) and confirm before saving. Calendar may then ask whether to email guests; ask the user which option to pick.
