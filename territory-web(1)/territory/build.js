/* Builds the site into dist/:
     dist/index.html    game/index.html with styles.css and game.js inlined (one file)
     dist/library.json  the card library a first-time visitor starts from, if game/ has one
     dist/art/…         sprite images, if any, for library entries that point at art/ paths
   dist/index.html is also a complete offline copy: it runs from a double-click.
   node build.js */
'use strict';
const fs = require('fs');
const path = require('path');

const root = __dirname;
const src = path.join(root, 'game');
const out = path.join(root, 'dist');

const html = fs.readFileSync(path.join(src, 'index.html'), 'utf8');
const css  = fs.readFileSync(path.join(src, 'styles.css'), 'utf8');
const js   = fs.readFileSync(path.join(src, 'game.js'), 'utf8');
if(js.includes('</script')) throw new Error('game.js contains "</script" — it would end the inlined script early');

const page = html
  .replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + css + '</style>')
  .replace('<script src="game.js"></script>', () => '<script>\n' + js + '</script>');

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, 'index.html'), page);
let note = 'index.html ' + page.length + ' bytes';

const lib = path.join(src, 'library.json');
if(fs.existsSync(lib)){
  const data = JSON.parse(fs.readFileSync(lib, 'utf8'));      // fail the build on a broken library, not the visitor
  if(!data.cards || !data.planets) throw new Error('game/library.json is not a Territory library (no cards or planets)');
  fs.copyFileSync(lib, path.join(out, 'library.json'));
  note += ' · library.json ' + data.cards.length + ' cards, ' + (data.decks || []).length + ' decks';
}

const art = path.join(src, 'art');
if(fs.existsSync(art)){
  const files = fs.readdirSync(art).filter(f => /\.(png|jpe?g|webp|gif|svg|avif)$/i.test(f));
  if(files.length){
    fs.mkdirSync(path.join(out, 'art'));
    files.forEach(f => fs.copyFileSync(path.join(art, f), path.join(out, 'art', f)));
    note += ' · ' + files.length + ' sprite file' + (files.length === 1 ? '' : 's');
  }
}
console.log('dist/: ' + note);
