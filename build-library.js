/* Makes game/library.json from a card-list CSV, read by the game's own importer:
   the built-in set, plus every card and token in the CSV, plus a deck holding
   one of each imported card.
   node build-library.js cards.csv ["Deck name"]
   The better source is your own library: Art & data -> Download a backup,
   saved as game/library.json. This script is for when you only have a CSV. */
'use strict';
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const csv = fs.readFileSync(process.argv[2], 'utf8');
const deckName = process.argv[3] || 'Card list';
const js = fs.readFileSync(path.join(__dirname, 'game', 'game.js'), 'utf8');
const dom = new JSDOM(`<div id="app"></div><div id="overlay"></div><script>${js}</script>`, {runScripts:'dangerously', url:'http://localhost/'});
const w = dom.window;
w.__csv = csv; w.__deck = deckName;
const out = w.eval(`(function(){
  const deck = {id: freshId('deck'), name: window.__deck, cards: []};
  LIB.decks.push(deck);
  const parsed = readImportTable(window.__csv);
  const res = commitImport(parsed, parsed.rows, deck.id);
  LIB.settings.deckOf = [deck.id, deck.id, deck.id, deck.id];
  return {lib: JSON.stringify(LIB, null, 1), res, flagged: parsed.rows.filter(r=>r.issues.length).map(r=>r.name+': '+r.issues.join(' | '))};
})()`);
fs.writeFileSync(path.join(__dirname, 'game', 'library.json'), out.lib);
console.log('game/library.json written:', out.res.added, 'added,', out.res.updated, 'updated,', out.res.flagged, 'flagged for review');
out.flagged.forEach(f => console.log('  check:', f));
w.close();
