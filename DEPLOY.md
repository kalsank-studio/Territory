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

**Records and stats count games against people only.** A game with a bot in any seat stays in the player's
match history (marked *not counted*) but adds nothing to their record (played, wins, losses, draws), their
Stats page, their public profile, the admin's Users tab or everyone's stats. A bot standing in for a player
who dropped doesn't make it a bot game. Each record also says how many bot games were left out (`vsBots`).

## The admin password (locks the Studio)

The Studio — cards, planets, decks, art & data — opens only after the admin password is typed in. The password is a **Cloudflare secret** called `ADMIN_PASSWORD`: it is stored encrypted by Cloudflare, never in your code or on GitHub, and the game never stores it either.

**Set it (or change it) in the dashboard:** Workers & Pages → **territory** → **Settings** → **Variables and Secrets** → **Add** → Type **Secret**, Name `ADMIN_PASSWORD`, Value your password → **Deploy**. Any characters work, symbols and spaces included.
**Or from a terminal:** `npx wrangler secret put ADMIN_PASSWORD` (it asks for the value, so it never lands in your shell history).

Until it is set, the Studio says no admin password exists and stays shut for everyone. A right password unlocks the Studio on that browser for 30 days; **Lock** in the Studio's top bar ends it. **Changing the secret signs every admin browser out at once** — do that if you think it leaked.

Guessing is slowed down on the server: 5 wrong passwords from one address and it must wait 15 minutes (doubling each time), and 50 wrong passwords from anywhere in an hour close the door for that hour. For trying it on your own computer, `wrangler dev` reads the secret from a `.dev.vars` file (`ADMIN_PASSWORD="…"`), which is in `.gitignore` — never commit it.

| Request | What it does |
| --- | --- |
| `POST /api/admin/login` | `{password}` → `{token}` (an admin session) |
| `GET /api/admin` | is this token an admin session? |
| `POST /api/admin/logout` | ends that session |
| `GET /api/admin/users[?after=]` | every listed account, 100 a page: name, emoji, joined, last seen, record, friends, sessions |
| `GET /api/admin/users/<u>` | one account in full: friends, requests, invites, sign-ins, every game |
| `GET /api/admin/users/<u>/games/<id>` | one game with its log, replay and comments |
| `GET /api/admin/matches[?after=&f=&q=]` | the match log, newest first, 40 a page. `f`: `all`, `people`, `bots`, `online`, `local`, `accounts`, `guests`, `sandbox`; `q`: a player name, username or match id |
| `GET /api/admin/matches/<id>` · `DELETE` | one match with its full log and replay · delete it |
| `POST /api/admin/stats/rebuild` | `{after}` — adds everyone's stats up again from every account, 25 accounts a call (the Studio's **Recount** button loops it) |
| `POST /api/matches` | `{match}` — a game page adds the match it just finished (no sign-in; 60 an hour from one address) |
| `GET /api/lobbies` | public rooms waiting to start with a free seat (no sign-in needed) |
| `POST /api/rooms/<code>/listing` | the host's device sets the room public/private and its settings (needs the host seat token) |

**Seeing every player:** unlock the Studio and open the **Users** tab (it only appears for an admin). Accounts show up once they have signed in or opened the game since 0.8. Passwords are never shown or sent — only a salted hash of each is stored, and nobody, admin included, can read it back.

**Seeing every match:** the **Matches** tab (admin only) lists every game finished on the site — see *The match log* below.

**Updating to 0.9.1:** upload `server/accounts.js`, `game/game.js` and `game/styles.css`, then set the secret above.

**Updating to 0.9:** upload `server/accounts.js` **and** `server/worker.js` (seats now carry each player's emoji) with the game files. Still no new migration. `GET /api/stats` (no sign-in) returns everyone's stats.

**Updating to 0.8:** upload `server/accounts.js` with the rest. There is no new Durable Object class or migration —
player search uses one more object of the `Account` class.
`BASE=https://territory.<your-name>.workers.dev node test/test-accounts.mjs` checks a deployed copy (it makes
a throwaway account each run).

**How safe it is.** Passwords are stored hashed (PBKDF2-SHA-256 with a salt), never as plain text, and the
site is HTTPS. But there's no limit on login attempts, no password reset, and no way to delete an account
from the game yet. Fine for friends; tell players not to reuse a password that matters. To see or remove
accounts, use the Cloudflare dashboard (Workers & Pages → territory → Durable Objects).

## The match log (0.9.5)

Every game finished on the website goes to a log only the admin can read: **Studio → Matches**.

- **What's kept:** local games and online games, signed in or not, with bots or without, and sandbox games
  (marked). Not the tutorial, not replays, and not games quit before the end. For each: who sat in each seat
  (name, emoji, bot or not, and the account that played it, if any), when it started and ended, mode,
  rounds, planets and their scores, the winner and why, the **whole game log** — including lines only one
  player saw, marked 🔒 with who saw them — and the **replay**.
- **Who sends it:** the device that ran the game — on one device, that device; online, the host (it holds
  the whole game; guests never send it). A browser that's offline keeps the match and sends it next time
  the page is open and online. A copy of the game opened from a file has no server and sends nothing.
- **Usernames are checked, not claimed.** A seat shows `@username` only when that account's own device
  saved the game to the account — so a match shows exactly who was signed in, and nobody can type someone
  else's name into it.
- **In the Studio:** filter (people only, with bots, online, on one device, with accounts, no accounts,
  sandbox), search by player name, username or match id, open a match for its seats, planets and log, then
  **▶ Watch replay** (back to the match afterwards), **Export game** (the same file the Replay page loads) or
  **Delete**.
- **Limits:** the newest **2,000** matches are kept (the oldest go first); one match can be up to about
  600 KB; one address can send 60 an hour. It all lives in one more object of the `Account` class,
  `~matches` — **no new Durable Object class, binding or migration**.
- **Anyone can send a match.** Like the rest of this version, the log trusts the game page: someone who
  knows how could post made-up matches (60 an hour). The account links can't be faked, and the admin can
  delete anything that looks wrong.

## Updating to 0.9.5

Upload these to GitHub (same paths), and the next deploy does the rest — **no new secrets, bindings or
migrations**:

- `server/accounts.js` — the match log, and records/stats without bot games
- `game/game.js`, `game/styles.css` — sending matches, the Studio's Matches tab, the Profile note
- `test/test-matches.mjs`, `test/test-matches-ui.py`, `test/test-matches-online.py` (new),
  `test/test-social.mjs`, `test/test-admin-users.py` (their games now have people as opponents), `package.json`,
  `README.md`, `DEPLOY.md`

**Then, once:** unlock the Studio → **Matches** → **Recount everyone's stats**. Everyone's stats were added up
game by game as they came in, so the bot games already in there stay until they're recounted from every
account. Players' own records and Stats pages are counted fresh each time and change straight away.

Matches start arriving from the first game finished after the deploy; games from before it aren't in the log.

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


## 0.9.4 upload

Upload `server/worker.js`, `server/accounts.js`, `game/game.js` and `game/styles.css`. No new secrets, bindings or migrations: the lobby registry lives in a `~lobbies` object of the existing `Account` class.
