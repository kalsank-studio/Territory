# Putting Territory on the web

Everything runs on one free Cloudflare Worker:

- **The game page.** `npm run build` writes `dist/`: the whole game as one `index.html`, plus `library.json`
  (the cards a first-time visitor starts with) and any sprite files in `game/art/`. Cloudflare serves these
  files directly. Requests for static files are free and unlimited.
- **The room relay.** `server/worker.js` answers `/api/…` only. It makes rooms with five-letter codes and
  passes messages between the players in a room. Each room is a Durable Object; the free plan allows
  100,000 requests a day, and an idle room costs nothing.

You need a free Cloudflare account. You'll get an address like `https://territory.<your-name>.workers.dev`.

## Route A — deploy from your computer (about 15 minutes, first time)

1. Install **Node.js** (the LTS version) from nodejs.org.
2. Unzip this folder somewhere, open a terminal in it, and run:
   ```
   npm install
   npx wrangler login        # opens a browser: sign in to Cloudflare and allow access
   npm run deploy            # builds dist/ and uploads it with the relay
   ```
3. The first deploy asks you to pick your `workers.dev` subdomain. When it finishes it prints the address.
   Open it on your phone: the game should load with your card library.

To update later: change files, then `npm run deploy` again.

## Route B — deploy from GitHub (every push goes live)

1. Make a new **private** repository on github.com and upload this folder's contents
   (drag the files into the web page, or `git push`). `node_modules/` and `dist/` are ignored on purpose.
2. In the Cloudflare dashboard: **Workers & Pages → Create → Import a repository**, and pick it.
3. Set the **build command** to `npm run build` and leave the **deploy command** as `npx wrangler deploy`.
4. Save and deploy. From then on, every push to the main branch redeploys.

## Trying it on your own computer first

```
npm install
npm run dev                  # builds, then serves page + relay at http://localhost:8787
npm test                     # checks the relay end to end, then plays whole games headless
```

`BASE=https://territory.<your-name>.workers.dev node test/test-relay.mjs` runs the relay checks against the
live copy.

## Your card library

A visitor's first visit starts from `game/library.json`; after that, their own edits stay in their browser.
The one shipped now was built from your card list (`cards/territory-cardlist.csv`) plus the built-in set,
with a **Card list** deck holding one of each of your cards.

To ship exactly what you have in the studio — your decks, planets and uploaded sprites included:

1. In the game: **Art & data → Download a backup**.
2. Save the file as `game/library.json`, replacing the one there.
3. Deploy again.

People who visited before keep their own copy. They can take the new one from
**Art & data → Take this site's card library**.

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

## What this version doesn't do yet

- **The game doesn't use the relay yet.** That's the next step: a "Play online" screen that makes or
  joins a room, and the host's game sending each guest their `playerView` after every move.
- **No security.** Anyone with a room code can join it, and the host's browser holds the real game.
  Fine for playing with friends; not for strangers or ranked play.
- **One message is at most 1 MB.** Game views carry each card's art; with many large uploaded sprites, put
  the images in `game/art/` (sent as a short path) rather than uploading them into the library.
