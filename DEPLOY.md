# Putting Territory on the web

Everything runs on one free Cloudflare Worker:

- **The game page.** `npm run build` writes `dist/`: the whole game as one `index.html`, plus `library.json`
  (the cards a first-time visitor starts with) and any sprite files in `game/art/`. Cloudflare serves these
  files directly. Requests for static files are free and unlimited.
- **Player accounts.** `server/accounts.js` keeps each player's name, record and match history under a
  username and password, so their Profile follows them to any browser. One Durable Object per account.
- **The room relay.** `server/worker.js` answers `/api/…` only. It makes rooms with five-letter codes and
  passes messages between the players in a room. Each room is a Durable Object; the free plan allows
  100,000 requests a day, and an idle room costs nothing.

You need free GitHub and Cloudflare accounts. You'll get an address like
`https://territory.<your-name>.workers.dev`. Open it on two phones, tap **Play → Make a room** on one
and type its code (or open the invite link) on the other.

## Route A — from GitHub (every push goes live; nothing to install)

1. On github.com: **New repository** → name it `territory`, **Private**, create. On the empty repo's page
   choose **uploading an existing file**, drag in everything inside this folder (including the `game`,
   `server`, `test` and `cards` folders), and **Commit changes**.
   (If your computer hides `.gitignore`, that's fine — it only keeps build output out of the repo.)
2. On dash.cloudflare.com: **Workers & Pages → Create → Import a repository** (connect GitHub when asked,
   and allow it to see the `territory` repo). Pick the repo.
3. In the build settings:
   - **Project name:** `territory` — it has to match `"name"` in `wrangler.json`. (Pick another name? Change it
     in both places.)
   - **Build command:** `npm run build`
   - **Deploy command:** `npx wrangler deploy` (the default)
   - Root directory: leave blank.
4. **Save and Deploy.** The first build takes a minute or two; the log ends with your `workers.dev` address.
   From then on, every commit to the main branch (including edits made on github.com) redeploys by itself.

## Route B — from your computer (about 15 minutes, first time)

1. Install **Node.js** (the LTS version) from nodejs.org.
2. Unzip this folder somewhere, open a terminal in it, and run:
   ```
   npm install
   npx wrangler login        # opens a browser: sign in to Cloudflare and allow access
   npm run deploy            # builds dist/ and uploads it with the relay
   ```
3. The first deploy asks you to pick your `workers.dev` subdomain. When it finishes it prints the address.
   Open it on your phone: the game should load with your card library.

To update later: change files, then `npm run deploy` again. (Use one route or the other for a given
Worker; with Route A set up, just push to GitHub.)

## Trying it on your own computer first

```
npm install
npm run dev                  # builds, then serves page + relay at http://localhost:8787
npm test                     # checks the relay end to end, then plays whole games headless
```

With `npm run dev` running, open http://localhost:8787 in two different browsers (or one normal window and
one private window — each needs its own storage) to play yourself online. `test/test-online.py` does that
automatically with Playwright: lobby, a whole game, hidden hands, a dropped connection, reloads on both
sides, a bot standing in, and a three-player game.

`BASE=https://territory.<your-name>.workers.dev node test/test-relay.mjs` runs the relay checks against the
live copy.

## Your card library

A visitor's first visit starts from `game/library.json`; after that, their own edits stay in their browser.
The one shipped now was built from your card list (`cards/territory-cardlist.csv`) plus the built-in set,
with a **Card list** deck holding one of each of your cards.

To ship exactly what you have in the studio — your decks, planets and uploaded sprites included:

1. In the game: **Studio → Art & data → Download a backup**.
2. Save the file as `game/library.json`, replacing the one there.
3. Deploy again.

People who visited before keep their own copy. They can take the new one from
**Studio → Art & data → Take this site's card library**.

Only have a spreadsheet? `npm run library -- cards/your-list.csv "Deck name"` rebuilds `library.json` from
a CSV with the same importer the studio uses, and lists any rows it flagged.

**Sprites as files.** Put images in `game/art/` and point cards at them as `art/name.png` (the studio's
art field, the sprite pack, or the CSV's `art` column). They're copied into `dist/art/` on build.

## The relay, in short

| Request | What it does |
| --- | --- |
| `POST /api/rooms` (body `{"seats":2}`, up to 4) | Makes a room. Returns `{"code":"KX7QA","seats":2}`. |
| `GET /api/rooms/KX7QA` | Who's in it and who's connected; 404 if there's no such room. |
| `GET /api/rooms/KX7QA/socket?name=Kal&token=…` | A WebSocket into the room. First in is the host (seat 0). |

On the socket: send `{"data": …}` (a guest's goes to the host, the host's to everyone else) or
`{"to": 1, "data": …}` for one seat. You receive `{"from": seat, "data": …}`, plus
`{"sys":"welcome", seat, token}` when you join and `{"sys":"seats", …}` when anyone comes or goes.
Keep the `token`: reconnecting with `?token=…` puts you back in the same seat. Send `"ping"` every
half minute or so to keep a phone's connection open; it's answered `"pong"` without waking the room.
A room with nobody connected for a day deletes itself.

## Accounts

Nothing to set up: the next deploy adds them (`wrangler.json` has a second Durable Object, `Account`, with
its own migration, `v2`). Players open **Profile → Sign in / Create account**. Games already recorded in that
browser are added to the account, and every game finished while signed in is saved to it — online games
for each player on their own device, local games for the signed-in player. A browser that's offline keeps
the games and saves them when it's back.

| Request | What it does |
| --- | --- |
| `POST /api/account/register` · `/login` | `{username, password}` → `{token, username}` |
| `GET /api/account` | name and match history (without logs) |
| `PUT /api/account` | `{name}` — the display name |
| `POST /api/account/games` | `{games:[…]}` — adds finished games; one already there is kept once |
| `GET /api/account/games/<id>` | one game with its log |
| `DELETE /api/account/games` · `POST /api/account/logout` | clear the history · sign this browser out |

| `GET /api/social` · `/api/social/poll` | friends (with records), requests both ways, invites · just the request count and invites |
| `POST /api/social/request` · `accept` · `decline` · `remove` | `{user}` — friend requests (25 friends at most) |
| `POST /api/social/invite` · `dismiss` | `{user, code}` — invite a friend to a room · `{code}` — clear an invite |
| `GET /api/users?q=` · `/api/users/<u>` | search usernames · a player's name, record and last 30 games |
| `GET /api/users/<u>/games/<id>` | one game with its log, replay and comments |
| `POST` · `DELETE /api/users/<u>/games/<id>/comments[/<cid>]` | `{text}` — add a comment (10 per game) · delete one (the game's owner, or whoever wrote it) |

Everything except register and login sends `Authorization: Bearer <token>`.
`node test/test-social.mjs` (or with `BASE=…`) checks the social routes.

**Updating to 0.8:** upload `server/accounts.js` with the rest. There is no new Durable Object class or migration —
player search uses one more object of the `Account` class.
`BASE=https://territory.<your-name>.workers.dev node test/test-accounts.mjs` checks a deployed copy (it makes
a throwaway account each run).

**How safe it is.** Passwords are stored hashed (PBKDF2-SHA-256 with a salt), never as plain text, and the
site is HTTPS. But there's no limit on login attempts, no password reset, and no way to delete an account
from the game yet. Fine for friends; tell players not to reuse a password that matters. To see or remove
accounts, use the Cloudflare dashboard (Workers & Pages → territory → Durable Objects).

## How online play works

- **Play → Make a room.** Your device becomes the host: it runs the game, and the relay just passes
  messages. Send the five-letter code or the invite link (it opens the join screen with the code filled in).
- **The lobby.** Everyone picks a deck from the host's library (the decks the site ships, plus any the host
  has made). The host sets planets, rounds and the timers, and starts once at least one friend is in;
  empty seats are played by bots.
- **In the game,** everyone places at once on their own device, then cards turn over in turn order. Each
  device only receives what its player may see: other hands, decks, and face-down cards never leave the
  host. The host's turn and choice clocks run for everyone.
- **Connections drop.** A player who loses signal or reloads goes straight back to their seat. The host
  sees who's away and can **Let a bot play** for them; it hands the seat back when they return. If the
  host reloads, their game is picked up from the last settled moment and everyone carries on. A room
  with nobody in it for a day disappears.
- **After the game,** the host can take everyone back to the lobby for another.

## Limits of this version

- **Light security.** Anyone with a room code can join an open seat, and the host's browser holds the whole
  game (a host who opens the developer tools can see everything). Fine for friends; not for strangers or
  ranked play. That needs the game to run on the server instead — the engine is ready for it
  (`dispatch` / `playerView`), it's the next big step after this one.
- **Decks come from the host's library.** A guest's own studio cards don't travel yet.
- **One message is at most 1 MB.** Game views carry each card's art, but every image goes to each guest
  only once. With many large uploaded sprites, put the images in `game/art/` (sent as a short path)
  rather than uploading them into the library.
- **Free-plan numbers.** The Durable Objects free tier allows 100,000 requests a day. A two-player game
  is a few hundred messages, so that's hundreds of games a day.
