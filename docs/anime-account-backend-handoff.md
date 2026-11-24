# Anime like/save — backend contract

An anime card has no record in our own catalogue: it comes from the anime service
(`GET /api/hen/city/recent`, `…/popular/:page`), and its id belongs to that source.
The frontend therefore never sends that id to our API as if it were ours.

The account keeps the entry itself, in the **same lists it already has**:

| | catalogue video | anime title |
| --- | --- | --- |
| route | `POST /api/videos/:id/like` / `…/save` | same route |
| id | the catalogue id (`AbC123xyz`) | `anime-<source slug>` (e.g. `anime-one-wife-1-OneWife001x`) |
| stored in | `likedVideos` / `savedVideos` | `likedVideos` / `savedVideos` |
| list entry | the id, as today | an object: `{ "id": "anime-…", "anime-title": "One Wife 1", "anime-thumbnail": "https://…jpg" }` |

## What the frontend sends

```http
POST /api/videos/anime-one-wife-1-OneWife001x/like
Authorization: Bearer <firebase id token>
Content-Type: application/json

{ "active": true, "anime-title": "One Wife 1", "anime-thumbnail": "https://cdn1.images.hentaicity.com/videos/0739/38322/main.jpg" }
```

- `active` is the **desired** state, so a retried request cannot undo a like. The
  same field already arrives for catalogue videos; older backends ignore the body
  and toggle, which the app tolerates.
- The id is `[A-Za-z0-9_-]{1,128}` and always starts with `anime-`. Everything after
  that prefix is the source's own slug, so it can be read back into a title.
- `anime-title` is a plain string (≤140 chars) and `anime-thumbnail` is a plain
  `https` image URL (`.jpg`, `.jpeg`, `.png` or `.webp`). No media URL, no stream
  link and no source id is sent — the entry is metadata only.

## What the backend must answer

Exactly the shape it answers today for a catalogue video:

```json
{ "ok": true, "data": { "liked": true, "likedVideos": [ "AbC123xyz", { "id": "anime-one-wife-1-OneWife001x", "anime-title": "One Wife 1", "anime-thumbnail": "https://…jpg" } ] } }
```

- `liked` (or `saved`) is the new state; the app reads it and ignores the rest of
  the sentence.
- `likedVideos` / `savedVideos` is optional but preferred: when present the app
  replaces its list with the answer, so nothing drifts. A compact answer
  (`{ "liked": true }`) is also accepted — the app applies the change itself.
- `likes` and `version` are not expected for an `anime-…` id; the app never polls a
  like count for one and draws no count on the card.

## What `/api/auth/me` must return

The same list, unchanged as a list — some entries are strings, some are objects:

```json
{ "ok": true, "data": { "user": {
  "uid": "…", "username": "viewer", "referralCode": "REF-OWN001",
  "likedVideos": [ "AbC123xyz", { "id": "anime-one-wife-1-OneWife001x", "anime-title": "One Wife 1", "anime-thumbnail": "https://…jpg" } ],
  "savedVideos": [ { "id": "anime-one-wife-1-OneWife001x", "anime-title": "One Wife 1", "anime-thumbnail": "https://…jpg" } ]
} } }
```

The app accepts `likedAnime`/`savedAnime` as separate arrays too, but one mixed list
is simpler and keeps the account record as it is today.

## Rules the backend must keep

1. **Prefix decides.** Anything starting with `anime-` is an external entry. Never
   resolve it against the catalogue, never count a view, never hand out a stream
   link, and never let it collide with a catalogue id.
2. **Validate before storing.** Reject an entry without an `anime-` id, a title, or
   an `https` poster URL; cap the title at 140 chars and the list at its current
   limit. The app validates the same way and drops what does not pass, so a bad row
   can never be drawn.
3. **Same list, same limits.** One like list and one save list per user, as now. No
   second table and no new endpoint are needed.
4. **Idempotent writes.** Honour `active` (set the state, do not flip it). This is
   the one change worth making for catalogue videos too.
5. **Nothing else is stored.** No source id, no page URL, no stream URL, no title of
   a title we do not host — the two metadata keys above are the whole entry.

## What the frontend does with it

- An `anime-…` id is filtered out of the catalogue ids, so the dashboard never
  reports it as "currently unavailable".
- Each anime entry is drawn from its own stored title and poster
  (`animeCardFromSaved`), in the same grid as our videos, with its like/save state
  already pressed. A category whose title the page has not loaded still appears.
- Pressing the pressed button again sends `active: false` on the same route and the
  entry disappears from the list.
- Because the entry carries its poster, the dashboard makes **no** request to the
  anime service to draw it.

Tests: `test/anime-api.test.mjs` (id and metadata, drawing back a stored entry),
`test/anime-account-browser.test.mjs` (guest → sign-in, one write per press with the
exact body, both lists, dashboard, removal) and `test/account-browser.test.mjs`
(an `anime-…` entry survives `/api/auth/me`, counts in the heading, is drawn, and is
removed with `active: false`).
