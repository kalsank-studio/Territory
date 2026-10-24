# Territory — prototype

A playable implementation of the Territory design doc: six rounds, face-down
placement, ordered reveal, planet slots with conditions and rewards, plus a
studio for editing content and a deck builder.

The game itself has no dependencies: open `game/index.html` in a browser
(double-clicking works, `file://` is fine). Only Google Fonts is fetched from the
network, and the game still runs without it. Putting it on the web, with online
rooms, is in **[DEPLOY.md](DEPLOY.md)**.

## Files

| Path | What's in it |
| --- | --- |
| `game/index.html` | Page shell. Two divs: `#app` for the current screen, `#overlay` for veils and sheets. |
| `game/styles.css` | All styling. Theme tokens live at the top. |
| `game/game.js` | Everything else, in eight numbered sections (see below). |
| `game/library.json` | The card library a first-time visitor to the website starts with (cards, tokens, planets, decks). Replace it with a *Studio → Art & data* backup to ship your own. Opened from `file://`, the game skips it and uses the built-in set. |
| `game/art/` | Sprite images, referenced from cards as `art/name.png`. |
| `cards/territory-cardlist.csv` | The card list as a table; `npm run library -- cards/territory-cardlist.csv "Card list"` rebuilds `game/library.json` from it. |
| `server/worker.js` | The online room relay: a Cloudflare Worker and one Durable Object per room. See DEPLOY.md. |
| `server/accounts.js` | Player accounts: one Durable Object per username, holding the name, record and match history. Also the admin's match log (`~matches`). |
| `build.js` | `npm run build`: writes `dist/` — `index.html` with the CSS and JS inlined (also a working offline single file), `library.json`, `art/`. |
| `build-library.js` | Turns a card CSV into `game/library.json` with the studio's own importer. |
| `wrangler.json`, `package.json` | Cloudflare config and the `build` / `dev` / `deploy` / `test` scripts. |
| `test/` | `npm test` runs `test-relay.mjs` (the relay end to end against a local Worker) and `test-games.js` (whole games in every seating). Also `test-online-prep.js` (commands, replays, player views), `test-timer-sandbox.js` (turn timer, sandbox bench), `smoke.py` (the real page in Chromium via Playwright). `test-ui-changes.py` checks the card reader's token links, rearranging at the end of the reveal turn, ability pop-ups and their timer, and the Game End screen, in Chromium against a served `dist/`. `test-accounts.mjs` checks the account API and `test-accounts-ui.py` signs in from two browsers; `test-round4.py` covers the mulligan, unlocking, the top bar, the passive mark and glow, the draw trigger and the Profile; `test-round3.py` covers the Play menu, the round-open screen, optional effects, discards and summoning onto a slot; `test-contrast.py` checks text contrast everywhere. `test-social.mjs` and `test-social-ui.py` cover friends, invites and comments; `test-tutorial.py` plays the tutorial. `test-online.py` plays online in real browsers through a local Worker (lobby, a whole game, hidden hands, dropped connections, reloads on both sides, a bot standing in, three players). `test-matches.mjs`, `test-matches-ui.py` and `test-matches-online.py` cover the match log (see *Match log* at the end). See *Online play* below. |
| *(older)* | The earlier headless suites (`test-targeting.js`, `test-abilities.js`, `test-flow.js` and the rest) live with the original prototype files, not in this folder. |

## Layout of `game.js`

1. **Constants and default content** — `RULES`, the verb and target tables, and the
   starter cards, tokens and planets.
2. **Persistence** — one `localStorage` key holds the whole library. `blankLibrary()`
   is the shape.
3. **Helpers** — condition evaluation, ability text generation, card instancing.
4. **Game engine** — `newGame`, `startRound`, `harvest`, placement, reveal, scoring.
   - **4b. Commands** — `dispatch(cmd)`, the one way any move enters the game.
   - **4c. What each player may see** — `playerView(state, seat)`, `emit`, `stateDigest`.
5. **Ability engine** — `resolveTargets` and `applyEffect`. The effect queue pauses
   for player choices (currently only Discard) and resumes from `resolveDiscard`.
6. **Bot** — greedy placement, weighted toward slots whose condition it meets and
   planets it is losing.
7. **Rendering** — one `render()` rebuilds the screen from state; no framework.
8. **Events** — delegated click, input and change handlers keyed off `data-act`, plus the
   pointer drag system (`startDrag` / `moveGhost` / `endDrag`) and `dropSelected`, the one
   resolver both the tap path and the drag path go through.

## Changing the rules

Round count, hand size, income and slots per player are in `RULES` at the top of
`game.js`. Round count is also exposed in the setup screen; the others are not, so
change them here.

## Mulligan and unlocking

- **One mulligan.** In round 1, while it's your placement turn and before you've
  placed a card, **New hand** (tap twice) shuffles your whole hand into your deck and
  deals the same number again: `{t:'mulligan', seat}`, once per player per game
  (`p.mulled`). Nothing triggers — it's the opening hand dealt again. On by default; a
  switch in the local setup and the online lobby (`settings.mulligan`, `G.mulligans`).
  Bots keep their hands.
- **Unlocking.** Placing at once, a player who has locked in can press **Unlock** while
  anyone else is still placing: `{t:'unlock', seat}`. Once the last player locks in, the
  reveal begins and it can't be taken back.

## The top bar

Three columns: Energy on the left, the round centred (`.hud-mid`: "Round **N** of 6"
at 20–24 px, the phase under it), the tools on the right.

## Profile

Title → **Profile** (`viewProfile`, section 10 of `game.js`). Signed out, it's kept in
this browser under `territory.v1.profile`, apart from the library. **Signed in**
(username and password, `server/accounts.js`), it's kept on the server and follows the
player to any browser:

- `signIn` registers or logs in, adds this browser's own games to the account (by
  id, so nothing is kept twice), then `syncAccount` loads the account's name and
  history (games without their logs; `fetchLog` gets one when it's opened). The
  token is kept under `territory.v1.account`, and a copy of the account under
  `territory.v1.profile.account`, so it shows at once and works offline.
- A game finished while signed in goes into `PROFILE.pending` and up with
  `flushPending` — straight away, or when the browser is next online. A name change
  is sent after a short pause (`pushName`). A 401 from the server signs the browser out.
- Signing out shows this browser's own profile again.

The parts:

- **Your name** (`PROFILE.name`). It fills in the first human seat at a local table and is
  your name online (the Play screen's name field is the same setting).
- **Record**: played, wins, losses, draws, win rate — tiles across the top. Games against
  people only: a game with a bot in it is in the history but not counted (see 0.9.5 at the end).
- **Match history**: every finished game, newest first (`recordGame`, called from
  `finishGame` on this device or the host, and from `guestView` when a guest sees the
  game end), up to 200: result, opponents (bots marked), local or online, when, and
  planets won ("3–2": yours, then the best of the rest). Tap one for each planet's final
  Power and the game log — the log as you could see it, kept for the last 30 games
  (`LOGS_KEPT`; if storage runs out, older logs go first). Sandbox games and replays
  aren't recorded. In a local game with several people, the record is for the seat with
  your name (the first human seat).
- Games are told apart by `G.gameId`, which isn't part of the rules (left out of
  `stateDigest`). Each entry also carries its stats and replay (see *What's new in 0.8*).

## Choices on the board, optional effects, discards

- **Summoning picks a slot.** When a person summons (a token, a graveyard card, "that
  card") and more than one open slot is allowed, `summonAt` opens
  `G.choice = {kind:'pickslot', side, options:[[planet, slot], …]}`. There's no pop-up:
  the board shows the allowed open slots glowing (`.slot.summon-target`, ✓ when the
  token would meet the slot's condition) and only those can be tapped. One allowed
  slot, a bot, or "on a random planet" doesn't ask. If the person choosing isn't the
  one looking at the board (a passive on someone else's turn), a sheet lists the slots.
- **Optional effects.** Any effect can be marked optional (Studio: *Optional — ask
  first, with a Skip button*; text: "You may …", or "(optional)" after "in order
  to"). Before it fires, its owner gets *Use it* / *Skip* (`kind:'optional'`).
  Skipping counts as not working, so an "in order to" after it is skipped too. Bots
  always use it; a timed-out choice uses it.
- **An opponent's discard is shown.** A card discarded from a hand that isn't on
  screen turns up face up under the top bar with "<name> discards", holds for
  `REVEAL_HOLD` (650 ms), then crumbles like any discard (`fxRevealVanish`). Online,
  guests get the card's face from the graveyard in the new view.
- **Wording.** One of your own cards that you pick reads "your card of choice"; an
  enemy one "an enemy card of your choice". Both read back through the importer.

## Contrast

Every text colour is checked against what's drawn behind it. The board and the
full-screen beats are always dark, so they redefine the `--ui-*` tokens to the dark
set (anything on them, buttons included, gets light text); menus and sheets follow
the light / dark theme. Buttons take `--ui-text`, never the colour around them.
`test/test-contrast.py` measures every visible piece of text on every screen, in
light and dark, from a screenshot with the text hidden (so gradients and scrims
count), against WCAG AA (4.5:1, or 3:1 for large text).

## Game End

On the final round, round-end abilities resolve first. Then, if any face-up card
has an "at the end of the game" ability, `endOfRoundContinue` shows a Game End
screen (`gameEndScreenHTML`, the round screen's frame, `GAME_END_MS` or a tap)
listing those cards in the order they'll fire (2.5 s, or a tap), and `fireGameEnd` runs them; choices
they ask for come up as usual. `G.gameEndDone` makes sure that happens once. Then the
Final tally beat and `finishGame`. With no Game End cards in play the screen is
skipped.

## Timing

Two constants near the top of section 4:

- `PAUSE` (1000ms) — every held beat between phases, players and rounds. One value
  for all of them, so the rhythm of a round is learnable rather than incidental.
  The beat is a bar that drops in over the top of the board naming who is up; the
  board stays visible underneath but does not take input for that second.
- `FLIP_MS` (460ms) — the card turn. Keep it in step with the `.flip-inner`
  transition in `styles.css`; the CSS runs the animation, the JS waits for it and
  then resolves the card.

## Whose side the board is on

`viewerIdx()` decides whose seat the board is drawn from. With exactly one human
at the table (`lockedSeat()`), it always returns that seat — bots play in the rows
above and the human's row never moves, so the device never has to physically turn
around during a solo game. With two or more humans it falls back to whoever's
turn it is, which is how pass-the-device hot-seat still swaps sides properly.

The turn bar at the top always names whoever is actually acting, in their colour,
even when that isn't the seat the board is drawn from — so during a bot's turn you
see "Nimbus Reach playing…" in the bot's colour while your own row stays put
underneath. `myTurn()` is `viewerIdx() === currentPlayer().idx`; every placement
control (`placing()`, the drag system's `draggableNow()`, the flip button) is
gated on it, so nothing responds to your taps while you're only watching.

## Handling a card

Every placement goes through `dropSelected(player, planetIdx, slotIdx)`, whichever
way the player got there:

- **Tap** a hand card, then a slot. Tap a card you have already committed to lift it
  again, then tap another slot to move or swap it, or use *Return to hand*.
- **Drag** a hand card upward out of the hand (sideways still scrolls the row), or
  drag a committed card anywhere: another slot on the same planet, a slot on a
  different planet, another committed card to swap the two, or back onto the hand
  to take it back. Dropping on a planet but not squarely on a slot uses the first
  free slot of yours there, so a near miss on a phone still lands.

A live drag never calls `render()`. A touch pointer is implicitly captured by the
element it started on, so rebuilding the DOM mid-gesture takes that element out from
under the finger and the drag dies on the first move — which is exactly what happens
on a tablet even though jsdom, having no implicit capture, is perfectly happy. The
board is decorated in place instead: `decorateFor(card)` adds the highlight classes,
reading each slot's condition back out of its `data-cond` attribute. `test-drag.js`
guards this by asserting the source element is still in the document mid-drag.

Nothing is paid until the card flips, so rearranging a committed card is free
right up to *Lock in*.

**Reading a card.** Press and hold any visible card for 450 ms (moving more than
8 px cancels, so drags and scrolls are unaffected) or right-click it, and
`inspectCard(uid)` opens `inspectSheetHTML`: the card full size, rarity / owner /
where it is, current vs printed Power, the full ability text and a glossary built
by `glossaryFor(fx)` from the `GLOSSARY` table — only the words that card actually
uses (its verbs, target rules, conditions, filters, triggers, activation). It works
at any moment, including over an open choice (the choice comes back when it's
closed) and during animations. An opponent's face-down cards and hand return
`false` and stay hidden. The click that ends a hold is swallowed (`HOLD.ate`).

**What made it, what it makes.** `insTokensHTML` adds rows under the card text. A
token shows **Created by**: the card whose Create or Summon made it (`card.creator`
uid, with `card.creatorName` kept for when that card has left the game), tappable,
with where it is now. A token with no recorded maker (added in the sandbox, or read
from the library) lists every library card that makes it (`makersOf`). A card whose
abilities Create or Summon tokens shows **The token it makes** (`tokensMadeBy`, which
walks Choose options too). Rows open that card's reader (`inspectDef` for a library
definition); the ← in the header walks back (`UI.peekStack`).

**Picking from the board.** When a human chooses a card that is already on a
planet (`G.choice.kind==='pickcard'` with purpose `board` or `swap`, and the chooser
is the one looking: `boardPicking()`), there is no sheet. `slotHTML` marks cards in
`G.choice.pool` `.pickable` with `data-act="targetcard"` and every other face-up
card `.unpickable` (greyed), the board gets `.is-picking` (the hand dims), and
`pickBannerHTML` puts a banner at the bottom saying what's being chosen. Hand and
graveyard picks keep their sheets.

**Ability pop-ups.** Every choice sheet (`choiceSheetHTML`, class `.sheet.choice`)
opens with `choiceSrcHTML`: the card whose ability is asking (`choiceSource`, from
`ch.ctx.uid` — tap it to read it), whose ability it is, and the choice clock. There
is no graveyard button in a pop-up. Instead `choiceSideHTML` puts a tab on the right
edge: **Board** sets the choice aside (`UI.choicePeek = G.choice`) so the whole board
is there to look at — read any card, open the graveyard from the top bar — and the
same tab, now **Choice** with the clock under it, brings it back. Board picking
(the banner) gets the same tab. A new choice always opens in front.

**Choice timer.** With the turn timer on, a choice a person on this device has to
answer (`timedChoice()`) gets its own clock, `LIB.settings.choiceTimer` seconds
(default 30; setup offers 15 s to 1½ min under *Ability choice timer*).
`tickChoiceTimer` runs before the turn clock and, while it's running, the turn clock
stands still. At zero (`timeOutChoice`) the choice is made at random, every tick,
until it closes — so "discard two" makes both picks. If the turn's own time is
already up, its choices don't wait.

**"Of your choice" excludes the card itself.** `resolveCardTarget` (and the
recipient check for Steal) drop `ctx.uid` from a `choice` pool; an empty pool fails
the effect, so a card with nothing else to pick does nothing. Random / strongest /
weakest rules can still land on the card itself.

**Turn timer.** `LIB.settings.turnTimer` (seconds, 0 = off; setup offers presets
or a custom 10–900). A 200 ms interval runs `tickTimer()`: the clock is keyed to
`round:phase:player` and resets when that changes; only human turns are timed;
it stands still while `timerPaused()` (hand-over veil, transitions, round screen,
flips, animations). At `TIMER_WARN` (10 s) the turn-bar pill `[data-timer]` turns
red and pulses and a toast says so. At zero `autoCompleteTurn()` runs on every tick
until the turn has moved on: it closes the reader, makes any open choice at random
(`autoResolveChoice`), then ends placement (`endPlacementTurn`) or, in a reveal,
sets `G.revealDone` and flips whatever is still face down (`autoFlipAll`).

Cards already turned over can be rearranged too, but on a shorter leash: **only at
the end of your own reveal turn** (everything of yours face up, before End turn), you
can move one to any other slot on the *same planet* — never to a different planet,
and never back to your hand, since it has already been paid for and has already
banked whatever it earned or spent. During placement revealed cards stay put. Lift
one and all three of your slots on its planet light up (`.slot.dest`, or `.open` when
empty) while your slots elsewhere step back (`.blocked`); dropped on an occupied slot,
the two cards swap. This is
what lets you react to a slot's condition changing (a fresh card landing next to
it, say) without breaking the fiction that a card, once revealed, has taken its
ground. `pickupKind(player, planetIdx, slotIdx)` returns `'committed'`,
`'revealed'`, or `null`, and both the tap path and the drag path read it before
deciding where a card is allowed to land. Set `RULES.rearrangeRevealed = false`
to turn this off and nail every revealed card to its slot instead.

**The end of a reveal turn.** With `RULES.revealEndTurn` (on), a human's reveal
turn doesn't end when their last card flips: `afterFlip` waits for `G.revealDone`,
which only **End turn** (`endReveal`) or the turn timer sets. Meanwhile
`rearranging()` is true and revealed cards move between slots on their own planet
(tap to lift, tap a slot or another card to move or swap, or drag; `arranging()` = `placing() || rearranging()` gates the drop zones and
`draggableNow`), and ⚙ abilities can be activated. `skipEmptyRevealers` still gives
a human a turn when they have nothing face down but any card face up; a player
with nothing on the board, and bots, move straight on. End turn pressed during an
animation waits for it rather than being ignored. A lifted board card rises out
of its slot (`.slot.lifted`).

**🏆 slots while holding a card.** `slotMet(planetIdx, slotIdx, card, owner)`
replaces `condMet` wherever a slot is judged for a card: for a `winner` slot it
asks `slotWins` — would this card's Power be strictly higher than every other
player's card in that exact slot? Opponents' face-down cards are unknown to the
player, so they're left out; a tie doesn't count. The rule label above the slot
(which now carries `data-p` / `data-s`) and the slot light up on tap-select, and
`metAt` does the same mid-drag. A face-up card currently holding a 🏆 slot shows
its harvest badge, and the bot now values trophy slots it would win.

## How an ability is stored

A card's `fx` is a list of effects, each an object like:

```js
{ v:'destroy', target:{ player:'choose', here:true, rule:'choice' } }       // "Destroy an enemy card here"
{ v:'givePower', n:4, target:{ player:'self', here:false, rule:'choice' } }   // "Give a card of your choice +4 Power"
{ v:'givePower', n:3, target:{ player:'self', here:false, rule:'next' } }     // "Give the next card you play +3 Power"
{ v:'discard', n:1, target:{ player:'choose', rule:'random' } }              // "Discard a random card from an opponent's hand"
{ v:'move', dest:'choice', t:'self' }                                         // "Move this card to a planet of your choice"
{ v:'steal', nFrom:'all', to:'self', t:'enemiesHere' }                        // "Steal all bonus Power from all enemy cards here and give it to this card"
{ v:'burn', n:3, target:{ player:'choose', here:false, rule:'strongest' } }   // "Burn 3 Power from the strongest enemy card"
{ v:'summon', from:'grave', pick:{ owner:'any', rule:'random' } }             // "Summon a random card from the graveyard here"
{ v:'destroy', target:{…}, then:true }, { v:'gainEnergy', nFrom:'prevPower' } // "…, in order to gain Energy equal to that card's Power"
{ v:'steal', what:'card', n:1, target:{ player:'choose', rule:'random' } }      // "Steal a random card from an opponent's hand"
{ v:'summon', from:'token', tok:'sapling', at:'choice', side:'choose' }        // "Summon a Sapling for an opponent on a planet of your choice"
{ v:'givePower', n:4, t:'self', if:{ src:'round', op:'>=', val:4 } }           // "… if the round number is at least 4"
{ v:'destroy', target:{…}, only:{ stat:'cost', op:'<=', val:3 } }              // "… (only cards with Energy cost at most 3)"
{ v:'summon', tok:'sapling', when:'destroyed' }                                // "When this card is destroyed: Summon a Sapling here"
{ v:'choose', n:1, opts:[ {v:'draw', n:2}, {v:'gainEnergy', n:2} ] }           // "Choose one: draw 2 cards / gain 2 Energy"
```

### Triggers, conditions, filters and options

- **`when`** — omitted means on reveal. Passive values (`WHEN`): `drawn`, `discarded`,
  `destroyed` (about this card), `graveIn`, `graveOut` (any card), `youDraw` ("Whenever
  you draw a card on your turn": each card drawn by an ability — from the deck or the
  graveyard — during its drawer's own reveal turn sets off that player's face-up cards
  once; the round's draw and slot rewards don't; `drawWatchers`). A card with a passive
  wears ◈ at the bottom left of its face (`passiveMarkHTML`), and lights up whenever one
  fires (`fireTrigger` → `glowCard`, and a `glow` event for guests). `fireTrigger` queues a
  card's matching effects into `G.trigBuf`; `processQueue` flushes the buffer before its
  next item, behind a `restore` marker, so a trigger resolves right after the effect that
  caused it and the interrupted chain carries on exactly where it was. A passive's
  `ctx.planetIdx` is its planet when it's on one, otherwise `null` (so "here" means
  nothing from a hand). Only face-up cards on planets watch the graveyard; a card in a
  hand only reacts to things happening to itself. `TRIGGER_CAP` (250) stops loops.
- **`if: {src, op, val | valFrom}`** — checked when the effect comes up. `src` and
  `valFrom` come from `condSources()` (every amount except the target's own and `all`);
  `op` from `OP_WORDS` (`>=`, `<=`, `>`, `<`, `==`, `between`). `between` is inclusive and
  adds an upper end, `val2` or `valFrom2` (`normalizeRange`); it reads "between 3 and 4"
  and the importer also takes "3-4" / "3 to 4". A condition or filter that reads an enemy
  card here (`ENEMY_CARD_SOURCES`, on either side) fails outright when there's no
  face-up enemy card on that planet, rather than comparing against 0. A false condition counts as a failed
  link, so it also stops anything chained after it.
- **`only: {stat, op, val | valFrom}`** — a card filter on any effect that picks cards
  (`filterable(f)`: board targets, hands, the graveyard). `stat` is `cost`, `power` or
  `bonus`. It narrows group targets, one-card pools, "next/last" and the player offer
  (an opponent with nothing that passes isn't offered).
- **Timed triggers** (`TIMED`): `roundStart` (after income and harvest), `roundEnd` (after
  the last reveal), `nextRound` (once, the round after the card arrived) and `gameEnd`
  (after the final round's `roundEnd`, before scoring). `fireTimed` queues them for every
  face-up card on a planet in arrival order — `card.seq`, stamped by `markInPlay` when a
  card flips or is summoned — and `endOfRound` runs them with `fxAfter:'roundover'`, so
  `endOfRoundContinue` only moves on once they (and any choices they ask for) are done.
- **Activated abilities** — effects with `when:'activate'` form one ability. The first
  carries `actCost` (Energy, 0 = free) and `actUses` (absent = unlimited);
  `normalizeFxList` copies them onto the rest. `actBlock(card, player)` says why it can't
  be used (`new` — played this round, `used` — already this round, `spent`, `poor`,
  `facedown`) or `''`. `activateCard` pays, stamps `actRound` / `actUsed` and runs the
  effects like a reveal. A human's reveal turn ends on **End turn** (`endReveal`) once nothing is
  face down; a bot's ends when nothing is face down and `readyActs` is empty.
  `skipEmptyRevealers` keeps a player whose only business is an ability or rearranging. Bots use what they can afford most of the time. `resetCard`
  clears the counters when a card leaves the board.
- **`choose`** — `n` and `opts` (effects without `when`/`then`, and never another
  `choose`). Options whose own `if` fails aren't offered; if no more remain than must be
  picked they all run without asking. Each chosen option runs as its own chain (`reset`).
- **Face-down cards** are invisible to all of it: `cardsOnPlanet` only returns face-up
  cards, so no pool, group, count, "last card" or graveyard watcher ever includes one.
- **`needsOf(f)`** narrows `VERBS[v].needs` to what one effect uses (Steal's `what`
  switches between a planet target and a hand; Summon names a token unless it's from
  the graveyard). Editor, normaliser and parser all go through it.

### Targets

`t` is a *group* target from `TARGETS` — including `yoursAll` (every one of your face-up
cards, on every planet, offered as its own *All of your cards* entry in the studio) and
`creator` (tokens only: `card.creator` is stamped with the uid of the card whose Create
or Summon made it) — every matching card at once
(`enemiesHere`, `yoursElsewhere`, …), plus three long-standing single picks across
all enemies here (`weakestEnemyHere`, `strongestEnemyHere`, `randomEnemyHere`).

`target` is the hierarchy for exactly one card: `player` from `PLAYER_SCOPES`
(`self`, `choose`, `random`), then `rule` from `CARD_RULES`. Which rules are offered
depends on the zone the verb reaches into — `rulesFor(zone)`:

| Zone | Verbs | Extra fields | Rules |
| --- | --- | --- | --- |
| a planet | Give Power, Burn, Steal, Move, Destroy, Recall | `here` | choice, random, strongest, weakest, lowestCost, highestCost, **next**, **last** |
| a hand | Discard, Steal with `what:'card'` | — | the same six, no next/last (Steal never targets your own hand) |
| the graveyard | Draw / Summon with `from:'grave'` | `pick.owner`: any / yours / theirs | the same six |

An effect has `t` or `target`, never both. Steal (Power) also has `to`: `'self'` (this card)
or a planet `target` for the one card that receives the Power.

`t:'enemiesHere'` means *all of one opponent's cards here*: with two or more opponents the
caster picks one (`pickplayer`), a bot picks at random.

**Swap.** `{v:'move', swap:true, dest}` — `doSwap` moves each card to the destination
and brings one of the same player's face-up cards there back to the slot it left
(`swapPair`); several candidates mean a `pickcard` choice with `purpose:'swap'` (bots
pick at random), none means a plain move if there's room.

**Played this turn.** `only:{stat:'playedTurn'}` (`FILTER_FLAGS`) passes cards whose
`playedTurn` — stamped by `markInPlay` with `turnKey()`, the round plus the current
revealer — matches now.

**Each card this round.** `rule:'thisRound'` registers like `next`, but the pending entry
carries `until: G.round` and stays after it fires; it lapses at the next `startRound`. It
can't be a Steal recipient (`recipientRules`).

**Summon that card.** `{v:'summon', from:'prev'}` takes the most recent card in the
memo (`ctx.memo.uids`) out of whichever hand holds it and puts it on a planet, free.

**Next and last.** Every card turned over is logged in `G.plays`. `last` finds that
player's most recent play other than the card resolving, if it's still on a planet.
`next` parks the effect in `G.pending` — together with any `then` chain hanging off
it — and `takePendingFor` hands it back the moment that player next turns a card
over, this round or any later one, before that card's own ability. With `here` it
only fires for a card played on the caster's planet.

**One pipeline.** Every one-card pick goes `settlePlayer` → `settleCard` → the zone's
handler (`resolveCardTarget`, `discardFrom`, `graveTake`) → `actOnCards`. A person
choosing between two or more real options pauses play: `G.choice.kind` is
`'pickplayer'`, `'pickcard'` (with `purpose` `'board'` or `'grave'`), `'pickplanet'`
(with `purpose` `'move'` or `'summon'`), `'discard'` (with `act` `'discard'` or `'steal'`,
and `chooser` and `player`, which differ when you're choosing from an opponent's hand),
or `'pickmode'` for Choose N. One option means no pause; a bot never pauses
and picks at random. The graveyard sheet can open on top of any choice.

### Amounts

`n` is a fixed number; `nFrom` reads one from the game as the effect resolves.
`AMOUNT_SOURCES` lists them, grouped as the studio shows them:

- **You / the game:** `hand`, `energy`, `deck`, `yoursHere`, `enemiesHere`, `leading` (planets you're winning outright), `grave`, `round`.
- **This card:** `selfPower`, `selfCost` — its own current values, wherever it is.
- **Enemies here:** `enemyMaxPower`, `enemyMinPower`, `enemyMaxCost`, `enemyMinCost` — over every face-up opponent card on this planet; 0 when there are none.
- **The target** (only on verbs with a card target): `tgtCost`, `tgtPower`, `tgtBonus` — each target's *own* value, so a group uses each card's own. Steal also has `all`, all of its bonus Power.
- **That card:** `prevCost`, `prevPower`, `prevBonus` — the card the previous effect touched — and `prevCount`, how many cards it touched. Every card-touching effect writes `ctx.memo` (Destroy, Recall, Discard as they were *before* leaving; Give, Burn, Move as they are after; Draw, Create, Summon the new card). Several cards add up. An effect that touched nothing leaves the record alone.

Values read from the game are never negative. `LEGACY_SOURCES` maps the old
per-player graveyard sources onto the shared one.

### The graveyard, Burn and printed Power

There is one graveyard, `G.grave`. Everything goes there through `toGrave`, which
calls `resetCard`: bonus to 0, and base back to the printed Power, because Burn
lowers *base* Power while a card is in play. A card recalled to hand is reset the
same way. A card drawn or summoned out of the graveyard takes the taker as its owner.

### Chains

`then:true` gates the *next* effect: it runs only if this one actually did
something. Every effect sets `G.fxLastSuccess` — a destroy with no target, a discard
from an empty hand, a move with nowhere to go, a steal with no bonus to take, a
summon with no room all fail — and `processQueue` skips the gated effect when it's
false. A skip counts as a failure too, so a chain stops at its first broken link,
but an effect after the end of a chain always runs. The gate survives a pause, and a
summoned card's own ability runs in the middle without disturbing it (`restore`).

### Saved libraries

`migrateFx` runs on load and on every instance: `ownGrave`/`allGrave` become `grave`,
and `discard` with `rand:true` becomes `target:{player:'self', rule:'random'}`.

## Rarity

`rarity` on a card definition: `basic` (or absent), `elite`, `exotic` (`RARITIES`).
Tokens have no rarity: `rarityOf()` returns `token` for anything in `LIB.tokens` (or
an instance made from one, `card.token`), drawn with the dark grey `--rar-token`
edge; the studio hides the rarity picker for them. Card edges are 3 px (2.5 px on
the board) and the Exotic glow is a wide, pulsing purple halo.
Instances copy it and the markup carries `data-rarity`; `styles.css` turns that into
the outline (`--rar-basic`, `--rar-elite`, `--rar-exotic`) and the Exotic glow. The
outline is reserved for rarity — ownership stays in the card tint and its row — and
the Elite/Exotic hues are pushed away from the P1 mint and P2 violet so they don't
read as player colours. Change the three tokens at the bottom of `styles.css` to
restyle. The Power badge takes `nerfed` (red) when a card's Power is below its
printed Power and `buffed` above it (`powerCls`).

## Ability animations

Section 6b of `game.js`. The engine waits for exactly one of them: before any
ability acts on cards (`actOnCards`, and hand picks in `takeFromHand`), `withBeams`
draws a beam in the caster's player colour from the caster to each target, holds
input (`UI.animLock`, part of `busy()`) for `FX_MS.beam`, then lands the ability —
the same `'pause'` / `continueAfter` path a choice uses. Everything else is visual
only and survives re-renders:

| What | How |
| --- | --- |
| Target glow | `UI.fx.glow[uid]` → `.fx-target` on the slot or hand card, for `FX_MS.glow`. |
| Power ticks up / down | `notePowerChanges()` diffs every visible card's Power at each render; a change starts a tick (`UI.fx.ticks`) that a rAF loop counts through on `[data-pw]` while the badge is enlarged and lit (`.ticking.tick-up` / `.tick-down`). |
| Destroyed / discarded | `fxVanish(card)` clones the card's element into `#fxlayer` just before it leaves and crumbles it top to bottom (a moving mask plus sparks). A card discarded from the hand on screen leaves a gap (`fxHole` → `.fx-hole` in `handCardsHTML`) that holds its width for `FX_MS.vanish` and then closes over `FX_MS.hole`, so the other cards only slide over once it has crumbled. |
| Drawn or created into your hand | `fxArrive(card,'draw')` → `.fx-draw`, floating in from the right edge. |
| Summoned | `fxArrive(card,'summon')` → `.fx-summon`, revealed bottom to top. |

**One thing at a time.** Animations that matter to the order of play push
`UI.fx.busyUntil` out (`fxBusyFor`). After each effect, `processQueue` renders and,
if anything is still moving, holds input (`UI.animLock`) and resumes when it stops;
`continueAfter` does the same after a choice or a beam. So "discard 2, draw 2" crumbles
both discards together, then floats both draws in together. Turn changes, beats
(`pause`), the round screen and `endPlacementTurn` / `afterFlip` all go through
`whenFxIdle`, so in pass-and-play the screen is only covered (the *Start turn* veil)
once the last animation has finished.

| Also | How |
| --- | --- |
| Energy gained (ability, harvest, income) | `fxEnergy(player, n, src)` queues it per player; each icon is 28 px and flies for `FX_MS.energyFly` (1.2 s); `flushEnergy` plays it when that player's own board is on screen and not veiled — icons fly from the card (or the round label, for income) to the pool, which counts up as each lands (`shownEnergy` holds the old number till then). |
| Cards moving (Move, Swap) | `fxSlideStart` copies the card into `#fxlayer` before it moves; `fxSlideRun` slides the copy to where the card is now drawn while the real card waits hidden. |
| Between rounds | One screen opens every round (`diceHTML`, shown by `showDice` from `startRound`): the round number, planets by leader colour, and one row per player with the planets they're winning (`planetsWinning`) and their die for who goes first. The dice tumble for `DICE_ROLL_MS`, land, and the winner's row lights up for `DICE_HOLD_MS` (1.4 s), or until tapped. `showRoundScreen` is now only the Game End screen. |
| Who goes first | `startRound` calls `rollForFirst()` every round: each player rolls 1–6, a tie for the top re-rolls, the single highest becomes `G.first` and `turnOrder()` runs clockwise from them (logged). `showDice()` then plays it: the dice tumble for `DICE_ROLL_MS` (faces flicker on an interval, no re-render), land, and the winner is lifted in their colour for `DICE_HOLD_MS` — about 1.7 s in all, or until tapped. `UI.dice` is part of `busy()`, so input, bots, income Energy and the turn timer wait for it; the hand-over veil comes after it. With animations off the result shows without the tumble; with no layout (the headless tests) the overlay is skipped. Both full-screen beats are opaque so a hand underneath can't show through. |

An arrival or glow redrawn mid-way is given a negative `animation-delay`, so it
carries on instead of restarting. `animOn()` turns the lot off when the player does
(*Menu → Ability animations*), when the OS asks for reduced motion, and when there's no
real layout (the jsdom tests) — then abilities resolve instantly, exactly as before.
Timings live in `FX_MS`; looks live at the end of `styles.css`.

## Sandbox

**Title → Sandbox**, or tick *Sandbox mode* in setup. `G.sandbox` turns off the
pass-the-device screen and adds the 🧪 bench (`sandboxSheetHTML`), which also opens
on top of a choice: `sbEnergy`, `sbAddCard` (a fresh instance straight into a hand,
no trigger), `sbDraw` (a real draw, so *when drawn* fires), `sbRound`, `sbEmptyGrave`,
and `resetBoard`, which empties every planet, the graveyard, `G.pending`, `G.plays`
and anything mid-resolution, and restarts the current round's placement — hands,
decks and Energy are kept. It bumps `G.epoch`, and every delayed step (`pause`, the
flip timer) checks the epoch so nothing in flight lands on the fresh board.

## Adding an ability verb

1. Add it to `VERBS` with the fields it needs (`target`, `amount`, `token`, `dest`, `to`, `hand`, `from`).
2. If it acts on cards on a planet, add it to `BOARD_VERBS` and give `actOnCards` a
   branch; it then gets group targets, the one-card hierarchy, next/last, and the
   "its own" amounts for free. Otherwise add a `case` to `applyEffect`. Either way,
   set `G.fxLastSuccess` and call `remember(ctx, …)` with what it touched.
3. Add a line to `verbPhrase` for its rules text, and teach `normalizeFx` its defaults.
4. Add its word to `VERB_WORDS` and `VERB_LIST`, and any phrasing to `parseClause`.
5. Run `node test-roundtrip.js` — it walks every option and fails if the importer
   can't read the studio's wording back.

## Slot types

A planet slot is `{cond, rew}`. `cond.stat` is `'any'`, `'cost'`, `'power'`, or
`'winner'`; `rew.type` is `'energy'`, `'draw'`, or `'none'`.

`'winner'` is not a per-card check. At harvest, `harvest()` compares every player's
card in that exact slot index and pays only the single strongest; a tie, or an
empty slot, pays nobody. `condMet` always returns false for it, so drag
highlighting never claims a lone card satisfies it. `'none'` pays nothing in any
case — a place to hold ground.

## Sprites

Card and planet art is `{ t: 'emoji', v: '🌱' }` or `{ t: 'img', v: <url> }`.

Three ways to set it:

- **Studio → pick a card → Upload.** The image is centre-cropped to 256 px, re-encoded
  as WebP, and stored as a data URL.
- **Studio → Art & data → bulk sprite pack.** Paste JSON mapping names to images:
  ```json
  { "cards":   { "Spore Drone": "data:image/webp;base64,..." },
    "planets": { "Verdance":    "data:image/webp;base64,..." } }
  ```
  Names must match exactly.
- **Point at files directly.** In the offline copy (or any self-hosted one) an
  image path relative to the page works anywhere art is set: the sprite pack
  (`"Spore Drone": "art/spore-drone.png"`), the `art` column of a card CSV
  (`readArtCell` takes `*.png|jpg|jpeg|webp|gif|svg|avif` paths as images, and
  `artCell` exports them as written), or `DEFAULT_CARDS`. The published page has
  no folder beside it, so the importer notes that there. Editing the defaults only
  affects a fresh library — clear the saved one from Studio → Art & data → Reset, or bump `KEY`.

Square images read best. Cards render art at roughly 40×34 in hand and full-bleed
in a planet slot, so keep the subject centred.

## The offline package

(Not part of this folder: `package-offline.js` and `offline-kit/` live with the original prototype. `dist/index.html` from `npm run build` is a simpler offline copy, using Google Fonts when online.)

`node package-offline.js` builds `dist/Territory/` and `dist/Territory-offline.zip`:

| In the package | What it is |
| --- | --- |
| `Territory.html` | the whole game in one file: `index.html` + `styles.css` + `game.js`, plus both typefaces embedded as base64 woff2 — no network request of any kind, so it runs from `file://` with no internet |
| `READ ME FIRST.txt` | plain-language instructions (computer, tablet, saving, art, updating) |
| `tablet-server/` | `serve.py` (Python 3 standard library only) serves the folder on the local network on port 8000, prints the LAN addresses, sends `Cache-Control: no-store`; launchers for Windows / Mac / Linux |
| `cards/`, `art/` | the card-list CSV; a folder for sprite images referenced by relative path |
| `source/` | the code, with `index.html` pointing at `fonts/fonts.css` instead of Google Fonts, the tests, and a `build.js` that rebuilds `../Territory.html` offline (it's `offline-kit/build.js`, which `package-offline.js` also uses, so both produce the same file) |

The fonts (Syne and Outfit, variable, Latin + Latin Extended, from Fontsource, SIL
OFL 1.1) live in `offline-kit/fonts/` with their licences. Saved data is the
browser's `localStorage`, scoped to how the page is opened (file vs. server,
which browser), so the instructions point people at the library backup.

## Backing up

Studio → Art & data → Show my library JSON dumps cards, tokens, planets, decks, sprites and
settings. Restore takes the same blob back, from the box or a `.json` file.

## Rulings this build makes

The design doc leaves these open:

- Who goes first is rolled at the start of every round (see *Who goes first* above).
- **Placement** takes turns in pass-and-play, as before. Online — and against bots, if
  you pick *All at once* in setup — everyone places at the same time and locks in;
  nobody sees anyone else's new cards until the reveal starts. Reveals still go one
  player at a time, in the order the dice decided.
- Each player reveals their whole board before the next player begins.
- Face-down cards are outside every ability: never targeted, counted or watched.
- Triggers resolve right after the effect that set them off, then the chain resumes.
- A summoned card belongs to whichever side it lands on; a stolen hand card belongs
  to the thief.
- Choose's options are independent: a failed option doesn't stop the next one.
- In hot-seat, a passive that needs a choice from a player other than the one whose
  turn it is shows that choice on the shared screen.
- If an ability drains a player below a committed card's cost, that card fizzles to
  the graveyard when it flips.
- Energy carries over between rounds. Power is floored at zero for scoring.
- Live planet totals count revealed cards only, so face-down commitments stay secret.
- During placement you see your own committed cards face up — you are still deciding.
  They turn face down at *Lock in* and stay that way until you flip them, so the back
  of the card is what sits on the table between the two phases.
- Your own backs keep their Energy pip, because you have to plan the order you pay in.
  *Peek at mine* shows the faces again. An opponent's back shows nothing.
- Committed cards can be moved and swapped freely across every planet, not just within
  one. If you want to restrict that to the planet the card is already on, add a
  `fromP === toP` guard at the top of `moveCard`.

## Importing a table of cards

## Exporting and importing files

**Studio → Import & export.** The Export half has one tile per file:

| File | What's in it |
| --- | --- |
| `territory-cards.csv` | Every card, then every token: `type, id, name, cost, power, rarity, ability, art, fx, notes`. `ability` is the rules text; `fx` is the same ability as exact JSON. |
| `territory-planets.csv` | `id, name, art, hue`, then `slotN` and `slotN reward` for each slot — `Cost <= 3`, `Power >= 5`, `Any card`, `Strongest wins`; `+2 Energy`, `Draw 1`, `None`. |
| `territory-library.json` | The whole library — cards, tokens, planets, decks, sprites. The same blob as *Studio → Art & data → Back up everything*, which now has a *Download a backup* button too. |

**Copy** puts a CSV on the clipboard instead. Sprites are written as `[sprite]` unless
*Embed sprite images* is ticked: spreadsheet apps cut long cells off (Excel at 32,767
characters), and a data: URL is usually longer than that. A `[sprite]` cell keeps
whatever image the card or planet already has when the file comes back in.

The Import half takes either file. A table with `slot1` / `slot 1 condition` columns is
read as planets; anything else as cards. Rows are matched to the library by `id`, or
by name when there's no id, and the *Rows that match* setting decides what a match does:
**update it in place** (the default — ids don't change, so decks keep pointing at it) or
**add a second copy** (flagged as a duplicate). The preview marks each row *New*,
*Update* or *Check*, and the button says what it will do (*Add 2, update 18*).

**Tokens and notes.** A row can name a token that's defined further down the same
table (*Create 1 Dexter in hand* above a `token,Dexter` row): the importer reads the
token rows first and, on import, points the cards at the new tokens. A `notes` column
(also `review`, `comment`) flags the row for review with what it says — several
reasons separated by ` | ` — and the studio shows them on the card; Export writes a
card's review notes back out to the same column.

**Lossless round trip.** On the way back in, a row whose `ability` still says exactly
what its `fx` says uses the `fx` as-is, so an untouched export reimports to the identical
library (`test-csv.js` checks this for cards, tokens and planets). Edit the words in a
spreadsheet and the words win: that row is parsed like any typed ability and flagged if
anything doesn't read. A broken `fx` cell is flagged and the words are used.

**Saving the file.** Published, the page declares the `downloads` capability and hands
the file to the Claude app's save prompt (`saveFile` → `claude.use('downloads')`).
Opened as a plain local file, it's a normal browser download. If neither is possible,
the file appears in a box on screen to copy.

**Studio → Import & export → Import.** Paste from a spreadsheet, a CSV file, or a markdown
table. Columns are `name`, `cost`, `power`, `ability`, and optionally `art` for an
emoji and `rarity` (Basic / Elite / Exotic; *common*, *rare*, *legendary* and the like
are mapped onto those, anything else is flagged); a header row is matched on its names (`energy` works for `cost`, `text` for
`ability`, and so on) and the column order does not matter. Without a header the
columns are read in that order and the screen says so.

The ability column is read against the design doc's verbs — Give Power, Discard,
Destroy, Recall, Create, Summon, plus Draw and Gain Energy — along with the target
phrases in `TARGETS`. Two effects can share a row, joined by a full stop or by
"and" before the next verb. `Draw 1 and discard 1`, `Give your other cards here +1
Power`, `Destroy the weakest enemy here`, `Summon a Sapling here`, `Create 2
Stardust in hand` all read cleanly.

The importer reads every verb and option the studio can build. It understands the one-card hierarchy too: *a card of your choice*, *an
enemy card here*, *an enemy card of your choice*, *your cheapest card*, *a random
card of yours*, *a card of your choice from a random opponent*. *Discard a random
card* gives no choice; *Discard a card* does. Chain effects with *in order to* (or
*If you X, Y*), and read an amount from the game with *equal to your Energy*, *equal
to the number of cards in the graveyard*, *equal to that card's Power*, *equal to its
own Energy cost* and so on. Older wording like *equal to your graveyard* still reads,
as the one shared graveyard. A bare *its cost* is read as the effect's own target if
it has one (and flagged, since it could mean either), otherwise as the previous card. The test suite checks that every
ability the studio can build reads back from its own wording to the identical
effect — all 50,000-odd combinations, plus sampled conditions, filters, passive
triggers, Choose options and summon placements — so studio text is always safe to paste into a table.

New in this build: *… if the round number is at least 4* (any game value on either
side), *(only cards with Energy cost at most 3)*, *Choose two: … / … / …* (its own
condition goes before the colon: *Choose one if your Energy is at least 3: …*), a
passive trigger opening a sentence (*When this card is destroyed:*, *Whenever a card
goes to the graveyard:* — several effects sharing it are joined with `;`), *Summon a
Sapling for an opponent on a planet of your choice*, and *Steal a random card from an
opponent's hand*.

Anything that does not resolve cleanly is flagged rather than guessed at:

| What | What happens |
| --- | --- |
| A verb outside the doc (`Deal 2 damage`) | No effect made; the row is flagged with the list of verbs that do work. |
| Timing it can't read (`At the end of each round…`, `When this card is played:`) | The timing is dropped, the rest reads from the first verb, and the row is flagged with the triggers that do work. |
| A condition on a value it doesn't know (`if the moon is at least 3`) | The condition is dropped, and flagged. |
| A filter on a verb that doesn't pick cards | The filter is dropped, and flagged. |
| A Choose with fewer than two options, or asking for more than it lists | Flagged. |
| A rarity it doesn't know | Read as Basic, and flagged. |
| A missing target or amount | Read as *this card* / *1*, and flagged. |
| A token name that is not a token | Flagged, and told which tokens exist — or that the name is a card, not a token. |
| An amount read from the game taken away (`lose Power equal to your Energy`) | Read as positive, and flagged — use Burn to take Power away. |
| An amount phrase it doesn't know (`equal to twice your hand`) | Read as 1, and flagged with examples of what it does know. |
| Move with no destination | Read as a planet of your choice, and flagged. |
| Steal with a recipient it can't pin to one card | Read as this card, and flagged. |
| A cost or Power that is not a number, or out of range | Read as 0 or clamped, and flagged. |
| A name that already exists, or repeats inside the table | Flagged as a duplicate. |

Flagged rows still import — they carry the reasons and your original wording — and
the studio opens on the first one to check. The card list marks them, the editor
shows the reasons with what you actually typed, and **Looks right** clears the flag.
*Add only the clean ones* is there when you would rather come back to the rest.
The flags live on the card as `review` and `abilityText`, so they survive a save and
travel with a library export.

To teach the parser a new phrasing, add to `VERB_WORDS` or `TARGET_WORDS` near the
top of section 3b. To teach it a new verb, add it to `VERBS` first (see above), then
give it a word here.

## Reviewing a finished game

The result screen has **Review the board**: the final board, everything face up, with a
seat switcher so you can read it from each player's side. The score rail at the bottom
follows whichever seat you are looking through.

## Getting ready for online play

The engine is built the way a server needs it; section 9 (*Online play*, below)
is the transport on top. Everything here also runs on one device.

**One seeded game.** `newGame()` picks a seed (or takes one: `LIB.settings.seed`,
or `newGame({seed})`) and keeps the random streams in the state: `G.rng` for the
rules (shuffles, the roll for first, random targets) and `G.botRng` for bots'
own deliberation, so a bot thinking never shifts what the rules roll. Visual
randomness (dust, stars, a tumbling die's face) uses `uiRnd` and touches neither.
Card ids are drawn from the rules stream too (`c` + 10 characters): every device
agrees on them, and unlike counted ids they don't tell an opponent which card of
your deck list is sitting face down.

**Commands.** Every move goes through `dispatch(cmd)` — taps, drags, bots, the
turn timer and the sandbox bench alike:

| Command | What it does |
| --- | --- |
| `{t:'place', seat, uid, p, s}` | a hand card onto your slot (a card you're still holding there swaps back to hand) |
| `{t:'move', seat, uid, p, s}` | one of your board cards to another of your slots |
| `{t:'unplace', seat, uid}` | a card committed this round back to hand |
| `{t:'lock', seat}` | done placing |
| `{t:'flip', seat, uid}` / `{t:'activate', seat, uid}` | turn a card over / use an activated ability |
| `{t:'endReveal', seat, early?}` | end your reveal turn (`early`: the timer ran out with cards still face down) |
| `{t:'choose', seat, uid \| i}` | answer the open choice |
| `{t:'sandbox', seat, op, …}` | the 🧪 bench (refused outside a sandbox, and always online) |

`cmdCheck(cmd)` says why a command can't run (`turn`, `slot`, `notyours`,
`busy`, …) and `dispatch` returns `{ok, why}`. While a beat, a flip or an ability
is still resolving the engine holds (`G.hold`, `G.flipping`, `G.fxQueue`) and
refuses everything except the answer to an open choice. Accepted commands go
into `G.cmdLog`. **The same seed and the same log replay to the same game**:
`test-online-prep.js` plays games in every mode, replays each from its log with
bots switched off (`UI.replaying`), and compares `stateDigest()` and the result.

**What each player may see.** `playerView(G, seat)` is the game as that seat may
know it — what a server would send that device. Gone: every deck's order and
contents (just how many), other players' hands (just how many — unless this seat
is choosing from that hand right now, as the rules allow), other players'
face-down cards (just the back; while everyone places at once, not even that),
their committed Energy, the seed, both streams, the command log, the engine's
working queues, private log lines (`say(t, who, vis)`) and any hidden card id
anywhere else. A device draws a view exactly like a full game — `G = view;
render()` — drawn from `G.viewer`'s side, with a "… is choosing" banner when
someone else has a choice open. The test sweeps every view at random moments
for leaked ids and faces, and draws a sample on a second page.

**Events.** `emit(k, …)` numbers what happens for a screen to animate: `round`,
`lock`, `flip`, `arrive` (draw / summon), `vanish`, `energy`, `slide`, `beam`.
The animation hooks already emit them; locally the animations still run from the
engine directly, as before.

**The network hook.** `NET = {seat, send}`. With `G.online` set and `NET.send`
connected, `dispatch` sends the command instead of applying it, `localSeat()`
is `NET.seat`, the hand-over screen never shows, and placement is always all at
once. No transport is wired yet.

## Online play

Section 9 of `game.js`, on top of the relay in `server/worker.js` (see DEPLOY.md).
**The host's browser runs the game**: it holds the real `G` and is seat 0
(`NET.seat = 0`, `NET.send = null`, so its own taps apply directly).

| Piece | How it works |
| --- | --- |
| Screens | Title → **Play** (`UI.screen = 'online'`, `viewOnline`): *On this device* (the local setup), or online — your name, *Make a room* (2–4 seats), *Join* by code, or *Rejoin / Resume* a room this device holds. Sandbox mode is a switch in the local setup and in the host's lobby (`ON.lobby.sandbox`); online, every seat gets the bench. In a room, `viewLobby`: the code, an invite link (`?room=CODE`), one row per seat with its deck, the host's settings (planets, rounds, turn and choice timers) and *Start*. Empty seats become bots. Lobby buttons use `data-on` and their own listeners, so they don't touch the main click switch. |
| Messages | Inside the relay's `{data}`. Guest → host: `{t:'hello'}`, `{t:'deck', id}`, `{t:'cmd', cmd}`. Host → guest: `{t:'lobby', lobby, decks, reset?}`, `{t:'view', v, ui, arts}`, `{t:'clock', timers}`, `{t:'nope', why}`, `{t:'closed'}`. |
| Commands | A guest's `dispatch` checks the move against its own view first (`cmdCheck`, and `dryRun` of place / move / unplace on a copy), then sends it. The host overwrites `cmd.seat` with the sender's seat, refuses `sandbox` and `standin` from guests, and runs `dispatch` as for its own taps. |
| Views | `render()` on the host calls `hostBroadcast()` (30 ms debounce): each online guest gets `playerView(G, seat)` with only the events it hasn't had, plus `hostScreenState()` — the beat bar, the round / Game End screen, the dice, and both clocks. A view identical to the last one sent isn't sent again. |
| Art | `packArts` swaps any `data:` string over 1.5 KB for a short reference; each image travels once per guest (`ON.sent[seat].arts`), and `unpackArts` puts it back. A message over 1 MB isn't sent (the host is told to move sprites into `art/`). |
| Guest drawing | `guestView`: crumbles and slides play from the old screen, then `G = view`, then arrivals, Energy, the flip (`UI.flipAnim`) and beams on the new one. The first view after joining or reloading plays nothing. The host's beats and dice are mirrored; taps on them do nothing on a guest. "Turn the rest over" sends one flip at a time (`guestAfterView`). |
| Clocks | Only the host counts. Online placement is one clock for everyone still placing (`timerKey` → `round:placement:all`; at zero every human still placing is locked in). Guests show the host's numbers (`netTimerHTML`), counting down between updates. |
| Choices | The host never sees another seat's choice sheet, only "… is choosing" with the clock; the chooser's device gets the sheet. |
| Connections | Seat tokens are kept in `localStorage` (`territory.v1.online`). A dropped socket retries with back-off (0.8 s → 10 s); a socket that goes quiet for 50 s, or a phone coming back online or to the foreground, reconnects at once (`dropAndRetry`). A reload goes straight back in. The host's game is saved after every settled moment (`territory.v1.hostgame`) and `hostResume` restores it, streams included. |
| Dropped players | The host sees a banner per seat that's away, with **Let a bot play** → `{t:'standin', seat:0, target, on:true}` (a logged command, so replays still match). The seat goes back to its player when they reconnect. A choice the seat owed is made at random. |
| Ending | The host's results screen offers **Back to the lobby** (everyone returns together); *End the game for everyone* in the menu closes the room. |

**Next for online:** run the game in the Durable Object instead of the host's
browser (load `game.js` headless, hold `G`, apply commands) so nobody can peek and
the host can leave; a guest's own decks travelling with them; accounts and
matchmaking.

## What's new in 0.8

### Smaller changes

- **Light and dark.** Text fields without a `type` were left unstyled; every field now follows the theme, and `color-scheme` is set per theme so the browser's own controls match. `test/test-contrast.py` measures field values and placeholders as well as text.
- **Energy pool.** The ⚡ pill at the top left is bigger and glows, so it reads first.
- **Paid slots.** During Placement, a slot that paid its reward at the start of this round has a green outline (`G.paid`, filled in by `harvest`).
- **Players bar.** Under the turn bar, every player in turn order with their ⚡ Energy and 🃏 hand size, and a **1st** badge on whoever reveals first this round.
- **Opening.** Before round 1: everyone's name in their colour, then the planets slide in and the opening hands are dealt (`showIntro`; a tap skips it). Guests see the host's. Off when animations are off.
- **Planets centred** across and down the space between the bars and the hand.
- **Card icons.** ⚡ sits inside the cost circle and 💪 inside the Power circle (they stretch into pills); on slots, 🃏 is a card, ⚡ Energy, 💪 Power. The passive (◈) and activated (⚙) marks sit centred between the art and the name.
- **Sorting and filtering.** Studio → Cards / Tokens and the sandbox's card list sort by name, ⚡ cost or 💪 Power (tap again to reverse) and filter by ability verb, passive and activated (`sortFilterCards`, `cardSortBarHTML`). Within verbs a card needs any ticked one; Passive and Activated each narrow further.
- **No more flicker** on the round-open screen: an overlay already on screen keeps still when the page redraws (`steadyEntrances`).
- **A new account starts from the shipped library** (`fetchShippedLibrary` on account creation).

### Exporting games and the Replay page

Every finished game keeps a **replay**: its seed, seats, decks, the library it was played with (cards in the decks and anything they name, every token and planet; big uploaded pictures are left out and borrowed from this device's library by id or name), and every command in order (`G.setup`, `replayBundle`). Same seed plus same commands gives the same game — `test-online-prep.js` already proved that, and the replay check compares the final state.

- **Export game** on the result screen, and on any game in the match history (or a friend's), saves `territory-<date>-<players>.json`: `{format:'territory-game', v:1, summary, log, replay}`.
- **Title → Replay** loads that file (or picks a game from your history) and plays it again, with every animation, like a slideshow: play / pause, one step, 1× 2× 4×, and **Watch as** any seat. A replay borrows its own library for as long as it runs (nothing is saved while it does) and gives yours back afterwards.
- Online, the host's final view carries the replay to every guest, so everyone's history has it. On the server a replay is kept under its own key (`r:<id>`), so loading the history never reads them.

### Stats

Profile → **Stats**, added up from the match history (`gameStats` stores the numbers with each game; games from before 0.8 count only toward planets seen). Since 0.9.5, games against people only:

- **Cards you played** — play rate (share of your games), game win % (games won when you played it), planet win % (when it ended the game on a planet, how often you won that planet). Sort by any column.
- **Planets** — how often each came up, how often you won it, and for each of your slots there, how often the card in it met the condition when rewards were checked.
- **Power** — average gained per round and on the table at the end; most in one round and one game.
- **Cards drawn** (not the opening hand) — average per game; most in one round and one game.

### Social

Title → **Social** (needs an account):

- **Find players** by username; **Add friend** sends a request; they **Accept** or **Decline** (up to 25 friends; asking someone who already asked you makes you friends at once).
- Tap a friend (or any player) for their **record and last 30 games**; tap a game for its planets, log, replay and **comments**.
- **Comments**: anyone signed in can comment on a game, up to 10 per game. The player whose game it is can delete any comment on it, and you can delete your own. Your own games show their comments in your match history.
- **Invites**: hosting a room, the lobby lists your friends — tap one to invite. They get a pop-up with **Join the game** wherever they are in the app (the game checks every 20 seconds while signed in), and the invite waits in their Social tab for two hours.

The server side is in `server/accounts.js` (`socialRoute`); search uses one more object of the same class, named `~directory`, so there is **no new migration**.

### Tutorial

Title → **Tutorial**. Eight short pages (how to win; cards; planets and slots; Energy and Power; satisfying a condition; a round's two phases; abilities and their verbs; then the game), followed by a **guided game** against a scripted Rival with stacked decks on four planets (`TUTOR_LIB`, `TUTOR_STACKS`, `TUTOR_ENEMY`). The coach asks for one move at a time and the board highlights the card and the slot; any other move is turned away with a nudge (`tutAllows`). Along the way you satisfy ⚡≤2 → +2⚡ with Blade, discard Battleaxe with Ward, draw with Atlas, use Aqitan's activated ability, create Stardust with Starfall, chain Lightspark → Sahel → Ambrosia, pull the Rival's Stardust off the slot that paid them, burn Dexter below its condition with Torch, and bring Battleaxe back with the Amulet of Cochrane. It always ends 3–1 to you; Ashen Gate would be a tie without Torch and the Amulet. The lesson borrows its own library, isn't recorded, and hands yours back when you leave. `test/test-tutorial.py` plays it through by tapping what the coach highlights.

## What's new in 0.9

- **Tutorial rebuilt on your library.** Every card (ability, numbers, emoji) and all five planets come from the library you sent, in `TUTOR_LIB`. The board is Dirge Winds, Ashfall Rim, The Shoal, Hallow Moon and Oasis; the game ends 3–1 to the player with Oasis tied. The coach's words are `TUTOR_STEPS`, each with an id (`1.1` … `6.5`) that matches the *Territory tutorial — coach script* doc, so edited wording drops straight back in. The Rival's moves are `TUTOR_ENEMY`; the draw order is `TUTOR_STACKS`.
- **Icon colours.** ⚡ is blue and 💪 is white everywhere: `paintIcons` wraps each one in text with `.ic-e` / `.ic-p`, and the stylesheet recolours the emoji (and the ones drawn inside the cost and Power circles).
- **Opening deal** uses the very same animation as a normal draw (`fxDrawIn`, in from the side).
- **The hand never collapses** — the tray keeps a card's height when it's empty.
- **Profile emoji.** Pick one in Social → Profile (or type your own). It shows beside your name in the players bar, the lobby, the opening screen, friends lists and the win screen, and is saved to the account. Bots are 🤖.
- **The winner's moment.** When a game ends, the winner's emoji (or initial) fills the screen in their colour with a burst, then the result. A tap skips it.
- **No "+1 ⚡" tag** on slot cards — the green outline already says a slot paid.
- **A slot with no reward** never lights up for a card you pick up.
- **Planet stats** count, for each slot, the rounds it paid out of every round it was in play (games × 6).
- **Unconfirmed placements** never reach the command log, replays or exports: at lock-in, everything a player placed and took back that turn is folded into one `commit` (where the cards ended up and the order the hand was left in), so a replay shows only what was committed and still ends in exactly the same state.
- **Menus.** Profile is a tab of Social; Decks is a tab of Studio.
- **Everyone's stats** — the same numbers as your own Stats, added up over every game any account records — are on the Replay page for now (`GET /api/stats`, kept by one more `Account` object named `~stats`).
- **Search** now also finds any exact username, even an account nobody has opened since search arrived, and every account is listed as soon as it opens the game. A server that doesn't have the social routes yet says so instead of "Nobody by that username".

## The admin lock (0.9.1)

The Studio opens only for an admin (`isAdmin()`, `viewAdminGate`). The password is the Worker secret `ADMIN_PASSWORD` (see DEPLOY.md); `server/accounts.js` checks it (`adminRoute`), slows guessing per address and overall, and hands out 30-day admin sessions kept in one more `Account` object named `~admin`. Offline (`file://`) the Studio stays locked. The lock guards the Studio screens in the app; what everyone plays with — the library the site ships — still changes only through GitHub. Also: the ⚡ and 💪 emoji keep their own colours, and the circles behind them are blue (Energy) and white (Power). `test/test-admin.mjs` and `test/test-admin-ui.py` check the lock.

## One shared deck, menu look, sign-in nudge (0.9.2)

- **One shared deck.** New game (and the online lobby, for the host) has **Decks: Own deck each / One shared deck**. Shared, the chosen deck goes in once per player, shuffled together into one pile every player draws from (`G.sharedDeck`; every `p.deck` is the same array — `relinkSharedDeck` restores that after a saved game is read back). A card belongs to whoever draws it; a mulligan shuffles back into the shared pile. Replays and exports carry the choice. `test/test-shared-deck.js` plays 2-, 3- and 4-player games and replays them.
- **Main menu.** The title is the logo image (`game/art/logo.png`, its black blended away), the menu titles are Orbitron (`game/fonts/`, built into the page), and the orbs are gone.
- **Play screen.** Signed out, a banner at the top links to Social → Profile: "Sign in or create an account to record your matches and add friends! No personal info required."
- **Studio without the password** is read only: Cards, Tokens, Planets and Decks can be browsed; nothing can be changed.

## Users tab (0.9.3)

Studio → **Users**, admin only (hidden otherwise): every account with its name, emoji, record, friends, when it joined and was last seen; tap one for its friends, requests, sign-ins and whole match history, and any game for its log, comments and replay. Served by `/api/admin/users…` in `server/accounts.js`, behind the admin session; password hashes and session secrets never leave the account objects. `test/test-admin-users.py` checks it.

## Not built

The server-held game and matchmaking (above). Local hot-seat covers 2–4 players on one
device, with a pass-the-device screen between turns when more than one seat is
human; one human against bots can place all at once.

## Lobby search and private lobbies (0.9.4)

Play → **Join a game** now lists **Open lobbies**: every public room that is waiting to start, has its host connected and has a free seat (host emoji and name, players/seats, planets, rounds, shared deck, sandbox). It refreshes every 10 seconds while the Play screen is open, or tap ↻. Tap **Join** on a row to take a seat (asks for a name first if you haven't set one).

In the lobby, the host has a **Private lobby** switch. Ticking it removes the room from the search immediately; friends still join with the code, the link or an invite. Unticking it lists the room again. A room also drops out of the search as soon as it fills, the game starts, the host disconnects, or it closes; it comes back if the host returns to the lobby with seats free.

How it works: the host's device posts its listing to `POST /api/rooms/<code>/listing` (checked against the host's seat token); the room keeps the registry in the `~lobbies` account object up to date on joins, leaves and expiry; `GET /api/lobbies` reads it. No new Durable Object classes or migrations. `test/test-lobby-search.py` checks it.

## Match log, and records without bots (0.9.5)

**Records and stats count games against people only.** A game with a bot in any seat (`isVsBots(g)`:
some `players[i].bot`; a bot standing in for a dropped player isn't one) stays in the match history,
marked *not counted*, but leaves out of:

- the Profile's record tiles (`profileStats`, which also returns `vsBots`) and its Stats tab (`statsFrom`
  filters first), with a line under the tiles saying how many were left out;
- the server's records — `recordOf` in `server/accounts.js` for `record()`, `publicProfile`, `adminSummary`
  (each with `vsBots`) — so friends lists, other players' profiles and Studio → Users agree;
- everyone's stats (`addGames` only passes `counted` games to `~stats`). Games merged before 0.9.5 are
  recounted by Studio → Matches → **Recount everyone's stats** (`POST /api/admin/stats/rebuild`, 25
  accounts a call into a scratch copy, `statsRebuildStep`, swapped in at the end).

**The match log.** Every game finished on the website, signed in or not, bots or not, sandbox included
(not the tutorial or replays), goes to one more `Account` object, `~matches`:

| Client (`game.js`) | |
| --- | --- |
| `submitMatch()` | called from `finishGame` after `recordGame`. Skips a guest's view (`G.isView` — online, the host sends), the tutorial, replays, and `file://` copies (`accountsAvailable()`). Builds `matchEntry()` once per `G.gameId` and queues it. |
| `matchEntry()` | `{id, at, started, mode, sandbox, rounds, planets, sharedDeck, players:[{name, emoji, bot, standIn}], won, winner, reason, rows, log, replay, v}`. `started` is read from the first 8 characters of `G.gameId` (`Date.now()` in base 36), so nothing new goes into `G`. The log is the whole `G.log`; a line with `vis` carries `p:[seats]`. |
| `flushMatches()` | posts the queue (`MATCHQ_KEY`, at most 12 waiting) to `POST /api/matches`; on success or a final refusal (400, 413) an entry is dropped, otherwise (offline, 429, 5xx, a server without the log) it waits. Runs after each game, 2.5 s after the page opens, and on the `online` event. |
| Studio → **Matches** | `matchesBody` / `matchDetailHTML`, state in `AM`. Admin only (hidden read-only, like Users). Filter chips (`AM_FILTERS`) and search go to the server; 40 a page with *Load more*. A match opens to its seats (account or *no account*, bot, stand-in), planets, log (🔒 lines name who saw them), **Watch replay** (`startReplay(gameFile(amEntry(m)))`; `stopReplay` returns to the Studio because `UI.rp.back` is `'studio'`), **Export game**, **Delete** (tap twice). |

| Server (`accounts.js`) | |
| --- | --- |
| `POST /api/matches` | no sign-in. `cleanMatch` checks and trims it (ids, 1–4 players, strings clipped, ≤ `MATCH_BYTES_MAX`). `matchAdd`: 60 an hour per address (`rl:`), once per id (`x:`), summary under `i:<countdown>:<id>` so key order is newest first, log `l:` and replay `r:` apart. Keeps `MATCHES_MAX` (2,000); `matchTrim` drops the oldest. |
| account links | `POST /api/account/games` returns the seats it was sent (`{id, seat}`) and calls `matchLink(user, seats)`: the match's `accounts[seat]` becomes that username. A link that arrives before its match waits under `p:<id>` (a week at most). |
| `GET /api/admin/matches?after=&f=&q=` | `matchList`: pages of 40, scanning at most 1,000 summaries per call for the filter and search; `next` is the last key scanned. |
| `GET` · `DELETE /api/admin/matches/<id>` | `matchGet` (summary + log + replay) · `matchDelete`. |

Tests: `test/test-matches.mjs` (the API: adding, dedupe, filters, links both ways, records and stats without
bots, the rebuild, deleting, the limits), `test/test-matches-ui.py` (games played in Chromium reach the log —
bots only, a person against a bot, sandbox, offline then online, signed in — and the Studio tab: filters,
search, detail, export, replay and back, delete, recount), `test/test-matches-online.py` (an online game is
logged once, by the host, with the guest's account on their seat). `test-social.mjs` and
`test-admin-users.py` now give their games a person as the opponent and check a bot game isn't counted.
