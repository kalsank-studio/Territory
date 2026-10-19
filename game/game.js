
"use strict";

/* ===================================================================
   TERRITORY — prototype engine
   Single file, no build step. Sections:
     1. Constants & default content
     2. Persistence
     3. Helpers
     4. Game engine
     5. Ability engine
     6. Bot
     7. Rendering (title, setup, board, results, studio, decks, sprites)
     8. Event routing
     9. Online (host runs the game, guests send commands and draw views)
   =================================================================== */

/* ------------------------------------------------------------------
   1. CONSTANTS & DEFAULT CONTENT
   ------------------------------------------------------------------ */

const RULES = { rounds:6, slotsPerPlayer:3, startHand:5, energyPerRound:2, drawPerRound:1,
  /* Cards already turned over can be shuffled between your slots on the planet
     they are on, at the end of your reveal turn (once everything of yours is
     face up, before End turn). Dropped on an occupied slot, the two cards swap.
     They never change planet and never come back to hand, so the ground they
     hold is unchanged — but which slot they sit in, and so what they harvest
     next round, is yours to arrange. During placement they stay put.
     Set false to nail revealed cards to the slot they landed in. */
  rearrangeRevealed:true,
  /* Once a human has turned all their cards over, their reveal turn waits for
     End turn: a last chance to shuffle revealed cards between slots on the same
     planet and to use activated abilities. Bots move on by themselves. */
  revealEndTurn:true };
const PCOLORS = ['var(--p1)','var(--p2)','var(--p3)','var(--p4)'];
const PNAMES  = ['Player 1','Player 2','Player 3','Player 4'];

const OPS = ['<=','>=','==','<','>'];
const OPSYM = {'<=':'\u2264','>=':'\u2265','==':'=','<':'<','>':'>'};

/* Group targets: affect every matching card at once. This is the original
   targeting system and stays exactly as it was. */
const TARGETS = {
  self:            'this card',
  alliesHere:      'your other cards here',
  yoursHere:       'your cards here',
  enemiesHere:     'all of an opponent\u2019s cards here',   // one opponent: yours to pick when there are several
  randomEnemyHere: 'a random enemy card here',
  weakestEnemyHere:'the weakest enemy card here',
  strongestEnemyHere:'the strongest enemy card here',
  yoursElsewhere:  'your cards on other planets',
  yoursAll:        'all of your cards',                 // every planet, this card included
  creator:         'the card that created this'         // tokens only: the card whose Create / Summon made it
};
/* Group targets offered in the "All matching cards" list; the other two have
   a place of their own (All of your cards; tokens only). */
const groupTargets = isToken => Object.keys(TARGETS).filter(k=>k!=='yoursAll' && (isToken || k!=='creator'));

/* Single-card targets: narrow down to exactly one card in two steps —
   whose cards are eligible, then which one of theirs. Every verb that picks
   ONE card uses this, wherever the card lives: on a planet (Give Power,
   Destroy, Recall, Move, Steal, Burn), in a hand (Discard), or in the
   graveyard (Draw / Summon from the graveyard). */
const PLAYER_SCOPES = {
  self:   'Yourself',
  choose: 'Choose another',
  random: 'Random player'
};
/* How one card is settled on. `zones` says where the rule makes sense:
   'next' and 'last' only mean something for cards being played onto planets. */
const CARD_RULES = {
  choice:     {label:'Your choice',          zones:['board','hand','grave']},
  random:     {label:'Random card',          zones:['board','hand','grave']},
  strongest:  {label:'Strongest',            zones:['board','hand','grave']},
  weakest:    {label:'Weakest',              zones:['board','hand','grave']},
  lowestCost: {label:'Lowest Energy cost',   zones:['board','hand','grave']},
  highestCost:{label:'Highest Energy cost',  zones:['board','hand','grave']},
  next:       {label:'The next card played', zones:['board']},
  last:       {label:'The last card played', zones:['board']},
  thisRound:  {label:'Each card played this round', zones:['board'], noRecipient:true}
};
/* Rules a Steal recipient can use: one card, never a standing effect. */
const recipientRules = () => rulesFor('board').filter(k=>!CARD_RULES[k].noRecipient);
const rulesFor = zone => Object.keys(CARD_RULES).filter(k=>CARD_RULES[k].zones.includes(zone));

/* The graveyard is one shared pile. A pick from it can be narrowed to the
   cards that belonged to you, or to everyone else. */
const GRAVE_OWNERS = { any:'Anyone’s', yours:'Yours', theirs:'Opponents’' };

/* Where Move sends a card. 'here' is wherever this ability's own card is. */
const MOVE_DEST = {
  here:   'This card’s planet',
  choice: 'A planet of your choice',
  random: 'A random planet'
};

/* Where an amount comes from. `group` organises the studio's dropdown;
   `for` limits an option to the verbs it makes sense on. */
const AMOUNT_SOURCES = {
  grave:      {group:'Game',        label:'Cards in the graveyard',      text:'the number of cards in the graveyard'},
  hand:       {group:'You',         label:'Cards in your hand',          text:'the number of cards in your hand'},
  energy:     {group:'You',         label:'Your Energy',                 text:'your Energy'},
  deck:       {group:'You',         label:'Cards left in your deck',     text:'the number of cards left in your deck'},
  yoursHere:  {group:'You',         label:'Your cards here',             text:'the number of your cards here'},
  enemiesHere:{group:'You',         label:'Enemy cards here',            text:'the number of enemy cards here'},
  leading:    {group:'You',         label:'Planets you are winning',     text:'the number of planets you are winning'},
  round:      {group:'Game',        label:'The round number',            text:'the round number'},
  /* One section for the cards an ability acts on: its own target ("its own …"),
     or the card the effect before it touched ("that card's …"). */
  tgtCost:    {group:'Target or that card', label:'The target’s own Energy cost', text:'its own Energy cost',  for:['givePower','burn','steal'], help:'TGT'},
  tgtPower:   {group:'Target or that card', label:'The target’s own Power',       text:'its own Power',       for:['givePower','burn','steal'], help:'TGT'},
  tgtBonus:   {group:'Target or that card', label:'The target’s own bonus Power', text:'its own bonus Power', for:['givePower','burn','steal'], help:'TGT'},
  all:        {group:'Target or that card', label:'All of the target’s bonus Power', text:'all of its bonus Power', for:['steal'], help:'Everything the target has in bonus Power.'},
  prevCost:   {group:'Target or that card', label:'That card’s Energy cost',  text:'that card’s Energy cost', help:'PREV'},
  prevPower:  {group:'Target or that card', label:'That card’s Power',        text:'that card’s Power',       help:'PREV'},
  prevBonus:  {group:'Target or that card', label:'That card’s bonus Power',  text:'that card’s bonus Power', help:'PREV'},
  prevCount:  {group:'Target or that card', label:'Cards the last effect touched', text:'the number of those cards',
               help:'How many cards the effect just before this one acted on \u2014 destroyed, discarded, drew, moved, buffed\u2026 \u201CDiscard random cards equal to the number of cards in your hand, in order to draw cards equal to the number of those cards\u201D discards your whole hand, then draws that many. 0 if it touched nothing.'},
  selfPower:  {group:'This card',   label:'This card’s Power',        text:'this card’s Power', help:'This card\u2019s current Power, buffs and burns included.'},
  selfCost:   {group:'This card',   label:'This card’s Energy cost',  text:'this card’s Energy cost'},
  enemyMaxPower:{group:'Enemies here', label:'Strongest enemy Power here', text:'the strongest enemy Power here', help:'ENEMY'},
  enemyMinPower:{group:'Enemies here', label:'Weakest enemy Power here',   text:'the weakest enemy Power here', help:'ENEMY'},
  enemyMaxCost: {group:'Enemies here', label:'Highest enemy Energy cost here', text:'the highest enemy Energy cost here', help:'ENEMY'},
  enemyMinCost: {group:'Enemies here', label:'Lowest enemy Energy cost here',  text:'the lowest enemy Energy cost here', help:'ENEMY'},
};
/* The two help lines shared by a family of sources. */
const SOURCE_HELP = {
  TGT:'The target\u2019s own value. With a group target, each card uses its own \u2014 \u201CGive your cards here Power equal to its own cost\u201D gives each card its own cost.',
  ENEMY:'Over every face-up enemy card on this card\u2019s planet; 0 when there are none.',
  PREV:'\u201CThat card\u201D is the card the effect just before this one acted on: the one it destroyed, discarded, drew, created, summoned, moved or buffed. If it acted on several, their values add up.'
};
const helpOf = k => { const h = (AMOUNT_SOURCES[k]||{}).help; return h ? (SOURCE_HELP[h] || h) : ''; };
/* Saved libraries from before the graveyard was shared. */
const LEGACY_SOURCES = { ownGrave:'grave', allGrave:'grave' };

/* needs: 'target' = a card (or cards) on a planet; 'amount' = a number;
   'token' = which token; 'dest' = Move's destination; 'to' = Steal's
   recipient; 'hand' = which hand and card; 'from' = deck/token or graveyard;
   'what' = Steal's Power-or-card switch; 'at'/'side' = where a summon lands;
   'opts' = the effects Choose picks between. needsOf() narrows these to what
   one effect actually uses. */
const VERBS = {
  givePower:  { label:'Give Power',      needs:['target','amount'] },
  burn:       { label:'Burn Power',      needs:['target','amount'] },
  steal:      { label:'Steal',           needs:['what','target','to','amount'] },
  move:       { label:'Move or Swap',    needs:['target','dest'] },
  destroy:    { label:'Destroy',         needs:['target'] },
  recall:     { label:'Recall',          needs:['target'] },
  draw:       { label:'Draw cards',      needs:['amount','from'] },
  gainEnergy: { label:'Gain Energy',     needs:['amount'] },
  discard:    { label:'Discard',         needs:['amount','hand'] },
  create:     { label:'Create in hand',  needs:['token','amount'] },
  summon:     { label:'Summon',          needs:['from','at','side'] },
  choose:     { label:'Choose N of…',    needs:['opts'] }
};
/* Verbs whose card target can be a group or the one-card hierarchy. */
const BOARD_VERBS = ['givePower','burn','steal','move','destroy','recall'];

/** The fields this particular effect uses. Steal takes Power from a card on
    a planet, or a card from a hand; Summon only names a token when it isn't
    pulling from the graveyard. */
function needsOf(f){
  const base = (VERBS[f.v]||{needs:[]}).needs;
  if(f.v==='steal') return f.what==='card' ? ['what','hand','amount'] : ['what','target','to','amount'];
  if(f.v==='summon') return (f.from==='grave' || f.from==='prev') ? base : base.concat('token');
  return base;
}
/** Does this effect pick cards from a pool a filter could narrow? */
function filterable(f){
  const n = needsOf(f);
  return n.includes('target') || n.includes('hand') || f.from==='grave';
}

/* When an effect fires. Everything but 'reveal' is passive: it waits on the
   card for something to happen to it, or to the graveyard. */
const WHEN = {
  reveal:    {label:'On reveal',                       text:''},
  drawn:     {label:'When drawn',                      text:'When this card is drawn'},
  discarded: {label:'When discarded',                  text:'When this card is discarded'},
  destroyed: {label:'When destroyed',                  text:'When this card is destroyed'},
  graveIn:   {label:'When a card goes to the graveyard', text:'Whenever a card goes to the graveyard'},
  graveOut:  {label:'When a card leaves the graveyard',  text:'Whenever a card leaves the graveyard'},
  roundStart:{label:'At the start of each round',        text:'At the start of each round'},
  roundEnd:  {label:'At the end of each round',          text:'At the end of each round'},
  nextRound: {label:'At the start of the next round',    text:'At the start of the next round'},
  gameEnd:   {label:'At the end of the game',            text:'At the end of the game'},
  activate:  {label:'Activated (tap)', text:'Activate'}
};
/* Triggers set off by the clock rather than by something happening. They fire
   for face-up cards on planets, in the order those cards arrived. */
const TIMED = ['roundStart','roundEnd','nextRound','gameEnd'];
const whenOf = f => (f && f.when) || 'reveal';

/* Comparisons, as words, for conditions and filters. */
const OP_WORDS = {'>=':'at least', '<=':'at most', '>':'more than', '<':'less than', '==':'exactly', 'between':'between'};
/* 'between' is a range, both ends included: val..val2 (either end can be read
   from the game instead, as valFrom / valFrom2). */
/* What a filter can test on a card. */
const CARD_STATS = { cost:'Energy cost', power:'Power', bonus:'bonus Power' };
/* Filters that are a yes/no about the card rather than a comparison. */
const FILTER_FLAGS = { playedTurn:'Played this turn' };
/** Whose turn it is, as a key a card can be stamped with: a reveal turn is one
    player's, placement is everyone's at once. */
const turnKey = () => !G ? '' : G.round+':'+(G.phase==='reveal' ? 'r'+G.revealer : G.phase);
/* Where a summon lands, and on whose side. */
const SUMMON_AT   = { here:'This planet', choice:'A planet of your choice', random:'A random planet' };
const SUMMON_SIDE = { self:'Your side', choose:'An opponent’s side', random:'A random opponent’s side' };
/* Rarity is an outline: white, green, purple. Exotics glow. */
const RARITIES = { basic:'Basic', elite:'Elite', exotic:'Exotic' };

/** Sources a condition or filter can compare against: anything read from the
    game, never "its own" (a condition has no target to be its own). */
const condSources = () => Object.keys(AMOUNT_SOURCES).filter(k=>!k.startsWith('tgt') && k!=='all');

/** Bring an effect saved by an older build up to the current shape. */
function migrateFx(f){
  if(!f) return f;
  if(LEGACY_SOURCES[f.nFrom]) f.nFrom = LEGACY_SOURCES[f.nFrom];
  if(f.v==='discard' && f.rand){ f.target = {player:'self', rule:'random'}; delete f.rand; }
  if(Array.isArray(f.opts)) f.opts.forEach(migrateFx);
  return f;
}

/* Card art is {t:'emoji'|'img', v:'value'} — see the Sprites screen. */
const E = v => ({t:'emoji', v});

const DEFAULT_CARDS = [
  { id:'spore',   name:'Spore Drone',      cost:1, power:2,  art:E('\u{1F9A0}'), fx:[] },
  { id:'kelp',    name:'Drift Kelp',       cost:1, power:1,  art:E('\u{1F33F}'), fx:[{v:'givePower',t:'alliesHere',n:1}] },
  { id:'husk',    name:'Hollow Seed',      cost:2, power:4,  art:E('\u{1F330}'), fx:[] },
  { id:'scout',   name:'Mycelial Scout',   cost:2, power:2,  art:E('\u{1F344}'), fx:[{v:'draw',n:1}] },
  { id:'moth',    name:'Ember Moth',       cost:2, power:3,  art:E('\u{1F98B}'), fx:[{v:'gainEnergy',n:1}] },
  { id:'beetle',  name:'Cinder Beetle',    cost:2, power:2,  art:E('\u{1FAB2}'), fx:[{v:'draw',n:1},{v:'discard',n:1}] },
  { id:'reef',    name:'Reef Sentinel',    cost:3, power:5,  art:E('\u{1FAB8}'), fx:[] },
  { id:'thorn',   name:'Thorn Choir',      cost:3, power:3,  art:E('\u{1F335}'), fx:[{v:'givePower',t:'randomEnemyHere',n:-2}], rarity:'elite' },
  { id:'bloom',   name:'Bloomcaller',      cost:3, power:2,  art:E('\u{1F337}'), fx:[{v:'summon',tok:'sapling'}], rarity:'elite' },
  { id:'fathom',  name:'Quiet Fathom',     cost:3, power:4,  art:E('\u{1F41A}'), fx:[] },
  { id:'grazer',  name:'Tidal Grazer',     cost:4, power:6,  art:E('\u{1F433}'), fx:[] },
  { id:'warden',  name:'Root Warden',      cost:4, power:4,  art:E('\u{1F332}'), fx:[{v:'givePower',t:'yoursElsewhere',n:1}], rarity:'elite' },
  { id:'reaper',  name:'Husk Reaper',      cost:4, power:3,  art:E('\u{1F578}\uFE0F'), fx:[{v:'destroy',t:'weakestEnemyHere'}], rarity:'elite' },
  { id:'vine',    name:'Sable Vine',       cost:4, power:5,  art:E('\u{1F33C}'), fx:[{v:'discard',n:1},{v:'gainEnergy',n:3}] },
  { id:'pollen',  name:'Pollen Storm',     cost:4, power:2,  art:E('\u{1F41D}'), fx:[{v:'recall',t:'randomEnemyHere'}], rarity:'elite' },
  { id:'bough',   name:'Stellar Bough',    cost:5, power:8,  art:E('\u2728'),    fx:[], rarity:'exotic' },
  { id:'nebula',  name:'Gravid Nebula',    cost:5, power:5,  art:E('\u{1F30C}'), fx:[{v:'create',tok:'stardust',n:2}], rarity:'elite' },
  { id:'sunward', name:'Sunward Bloom',    cost:5, power:6,  art:E('\u{1F33B}'), fx:[{v:'gainEnergy',n:2},{v:'draw',n:1}], rarity:'elite' },
  { id:'growth',  name:'Old Growth',       cost:6, power:11, art:E('\u{1F3DD}\uFE0F'), fx:[], rarity:'exotic' },
  { id:'heart',   name:'World-Tree Heart', cost:6, power:8,  art:E('\u{1F49A}'), fx:[{v:'givePower',t:'yoursHere',n:3}], rarity:'exotic' },
  { id:'oracle',  name:'Spore Oracle',     cost:3, power:3,  art:E('\u{1F52E}'), rarity:'elite',
    fx:[{v:'choose', n:1, opts:[{v:'draw',n:2},{v:'gainEnergy',n:2},{v:'givePower',t:'self',n:3}]}] },
  { id:'mire',    name:'Mire Lurker',      cost:2, power:3,  art:E('\u{1F40A}'), rarity:'elite',
    fx:[{v:'summon', when:'destroyed', from:'token', tok:'sapling', at:'here', side:'self'}] },
  { id:'cutpurse',name:'Void Cutpurse',    cost:3, power:2,  art:E('\u{1F311}'), rarity:'exotic',
    fx:[{v:'steal', what:'card', target:{player:'choose', rule:'random'}, n:1},
        {v:'givePower', t:'self', n:4, if:{src:'round', op:'>=', val:4}}] },
  { id:'beacon',  name:'Spore Beacon',     cost:2, power:2,  art:E('\u{1F4E1}'), rarity:'elite',
    fx:[{v:'givePower', t:'self', n:2, when:'activate', actCost:1, actUses:2}] },
  { id:'tideclock',name:'Tide Clock',      cost:3, power:3,  art:E('\u{1F570}\uFE0F'),
    fx:[{v:'gainEnergy', n:1, when:'roundEnd'}] },
  { id:'lastbloom',name:'Last Bloom',      cost:4, power:4,  art:E('\u{1F940}'), rarity:'exotic',
    fx:[{v:'givePower', t:'alliesHere', n:1, when:'gameEnd'}] }
];

const DEFAULT_TOKENS = [
  { id:'sapling',  name:'Sapling',  cost:0, power:2, art:E('\u{1F331}'), fx:[], token:true },
  { id:'stardust', name:'Stardust', cost:1, power:3, art:E('\u2B50'),    fx:[], token:true }
];

const c  = (stat,op,val) => ({stat,op,val});
const any = () => ({stat:'any',op:'>=',val:0});
const rE = n => ({type:'energy',amount:n});
const rD = n => ({type:'draw',amount:n});

const DEFAULT_PLANETS = [
  { id:'verdance', name:'Verdance',        art:E('\u{1F7E2}'), hue:'#4fd6b0', slots:[
      {cond:c('cost','<=',3), rew:rE(1)}, {cond:c('power','>=',5), rew:rD(1)}, {cond:c('cost','>=',4), rew:rE(2)} ]},
  { id:'ashfall',  name:'Ashfall Rim',     art:E('\u{1F7E0}'), hue:'#f2856c', slots:[
      {cond:c('power','<=',3), rew:rE(2)}, {cond:c('cost','>=',5), rew:rD(1)}, {cond:any(), rew:rE(1)} ]},
  { id:'shoal',    name:'The Deep Shoal',  art:E('\u{1F535}'), hue:'#5cbfe4', slots:[
      {cond:c('cost','<=',2), rew:rD(1)}, {cond:c('power','>=',7), rew:rE(2)}, {cond:c('cost','>=',3), rew:rE(1)} ]},
  { id:'corolla',  name:'Corolla Prime',   art:E('\u{1F7E3}'), hue:'#a482f0', slots:[
      {cond:c('power','>=',4), rew:rE(1)}, {cond:c('cost','<=',4), rew:rE(1)}, {cond:c('power','>=',9), rew:rD(1)} ]},
  { id:'hollow',   name:'Hollow Moon',     art:E('\u26AA'),    hue:'#c9d6cf', slots:[
      {cond:any(), rew:rE(1)}, {cond:c('cost','>=',6), rew:rE(2)}, {cond:c('power','<=',2), rew:rD(1)} ]},
  { id:'silt',     name:'Silt Garden',     art:E('\u{1F7E4}'), hue:'#b98a5e', slots:[
      {cond:c('cost','<=',1), rew:rE(2)}, {cond:c('power','>=',6), rew:rE(1)}, {cond:c('cost','>=',2), rew:rD(1)} ]},
  { id:'nimbus',   name:'Nimbus Reach',    art:E('\u{1F7E1}'), hue:'#f5b95c', slots:[
      {cond:c('power','>=',3), rew:rE(1)}, {cond:c('cost','>=',4), rew:rD(1)}, {cond:c('power','>=',8), rew:rE(2)} ]},
  { id:'cradle',   name:'Cradle of Wrens', art:E('\u{1F95A}'), hue:'#8fd6a0', slots:[
      {cond:c('cost','<=',3), rew:rD(1)}, {cond:c('power','<=',4), rew:rE(1)}, {cond:any(), rew:rE(1)} ]}
];

/* Shown by the "Paste an example" button on the import screen. Deliberately
   ends with a row that cannot be read as written, so the flagging is visible. */
const SAMPLE_TABLE = [
  'name, cost, power, ability, art, rarity',
  'Ashen Frond, 1, 2, , \u{1F343}',
  'Lantern Moth, 2, 2, Draw a card, \u{1FAB0}',
  'Salt Wren, 2, 3, Gain 1 Energy, \u{1F426}',
  'Glass Anemone, 3, 3, Give your other cards here +1 Power, \u{1FAB8}',
  'Cairn Beetle, 3, 2, Draw 1 and discard 1, \u{1FAB2}',
  'Nettle Choir, 4, 4, Give all enemy cards here -1 Power, \u{1F33F}',
  'Marrow Fig, 4, 3, Destroy the weakest enemy here, \u{1F33E}',
  'Slow Comet, 5, 6, Summon a Sapling here, \u2604\uFE0F',
  'Hunter Spore, 3, 3, Destroy an enemy card here, \u{1F344}',
  'Graft Bloom, 4, 3, Give a card of your choice +4 Power, \u{1F33A}',
  'Tithe Moth, 2, 2, Discard a card in order to give this card +3 Power, \u{1F98B}',
  'Grave Lantern, 3, 2, Gain Energy equal to the number of cards in the graveyard, \u{1F56F}\uFE0F',
  'Tidewalker, 3, 3, Move this card to a planet of your choice, \u{1F30A}',
  'Lichen Thief, 2, 2, Steal all bonus Power from an enemy card here and give it to this card, \u{1F98E}',
  'Solar Flare, 4, 3, Burn 3 Power from the strongest enemy card, \u2600\uFE0F',
  'Seed Vault, 2, 1, Give the next card you play +3 Power, \u{1F330}',
  'Carrion Bloom, 4, 2, Summon a random card from the graveyard here, \u{1F940}',
  'Fork Lichen, 3, 3, Choose one: draw a card / gain 2 Energy, \u{1F33F}, Elite',
  'Bog Warden, 2, 3, When this card is destroyed: Summon a Sapling here, \u{1F438}, Elite',
  'Late Bloomer, 3, 2, Give this card +4 Power if the round number is at least 4, \u{1F33C}',
  'Pick Wasp, 3, 2, Steal a random card from an opponent\'s hand, \u{1F41D}, Exotic',
  'Culling Vine, 4, 3, Destroy an enemy card of your choice here (only cards with Energy cost at most 3), \u{1F940}, Elite',
  'Vault Bloom, 5, 5, Whenever an opponent plays a card gain 2 Energy, \u{1F338}, Exotic'
].join('\n');

const DEFAULT_DECK = ['spore','kelp','husk','scout','moth','reef','thorn','bloom','grazer','warden','bough','growth'];

/* ------------------------------------------------------------------
   2. PERSISTENCE  (browser-local; export/import JSON from the Sprites
      screen to move a library between devices)
   ------------------------------------------------------------------ */

const KEY = 'territory.v1';

function blankLibrary(){
  return {
    cards:   clone(DEFAULT_CARDS),
    tokens:  clone(DEFAULT_TOKENS),
    planets: clone(DEFAULT_PLANETS),
    decks:   [ {id:'d1', name:'Verdant Rush', cards:clone(DEFAULT_DECK)},
               {id:'d2', name:'Second Deck',  cards:clone(DEFAULT_DECK)},
               {id:'d3', name:'Showcase',     cards:['spore','kelp','scout','moth','beetle','thorn','oracle','mire','cutpurse','reaper','pollen','nebula','heart','beacon','tideclock','lastbloom']} ],
    settings:{ players:2, planets:5, rounds:6, hide:true, choiceTimer:30, kinds:['human','human'], deckOf:['d1','d2'] }
  };
}

let LIB = null;   // populated at boot, after the helpers below are defined

function save(){
  try{ localStorage.setItem(KEY, JSON.stringify(LIB)); }
  catch(e){ console.warn('Could not save library', e); }
}
let saveTimer = null;
function saveSoon(){ clearTimeout(saveTimer); saveTimer = setTimeout(save, 400); }

/** Read the library this browser saved. True if there was one. */
function load(){
  try{
    const raw = localStorage.getItem(KEY);
    if(!raw) return false;
    const data = JSON.parse(raw);
    if(data && data.cards && data.planets){ adoptLibrary(data); return true; }
  }catch(e){ console.warn('Could not read saved library', e); }
  return false;
}

/* --- the library that ships with the page ----------------------------------
   A copy of the game on the web carries library.json beside it: the cards,
   decks, planets and sprites its maker put there. A first-time visitor starts
   from it; after that their own edits are theirs (saved in their browser).
   Art & data has a button to take the shipped one again. Opened as a plain
   file, or published without one, nothing is fetched and the built-in set is
   used, exactly as before. */
const SHIPPED_LIBRARY = 'library.json';
function fetchShippedLibrary(){
  if(typeof location==='undefined' || !/^https?:$/.test(location.protocol) || typeof fetch!=='function') return Promise.resolve(null);
  return fetch(SHIPPED_LIBRARY, {cache:'no-cache'})
    .then(r=>r.ok ? r.json() : null)
    .then(data=>(data && data.cards && data.planets) ? data : null)
    .catch(()=>null);
}
/** Settings a library might lack: four seats' kinds and decks. */
function fillSettings(){
  LIB.settings.kinds = LIB.settings.kinds || ['human','bot'];
  LIB.settings.deckOf = LIB.settings.deckOf || [LIB.decks[0].id, LIB.decks[1]?LIB.decks[1].id:LIB.decks[0].id];
  for(let i=0;i<4;i++){
    if(!LIB.settings.kinds[i]) LIB.settings.kinds[i] = i===0?'human':'bot';
    if(!LIB.settings.deckOf[i] || !LIB.decks.some(d=>d.id===LIB.settings.deckOf[i])) LIB.settings.deckOf[i] = LIB.decks[Math.min(i,LIB.decks.length-1)].id;
  }
}
/** Take a whole library (the saved one, or a backup file being restored):
    anything it lacks comes from the built-in set, settings it lacks keep their
    defaults, and older ability formats are brought up to date. */
function adoptLibrary(data){
  const base = blankLibrary();
  LIB = Object.assign(base, data);
  LIB.settings = Object.assign(blankLibrary().settings, data.settings||{});
  LIB.cards.concat(LIB.tokens||[]).forEach(c=>(c.fx||[]).forEach(migrateFx));
}

/* ------------------------------------------------------------------
   3. HELPERS
   ------------------------------------------------------------------ */

const $  = s => document.querySelector(s);
const clone = o => JSON.parse(JSON.stringify(o));
const esc = s => String(s==null?'':s).replace(/[&<>"']/g, m => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[m]));
const clamp = (n,a,b) => Math.max(a, Math.min(b, n));
/* --- randomness ------------------------------------------------------------
   Every random thing the RULES do (shuffles, the roll for first, random
   targets) draws from one seeded stream kept in the game state, G.rng. The same
   seed and the same commands replay to the same game, move for move — which is
   what lets a server run the game and lets anyone check a result afterwards.
   Bots think with a stream of their own (G.botRng), so a bot's deliberation
   never shifts what the rules roll. Purely visual randomness (dust, stars, a
   die's face while it tumbles) uses uiRnd and never touches either stream. */
function seededNext(st){                 // mulberry32 over a {s} object, so the state serialises
  st.s = (st.s + 0x6D2B79F5) >>> 0;
  let t = st.s;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const newSeed = () => (Math.floor(Math.random()*4294967296) >>> 0) || 1;
let RNG_LIVE = null;                     // the rules stream of the game being built or played
const rand01 = () => RNG_LIVE ? seededNext(RNG_LIVE) : Math.random();
const rnd = n => Math.floor(rand01()*n);
const pick = a => a[rnd(a.length)];
function shuffle(a){ a=a.slice(); for(let i=a.length-1;i>0;i--){ const j=rnd(i+1); [a[i],a[j]]=[a[j],a[i]]; } return a; }
/* the bots' own stream */
const botRand = () => (G && G.botRng) ? seededNext(G.botRng) : Math.random();
const botPick = a => a[Math.floor(botRand()*a.length)];
/* looks only */
const uiRnd = n => Math.floor(Math.random()*n);
/** Point the rules stream at whichever game is now live. */
function adoptRng(game){ RNG_LIVE = game && game.rng ? game.rng : null; }

/* Card ids count up per game (G.uids), so the same seed and the same commands
   give every card the same id on every device — commands name cards by id.
   Previews in the studio take ids from a separate counter and never touch it. */
let uidN = 0, UID_LIVE = null;
/* A card's id says nothing about the card: it is drawn from the game's own
   random stream (so every device agrees on it), not counted in deck order —
   a counted id would tell an opponent which of your deck's cards sits face
   down in front of them. */
const rid5 = () => Math.floor(rand01()*60466176).toString(36).padStart(5,'0');
const newUid = () => UID_LIVE ? (UID_LIVE.n++, 'c'+rid5()+rid5()) : 'x'+(++uidN);
/** A card built only to be looked at (the studio preview). */
function previewInstance(def, owner){ const live = UID_LIVE; UID_LIVE = null; try{ return instance(def, owner||0); } finally{ UID_LIVE = live; } }

function defById(id){
  return LIB.cards.find(c=>c.id===id) || LIB.tokens.find(c=>c.id===id) || null;
}
function deckById(id){ return LIB.decks.find(d=>d.id===id) || LIB.decks[0]; }

/** Turn a card definition into a live instance. */
function instance(def, owner){
  return { uid:newUid(), def:def.id, name:def.name, cost:def.cost, base:def.power, printed:def.power,
           bonus:0, art:clone(def.art||E('\u2B1B')), fx:clone(def.fx||[]).map(migrateFx), owner, faceUp:false,
           rarity: RARITIES[def.rarity] ? def.rarity : 'basic', token: !!def.token || !!(LIB && LIB.tokens && LIB.tokens.some(t=>t.id===def.id)) };
}
/** A card leaving the board loses its Power tokens and any burned-away base
    Power: it goes back to being the card as printed. */
function resetCard(card){
  card.bonus = 0;
  delete card.seq; delete card.playedRound; delete card.playedTurn; delete card.actRound; delete card.actUsed;
  if(card.printed!=null) card.base = card.printed;
  return card;
}
/** A card arriving face up on a planet: when (for activated abilities and
    "start of the next round") and in what order (round and game-end triggers). */
function markInPlay(card){
  card.seq = G.seq = (G.seq||0) + 1;
  card.playedRound = G.round;
  card.playedTurn = turnKey();
}
/** Everything destroyed, discarded or fizzled goes on one shared pile, and
    every card watching the graveyard hears about it. */
function toGrave(card){
  resetCard(card);
  card.faceUp = true;
  G.grave.push(card);
  graveWatchers('graveIn', card);
}
const powerOf = card => Math.max(0, card.base + card.bonus);
/** 'nerfed' below its printed Power (a red circle), 'buffed' above it. */
function powerCls(card){
  const now = powerOf(card), ref = card.printed!=null ? card.printed : card.base;
  return now<ref ? 'nerfed' : now>ref ? 'buffed' : '';
}
/* Tokens aren't collected, so they have no rarity: they wear a dark grey edge instead. */
const rarityOf = card => card && (card.token || (LIB && LIB.tokens && LIB.tokens.includes(card))) ? 'token' : RARITIES[card && card.rarity] ? card.rarity : 'basic';

function artHTML(art, alt){
  if(art && art.t==='img' && art.v) return `<img src="${esc(art.v)}" alt="${esc(alt||'')}" loading="lazy">`;
  return esc(art && art.v ? art.v : '\u2B1B');
}

function condText(cond){
  if(!cond || cond.stat==='any') return 'Any card';
  if(cond.stat==='winner') return 'Strongest card here wins it';
  return (cond.stat==='cost' ? 'Cost ' : 'Power ') + OPSYM[cond.op] + cond.val;
}
function condShort(cond){
  if(!cond || cond.stat==='any') return 'Any';
  if(cond.stat==='winner') return '\u{1F3C6}';
  return (cond.stat==='cost' ? '\u26A1' : '\u2726') + OPSYM[cond.op] + cond.val;
}
/* 'winner' is a cross-player comparison resolved once per slot in harvest(),
   not a per-card check — so on its own it never matches any single card. */
function condMet(cond, card){
  if(!card) return false;
  if(!cond || cond.stat==='any') return true;
  if(cond.stat==='winner') return false;
  const v = cond.stat==='cost' ? card.cost : powerOf(card);
  switch(cond.op){
    case '<=': return v<=cond.val; case '>=': return v>=cond.val;
    case '==': return v===cond.val; case '<': return v<cond.val; case '>': return v>cond.val;
  }
  return false;
}
/** Would `card`, sitting in slot `si` of planet `pi` for player `ownerIdx`, be
    the single strongest card in that slot? Only what that player can see
    counts: an opponent's face-down card is unknown, so it's left out. A tie is
    not a win — a tied trophy slot pays nobody. */
function slotWins(pi, si, card, ownerIdx){
  const mine = powerOf(card);
  return G.planets[pi].board.every((row,i)=>{
    if(i===ownerIdx) return true;
    const c = row[si];
    return !c || !c.faceUp || powerOf(c) < mine;
  });
}
/** A slot's condition for one card, at one place: the per-card check, or for a
    🏆 slot, whether it would be the strongest there. */
function slotMet(pi, si, card, ownerIdx){
  const cond = G.planets[pi].slots[si].cond;
  if(!card) return false;
  return cond && cond.stat==='winner' ? slotWins(pi, si, card, ownerIdx) : condMet(cond, card);
}
/* A slot's condition, round-tripped through a data attribute so a drag can test
   it without a re-render. */
function condAttr(cond){
  const v = (!cond || cond.stat==='any') ? 'any' : cond.stat+':'+cond.op+':'+cond.val;
  return `data-cond="${v}"`;
}
function condFromAttr(v){
  if(!v || v==='any') return {stat:'any', op:'>=', val:0};
  const bits = String(v).split(':');
  return {stat:bits[0], op:bits[1], val:+bits[2]};
}

function rewText(r){ return r.type==='energy' ? '+'+r.amount+' \u26A1' : r.type==='draw' ? '+'+r.amount+' \u{1F0A0}' : '\u2014'; }
function rewLong(r){ return r.type==='energy' ? '+'+r.amount+' Energy' : r.type==='draw' ? 'Draw '+r.amount : 'No reward'; }

/** The noun phrase for a single-card target: who owns the eligible cards,
    crossed with how one of them gets picked. */
function singleTargetPhrase(T){
  T = T || {player:'self', here:false, rule:'choice'};
  const loc = T.here ? ' here' : '';
  if(T.rule==='next') return (T.player==='self' ? 'the next card you play'
                            : T.player==='random' ? 'the next card a random opponent plays'
                            : 'the next card an opponent plays') + loc;
  if(T.rule==='thisRound') return (T.player==='self' ? 'each card you play'
                            : T.player==='random' ? 'each card a random opponent plays'
                            : 'each card an opponent plays') + loc + ' this round';
  if(T.rule==='last') return (T.player==='self' ? 'the last card you played'
                            : T.player==='random' ? 'the last card a random opponent played'
                            : 'the last card an opponent played') + loc;
  const sup = SUPERLATIVE[T.rule];
  let s;
  if(T.player==='self'){
    s = T.rule==='random' ? 'a random card of yours'
      : sup ? 'your '+sup+' card'
      : 'a card of your choice';
  }else if(T.player==='random'){
    s = T.rule==='random' ? 'a random enemy card'
      : sup ? "a random opponent's "+sup+' card'
      : 'a card of your choice from a random opponent';
  }else{                                       // 'choose' — you pick the opponent when there is more than one
    s = T.rule==='random' ? 'a random enemy card'
      : sup ? 'the '+sup+' enemy card'
      : 'an enemy card of your choice';
  }
  return s + loc;
}
const SUPERLATIVE = {strongest:'strongest', weakest:'weakest', lowestCost:'lowest-cost', highestCost:'highest-cost'};
const PLURAL_GROUPS = ['alliesHere','yoursHere','enemiesHere','yoursElsewhere'];

/** "a card", "2 random cards", "the strongest card", "cards of your choice"…
    `n` is a number, or null when the count comes from an amount source. */
function pickNoun(rule, n, ofYourChoice){
  const sup = SUPERLATIVE[rule];
  const choice = ofYourChoice ? ' of your choice' : '';
  if(n==null) return rule==='random' ? 'random cards' : sup ? 'the '+sup+' cards' : 'cards'+choice;
  if(n==1)    return rule==='random' ? 'a random card' : sup ? 'the '+sup+' card' : 'a card'+choice;
  return rule==='random' ? n+' random cards' : sup ? 'the '+n+' '+sup+' cards' : n+' cards'+choice;
}

/** What Discard takes, and from whose hand. */
function handPhrase(f){
  const T = handSpecOf(f);
  const n = f.nFrom ? null : (f.n==null?1:f.n);
  if(T.player==='self'){
    if(T.rule==='choice' || T.rule==='random') return pickNoun(T.rule, n, false);
    return pickNoun(T.rule, n, false)+' from your hand';
  }
  const whose = T.player==='random' ? "a random opponent's hand" : "an opponent's hand";
  return pickNoun(T.rule, n, true)+' from '+whose;
}
/** Steal only ever takes from someone else's hand. */
function handSpecOf(f){
  const T = f.target || {player:'self', rule:'choice'};
  return (f.v==='steal' && T.player==='self') ? Object.assign({}, T, {player:'choose'}) : T;
}

/** Which graveyard card(s) Draw or Summon takes. */
function gravePhrase(f, n){
  const spec = f.pick || {owner:'any', rule:'choice'};
  const from = spec.owner==='yours' ? 'your cards in the graveyard'
             : spec.owner==='theirs' ? 'enemy cards in the graveyard' : 'the graveyard';
  return pickNoun(spec.rule, n, true)+' from '+from;
}

/** Where an effect's amount comes from, as a trailing phrase, or '' for a
    plain fixed number. */
function amountPhrase(f){
  const src = LEGACY_SOURCES[f.nFrom] || f.nFrom;
  if(!src || src==='all') return '';
  let text = (AMOUNT_SOURCES[src]||{}).text || '';
  if(src.startsWith('tgt') && !f.target && PLURAL_GROUPS.includes(f.t)) text = text.replace(/^its own/, 'their own');
  return ' equal to '+text;
}

/** The other side of a comparison: a number, or a value read from the game. */
const rhsText = spec => spec.valFrom ? (AMOUNT_SOURCES[spec.valFrom]||{}).text || '?' : String(+spec.val||0);
/** "the round number is at least 3" */
const rhsText2 = spec => spec.valFrom2 ? (AMOUNT_SOURCES[spec.valFrom2]||{}).text || '?' : String(+spec.val2||0);
/** "at least 3", or for a range "between 3 and 4" */
const cmpText = spec => spec.op==='between' ? `between ${rhsText(spec)} and ${rhsText2(spec)}` : `${OP_WORDS[spec.op]||'at least'} ${rhsText(spec)}`;
const condCore = c => `${(AMOUNT_SOURCES[c.src]||{}).text||'?'} is ${cmpText(c)}`;
/** " if the round number is at least 3", or '' */
const condPhrase = c => c ? ' if '+condCore(c) : '';
/** " (only cards with Energy cost at most 3)", or '' */
const filterPhrase = o => !o ? ''
  : o.stat==='playedTurn' ? ' (only cards played this turn)'
  : ` (only cards with ${CARD_STATS[o.stat]||'Power'} ${cmpText(Object.assign({op:'<='}, o))})`;

const NUMBER_WORDS = ['zero','one','two','three','four','five','six','seven','eight','nine','ten'];
const tokName = id => defById(id) ? defById(id).name : (PENDING_TOKENS[id] || '?');
/* Tokens defined further down the table being imported, so Create and Summon
   can name them before they exist: id -> name. */
const PENDING_TOKENS = {};
const lc = t => t ? t.charAt(0).toLowerCase()+t.slice(1) : t;

/** One effect as a sentence, starting with a capital — the verb and its
    target first, then any filter, then any condition. `bare` leaves both
    off, for when the condition is what's being talked about. */
function verbPhrase(f, bare){
  if(f.v==='choose'){
    /* Its own condition sits before the colon, so it can't be mistaken for
       the last option's. */
    const n = f.n||1;
    const opts = (f.opts||[]).map(o=>lc(verbPhrase(o))).filter(Boolean);
    return `Choose ${NUMBER_WORDS[n]||n}${bare?'':condPhrase(f.if)}: ${opts.join(' / ') || 'nothing'}`;
  }
  const tail = bare ? '' : filterPhrase(f.only) + condPhrase(f.if);
  return coreVerbPhrase(f) + tail;
}

function coreVerbPhrase(f){
  const t = f.target ? singleTargetPhrase(f.target) : (TARGETS[f.t] || 'this card');
  const amt = amountPhrase(f);
  switch(f.v){
    case 'givePower':  return amt ? 'Give '+t+' Power'+amt : 'Give '+t+' '+(f.n>0?'+':'')+f.n+' Power';
    case 'burn':       return amt ? 'Burn Power'+amt+' from '+t : 'Burn '+(f.n||0)+' Power from '+t;
    case 'steal':{
      if(f.what==='card') return 'Steal '+handPhrase(f)+amt;
      const how = (f.nFrom==='all' || (f.n==null && !f.nFrom)) ? 'all bonus Power'
                : amt ? 'bonus Power'+amt : 'up to '+f.n+' bonus Power';
      const to = (!f.to || f.to==='self') ? 'this card' : singleTargetPhrase(f.to);
      return 'Steal '+how+' from '+t+' and give it to '+to;
    }
    case 'move':
      if(f.swap) return 'Swap '+t+({here:' with a card on this planet', choice:' with a card on a planet of your choice', random:' with a card on a random planet'}[f.dest||'here']);
      return 'Move '+t+({here:' to this planet', choice:' to a planet of your choice', random:' to a random planet'}[f.dest||'here']);
    case 'destroy':    return 'Destroy '+t;
    case 'recall':     return 'Recall '+t;
    case 'draw':
      if(f.from==='grave') return 'Draw '+gravePhrase(f, f.nFrom?null:(f.n==null?1:f.n))+amt;
      return amt ? 'Draw cards'+amt : 'Draw '+(f.n==1?'a card':f.n+' cards');
    case 'gainEnergy': return amt ? 'Gain Energy'+amt : 'Gain '+f.n+' Energy';
    case 'discard':    return 'Discard '+handPhrase(f)+amt;
    case 'create':     return amt ? 'Create '+tokName(f.tok)+' in hand'+amt : 'Create '+f.n+' '+tokName(f.tok)+' in hand';
    case 'summon':{
      const what = f.from==='grave' ? gravePhrase(f, 1) : f.from==='prev' ? 'that card' : 'a '+tokName(f.tok);
      const side = {self:'', choose:' for an opponent', random:' for a random opponent'}[f.side||'self'];
      const at = {here:' here', choice:' on a planet of your choice', random:' on a random planet'}[f.at||'here'];
      return 'Summon '+what+side+at;
    }
    case 'choose':{
      const n = f.n||1;
      const opts = (f.opts||[]).map(o=>lc(verbPhrase(o))).filter(Boolean);
      return `Choose ${NUMBER_WORDS[n]||n}: ${opts.join(' / ') || 'nothing'}`;
    }
  }
  return '';
}

/** Human-readable ability line, generated from the effect list. Effects
    chained with "in order to" read as one sentence. Passive effects open
    their sentence with what sets them off; several with the same trigger
    share it, separated by semicolons. */
function fxText(fx){
  if(!fx || !fx.length) return '';
  const sentences = [];
  let cur = null, linked = false;
  fx.forEach(f=>{
    const raw = verbPhrase(f);
    if(!raw) return;
    const w = whenOf(f);
    if(cur && linked && cur.when===w) cur.text += ', in order to '+lc(raw);
    else if(cur && cur.when===w && w!=='reveal') cur.text += '; '+lc(raw);
    else { cur = {when:w, text:raw, first:f}; sentences.push(cur); }
    linked = !!f.then;
  });
  return sentences.map(x => (x.when==='reveal' ? '' : whenText(x.first)+': ') + x.text).join('. ') + '.';
}
const USES_WORDS = {1:'once', 2:'twice'};
/** The words that open a passive, timed or activated sentence. An activated
    ability carries its price: "Activate (2 Energy, twice)", "Activate (free)". */
function whenText(f){
  const w = whenOf(f);
  if(w!=='activate') return WHEN[w].text;
  const cost = Math.max(0, f.actCost|0), uses = f.actUses>0 ? (f.actUses|0) : 0;
  return `Activate (${cost ? cost+' Energy' : 'free'}${uses ? ', '+(USES_WORDS[uses] || uses+' times') : ''})`;
}

/* ------------------------------------------------------------------
   3b. TABLE IMPORT
   Paste a table of cards; read the ability column against the verbs in the
   design doc. Anything that does not resolve cleanly is flagged for review
   rather than quietly guessed at.
   ------------------------------------------------------------------ */

/* --- the table itself --- */

function splitTable(text){
  let lines = String(text||'').replace(/\r/g,'').split('\n');
  const pipey = lines.filter(l=>l.trim()).length &&
                lines.filter(l=>l.trim()).every(l=>l.trim().startsWith('|') || /\|/.test(l));
  if(pipey){                                    // a markdown table
    return lines
      .filter(l=>l.trim() && !/^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(l))
      .map(l=>l.replace(/^\s*\|/,'').replace(/\|\s*$/,'').split('|').map(c=>c.trim()));
  }
  const head = lines.find(l=>l.trim()) || '';
  const delim = (head.split('\t').length > head.split(',').length) ? '\t' : ',';
  const rows = [];
  let row = [], field = '', quoted = false;
  const src = String(text||'').replace(/\r/g,'');
  for(let i=0;i<src.length;i++){
    const ch = src[i];
    if(quoted){
      if(ch==='"'){ if(src[i+1]==='"'){ field+='"'; i++; } else quoted = false; }
      else field += ch;
    }
    else if(ch==='"') quoted = true;
    else if(ch===delim){ row.push(field); field=''; }
    else if(ch==='\n'){ row.push(field); rows.push(row); row=[]; field=''; }
    else field += ch;
  }
  row.push(field); rows.push(row);
  return rows.map(r=>r.map(c=>c.trim())).filter(r=>r.some(c=>c!==''));
}

const COLUMN_ALIASES = {
  name:   ['name','card','card name','title'],
  cost:   ['cost','energy','energy cost','e'],
  power:  ['power','pow','strength','p'],
  ability:['ability','abilities','text','rules','rules text','effect','ability text'],
  art:    ['art','emoji','icon','sprite','image'],
  rarity: ['rarity','tier','rarity tier','grade'],
  id:     ['id','card id','key'],
  type:   ['type','kind','card type'],
  fx:     ['fx','fx json','effects','effects json'],
  notes:  ['notes','note','review','comment','comments','designer note','designer notes']
};
/* Rarity words a table might use, mapped onto the three this build has. */
const RARITY_WORDS = { basic:'basic', common:'basic', normal:'basic', white:'basic',
  elite:'elite', uncommon:'elite', rare:'elite', green:'elite',
  exotic:'exotic', epic:'exotic', legendary:'exotic', mythic:'exotic', purple:'exotic' };

function readHeader(row){
  const map = {};
  row.forEach((cell,i)=>{
    const k = cell.toLowerCase().replace(/[^a-z ]/g,'').trim();
    Object.entries(COLUMN_ALIASES).forEach(([field,names])=>{
      if(map[field]==null && names.includes(k)) map[field] = i;
    });
  });
  return (map.name!=null && (map.cost!=null || map.power!=null)) ? map : null;
}

/* --- the ability column --- */

const NUM_WORDS = {a:1, an:1, one:1, two:2, three:3, four:4, five:5, six:6, seven:7, eight:8, nine:9, ten:10};

const VERB_WORDS = [
  [/^(give|grant|buff)\b/,        'givePower'],
  [/^(destroy|kill|remove)\b/,    'destroy'],
  [/^(recall|return|bounce)\b/,   'recall'],
  [/^draw\b/,                     'draw'],
  [/^(gain|get)\b/,               'gainEnergy'],
  [/^discard\b/,                  'discard'],
  [/^(create|add)\b/,             'create'],
  [/^summon\b/,                   'summon'],
  [/^(move|relocate|shift)\b/,    'move'],
  [/^(steal|siphon)\b/,           'steal'],
  [/^(burn|scorch|sear)\b/,       'burn'],
  [/^choose\b/,                   'choose'],
  [/^(swap|switch|trade places)\b/, 'move']
];

/* Most specific phrasing first, so "weakest enemy here" never reads as "enemies here". */
const TARGET_WORDS = [
  ['creator',           [/\bthe card that (?:created|made|summoned) (?:this|it)\b/]],
  ['yoursAll',          [/\ball (?:of )?your cards (?:everywhere|on every planet|anywhere)\b/, /\ball of your cards\b(?! here| on)/]],
  ['yoursElsewhere',    [/on other planets/, /other planets/, /elsewhere/]],
  ['weakestEnemyHere',  [/weakest enemy/, /lowest power enemy/]],
  ['strongestEnemyHere',[/strongest enemy/, /highest power enemy/]],
  ['randomEnemyHere',   [/random enemy/]],
  ['alliesHere',        [/your other cards/, /other allies/, /allies here/, /other friendly/]],
  ['yoursHere',         [/all your cards/, /your cards/, /friendly cards/, /allies/]],
  ['enemiesHere',       [/all of an opponent'?s cards/, /all enemy cards/, /enemy cards/, /enemies/, /opposing cards/, /enemy/]],
  ['self',              [/this card/, /itself/, /\bself\b/, /\bthis\b/]]
];

/* Where a clause actually starts saying what happens. */
const VERB_LIST = 'give|grant|buff|destroy|kill|remove|recall|return|bounce|draw|gain|get|discard|create|add|summon|move|relocate|shift|steal|siphon|burn|scorch|sear|choose|swap|switch';
const VERB_START = new RegExp('\\b('+VERB_LIST+')\\b', 'i');
const VERB_ANCHOR = new RegExp('^'+VERB_START.source, 'i');
/* "…and draw a card" starts a new effect; Steal's "…and give it to…" does not. */
const AND_VERB = new RegExp(',?\\s*\\band\\s+(?=(?:'+VERB_LIST.replace('give|','give(?!\\s+(?:it|them)\\s+to)|')+')\\b)', 'i');

const TIMING_WORDS = /\b(when|whenever|if|while|each round|every round|at the (start|end)|after|ongoing|instead|until|next turn)\b/i;

/* "When this card is destroyed:" and the rest, matched loosely. */
const WHEN_WORDS = [
  ['drawn',     /^when(?:ever)? this card is drawn\s*[:,–—-]\s*/i],
  ['discarded', /^when(?:ever)? this card is discarded\s*[:,–—-]\s*/i],
  ['destroyed', /^when(?:ever)? this card is destroyed\s*[:,–—-]\s*/i],
  ['graveIn',   /^when(?:ever)? (?:a|any) card (?:goes|is put|is sent|enters?)(?: in)?(?: to| into)? the graveyard\s*[:,–—-]\s*/i],
  ['graveOut',  /^when(?:ever)? (?:a|any) card leaves the graveyard\s*[:,\u2013\u2014-]\s*/i],
  ['roundStart',/^at the (?:start|beginning) of (?:each|every) round\s*[:,\u2013\u2014-]?\s*/i],
  ['roundEnd',  /^at the end of (?:each|every) round\s*[:,\u2013\u2014-]?\s*/i],
  ['nextRound', /^at the (?:start|beginning) of (?:the )?next round\s*[:,\u2013\u2014-]?\s*/i],
  ['gameEnd',   /^at the end of the game\s*[:,\u2013\u2014-]?\s*/i],
  ['activate',  /^activate(?:d)?\s*(?:\(([^)]*)\))?\s*[:,\u2013\u2014-]\s*/i]
];
/** "2 Energy, twice" inside Activate (…): the price and the number of uses. */
function readActivation(inside, issues){
  const t = String(inside||'').toLowerCase().trim();
  const out = {cost:0, uses:0};
  if(!t) return out;
  t.split(/\s*[,;\/]\s*|\s+and\s+/).filter(Boolean).forEach(bit=>{
    let m;
    if(/^(free|no cost|0 energy)$/.test(bit)) out.cost = 0;
    else if((m = bit.match(/^(\d+)\s*(?:energy|\u26A1)$/))) out.cost = parseInt(m[1],10);
    else if(bit==='once') out.uses = 1;
    else if(bit==='twice') out.uses = 2;
    else if((m = bit.match(/^(\d+|one|two|three|four|five|six|seven|eight|nine|ten)\s*(?:times|uses?)$/))) out.uses = /^\d/.test(m[1]) ? parseInt(m[1],10) : NUM_WORDS[m[1]];
    else if(/^(unlimited|any number of times|no limit|unlimited uses)$/.test(bit)) out.uses = 0;
    else issues.push(`"${bit}" in "Activate (${inside})" isn\u2019t a cost or a number of uses \u2014 it was ignored. Write it like "Activate (2 Energy, twice)" or "Activate (free)".`);
  });
  return out;
}
const OP_TEXT = 'at least|at most|more than|less than|exactly|between';
const COND_TAIL = new RegExp('\\s+if (.+?) is ('+OP_TEXT+') (.+)$');
const FILTER_FLAG_PAREN = /\s*\(only cards? (?:that were |which were )?played this turn\)/;
const FILTER_PAREN = new RegExp("\\s*\\(only cards? with (energy cost|cost|power|bonus power) (?:is )?("+OP_TEXT+") (.+?)\\)");
const opOf = w => Object.keys(OP_WORDS).find(k=>OP_WORDS[k]===w) || '>=';

function parseAbility(raw){
  const issues = [], fx = [];
  let text = String(raw||'').replace(/[‘’]/g, "'").trim();
  if(!text || /^(none|no ability|n\/a|vanilla|[-–—])$/i.test(text)) return {fx, issues};

  const trigger = text.match(/^(on reveal|when revealed|reveal)\s*[:,–—-]\s*/i);
  if(trigger) text = text.slice(trigger[0].length);
  text = text.replace(/[\s,(]*\b(when revealed|on reveal)\b\)?\.?\s*$/i, '');   // trailing trigger

  /* "If you discard a card, gain 2 Energy" is a conditional chain, not a
     timing condition — rewrite it to the canonical "in order to" form. */
  const ifm = text.match(/^if you\s+(.+?),\s*(?:then\s+)?(.+)$/i);
  if(ifm && VERB_ANCHOR.test(ifm[1].trim()) && VERB_ANCHOR.test(ifm[2].trim())){
    text = ifm[1].trim()+' in order to '+ifm[2].trim();
  }

  /* Sentences (each may open with a passive trigger), then ';' parts that
     share it, then "in order to" links, then "and <verb>" within a link. The
     last effect read before each "in order to" gates whatever follows it. */
  const sentences = text.split(/[.\n]/).map(s=>s.trim()).filter(Boolean);
  sentences.forEach(sent=>{
    let when = 'reveal', act = null;
    const pw = WHEN_WORDS.find(([,re])=>re.test(sent));
    if(pw){
      when = pw[0];
      if(when==='activate') act = readActivation((sent.match(pw[1])||[])[1], issues);
      sent = sent.replace(pw[1], '');
    }
    /* Anything else that sounds like timing can't be read: say so, and read
       on from the first verb. Conditions ("… if X is at least N") are fine. */
    const scrub = sent.replace(new RegExp('\\bif (.+?) is ('+OP_TEXT+') ', 'gi'), ' ');
    if(TIMING_WORDS.test(scrub.replace(/\bchoose \w+( if .+?)?:/gi,''))){
      issues.push(`"${sent}" has timing this build can't read. Triggers it reads: "When this card is drawn / discarded / destroyed:", "Whenever a card goes to / leaves the graveyard:", "At the start / end of each round:", "At the start of the next round:", "At the end of the game:" and "Activate (2 Energy, twice):"; conditions read "… if <value> is at least N". The rest was read as ${when==='reveal'?'an on-reveal':WHEN[when].label.toLowerCase()}.`);
      const vstart = sent.search(VERB_START);
      if(vstart > 0) sent = sent.slice(vstart);
    }
    sent.split(';').map(s=>s.trim()).filter(Boolean).forEach(part=>{
      const links = part.split(/,?\s*\bin order to\b\s*/i).map(s=>s.trim()).filter(Boolean);
      links.forEach((link, j)=>{
        let last = null;
        const clauses = /^choose\b/i.test(link) ? [link] : link.split(AND_VERB).map(s=>s.trim()).filter(Boolean);
        clauses.forEach(cl=>{
          const r = parseClause(cl);
          if(r.fx){
            if(when!=='reveal') r.fx.when = when;
            if(act){ r.fx.actCost = act.cost; if(act.uses) r.fx.actUses = act.uses; }
            fx.push(r.fx); last = r.fx;
          }
          r.issues.forEach(i=>issues.push(i));
        });
        if(j < links.length-1){
          if(last) last.then = true;
          else issues.push(`Nothing readable before "in order to" in "${part}", so what follows runs unconditionally.`);
        }
      });
    });
  });
  if(!fx.length && !issues.length) issues.push(`Nothing readable in "${text}".`);
  return {fx, issues};
}

/** A value read off the game, by its rules-text wording. */
function readCondSource(phrase){
  const p = phrase.replace(/[‘’]/g,"'").replace(/[.,]$/,'').trim().toLowerCase();
  const exact = condSources().find(k=>AMOUNT_SOURCES[k].text.replace(/[‘’]/g,"'").toLowerCase()===p);
  if(exact) return exact;
  const loose = readSource(p, 'gainEnergy', []);
  return loose && condSources().includes(loose) ? loose : null;
}
/** The right-hand side of a comparison: {val} or {valFrom}, or null. */
function readCompareValue(phrase){
  const p = phrase.trim();
  if(/^[+-]?\d+$/.test(p)) return {val: parseInt(p,10)};
  if(NUM_WORDS[p]!=null) return {val: NUM_WORDS[p]};
  const src = readCondSource(p);
  return src ? {valFrom: src} : null;
}

function parseClause(cl){
  const issues = [];
  let low = cl.toLowerCase().replace(/[\u2018\u2019]/g,"'").replace(/\s+/g,' ').trim();
  if(!low) return {fx:null, issues};

  /* Choose N: options separated by " / ", its own condition before the colon. */
  const ch = low.match(new RegExp('^choose (\\w+)(?: if (.+?) is ('+OP_TEXT+') ([^:]+?))?\\s*[:\u2013\u2014-]\\s*(.+)$'));
  if(ch){
    const n = /^\d+$/.test(ch[1]) ? parseInt(ch[1],10) : NUM_WORDS[ch[1]];
    const f = {v:'choose', n: n||1, opts:[]};
    if(!n) issues.push(`"choose ${ch[1]}" isn't a number — read as choose one.`);
    ch[5].split(new RegExp('\\s*\\/\\s*|\\s+or\\s+(?=(?:'+VERB_LIST+')\\b)')).map(x=>x.trim()).filter(Boolean).forEach(o=>{
      const r = parseClause(o);
      if(r.fx){ if(r.fx.v==='choose'){ issues.push(`An option can't be another Choose ("${o}").`); } else { delete r.fx.then; r.fx.when && delete r.fx.when; f.opts.push(r.fx); } }
      r.issues.forEach(i=>issues.push(i));
    });
    if(ch[2]) attachCond(f, ch[2], ch[3], ch[4], cl, issues);
    if(f.opts.length<2) issues.push(`"${cl}" offers fewer than two options. Separate them with " / ".`);
    if(f.n>f.opts.length) issues.push(`"${cl}" asks to choose ${f.n} of ${f.opts.length} options.`);
    if(!f.opts.length) return {fx:null, issues};
    return {fx:f, issues};
  }

  /* A condition on the end, a card filter in brackets: both come out first. */
  let cond = null, only = null;
  const cm = low.match(COND_TAIL);
  if(cm){ cond = cm; low = low.slice(0, cm.index).trim(); }
  const ff = low.match(FILTER_FLAG_PAREN);
  let onlyFlag = null;
  if(ff){ onlyFlag = 'playedTurn'; low = (low.slice(0, ff.index)+low.slice(ff.index+ff[0].length)).replace(/\s+/g,' ').trim(); }
  const fm = low.match(FILTER_PAREN);
  if(fm){ only = fm; low = (low.slice(0, fm.index)+low.slice(fm.index+fm[0].length)).replace(/\s+/g,' ').trim(); }

  const hit = VERB_WORDS.find(([re])=>re.test(low));
  if(!hit) return {fx:null, issues:[`"${cl}" does not start with a verb from the design doc (Give Power, Discard, Destroy, Recall, Create, Summon, Draw, Gain Energy).`]};

  let v = hit[1];
  /* "gain 2 Power" is a buff on itself; "give 2 Energy" is income. */
  if(v==='gainEnergy' && /power/.test(low) && !/energy/.test(low)) v = 'givePower';
  if(v==='givePower' && /energy/.test(low) && !/power/.test(low)) v = 'gainEnergy';

  const f = {v};
  if(cond) attachCond(f, cond[1], cond[2], cond[3], cl, issues);
  if(v==='steal' && /\bhand\b/.test(low.replace(/\bequal to .+?(?= from | and give (?:it|them) to |$)/, ''))) f.what = 'card';

  /* Where a summon lands and on whose side, taken out before anything else
     reads the clause (so "a random planet" isn't "a random card"). */
  if(v==='summon'){
    const take = re => { const m = low.match(re); if(m) low = (low.slice(0,m.index)+low.slice(m.index+m[0].length)).replace(/\s+/g,' ').trim(); return !!m; };
    const side = take(/ for a random (opponent|enemy|player)\b/) ? 'random' : take(/ for (an|another|each|your) (opponent|enemy|player)\b/) ? 'choose' : 'self';
    const at = take(/ on a planet of your choice\b| on (a|any) planet you choose\b/) ? 'choice' : take(/ on a random planet\b/) ? 'random' : (take(/ (here|on this planet|at this location)\b/), 'here');
    if(side!=='self') f.side = side;      // the defaults stay implicit, as in older cards
    if(at!=='here') f.at = at;
  }
  const needs = needsOf(f);

  /* The amount phrase comes out first, so "equal to the number of enemy
     cards here" can never be mistaken for the target. */
  const amtM = low.match(/\bequal to (.+?)(?= from | and give (?:it|them) to |$)/);
  let rest = amtM ? (low.slice(0, amtM.index) + low.slice(amtM.index + amtM[0].length)).replace(/\s+/g,' ').trim() : low;

  if(needs.includes('amount')){
    const src = amtM ? readSource(amtM[1], v, issues) : null;
    if(amtM && !src){
      issues.push(`"${amtM[1]}" isn't an amount this build can read — read as 1. Try "your Energy", "the number of cards in your hand", "that card's Power", "its own Energy cost"…`);
      f.n = 1;
    }else if(src) f.nFrom = src;
    else if(v==='steal' && f.what!=='card'){
      const up = rest.match(/\bup to (\d+)/) || rest.match(/^steal (\d+)/);
      if(up) f.n = parseInt(up[1],10); else f.nFrom = 'all';
    }else{
      let n = readAmount(rest, v);
      const noun = rest.split(/ from /)[0];        // "the strongest card", not "…from your cards in the graveyard"
      if(n===null && /\bcard\b/.test(noun) && !/\bcards\b/.test(noun)) n = 1;
      if(n===null){ f.n = 1; issues.push(`No amount in "${cl}" — read as 1.`); }
      else f.n = (v==='burn') ? Math.abs(n) : n;
      if(v==='givePower' && f.n===0) issues.push(`"${cl}" gives 0 Power.`);
    }
    if(src && /\b(lose|loses|minus|less|reduce|weaken)\b/.test(low))
      issues.push(`"${cl}" takes away an amount read from the game — those only count up, so it was read as positive. To take Power away, use Burn.`);
  }

  if(v==='move' && /^(swap|switch|trade places)\b/.test(low)) f.swap = true;
  if(v==='move'){
    const d = f.swap ? readSwapDest(rest) : readDest(rest);
    if(d.dest) f.dest = d.dest;
    else{ f.dest = 'choice'; issues.push(`No destination in "${cl}" — read as a planet of your choice. Say "to this planet", "to a planet of your choice" or "to a random planet".`); }
    rest = d.rest;
  }

  if(v==='steal' && f.what!=='card'){
    const sp = rest.split(/ and give (?:it|them) to | giving it to /);
    const r = (sp[1]||'').trim();
    rest = sp[0];
    if(!r || /\bthis card\b|\bitself\b/.test(r)) f.to = 'self';
    else{
      const one = readSingleTarget(r, true);      // a recipient is always exactly one card
      if(one) f.to = one;
      else{ f.to = 'self'; issues.push(`Couldn't tell which one card gets the stolen Power in "${cl}" — read as this card.`); }
    }
  }

  if(needs.includes('target')){
    /* Burn and Steal name their target after "from". */
    const phrase = (v==='burn' || v==='steal') && / from /.test(rest) ? rest.slice(rest.indexOf(' from ')+6) : rest;
    const single = readSingleTarget(phrase);
    if(single) f.target = single;
    else{
      const t = readTarget(phrase);
      if(!t){ f.t = 'self'; issues.push(`No target in "${cl}" — read as this card. Say "a card of your choice", "an enemy card here", "the next card you play", "all enemy cards here", and so on.`); }
      else f.t = t;
    }
  }

  if(needs.includes('hand')){
    const T = readHandPick(rest);
    if(T.player!=='self' || T.rule!=='choice') f.target = T;
  }

  if(needs.includes('from')){
    const g = readGravePick(rest);
    if(g){ f.from = 'grave'; f.pick = g; if(v==='summon') delete f.n; }
  }

  if(onlyFlag){
    if(!filterable(f)) issues.push(`"${cl}" has a card filter, but ${VERBS[v].label} doesn't pick cards — the filter was dropped.`);
    else f.only = {stat:onlyFlag};
  }
  if(only){
    if(!filterable(f)) issues.push(`"${cl}" has a card filter, but ${VERBS[v].label} doesn't pick cards — the filter was dropped.`);
    else{
      const val = readCompareSpec(only[2], only[3]);
      const stat = only[1]==='power' ? 'power' : only[1]==='bonus power' ? 'bonus' : 'cost';
      if(!val) issues.push(`"${only[3]}" in the card filter isn't a number or a value this build can read — the filter was dropped.`);
      else f.only = Object.assign({stat, op:opOf(only[2])}, val);
    }
  }

  if(v==='summon' && f.from==='grave') return {fx:f, issues};
  if(v==='summon' && /\bthat card\b|\bit\b(?! to)/.test(rest.replace(/^summon\s+/,'').split(/ (?:here|on |for )/)[0]) && !readToken(low)){
    f.from = 'prev';
    return {fx:f, issues};
  }
  if(needs.includes('token')){
    const tok = readToken(low);
    if(tok && tok.id) f.tok = tok.id;
    else if(tok && tok.card) issues.push(`${tok.card} is a card, not a token — ${VERBS[v].label} only works on tokens. Make a token with that name in the Tokens tab.`);
    else issues.push(`No token named in "${cl}". Tokens available: ${LIB.tokens.map(t=>t.name).join(', ') || 'none yet'}.`);
  }

  return {fx:f, issues};
}

/** Hang "if <value> is <op> <value>" onto an effect, or flag what didn't read. */
function attachCond(f, srcText, opText, valText, cl, issues){
  const src = readCondSource(srcText), val = readCompareSpec(opText, valText);
  if(!src) issues.push(`"${srcText}" in "${cl}" isn't a value this build can check — the condition was dropped. Try "the round number", "your Energy", "the number of cards in your hand"…`);
  else if(!val) issues.push(`"${valText}" in "${cl}" isn't ${opText==='between'?'a range like "3 and 4"':'a number or a value this build can read'} — the condition was dropped.`);
  else f.if = Object.assign({src, op:opOf(opText)}, val);
}
/** The value side of a comparison: one value, or for "between" two —
    "3 and 4", "1-6", "2 to your Energy". */
function readCompareSpec(opText, valText){
  if(opText!=='between') return readCompareValue(valText);
  const m = String(valText).trim().match(/^(.+?)\s*(?:\band\b|\bto\b|-|\u2013|\u2014)\s*(.+)$/);
  if(!m) return null;
  const a = readCompareValue(m[1]), b = readCompareValue(m[2]);
  if(!a || !b) return null;
  const out = Object.assign({}, a);
  if(b.valFrom) out.valFrom2 = b.valFrom; else out.val2 = b.val;
  return out;
}

function readAmount(low, v){
  let m = null;
  if(v==='givePower') m = low.match(/([+-]?\d+)\s*(?:more\s+)?power/);
  if(!m) m = low.match(/([+-]?\d+)/);
  let n = m ? parseInt(m[1],10) : null;
  if(n===null){
    const w = low.match(/\b(a|an|one|two|three|four|five|six|seven|eight|nine|ten)\b/);
    if(w) n = NUM_WORDS[w[1]];
  }
  if(n===null) return null;
  if(/\b(lose|loses|minus|less|reduce|remove|weaken|drain)\b/.test(low) && n>0) n = -n;
  return n;
}

/** What comes after "equal to". Ambiguous "its" is read as this effect's
    own target when it has one, otherwise as the previous effect's card. */
function readSource(phrase, v, issues){
  const p = phrase.replace(/[.,]$/,'').trim();
  const hasTarget = (VERBS[v]||{needs:[]}).needs.includes('target');
  const own = [
    [/\b(its|their) own (energy )?cost\b/, 'tgtCost'],
    [/\b(its|their) own bonus power\b/,    'tgtBonus'],
    [/\b(its|their) own power\b/,          'tgtPower'],
    [/\bthat card'?s (energy )?cost\b/,     'prevCost'],
    [/\bthat card'?s bonus power\b/,        'prevBonus'],
    [/\bthat card'?s power\b/,              'prevPower'],
    [/\ball (of )?its bonus power\b/,       'all'],
    [/\bnumber of those cards\b|\bnumber of cards (it|that) (touched|affected)\b/, 'prevCount'],
    [/\bthis card'?s (energy )?cost\b/,    'selfCost'],
    [/\bthis card'?s power\b|\bmy (own )?power\b/, 'selfPower'],
    [/\bstrongest enemy power here\b|\bstrongest enemy card'?s power here\b/, 'enemyMaxPower'],
    [/\bweakest enemy power here\b|\bweakest enemy card'?s power here\b/,     'enemyMinPower'],
    [/\bhighest enemy (energy )?cost here\b/, 'enemyMaxCost'],
    [/\blowest enemy (energy )?cost here\b/,  'enemyMinCost'],
    [/\bgraveyards?\b|\bdiscard pile\b/,  'grave'],
    [/\b(cards )?in your hand\b|\bhand size\b/, 'hand'],
    [/\b(cards )?(left )?in your deck\b/,   'deck'],
    [/\byour energy\b/,                    'energy'],
    [/\byour cards here\b/,                'yoursHere'],
    [/\benemy cards here\b/,               'enemiesHere'],
    [/\bplanets you('re| are) (winning|leading)\b|\bplanets you lead\b/, 'leading'],
    [/\bround( number)?\b/,                'round']
  ];
  for(const [re,key] of own){
    if(!re.test(p)) continue;
    const src = AMOUNT_SOURCES[key];
    if(src.for && !src.for.includes(v)){
      issues.push(`"${p}" needs a card target, which ${VERBS[v].label} doesn't have — read as that card's value instead.`);
      return key.replace(/^tgt/, 'prev');
    }
    return key;
  }
  /* Plain "its cost", "its Power": nobody said "own" or "that card's". */
  const its = p.match(/\bits (energy cost|cost|bonus power|power)\b/);
  if(its){
    const stat = its[1]==='bonus power' ? 'Bonus' : its[1]==='power' ? 'Power' : 'Cost';
    /* With no target of its own, "its" can only be the previous card. With
       one, it could be either — say which way it was read. */
    if(hasTarget) issues.push(`"its ${its[1]}" was read as this effect's own target. Say "its own…" or "that card's…" to be exact.`);
    return (hasTarget ? 'tgt' : 'prev') + stat;
  }
  return null;
}

/** Move's destination, and the clause with that phrase taken out. */
function readDest(low){
  const pats = [
    [/\bto (this|the same) (planet|location)\b/, 'here'],
    [/\bto a random (other )?(planet|location)\b/, 'random'],
    [/\bto (a|an|any|another) (other )?(planet|location)( of your choice)?\b|\bto (a|any) (planet|location) you choose\b/, 'choice']
  ];
  for(const [re,dest] of pats){
    const m = low.match(re);
    if(m) return {dest, rest:(low.slice(0,m.index)+low.slice(m.index+m[0].length)).replace(/\s+/g,' ').trim()};
  }
  return {dest:null, rest:low};
}

/** Swap's destination: "with a card on this planet / on a planet of your choice / on a random planet". */
function readSwapDest(low){
  const pats = [
    [/\s*\bwith (?:a|one|another) card (?:on this planet|here|at this location)\b/, 'here'],
    [/\s*\bwith (?:a|one|another) card on a random (?:planet|location)\b/, 'random'],
    [/\s*\bwith (?:a|one|another) card on (?:a|any) (?:planet|location)(?: of your choice| you choose)?\b/, 'choice']
  ];
  for(const [re,dest] of pats){
    const m = low.match(re);
    if(m) return {dest, rest:(low.slice(0,m.index)+low.slice(m.index+m[0].length)).replace(/\s+/g,' ').trim()};
  }
  return {dest:null, rest:low};
}

function ruleWord(low){
  if(/lowest[- ]cost|\bcheapest\b|lowest energy/.test(low)) return 'lowestCost';
  if(/highest[- ]cost|most expensive|highest energy/.test(low)) return 'highestCost';
  if(/\bstrongest\b|highest power|most power/.test(low)) return 'strongest';
  if(/\bweakest\b|lowest power|least power/.test(low)) return 'weakest';
  if(/\brandom\b(?! opponent)/.test(low.replace(/random opponent/g,''))) return 'random';
  return 'choice';
}

/** Discard: whose hand, and which card. */
function readHandPick(low){
  let player = 'self';
  if(/\bfrom a random (opponent|player|enemy)'?s? hand\b/.test(low)) player = 'random';
  else if(/\bfrom (an|each|your|the|their)? ?(opponent|enemy)'?s? hand\b|\bfrom their hand\b/.test(low)) player = 'choose';
  return {player, rule: ruleWord(low)};
}

/** Draw / Summon from the graveyard: whose cards, and which. Null if the
    clause doesn't take from the graveyard at all. */
function readGravePick(low){
  if(!/\bfrom (the |your |an? enemy'?s? |enemy )?(cards in the )?(graveyard|discard pile)\b|\bfrom (your|enemy) cards in the graveyard\b/.test(low)) return null;
  const owner = /\byour cards in the graveyard\b|\bfrom your graveyard\b/.test(low) ? 'yours'
              : /\benemy cards in the graveyard\b|\benemy'?s? graveyard\b/.test(low) ? 'theirs' : 'any';
  return {owner, rule: ruleWord(low)};
}

/** An amount read off a graveyard: "equal to your graveyard", "for each
    card in every graveyard". Returns 'ownGrave', 'allGrave', or null. */
function readGraveSource(low){
  if(!/\bgraveyards?\b|\bdiscard pile\b/.test(low)) return null;
  return 'grave';                 // there is one graveyard, shared by everyone
}

/** One card, through the verb -> player -> card hierarchy. Returns null when
    the phrase names a group (or one of the long-standing single-pick group
    targets such as "the weakest enemy here"), so readTarget can take it. */
function readSingleTarget(low, mustBeOne){
  const tr = low.match(/\beach card (you|an opponent|an enemy|a random opponent) (?:play|plays)( here)? this round\b/);
  if(tr) return {player: tr[1]==='you' ? 'self' : tr[1]==='a random opponent' ? 'random' : 'choose', here: !!tr[2], rule:'thisRound'};
  const nl = low.match(/\b(?:the )?(next|last) card (you|an opponent|an enemy|a random opponent) (?:play|plays|played)\b/);
  if(nl){
    const player = nl[2]==='you' ? 'self' : nl[2]==='a random opponent' ? 'random' : 'choose';
    return {player, here: /\bhere\b|\bat this location\b|\bon this planet\b/.test(low), rule: nl[1]};
  }
  if(/\b(all|every|each)\b/.test(low)) return null;
  if(/\bthis card\b|\bitself\b/.test(low)) return null;
  const enemy = /\b(enemy|enemies|opposing|opponents?'?s?)\b/.test(low);
  const here = /\bhere\b|\bat this location\b|\bon this planet\b/.test(low);
  const choice = /\bof your choice\b|\byou choose\b|\bchoose\b|\bchosen\b/.test(low);
  const random = /\brandom\b/.test(low);
  const randomOpp = /\brandom (opponent|player)/.test(low);

  let rule = null;
  if(/lowest[- ]cost|\bcheapest\b|lowest energy/.test(low)) rule = 'lowestCost';
  else if(/highest[- ]cost|most expensive|highest energy/.test(low)) rule = 'highestCost';
  else if(/\bstrongest\b|highest power|most power/.test(low)) rule = 'strongest';
  else if(/\bweakest\b|lowest power|least power/.test(low)) rule = 'weakest';
  else if(choice) rule = 'choice';
  else if(random) rule = 'random';

  const singular = /\b(a|an|one)\s+(random\s+)?((enemy|friendly|allied|opposing)\s+)?card\b/.test(low)
                || /\bcard of your choice\b/.test(low);

  /* These already exist as group targets with exactly this meaning across
     every enemy at once — keep them there, so old cards read unchanged. */
  if(!mustBeOne && enemy && here && !randomOpp && (rule==='strongest' || rule==='weakest' || rule==='random')) return null;
  if(!rule && !singular) return null;

  let player = 'self';
  if(randomOpp) player = 'random';
  else if(enemy) player = (rule==='random' && !choice) ? 'random' : 'choose';
  return {player, here, rule: rule || 'choice'};
}

function readTarget(low){
  for(const [key, pats] of TARGET_WORDS){
    if(pats.some(re=>re.test(low))) return key;
  }
  return null;
}

function readToken(cl){
  const low = cl.toLowerCase();
  const pending = Object.entries(PENDING_TOKENS).filter(([,nm])=>!LIB.tokens.some(t=>t.name.toLowerCase()===nm.toLowerCase()))
    .map(([id,name])=>({id, name}));
  const toks = LIB.tokens.concat(pending).sort((a,b)=>b.name.length-a.name.length);
  const tok = toks.find(t=>low.includes(t.name.toLowerCase()));
  if(tok) return {id:tok.id};
  const cards = LIB.cards.slice().sort((a,b)=>b.name.length-a.name.length);
  const card = cards.find(c=>c.name.length>2 && low.includes(c.name.toLowerCase()));
  if(card) return {card:card.name};
  return null;
}

/* --- one row of the table into a card, with its verdict --- */

function readImportRow(cells, map, rowNo, seen){
  const at = k => (map[k]!=null && cells[map[k]]!=null) ? cells[map[k]].trim() : '';
  const issues = [];
  const name = at('name');
  if(!name) issues.push('No name in this row.');

  const rawCost = at('cost'), rawPower = at('power');
  const num = (raw, label, lo, hi) => {
    if(raw===''){ issues.push(`No ${label} — read as 0.`); return 0; }
    const n = Number(raw.trim());
    if(raw.trim()==='' || !isFinite(n)){
      issues.push(`"${raw}" is not a number for ${label} — read as 0.`); return 0;
    }
    if(!Number.isInteger(n)){ issues.push(`${label} ${n} is not a whole number — rounded.`); }
    const r = clamp(Math.round(n), lo, hi);
    if(r!==Math.round(n)) issues.push(`${label} ${Math.round(n)} is outside ${lo}\u2013${hi} — clamped to ${r}.`);
    return r;
  };
  const cost = num(rawCost, 'Energy cost', 0, 99);
  const power = num(rawPower, 'Power', -99, 999);

  const abilityText = at('ability');
  /* A file exported from here carries the exact effects as JSON next to the
     words. While the words still match those effects, the JSON is used as-is
     (lossless); once someone edits the words, the words win. */
  let fxExact = null;
  const rawFx = at('fx');
  if(rawFx){
    try{ const arr = JSON.parse(rawFx); if(Array.isArray(arr) && arr.every(f=>f && VERBS[f.v])) fxExact = arr.map(migrateFx); }catch(e){}
    if(!fxExact) issues.push('The fx column isn\u2019t readable JSON, so the ability text was read instead.');
  }
  const sameWords = (a, b) => String(a||'').replace(/[\u2018\u2019]/g,"'").replace(/\s+/g,' ').replace(/\.\s*$/,'').trim().toLowerCase()
                            === String(b||'').replace(/[\u2018\u2019]/g,"'").replace(/\s+/g,' ').replace(/\.\s*$/,'').trim().toLowerCase();
  let parsed;
  if(fxExact && sameWords(fxText(normalizeFxList(clone(fxExact))), abilityText)) parsed = {fx: fxExact, issues: []};
  else parsed = parseAbility(abilityText);
  parsed.issues.forEach(i=>issues.push(i));

  /* A notes column flags the row for review with whatever it says: the way
     to mark a card "worth a look" from a spreadsheet. ' | ' separates several. */
  at('notes').split(/\s+\|\s+/).map(x=>x.trim()).filter(Boolean).forEach(x=>issues.push(x));

  const rawType = at('type').toLowerCase();
  const isToken = /^tok/.test(rawType);
  if(rawType && !isToken && !/^card/.test(rawType)) issues.push(`"${at('type')}" isn\u2019t a type \u2014 read as a card. Use card or token.`);
  const list = isToken ? LIB.tokens : LIB.cards;
  const id = at('id');
  const match = (id && (LIB.cards.find(c=>c.id===id) || LIB.tokens.find(c=>c.id===id)))
             || (name && list.find(c=>c.name.toLowerCase()===name.toLowerCase())) || null;
  const updating = !!match && (UI.importMatch||'update')==='update';
  if(match && !updating) issues.push(`A ${isToken?'token':'card'} called ${match.name} already exists \u2014 this would be a second one.`);
  if(seen && name){
    const key = (isToken ? 'token:' : 'card:') + name.toLowerCase();   // a card and a token may share a name
    if(seen[key]) issues.push(`${name} appears more than once in this table.`);
    seen[key] = true;
  }

  const artCell = at('art');
  const rawRarity = at('rarity');
  let rarity = 'basic';
  if(rawRarity){
    const w = RARITY_WORDS[rawRarity.toLowerCase().replace(/[^a-z]/g,'')];
    if(w) rarity = w;
    else issues.push(`"${rawRarity}" isn't a rarity — read as Basic. Use Basic, Elite or Exotic.`);
  }
  return {
    rowNo, name: name || 'Unnamed card', cost, power, rarity,
    abilityText, fx: parsed.fx, exact: !!(fxExact && parsed.fx===fxExact),
    art: readArtCell(artCell, updating, issues),
    token: isToken, id: id || null, match: updating ? match.id : null,
    issues, skip:false
  };
}

function readImportTable(text){
  const rows = splitTable(text);
  if(!rows.length) return {kind:'cards', rows:[], note:'Nothing to read yet.'};
  const pmap = readPlanetHeader(rows[0]);
  if(pmap){
    const seen = {};
    return {kind:'planets', rows: rows.slice(1).map((r,i)=>readPlanetRow(r, pmap, i+1, seen)), note:''};
  }
  let map = readHeader(rows[0]);
  let body = rows;
  let note = '';
  if(map) body = rows.slice(1);
  else {
    map = {name:0, cost:1, power:2, ability:3, art:4, rarity:5};
    note = 'No header row found, so the columns were read as name, Energy cost, Power, ability, art, rarity.';
  }
  /* Tokens this same table defines can be named by its other rows. */
  Object.keys(PENDING_TOKENS).forEach(k=>delete PENDING_TOKENS[k]);
  if(map.type!=null && map.name!=null) body.forEach(r=>{
    const type = String(r[map.type]||'').trim().toLowerCase(), name = String(r[map.name]||'').trim();
    if(!/^tok/.test(type) || !name || LIB.tokens.some(t=>t.name.toLowerCase()===name.toLowerCase())) return;
    const id = map.id!=null && String(r[map.id]||'').trim();
    PENDING_TOKENS[id || 'new-token:'+name.toLowerCase().replace(/[^a-z0-9]+/g,'-')] = name;
  });
  const seen = {};
  return {kind:'cards', rows: body.map((r,i)=>readImportRow(r, map, i+1, seen)), note};
}

/* ------------------------------------------------------------------
   3c. CSV FILES — cards, tokens and planets out of the studio and back in.
   A file exported here reads back to the identical library; a file edited
   in a spreadsheet reads back through the same checks as a pasted table.
   ------------------------------------------------------------------ */

/** "[sprite]" stands in for an uploaded image when sprites aren't embedded. */
const SPRITE_MARK = '[sprite]';

/** The art cell: an emoji, a data: URL, or the sprite placeholder. Null means
    "keep whatever art the card already has". */
function readArtCell(cell, updating, issues){
  const v = String(cell||'').trim();
  if(!v) return updating ? null : E('\u2B50');
  if(v.toLowerCase()===SPRITE_MARK){
    if(updating) return null;
    issues.push('This row\u2019s sprite wasn\u2019t included in the file, so it gets a placeholder. Upload the image in Art & data, or export again with sprites embedded.');
    return E('\u2B50');
  }
  if(/^data:image\//i.test(v)) return {t:'img', v};
  /* A path to an image file beside the page (art/spore-drone.png) — what the
     offline copy uses. A published page has no folder beside it, so say so there. */
  if(/^(?![a-z]+:)[^\s"<>]+\.(png|jpe?g|webp|gif|svg|avif)$/i.test(v)){
    if(window.claude) issues.push('"'+v+'" is a file path: it only shows in the offline copy, where an art folder sits beside the game.');
    return {t:'img', v};
  }
  if(/^https?:\/\//i.test(v)) issues.push('A link to an image won\u2019t load once this page is published \u2014 use a data: URL or upload it in Art & data.');
  if(/^https?:\/\//i.test(v)) return updating ? null : E('\u2B50');
  return E(v);
}
function artCell(art, sprites){
  if(!art) return '';
  if(art.t==='img') return (sprites || !/^data:/i.test(art.v)) ? art.v : SPRITE_MARK;   // a file path is short: always keep it
  return art.v || '';
}

/** One CSV cell. Quotes when needed; a leading = + - @ is left alone (these
    are game words like "-1", not formulas we generate). */
function csvCell(v){
  const t = v==null ? '' : String(v);
  return /[",\n\r]|^\s|\s$/.test(t) ? '"'+t.replace(/"/g,'""')+'"' : t;
}
/* A byte-order mark so spreadsheet apps read the emoji and dashes as UTF-8. */
const toCSV = rows => '\uFEFF' + rows.map(r=>r.map(csvCell).join(',')).join('\r\n') + '\r\n';

const CARD_COLUMNS = ['type','id','name','cost','power','rarity','ability','art','fx','notes'];

/** Every card, then every token. `ability` is the rules text; `fx` is the
    exact effects, so nothing is lost on the way back in. */
function cardsCSV(opts){
  const sprites = !!(opts && opts.sprites);
  const row = (c, type) => [type, c.id, c.name, c.cost, c.power, type==='token' ? '' : rarityOf(c),
    fxText(c.fx||[]), artCell(c.art, sprites), (c.fx&&c.fx.length) ? JSON.stringify(c.fx) : '',
    c.review ? [].concat(c.review).join(' | ') : ''];
  return toCSV([CARD_COLUMNS].concat(LIB.cards.map(c=>row(c,'card')), LIB.tokens.map(c=>row(c,'token'))));
}

/* --- planets ------------------------------------------------------------ */

/** "Any card", "Strongest wins", "Cost <= 3", "Power >= 5". */
function slotCondText(cond){
  if(!cond || cond.stat==='any') return 'Any card';
  if(cond.stat==='winner') return 'Strongest wins';
  return (cond.stat==='cost' ? 'Cost' : 'Power')+' '+cond.op+' '+cond.val;
}
/** "+1 Energy", "Draw 2", "None". */
function slotRewText(rew){
  if(!rew || rew.type==='none') return 'None';
  return rew.type==='draw' ? 'Draw '+rew.amount : '+'+rew.amount+' Energy';
}
const SYM_OPS = {'\u2264':'<=', '\u2265':'>=', '=':'==', '==':'==', '<=':'<=', '>=':'>=', '<':'<', '>':'>', '=<':'<=', '=>':'>='};
const WORD_OPS = {'at most':'<=', 'at least':'>=', 'exactly':'==', 'less than':'<', 'more than':'>', 'or less':'<=', 'or more':'>=', 'under':'<', 'over':'>'};

function readSlotCond(text, label, issues){
  const t = String(text||'').toLowerCase().replace(/\s+/g,' ').trim();
  if(!t || /^any( card)?$|^anything$|^none$|^-$/.test(t)) return {stat:'any', op:'>=', val:0};
  if(/strongest|winner|wins|highest power here/.test(t)) return {stat:'winner', op:'>=', val:0};
  const stat = /cost|energy/.test(t) ? 'cost' : /power|strength/.test(t) ? 'power' : null;
  const num = t.match(/-?\d+/);
  let op = null;
  const sym = t.match(/(\u2264|\u2265|<=|>=|=<|=>|==|<|>|=)/);
  if(sym) op = SYM_OPS[sym[1]];
  else { const w = Object.keys(WORD_OPS).find(k=>t.includes(k)); if(w) op = WORD_OPS[w]; }
  if(!stat || !num || !op){
    issues.push(`${label}: "${text}" isn\u2019t a condition this build reads \u2014 read as Any card. Write it like "Cost <= 3", "Power >= 5", "Any card" or "Strongest wins".`);
    return {stat:'any', op:'>=', val:0};
  }
  return {stat, op, val: parseInt(num[0],10)};
}
function readSlotRew(text, label, issues){
  const t = String(text||'').toLowerCase().replace(/\s+/g,' ').trim();
  if(!t) return {type:'energy', amount:1};          // a blank reward is the default slot
  if(/^(none|no reward|nothing|-|\u2014)$/.test(t)) return {type:'none', amount:0};
  const num = t.match(/\d+/), n = num ? clamp(parseInt(num[0],10), 1, 9) : 1;
  if(/draw|card|\u{1F0A0}/u.test(t)) return {type:'draw', amount:n};
  if(/energy|\u26A1/.test(t)) return {type:'energy', amount:n};
  issues.push(`${label}: "${text}" isn\u2019t a reward this build reads \u2014 read as +1 Energy. Write "+2 Energy", "Draw 1" or "None".`);
  return {type:'energy', amount:1};
}

/** id, name, art, hue, then a condition and a reward column per slot. */
function planetsCSV(opts){
  const sprites = !!(opts && opts.sprites);
  const head = ['id','name','art','hue'];
  for(let i=1;i<=RULES.slotsPerPlayer;i++) head.push('slot'+i, 'slot'+i+' reward');
  const rows = LIB.planets.map(p=>{
    const r = [p.id, p.name, artCell(p.art, sprites), p.hue||''];
    for(let i=0;i<RULES.slotsPerPlayer;i++){ const sl = p.slots[i]; r.push(slotCondText(sl&&sl.cond), slotRewText(sl&&sl.rew)); }
    return r;
  });
  return toCSV([head].concat(rows));
}

/** A planet table is recognised by its slot columns. */
function readPlanetHeader(row){
  const map = {slots:[]};
  row.forEach((cell,i)=>{
    const k = cell.toLowerCase().replace(/[^a-z0-9]/g,'');
    if(k==='name'||k==='planet'||k==='planetname') map.name = map.name==null ? i : map.name;
    else if(k==='id') map.id = i;
    else if(['art','emoji','icon','sprite','image'].includes(k)) map.art = i;
    else if(['hue','colour','color'].includes(k)) map.hue = i;
    else{
      const m = k.match(/^slot(\d+)(condition|cond|if|check|reward|rew|pays)?$/);
      if(m){
        const n = parseInt(m[1],10)-1, slot = map.slots[n] = map.slots[n] || {};
        if(/^(reward|rew|pays)$/.test(m[2]||'')) slot.rew = i; else slot.cond = i;
      }
    }
  });
  return map.name!=null && map.slots.some(Boolean) ? map : null;
}

function readPlanetRow(cells, map, rowNo, seen){
  const at = k => (k!=null && cells[k]!=null) ? cells[k].trim() : '';
  const issues = [];
  const name = at(map.name);
  if(!name) issues.push('No name in this row.');
  const id = at(map.id);
  const match = (id && LIB.planets.find(p=>p.id===id)) || (name && LIB.planets.find(p=>p.name.toLowerCase()===name.toLowerCase())) || null;
  const updating = !!match && (UI.importMatch||'update')==='update';
  if(match && !updating) issues.push(`A planet called ${match.name} already exists \u2014 this would be a second one.`);
  if(seen && name){ const k = name.toLowerCase(); if(seen[k]) issues.push(`${name} appears more than once in this table.`); seen[k] = true; }

  const slots = [];
  for(let i=0;i<RULES.slotsPerPlayer;i++){
    const col = map.slots[i] || {};
    if(col.cond==null && col.rew==null && !updating) issues.push(`No columns for slot ${i+1} \u2014 it reads as Any card, +1 Energy.`);
    const old = updating && match.slots[i];
    slots.push({
      cond: col.cond!=null ? readSlotCond(at(col.cond), 'Slot '+(i+1), issues) : (old ? clone(old.cond) : {stat:'any', op:'>=', val:0}),
      rew:  col.rew!=null  ? readSlotRew(at(col.rew),  'Slot '+(i+1), issues) : (old ? clone(old.rew)  : {type:'energy', amount:1})
    });
  }
  if(map.slots.length>RULES.slotsPerPlayer) issues.push(`This table has ${map.slots.length} slots; planets have ${RULES.slotsPerPlayer}, so the extra columns were ignored.`);

  let hue = at(map.hue);
  if(hue && !/^#[0-9a-f]{6}$/i.test(hue)){ issues.push(`"${hue}" isn\u2019t a colour like #4fd6b0 \u2014 the default was used.`); hue = ''; }
  return {
    rowNo, name: name || 'Unnamed planet', id: id || null,
    art: readArtCell(at(map.art), updating, issues),
    hue: hue || (updating ? null : '#4fd6b0'),
    slots, match: updating ? match.id : null, issues, skip:false
  };
}

/** Put the chosen rows into the library: new ones added, matches updated in
    place. Returns {added, updated, flagged, firstFlagged}. */
function commitImport(parsed, take, deckId){
  const out = {added:0, updated:0, flagged:0, firstFlagged:null, firstKind:null};
  const deck = deckId ? deckById(deckId) : null;
  const taken = id => !!(id && (defById(id) || LIB.planets.some(p=>p.id===id) || LIB.decks.some(d=>d.id===id)));
  const okId = id => id && /^[\w-]{1,40}$/.test(id) && !taken(id);
  const tokIds = {};                                   // a pending token's placeholder id -> its real id
  take = take.slice().sort((a,b)=>(b.token?1:0)-(a.token?1:0));   // tokens first, so cards can point at them
  take.forEach(r=>{
    if(r.issues.length) out.flagged++;
    if(parsed.kind==='planets'){
      let pl = r.match && LIB.planets.find(p=>p.id===r.match);
      if(pl){ out.updated++; }
      else{ pl = {id: okId(r.id) ? r.id : freshId('planet')}; LIB.planets.push(pl); out.added++; }
      pl.name = r.name; pl.slots = clone(r.slots);
      if(r.art) pl.art = clone(r.art); else if(!pl.art) pl.art = E('\u2B50');
      if(r.hue) pl.hue = r.hue; else if(!pl.hue) pl.hue = '#4fd6b0';
      return;
    }
    let def = r.match && defById(r.match);
    if(r.fx) remapToks(r.fx, tokIds);
    if(def){ out.updated++; }
    else{
      def = {id: okId(r.id) ? r.id : freshId(r.token ? 'token' : 'card')};
      if(r.token) def.token = true;
      (r.token ? LIB.tokens : LIB.cards).push(def);
      if(deck && !r.token) deck.cards.push(def.id);
      out.added++;
    }
    if(r.token){
      const placeholder = Object.keys(PENDING_TOKENS).find(k=>PENDING_TOKENS[k].toLowerCase()===r.name.toLowerCase());
      if(placeholder) tokIds[placeholder] = def.id;
    }
    def.name = r.name; def.cost = r.cost; def.power = r.power; def.fx = clone(r.fx);
    if(r.art) def.art = clone(r.art); else if(!def.art) def.art = E('\u2B50');
    if(r.rarity && r.rarity!=='basic' && !r.token) def.rarity = r.rarity; else delete def.rarity;
    if(r.abilityText && !r.exact) def.abilityText = r.abilityText; else delete def.abilityText;
    if(r.issues.length){ def.review = r.issues.slice(); if(!out.firstFlagged){ out.firstFlagged = def.id; out.firstKind = r.token ? 'tokens' : 'cards'; } }
    else delete def.review;
  });
  return out;
}

/** Point Create/Summon at the real id of a token imported alongside them;
    a token left out of the import is looked up by name instead. */
function remapToks(fx, ids){
  (fx||[]).forEach(f=>{
    if(f.tok && !defById(f.tok)){
      if(ids[f.tok]) f.tok = ids[f.tok];
      else if(PENDING_TOKENS[f.tok]){ const t = LIB.tokens.find(x=>x.name.toLowerCase()===PENDING_TOKENS[f.tok].toLowerCase()); if(t) f.tok = t.id; }
    }
    if(f.opts) remapToks(f.opts, ids);
  });
}

/* --- getting a file to the person ---------------------------------------
   Published, the page asks the viewer's app to save it (the `downloads`
   capability). Opened as a plain file, a normal browser download. If neither
   works, the text lands in a box to copy. */
let DOWNLOADS = null;
function downloadsCap(){
  if(!DOWNLOADS) DOWNLOADS = (window.claude && typeof window.claude.use==='function')
    ? Promise.resolve(window.claude.use('downloads')).catch(()=>null) : Promise.resolve(null);
  return DOWNLOADS;
}
async function saveFile(filename, text){
  const dl = await downloadsCap();
  if(dl){
    try{ await dl.save({filename, data:text}); toast('Saved '+filename+'.'); return 'saved'; }
    catch(e){
      const code = e && e.code;
      if(code==='declined'){ toast('Not saved.'); return 'declined'; }
      if(code==='rate_limited'){ toast('A save is already waiting for an answer.'); return 'busy'; }
      /* anything else: fall through to the plain-browser route */
    }
  }
  try{
    if(!window.URL || !URL.createObjectURL) throw 0;
    const url = URL.createObjectURL(new Blob([text], {type: /\.json$/.test(filename) ? 'application/json' : 'text/csv;charset=utf-8'}));
    const a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(()=>URL.revokeObjectURL(url), 4000);
    toast('Downloading '+filename+'.');
    return 'downloaded';
  }catch(e){
    UI.exportText = text; UI.exportName = filename; render();
    toast('Saving isn\u2019t available here \u2014 copy it from the box.');
    return 'box';
  }
}
function copyText(text, label){
  if(navigator.clipboard && navigator.clipboard.writeText)
    navigator.clipboard.writeText(text).then(()=>toast(label+' copied.'), ()=>{ UI.exportText = text; render(); toast('Copy blocked \u2014 it\u2019s in the box.'); });
  else { UI.exportText = text; render(); toast('It\u2019s in the box below.'); }
}
function exportFile(kind){
  const sprites = !!UI.exportSprites;
  if(kind==='cards')   return {name:'territory-cards.csv',   text:cardsCSV({sprites})};
  if(kind==='planets') return {name:'territory-planets.csv', text:planetsCSV({sprites})};
  return {name:'territory-library.json', text:JSON.stringify(LIB, null, 1)};
}

let G = null;          // live game state
let UI = {             // transient view state
  screen:'title', sheet:null, sel:null, gate:false,
  justFlipped:null, editCard:null, editPlanet:null, editDeck:null, toast:null,
  transition:null,     // {title, sub} — a held beat between phases; blocks input
  flipAnim:null,       // uid of the card currently mid-flip
  autoflip:false,      // "Flip the rest" is running
  drag:null,           // {uid, from, ...} while a card is in the air
  peek:null,           // card shown in the inspect sheet
  peekBoard:false,     // reveal phase: show my own face-down cards
  importText:'', importRows:null, importDeck:'',   // the table import screen
  importMatch:'update',                            // rows that match an existing card or planet: update it, or add a copy
  exportSprites:false, exportText:'', exportName:'',
  review:false,        // post-game: look back over the final board
  reviewSeat:0, lastSeat:0,
  botQueued:{},        // simultaneous placement: bots already set going this round
  replaying:false      // a recorded game is being replayed: bots don't move by themselves
};

/* Every held beat between phases uses the same duration, so the rhythm of a
   round is learnable rather than incidental. */
const PAUSE = 1000;
const FLIP_MS = 460;

/* A beat: a bar drops in at the top naming who is up and what phase it is,
   input is held for a second, then play continues. */
function pause(title, sub, next, playerIdx){
  if(G) G.hold = true;                     // the engine takes no commands during a beat
  if(fxIdleIn()){ whenFxIdle(()=>pause(title, sub, next, playerIdx)); render(); return; }
  UI.transition = {title, sub, pi: (playerIdx==null ? null : playerIdx)};
  UI.sel = null;
  render();
  const game = G, epoch = G ? G.epoch : 0;
  setTimeout(()=>{
    if(G!==game || (G && G.epoch!==epoch)) return;   // the board was reset or replaced meanwhile
    UI.transition = null; if(G) G.hold = false; next();
  }, PAUSE);
}
/* True whenever the board should not accept input. */
function busy(){ return !!(UI.transition || UI.flipAnim || UI.animLock || UI.fxWait || UI.roundScreen || UI.dice || (G && G.choice)); }

/** How placement runs for a given table. Pass-the-device play always takes
    turns — two people can't place at once on one screen. Simultaneous
    placement is for tables where each human has their own device (online), and
    can be tried locally against bots from setup. */
function placementModeFor(s, kinds){
  const humans = kinds.filter(k=>k==='human').length;
  if(s.online) return 'simultaneous';
  return (s.placement==='simultaneous' && humans<=1) ? 'simultaneous' : 'turns';
}

/** Start a game from the setup screen. `opts` can override the seed and the
    seats (a server or a test hands these in); otherwise LIB.settings decides. */
function newGame(opts){
  opts = opts || {};
  const s = Object.assign({}, LIB.settings, opts);
  const n = clamp(s.players|0, 2, 4);
  const seed = (s.seed!=null ? (s.seed>>>0) : newSeed()) || 1;
  const rng = {s: seed}, botRng = {s: (seed ^ 0x9E3779B9) >>> 0 || 7}, uids = {n:0};
  RNG_LIVE = rng; UID_LIVE = uids;                 // everything below draws from this game's streams
  const planetPool = shuffle(LIB.planets);
  const planetCount = clamp(s.planets|0, 1, Math.max(1, LIB.planets.length));

  const players = [];
  for(let i=0;i<n;i++){
    const deck = deckById(s.deckOf[i] || LIB.decks[0].id);
    const cards = (deck.cards||[]).map(id=>defById(id)).filter(Boolean).map(d=>instance(d,i));
    players.push({
      idx:i, name:(s.names && s.names[i]) || PNAMES[i], kind:(s.kinds[i]||'human'),
      deck:shuffle(cards), hand:[], energy:0, planned:0, placed:[]
    });
  }

  const planets = planetPool.slice(0, planetCount).map(p=>({
    def:p.id, name:p.name, art:clone(p.art), hue:p.hue||'#4fd6b0',
    slots:clone(p.slots),
    board:players.map(()=>new Array(RULES.slotsPerPlayer).fill(null))
  }));

  G = {
    round:0, phase:'placement', players, planets,
    first: rnd(n), order:[], turn:0, revealer:0,
    rounds: clamp(s.rounds|0, 1, 12),
    log:[], fxQueue:null, choice:null, over:false, result:null,
    sandbox: !!s.sandbox,
    epoch: 0,      // bumped by a sandbox reset, so a beat already in flight doesn't land on the new board
    trigBuf: [], fxAfter: null, trigCount: 0,
    grave:[],      // one graveyard, shared by every player
    plays:[],      // every card turned over, in order: {playerIdx, uid, planetIdx, round}
    pending:[],    // "the next card X plays" effects waiting for that card
    /* --- multiplayer-ready state ---------------------------------------- */
    seed, rng, botRng, uids,              // the streams above; same seed + same commands = same game
    simul: placementModeFor(s, players.map(p=>p.kind))==='simultaneous',
    online: !!s.online,
    cmdLog:[],     // every accepted command, in order: what a replay or a server re-applies
    events:[],     // what happened, for the screen to animate: {n, k, …} (see emit)
    eventN:0
  };
  G.players.forEach(p=>{ p.locked = false; });

  UI.transition = null; UI.flipAnim = null; UI.autoflip = false;
  UI.drag = null; UI.review = false; UI.peekBoard = false; UI.sheet = null;
  UI.botQueued = {}; UI.sel = null; UI.gate = false;
  fxReset();

  // opening hands
  G.players.forEach(p=>{ for(let i=0;i<RULES.startHand;i++) drawCard(p, true, true); });
  logRound();
  startRound();
}

/* --- SANDBOX --------------------------------------------------
   A test bench on top of a normal game: the rules run exactly as usual,
   these just reach in from outside them. Nothing here fires an ability. */

function sbEnergy(pi, delta){
  const p = G.players[pi]; if(!p) return;
  p.energy = Math.max(p.planned||0, p.energy + delta);
  say(`Sandbox: ${p.name} ${delta>=0?'gains':'loses'} ${Math.abs(delta)} Energy (now ${p.energy}).`, pi);
  render();
}

/** Put a fresh copy of any card or token into a hand. It is not "drawn". */
function sbAddCard(pi, id){
  const p = G.players[pi], def = defById(id);
  if(!p || !def) return;
  p.hand.push(instance(def, pi));
  say(`Sandbox: ${def.name} added to ${p.name}’s hand.`, pi);
  toast(`${def.name} → ${p.name}`);
  render();
}

function sbDraw(pi){
  const p = G.players[pi]; if(!p) return;
  const midway = !!(G.choice || G.fxQueue || UI.flipAnim);   // its trigger joins the chain already running
  const c = drawCard(p);
  if(!c) toast(`${p.name} has no cards left to draw.`);
  if(midway){ render(); return; }
  G.fxQueue = []; G.fxAfter = 'resume';
  processQueue();
}

function sbRound(delta){
  G.round = clamp(G.round + delta, 1, G.rounds);
  say(`Sandbox: round set to ${G.round}.`);
  render();
}

/** Clear every planet, the graveyard and anything mid-resolution, and go back
    to the first placement turn of the current round. Hands, decks and Energy
    stay as they are. */
function resetBoard(){
  G.planets.forEach(pl=>pl.board = G.players.map(()=>new Array(RULES.slotsPerPlayer).fill(null)));
  G.grave = []; G.plays = []; G.pending = [];
  G.choice = null; G.fxQueue = null; G.trigBuf = []; G.fxAfter = null; G.trigCount = 0;
  G.over = false; G.result = null;
  G.phase = 'placement'; G.order = turnOrder(); G.turn = 0; G.revealer = 0;
  G.players.forEach(p=>{ p.planned = 0; p.placed = []; });
  G.epoch++;
  G.hold = false; G.flipping = null;
  G.players.forEach(p=>{ p.locked = false; });
  UI.transition = null; UI.flipAnim = null; UI.autoflip = false; UI.sel = null; UI.drag = null; UI.gate = false;
  fxReset();
  say('Sandbox: the board was reset.');
  afterStateChange();
}

function sbEmptyGrave(){
  G.grave = [];
  say('Sandbox: the graveyard was emptied.');
  render();
}

function turnOrder(){
  const n = G.players.length, o = [];
  for(let i=0;i<n;i++) o.push((G.first+i)%n);
  return o;
}

function logRound(){ G.log.push({rd:true, t:'Round '+Math.max(1,G.round)}); }
/** A line in the game log. `vis` (a list of seats) keeps a line private. */
function say(t, who, vis){ G.log.push(vis ? {t, who, vis} : {t, who}); }

/** `quiet` is the opening deal: no "no cards left" line, and nothing fires,
    because a hand being dealt isn't a card being drawn. */
function drawCard(p, silent, quiet){
  if(!p.deck.length){ if(!silent) say(`${p.name} has no cards left to draw.`, p.idx); return null; }
  const card = p.deck.pop();
  p.hand.push(card);
  if(!quiet) fxArrive(card, 'draw');
  if(!quiet) fireTrigger(card, 'drawn', {owner:p.idx, planetIdx:null, slotIdx:null, uid:card.uid});
  return card;
}

/* --- PLACEMENT ------------------------------------------------- */

function startRound(){
  G.round++;
  if(G.round>1) logRound();
  G.pending = (G.pending||[]).filter(pk=>pk.until==null || pk.until===G.round);   // "this round" effects lapse
  G.phase = 'placement';
  rollForFirst();
  G.order = turnOrder();
  G.turn = 0;

  /* Income and harvest can draw cards, and a drawn card can have something
     to say about it. They run inside an open queue that hands back to normal
     play when it empties. */
  G.fxQueue = G.fxQueue || [];
  G.fxAfter = 'resume';

  // income: draw one, gain Energy
  G.order.forEach(i=>{
    const p = G.players[i];
    for(let d=0; d<RULES.drawPerRound; d++) drawCard(p);
    p.energy += RULES.energyPerRound;
    fxEnergy(p.idx, RULES.energyPerRound, {income:true});
    p.planned = 0; p.placed = []; p.locked = false;
  });
  emit('round', {round:G.round});
  say(`Everyone draws ${RULES.drawPerRound} and gains ${RULES.energyPerRound} Energy.`);

  // harvest: slots whose condition is satisfied pay out
  if(G.round>1) harvest();

  // then "at the start of each round" and "at the start of the next round"
  fireTimed([['roundStart'], ['nextRound', c=>c.playedRound===G.round-1]]);

  UI.sel = null;
  UI.gate = G.players[G.order[0]].kind==='human' && needsGate();
  showDice();
  processQueue();
}

function needsGate(){
  return !G.sandbox && !G.simul && !G.online && LIB.settings.hide && G.players.filter(p=>p.kind==='human').length>1;
}

/** Pay a slot's reward to one player, or do nothing for a 'none' slot. */
function payReward(rew, p, card){
  if(rew.type==='energy'){ p.energy += rew.amount; fxEnergy(p.idx, rew.amount, card ? {uid:card.uid} : {income:true}); }
  else if(rew.type==='draw') for(let k=0;k<rew.amount;k++) drawCard(p);
  return rew.type!=='none';
}

function harvest(){
  G.planets.forEach(pl=>{
    pl.slots.forEach((slot,si)=>{
      /* A 'winner' slot is a single cross-player comparison, not a per-card
         check: whoever holds the most Power in this exact slot takes the
         reward, and a tie (including nobody there at all) pays out nothing. */
      if(slot.cond.stat==='winner'){
        const entries = pl.board.map((row,pi)=>({pi, card:row[si]})).filter(e=>e.card);
        if(!entries.length) return;
        const best = Math.max(...entries.map(e=>powerOf(e.card)));
        const winners = entries.filter(e=>powerOf(e.card)===best);
        if(winners.length!==1) return;
        const w = winners[0], p = G.players[w.pi];
        if(payReward(slot.rew, p, w.card)) say(`${p.name} harvests ${rewLong(slot.rew)} from ${w.card.name} on ${pl.name} \u2014 the strongest card in that slot.`, w.pi);
        return;
      }
      pl.board.forEach((row,pi)=>{
        const card = row[si];
        if(!card || !condMet(slot.cond, card)) return;
        const p = G.players[pi];
        if(payReward(slot.rew, p, card)) say(`${p.name} harvests ${rewLong(slot.rew)} from ${card.name} on ${pl.name}.`, pi);
      });
    });
  });
}

function currentPlayer(){
  if(!G) return null;                       // called before a game exists
  if(G.phase==='placement'){
    /* Everyone places at once: the player this device is placing for, until
       they lock in. Taking turns: whoever's turn it is. */
    if(G.simul){ const s = localSeat(); const p = s!=null ? G.players[s] : null; return p && !p.locked ? p : null; }
    return G.players[G.order[G.turn]];
  }
  if(G.phase==='reveal') return G.players[G.order[G.revealer]];
  return null;
}

function canPlace(p, card){
  return p.planned + card.cost <= p.energy;
}

function placeCard(p, cardUid, planetIdx, slotIdx){
  const hi = p.hand.findIndex(c=>c.uid===cardUid);
  if(hi<0) return false;
  const card = p.hand[hi];
  const pl = G.planets[planetIdx];
  if(pl.board[p.idx][slotIdx]) return false;
  if(!canPlace(p, card)) return false;
  p.hand.splice(hi,1);
  card.faceUp = false;
  pl.board[p.idx][slotIdx] = card;
  p.planned += card.cost;
  p.placed.push({uid:card.uid, planetIdx, slotIdx});
  return true;
}

/* A card committed this round can be picked up again: it is face down, nothing
   has been paid, and `placed` still holds its receipt. */
function committedHere(p, planetIdx, slotIdx){
  const card = G.planets[planetIdx].board[p.idx][slotIdx];
  if(!card || card.faceUp) return null;
  return p.placed.some(r=>r.uid===card.uid) ? card : null;
}

/** What kind of handle you have on one of your cards:
    'committed' — placed this round, still face down, goes anywhere (placement);
    'revealed'  — already turned over, moves only between slots on its planet,
                  and only in the reveal phase (the end of your reveal turn);
    null        — cannot be moved at all. */
function pickupKind(p, planetIdx, slotIdx){
  if(!p) return null;
  const card = G.planets[planetIdx].board[p.idx][slotIdx];
  if(!card) return null;
  if(!card.faceUp) return committedHere(p, planetIdx, slotIdx) ? 'committed' : null;
  return (RULES.rearrangeRevealed && G.phase==='reveal') ? 'revealed' : null;
}

/** Move one of your cards to another of your slots, swapping with whatever is
    there if that card can move too. Energy is untouched either way. */
function moveCard(p, fromP, fromS, toP, toS){
  if(fromP===toP && fromS===toS) return false;
  const kind = pickupKind(p, fromP, fromS);
  if(!kind) return false;

  const card = G.planets[fromP].board[p.idx][fromS];
  const target = G.planets[toP].board[p.idx][toS];
  const targetKind = target ? pickupKind(p, toP, toS) : 'empty';
  if(!targetKind) return false;                                   // nothing can move out of the way

  /* A card that has been turned over holds the ground it landed on. It can
     change slot, never planet — and it cannot push another revealed card
     across planets either. */
  if(fromP!==toP && (kind==='revealed' || targetKind==='revealed')) return false;

  G.planets[fromP].board[p.idx][fromS] = target || null;
  G.planets[toP].board[p.idx][toS] = card;
  const rec = p.placed.find(r=>r.uid===card.uid);
  if(rec){ rec.planetIdx = toP; rec.slotIdx = toS; }
  if(target){
    const rec2 = p.placed.find(r=>r.uid===target.uid);
    if(rec2){ rec2.planetIdx = fromP; rec2.slotIdx = fromS; }
  }
  return true;
}

/** Drop a hand card onto a slot that already holds a committed card: the old
    one goes back to hand, the new one takes its place. */
function swapWithHand(p, cardUid, planetIdx, slotIdx){
  const held = committedHere(p, planetIdx, slotIdx);
  if(!held) return false;
  const hi = p.hand.findIndex(c=>c.uid===cardUid);
  if(hi<0) return false;
  const incoming = p.hand[hi];
  if(p.planned - held.cost + incoming.cost > p.energy) return false;
  unplaceCard(p, planetIdx, slotIdx);
  return placeCard(p, cardUid, planetIdx, slotIdx);
}

function unplaceCard(p, planetIdx, slotIdx){
  const pl = G.planets[planetIdx];
  const card = pl.board[p.idx][slotIdx];
  if(!card || card.faceUp) return false;
  const rec = p.placed.findIndex(r=>r.uid===card.uid);
  if(rec<0) return false;                    // not placed this round
  p.placed.splice(rec,1);
  p.planned -= card.cost;
  pl.board[p.idx][slotIdx] = null;
  p.hand.push(card);
  return true;
}

/** The players who may still place cards this round. */
function placingSeats(){
  if(!G || G.phase!=='placement' || G.over) return [];
  if(G.simul) return G.players.filter(p=>!p.locked).map(p=>p.idx);
  const p = G.players[G.order[G.turn]];
  return p ? [p.idx] : [];
}

/** A player is done placing. Taking turns, play passes to the next player;
    placing at once, the reveal starts when the last player locks in. */
function lockIn(seat){
  if(!G.simul) return endPlacementTurn();
  const p = G.players[seat];
  if(!p || p.locked) return;
  p.locked = true;
  /* how many cards is nobody else's business until the reveal */
  say(`${p.name} has locked in.`, p.idx);
  say(p.placed.length ? `You committed ${p.placed.length} card${p.placed.length>1?'s':''} face down.` : 'You played nothing this round.', p.idx, [p.idx]);
  emit('lock', {seat});
  if(p.idx===localSeat()){ UI.sel = null; UI.drag = null; }
  if(G.players.every(q=>q.locked)){
    G.hold = true;
    whenFxIdle(()=>pause('Reveal', 'Everyone has locked in \u2014 every commitment turns face down', beginReveal));
  }else afterStateChange();
}

function endPlacementTurn(){
  if(G) G.hold = true;                      // until the next player is up
  if(fxIdleIn()){ whenFxIdle(endPlacementTurn); render(); return; }
  const p = currentPlayer();
  if(!p){ G.hold = false; return; }
  if(p.placed.length) say(`${p.name} commits ${p.placed.length} card${p.placed.length>1?'s':''} face down.`, p.idx);
  emit('lock', {seat:p.idx});
  G.turn++;
  UI.sel = null;
  if(G.turn >= G.order.length){
    pause('Reveal', 'Every commitment turns face down', beginReveal);
  }else{
    const next = G.players[G.order[G.turn]];
    UI.gate = next.kind==='human' && needsGate();
    if(UI.gate){ G.hold = false; afterStateChange(); }
    else pause(next.name+' places', `Round ${G.round} of ${G.rounds}`, afterStateChange, next.idx);
  }
}

/* --- REVEAL ---------------------------------------------------- */

function beginReveal(){
  G.phase = 'reveal';
  G.revealer = 0;
  UI.peekBoard = false;
  say('Reveal phase.');
  skipEmptyRevealers(true);
}

/* `first` suppresses the beat, because the placement→reveal beat just played. */
function skipEmptyRevealers(first){
  G.revealDone = false;
  while(G.revealer < G.order.length){
    const p = G.players[G.order[G.revealer]];
    if(faceDownOf(p).length || readyActs(p).length) break;     // something to turn over, or an ability to use
    if(p.kind==='human' && RULES.revealEndTurn && RULES.rearrangeRevealed && hasFaceUp(p)) break;   // or cards to rearrange
    G.revealer++;
  }
  if(G.revealer >= G.order.length){ endOfRound(); return; }
  const p = currentPlayer();
  UI.gate = p.kind==='human' && needsGate();
  UI.peekBoard = false;
  if(first || UI.gate) afterStateChange();
  else pause(p.name+' reveals', faceDownOf(p).length ? 'One card at a time, in any order' : 'Rearrange or activate, then end the turn', afterStateChange, p.idx);
}
function hasFaceUp(p){ return G.planets.some(pl=>pl.board[p.idx].some(c=>c && c.faceUp)); }

function faceDownOf(p){
  const out = [];
  G.planets.forEach((pl,pi)=>pl.board[p.idx].forEach((card,si)=>{
    if(card && !card.faceUp) out.push({card, planetIdx:pi, slotIdx:si});
  }));
  return out;
}

/* Turning a card over is two beats: the card rotates, then it resolves. The
   animation owns the first 460ms and input is frozen for the duration. */
function flipCard(uid){
  const p = currentPlayer();
  if(!p || G.phase!=='reveal' || G.choice || UI.flipAnim || G.flipping) return;
  if(!faceDownOf(p).some(f=>f.card.uid===uid)) return;
  G.flipping = uid;                         // the engine's own "a card is turning" — no second flip meanwhile
  UI.flipAnim = uid;
  UI.peekBoard = false;
  render();
  const game = G, epoch = G.epoch;
  setTimeout(()=>{ if(G!==game || G.epoch!==epoch) return; UI.flipAnim = null; G.flipping = null; resolveFlip(uid); }, FLIP_MS);
}

function resolveFlip(uid){
  const p = currentPlayer();
  if(!p || G.phase!=='reveal' || G.choice) return;
  const found = faceDownOf(p).find(f=>f.card.uid===uid);
  if(!found) return;
  const {card, planetIdx, slotIdx} = found;

  if(p.energy < card.cost){
    G.planets[planetIdx].board[p.idx][slotIdx] = null;
    say(`${p.name} cannot pay for ${card.name} — it is discarded.`, p.idx);
    G.fxQueue = []; G.fxAfter = 'flip';
    toGrave(card);
    processQueue();
    return;
  }
  p.energy -= card.cost;
  card.faceUp = true;
  markInPlay(card);
  emit('flip', {uid:card.uid, seat:p.idx, p:planetIdx, s:slotIdx});
  UI.justFlipped = card.uid;
  say(`${p.name} reveals ${card.name} (${card.cost}\u26A1 / ${powerOf(card)}\u2726) on ${G.planets[planetIdx].name}.`, p.idx);

  /* This is the moment a card counts as "played". Anything waiting for "the
     next card this player plays" fires now, before the card's own ability \u2014
     so a buff lands on the card as it arrives. */
  G.plays.push({playerIdx:p.idx, uid:card.uid, planetIdx, round:G.round});
  const waiting = takePendingFor(p.idx, planetIdx, card.uid);
  runAbility(card, {owner:p.idx, planetIdx, slotIdx, uid:card.uid}, waiting);
}

/** Called once an ability (and any pending choices) has fully resolved. */
function afterFlip(){
  const p = currentPlayer();
  if(!p) return;
  /* The turn ends once every card is face up — unless an ability could still
     be activated, in which case the player says when they're done. */
  const waits = p.kind==='human' && RULES.revealEndTurn;
  if(faceDownOf(p).length===0 && (G.revealDone || (!waits && !readyActs(p).length))){
    if(fxIdleIn()){ whenFxIdle(afterFlip); render(); return; }     // let the last card's animations finish first
    G.revealer++;
    G.revealDone = false;
    UI.justFlipped = null;
    UI.sel = null; UI.drag = null;
    UI.autoflip = false;
    skipEmptyRevealers(false);
  }else{
    afterStateChange();
  }
}

/** "Done": the current revealer has nothing face down and won't use any more abilities. */
function endReveal(who, early){
  const p = currentPlayer();
  if(!p || G.phase!=='reveal') return;
  if(who!=null && p.idx!==who) return;                       // a retry for a turn that has already ended
  /* `early`: the turn timer ran out with cards still face down. The turn is
     marked done now and ends by itself as the last of them flips. */
  if(faceDownOf(p).length){ if(early) G.revealDone = true; return; }
  /* Pressed while an animation is still holding input: finish it first rather
     than ignore the tap. A choice still has to be made by hand. */
  if(busy()){
    if(!G.choice && !UI.transition && !UI.roundScreen){ clearTimeout(UI.endRevealT); UI.endRevealT = setTimeout(()=>endReveal(p.idx), 120); }
    return;
  }
  G.revealDone = true;
  UI.sel = null; UI.drag = null;
  afterFlip();
}

/* --- ACTIVATED ABILITIES ----------------------------------------------------
   A card's effects with when:'activate' are one ability its owner can fire by
   tapping the card during their own reveal turn: from the round after it was
   played, at most once per reveal phase, paying actCost Energy, actUses times
   in total (no actUses = unlimited). The cost and uses live on the first
   activate effect; normalizeFxList keeps the rest in step. */
const actFx = card => (card && card.fx || []).filter(f=>whenOf(f)==='activate');
function actSpec(card){
  const f = actFx(card)[0];
  return f ? {cost: Math.max(0, f.actCost|0), uses: f.actUses>0 ? (f.actUses|0) : null} : null;
}
const usesLeft = card => { const a = actSpec(card); return !a ? 0 : a.uses==null ? Infinity : Math.max(0, a.uses-(card.actUsed||0)); };
const ACT_WHY = {
  none:'This card has no activated ability.', facedown:'Turn it over first.',
  new:'It can be activated from the round after it was played.', used:'Already activated this round.',
  spent:'No uses left.', poor:'Not enough Energy.'
};
/** Why this card's ability can't be activated by `p` right now, or '' if it can. */
function actBlock(card, p){
  const a = actSpec(card);
  if(!a) return 'none';
  if(!card.faceUp) return 'facedown';
  if(card.playedRound==null || card.playedRound >= G.round) return 'new';
  if(!usesLeft(card)) return 'spent';
  if(card.actRound===G.round) return 'used';
  if(p && p.energy < a.cost) return 'poor';
  return '';
}
function readyActs(p){
  const out = [];
  G.planets.forEach((pl,pi)=>pl.board[p.idx].forEach((c,si)=>{
    if(c && c.faceUp && !actBlock(c, p)) out.push({card:c, planetIdx:pi, slotIdx:si});
  }));
  return out;
}
function activateCard(uid){
  const p = currentPlayer();
  if(!p || G.phase!=='reveal' || busy()) return;
  const o = locate(uid);
  if(!o || o.playerIdx!==p.idx) return;
  const why = actBlock(o.card, p);
  if(why){ if(p.kind==='human') toast(ACT_WHY[why]); return; }
  const a = actSpec(o.card);
  p.energy -= a.cost;
  o.card.actRound = G.round;
  o.card.actUsed = (o.card.actUsed||0) + 1;
  const left = usesLeft(o.card);
  say(`${p.name} activates ${o.card.name}${a.cost?` (${a.cost}\u26A1)`:''}${a.uses!=null?` \u2014 ${left} use${left===1?'':'s'} left`:''}.`, p.idx);
  UI.peekBoard = false; UI.sheet = null;
  runAbility(o.card, {owner:p.idx, planetIdx:o.planetIdx, slotIdx:o.slotIdx, uid}, null, 'activate');
}

function autoFlipAll(){
  const p = currentPlayer();
  if(!p || !faceDownOf(p).length) return;
  UI.autoflip = true;
  dispatch({t:'flip', seat:p.idx, uid:faceDownOf(p)[0].card.uid});   // afterStateChange keeps the chain going
}

/* --- END OF ROUND / GAME --------------------------------------- */

/** Queue the timed triggers of every face-up card on a planet, oldest first.
    `kinds` is [[when, filter?], …]; one card fires all of its kinds before the
    next card goes. Returns how many cards fired. */
function fireTimed(kinds){
  const cards = [];
  G.planets.forEach((pl,pi)=>pl.board.forEach((row,p)=>row.forEach((c,si)=>{
    if(c && c.faceUp) cards.push({c, ctx:{owner:p, planetIdx:pi, slotIdx:si, uid:c.uid}});
  })));
  cards.sort((a,b)=>(a.c.seq||0)-(b.c.seq||0));
  let n = 0;
  cards.forEach(({c, ctx})=>kinds.forEach(([when, keep])=>{
    if(keep && !keep(c)) return;
    if((c.fx||[]).some(f=>whenOf(f)===when)){ fireTrigger(c, when, Object.assign({}, ctx)); n++; }
  }));
  return n;
}

/** After the last reveal: "at the end of each round", in the order the cards
    were played. The round moves on once they've all resolved. */
function endOfRound(){
  G.fxQueue = G.fxQueue || [];
  G.fxAfter = 'roundover';
  G.fxLastSuccess = true; G.fxGateNext = false; G.trigCount = 0;
  fireTimed([['roundEnd']]);
  processQueue();
}
/** Face-up cards with an "at the end of the game" ability, oldest first. */
function gameEndCards(){
  const out = [];
  G.planets.forEach(pl=>pl.board.forEach(row=>row.forEach(c=>{
    if(c && c.faceUp && (c.fx||[]).some(f=>whenOf(f)==='gameEnd')) out.push(c);
  })));
  return out.sort((a,b)=>(a.seq||0)-(b.seq||0));
}
/** On the final round, once round-end abilities are done: a screen announcing
    the Game End effects (only if any card has one), then they fire in the
    order the cards were played, then the tally. */
function endOfRoundContinue(){
  if(G.round >= G.rounds){
    if(!G.gameEndDone){
      G.gameEndDone = true;
      const cards = gameEndCards();
      if(cards.length){
        showRoundScreen(fireGameEnd, {gameEnd:true, uids:cards.map(c=>c.uid)}, GAME_END_MS);
        return;
      }
    }
    pause('Final tally', 'Counting Power on every planet', finishGame);
    return;
  }
  showRoundScreen(startRound);
}
function fireGameEnd(){
  G.fxQueue = [];
  G.fxAfter = 'roundover';
  G.fxLastSuccess = true; G.fxGateNext = false; G.trigCount = 0;
  const n = fireTimed([['gameEnd']]);
  if(n) say(`End of the game: ${n} ${n===1?'card fires':'cards fire'}, in the order they were played.`);
  processQueue();
}

/* --- the turn timer --------------------------------------------------------
   Optional, set in setup. Each human turn (placing, or revealing) gets the same
   time. It runs while that player can act and stops for hand-overs, beats, the
   round screen and animations. Ten seconds out it warns; at zero the turn
   finishes itself: placement locks in what's placed, a reveal turns the rest
   over and skips unused abilities, and any open choice is made at random. */
const TIMER_PRESETS = [[0,'Off'],[30,'30 seconds'],[45,'45 seconds'],[60,'1 minute'],[90,'1\u00BD minutes'],[120,'2 minutes'],['custom','Custom\u2026']];
const timerPreset = s => s.turnTimerCustom ? 'custom' : String(s.turnTimer||0);
const fmtClock = ms => { const t = Math.max(0, Math.ceil(ms/1000)); return Math.floor(t/60)+':'+String(t%60).padStart(2,'0'); };
const TIMER_WARN = 10000;
function timerKey(){
  /* Online, everyone places at once on their own device: one clock for the
     whole placement, held by the host, for every human still placing. */
  if(G && G.online && G.simul && G.phase==='placement' && !G.over)
    return G.players.some(q=>q.kind==='human' && !q.locked) ? G.round+':placement:all' : null;
  const p = currentPlayer();
  return (G && p && p.kind==='human' && !G.over) ? G.round+':'+G.phase+':'+p.idx : null;
}
function timerHTML(){
  if(G && G.isView) return netTimerHTML('turn');
  if(!G || !LIB.settings.turnTimer) return '';
  const key = timerKey();
  if(!key) return '';
  const left = UI.timer && UI.timer.key===key ? UI.timer.left : LIB.settings.turnTimer*1000;
  return `<span class="turn-timer ${left<=TIMER_WARN?'warn':''}" data-timer aria-label="Time left this turn">\u23F1 ${fmtClock(left)}</span>`;
}
function timerPaused(){
  return !!(UI.gate || UI.transition || UI.roundScreen || UI.dice || UI.flipAnim || UI.animLock || UI.fxWait || UI.screen!=='game');
}

/* --- the choice timer --------------------------------------------------------
   With turn timers on, every ability pop-up a person has to answer gets its
   own clock (30 seconds unless setup says otherwise). The turn's clock stops
   while it runs. At zero the choice is made at random, as a bot would. A
   choice that takes several picks (discard two) keeps one clock for all. */
const CHOICE_PRESETS = [[15,'15 seconds'],[20,'20 seconds'],[30,'30 seconds'],[45,'45 seconds'],[60,'1 minute'],[90,'1\u00BD minutes']];
const choiceSecs = () => (LIB && LIB.settings && LIB.settings.turnTimer) ? (LIB.settings.choiceTimer || 30) : 0;
/** The open choice, if a person on this device is the one answering it. */
function timedChoice(){
  const ch = G && G.choice;
  if(!ch || ch.waiting || G.isView || G.over) return null;
  const seat = chooserOf(ch);
  return (G.players[seat] && G.players[seat].kind==='human') ? ch : null;
}
function choiceTimerHTML(compact){
  if(G && G.isView) return netTimerHTML('choice', compact);
  const secs = choiceSecs();
  const ch = secs ? timedChoice() : null;
  if(!ch) return '';
  const left = UI.ctimer && UI.ctimer.ch===ch ? UI.ctimer.left : secs*1000;
  return `<span class="turn-timer choice-timer ${compact?'compact':''} ${left<=TIMER_WARN?'warn':''}" data-ctimer aria-label="Time left to choose">\u23F1 ${fmtClock(left)}</span>`;
}
/** Runs the choice clock. True while a choice is being timed, so the turn
    clock holds still. */
function tickChoiceTimer(now){
  const secs = choiceSecs();
  const ch = secs ? timedChoice() : null;
  if(!ch){ UI.ctimer = null; return false; }
  if(!UI.ctimer || UI.ctimer.ch!==ch) UI.ctimer = {ch, left:secs*1000, last:now, up:false, warned:false};
  const t = UI.ctimer;
  const dt = now - t.last; t.last = now;
  /* the turn's own time has already run out: its choices don't wait */
  if(!t.up && UI.timer && UI.timer.up && UI.timer.key===timerKey()) t.up = true;
  if(t.up){ timeOutChoice(); return true; }
  if(UI.transition || UI.animLock || UI.fxWait || UI.flipAnim || UI.gate || UI.screen!=='game') return true;
  t.left -= dt;
  document.querySelectorAll('[data-ctimer]').forEach(el=>{ el.textContent = '\u23F1 '+fmtClock(t.left); el.classList.toggle('warn', t.left<=TIMER_WARN); });
  if(!t.warned && t.left<=TIMER_WARN && secs*1000 > TIMER_WARN){ t.warned = true; toast('10 seconds to choose'); }
  if(t.left<=0){ t.up = true; t.left = 0; toast('Time\u2019s up \u2014 choosing at random'); timeOutChoice(); }
  return true;
}
function timeOutChoice(){
  if(UI.transition || UI.animLock || UI.fxWait || UI.flipAnim) return;     // the next tick tries again
  if(UI.sheet==='peek' || UI.sheet==='grave'){ UI.sheet = null; UI.peek = null; }
  UI.choicePeek = null;
  autoResolveChoice();
}

function tickTimer(){
  if(G && G.isView){ netTimerTick(); return; }     // a guest only shows the host's clocks
  if(tickChoiceTimer(Date.now())){ if(UI.timer) UI.timer.last = Date.now(); return; }
  const secs = LIB && LIB.settings && LIB.settings.turnTimer;
  const key = secs ? timerKey() : null;
  if(!key){ UI.timer = null; return; }
  const now = Date.now();
  if(!UI.timer || UI.timer.key!==key) UI.timer = {key, left: secs*1000, warned:false, last:now, up:false};
  const t = UI.timer;
  const dt = now - t.last; t.last = now;
  if(t.up){ autoCompleteTurn(); return; }
  if(timerPaused()) return;
  t.left -= dt;
  const el = document.querySelector('[data-timer]');
  if(el){ el.textContent = '\u23F1 '+fmtClock(t.left); el.classList.toggle('warn', t.left<=TIMER_WARN); }
  if(!t.warned && t.left<=TIMER_WARN && secs*1000 > TIMER_WARN){ t.warned = true; toast('10 seconds left'); }
  if(t.left<=0){ t.up = true; t.left = 0; toast('Time\u2019s up \u2014 finishing the turn'); autoCompleteTurn(); }
}
/** Time ran out: make the open choice at random, then finish the turn. Called
    again on every tick until the turn has moved on. */
function autoCompleteTurn(){
  if(G && G.online && G.simul && G.phase==='placement'){
    if(!UI.timer || UI.timer.key!==timerKey()) return;
    if(UI.gate || UI.transition || UI.roundScreen || UI.dice || UI.flipAnim || UI.animLock || UI.fxWait) return;
    if(G.choice){ autoResolveChoice(); return; }
    UI.sel = null; UI.drag = null; DRAG.uid = null;
    G.players.filter(q=>q.kind==='human' && !q.locked).forEach(q=>dispatch({t:'lock', seat:q.idx}));
    return;
  }
  const p = currentPlayer();
  if(!p || p.kind!=='human' || !UI.timer || UI.timer.key!==timerKey()) return;
  if(UI.sheet==='peek'){ UI.sheet = null; UI.peek = null; }
  if(G.choice){ autoResolveChoice(); return; }
  if(UI.gate || UI.transition || UI.roundScreen || UI.dice || UI.flipAnim || UI.animLock || UI.fxWait) return;
  if(G.phase==='placement'){
    UI.sel = null; UI.drag = null; DRAG.uid = null;
    dispatch({t:'lock', seat:p.idx});
  }else if(G.phase==='reveal'){
    if(UI.autoflip) return;                     // already turning the rest over
    dispatch({t:'endReveal', seat:p.idx, early:true});
    if(faceDownOf(p).length) autoFlipAll();
  }
}
function autoResolveChoice(){
  const ch = G.choice;
  if(!ch) return;
  const any = list => botPick(list);          // a decision made for the player: the bots' stream, never the rules'
  const seat = chooserOf(ch);
  switch(ch.kind){
    case 'discard': { const pool = ch.ctx ? handPool(ch.player, ch.f, ch.ctx) : handPool(ch.player); if(pool.length) dispatch({t:'choose', seat, uid:any(pool).card.uid}); break; }
    case 'pickplayer': dispatch({t:'choose', seat, i:any(ch.options)}); break;
    case 'pickplanet': dispatch({t:'choose', seat, i:any(ch.options)}); break;
    case 'pickcard':   dispatch({t:'choose', seat, uid:any(ch.pool).card.uid}); break;
    case 'pickmode':   { const left = ch.live.filter(i=>!ch.picked.includes(i)); if(left.length) dispatch({t:'choose', seat, i:any(left)}); break; }
  }
}
setInterval(()=>{ try{ if(typeof G!=='undefined' && G) tickTimer(); }catch(e){ console.warn(e); } }, 200);

/* --- who goes first: a dice roll at the start of every round ---------------
   Everyone rolls a die; the highest goes first and play runs clockwise from
   them, for placing and for revealing. A tie for the top re-rolls (the log
   says how many times). The roll itself is decided at once — the dice on
   screen only show it: they tumble for DICE_ROLL_MS, land, and the winner is
   held up for DICE_HOLD_MS. Input waits for them (busy()), and so do bots,
   income Energy and the turn timer. A tap skips to the end. */
const DICE_ROLL_MS = Math.max(PAUSE * 0.9, 30), DICE_HOLD_MS = Math.max(PAUSE * 0.8, 30);
function rollForFirst(){
  let rolls, best, rerolls = 0;
  for(;;){
    rolls = G.players.map(()=>1 + rnd(6));
    best = Math.max(...rolls);
    if(rolls.filter(r=>r===best).length===1) break;
    rerolls++;
  }
  G.first = rolls.indexOf(best);
  G.dice = {round:G.round, rolls, rerolls};
  say(`Roll for first: ${G.players.map((p,i)=>p.name+' '+rolls[i]).join(', ')}${rerolls?` (after ${rerolls} re-roll${rerolls>1?'s':''} for a tie)`:''} \u2014 ${G.players[G.first].name} goes first.`);
}
function showDice(){
  /* Only on a real screen; the headless tests have no layout to show it on. */
  if(typeof document==='undefined' || !(document.documentElement.getBoundingClientRect().width > 0)) return;
  const game = G, epoch = G.epoch, spin = animOn();
  let done = false;
  clearInterval(UI.diceSpin); clearTimeout(UI.diceT);
  const finish = ()=>{
    if(done) return;
    done = true; clearInterval(UI.diceSpin); clearTimeout(UI.diceT);
    if(G!==game || G.epoch!==epoch){ return; }
    UI.dice = null; UI.diceGo = null;
    render();
    if(animOn()) flushEnergy();
  };
  const land = ()=>{
    clearInterval(UI.diceSpin);
    if(!UI.dice || G!==game) return;
    UI.dice.landed = true;
    render();
    UI.diceT = setTimeout(finish, DICE_HOLD_MS);
  };
  UI.dice = {round:G.round, landed:!spin};
  UI.diceGo = finish;
  if(spin){
    /* tumbling: the faces flicker without a re-render */
    UI.diceSpin = setInterval(()=>{
      document.querySelectorAll('.die[data-rolling]').forEach(el=>{ el.innerHTML = pipsHTML(1 + uiRnd(6)); });
    }, 75);
    UI.diceT = setTimeout(land, DICE_ROLL_MS);
  }else UI.diceT = setTimeout(finish, DICE_ROLL_MS + DICE_HOLD_MS);
}
const PIPS = {1:[4], 2:[0,8], 3:[0,4,8], 4:[0,2,6,8], 5:[0,2,4,6,8], 6:[0,2,3,5,6,8]};
const pipsHTML = n => Array.from({length:9}, (_,i)=>`<i class="${PIPS[n].includes(i)?'on':''}"></i>`).join('');
function diceHTML(){
  const d = UI.dice, roll = G.dice || {rolls:G.players.map(()=>1)};
  const first = G.first, landed = d.landed;
  return `<div class="dice-screen ${landed?'landed':''}" data-act="dicego" role="dialog" aria-label="Rolling for who goes first">
    <div class="rs-inner">
      <div class="rs-kicker">Round ${G.round} \u00B7 who goes first?</div>
      <div class="dice-row">${G.players.map((p,i)=>`
        <div class="die-seat ${landed ? (i===first?'win':'lose') : ''}" style="--pc:${PCOLORS[i]}">
          <div class="die" ${landed?'':'data-rolling'} style="--spin:${(i%2?-1:1)*(300+90*i)}deg;--delay:${i*60}ms" aria-label="${esc(p.name)} rolled ${landed?roll.rolls[i]:'\u2026'}">${pipsHTML(landed ? roll.rolls[i] : 1 + uiRnd(6))}</div>
          <b>${esc(p.name)}</b>
        </div>`).join('')}</div>
      <div class="dice-result">${landed ? `<span class="dot" style="--pc:${PCOLORS[first]}"></span><b style="color:${PCOLORS[first]}">${esc(G.players[first].name)}</b> goes first${roll.rerolls?` <i>(tie re-rolled)</i>`:''}` : 'Rolling\u2026'}</div>
    </div>
  </div>`;
}

/* --- the screen between rounds ------------------------------------------
   A full-screen beat once the last reveal (and its animations) are done:
   where everyone stands, then what's about to happen. It moves on by itself,
   or on a tap. */
const ROUND_MS = Math.max(PAUSE, 60);          // one second; a tap skips it
const GAME_END_MS = Math.max(PAUSE*2.4, 60);   // long enough to read who fires
function showRoundScreen(next, info, ms){
  G.hold = true;
  if(fxIdleIn()){ whenFxIdle(()=>showRoundScreen(next, info, ms)); render(); return; }
  const game = G, epoch = G.epoch;
  let done = false;
  const go = ()=>{
    if(done || G!==game || G.epoch!==epoch) return;
    done = true; clearTimeout(timer);
    UI.roundScreen = null; UI.roundGo = null;
    G.hold = false;
    next();
  };
  UI.roundScreen = Object.assign({ended: G.round, next: G.round+1, ms: ms||ROUND_MS}, info||{});
  UI.roundGo = go;
  UI.sel = null; UI.sheet = null;
  render();
  const timer = setTimeout(go, ms||ROUND_MS);
}

function roundScreenHTML(){
  const rs = UI.roundScreen;
  if(rs.gameEnd) return gameEndScreenHTML(rs);
  const standings = G.players.map(p=>{
    const held = G.planets.filter(pl=>{ const sc = planetScore(pl); return sc[p.idx]>0 && sc.every((x,i)=>i===p.idx || x<sc[p.idx]); }).length;
    return {p, held};
  });
  const top = Math.max(...standings.map(s=>s.held));
  const planets = G.planets.map(pl=>{
    const sc = planetScore(pl), best = Math.max(...sc);
    const lead = sc.filter(v=>v===best).length===1 && best>0 ? sc.indexOf(best) : null;
    return `<span class="rs-planet" style="--po:${pl.hue};--pc:${lead==null?'var(--ui-line-2)':PCOLORS[lead]}" title="${esc(pl.name)}">
      <span class="rs-orb">${artHTML(pl.art, pl.name)}</span>
      <span class="rs-score">${sc.map((v,i)=>`<b style="color:${PCOLORS[i]}">${v}</b>`).join('<i>\u00B7</i>')}</span></span>`;
  }).join('');
  const lastRound = rs.next===G.rounds;
  return `<div class="round-screen" data-act="roundgo" role="dialog" aria-label="Round ${rs.next}">
    <div class="rs-inner">
      <div class="rs-kicker">Round ${rs.ended} is over</div>
      <div class="rs-title">Round <em>${rs.next}</em><span> of ${G.rounds}</span></div>
      ${lastRound?'<div class="rs-final">Final round</div>':''}
      <div class="rs-planets">${planets}</div>
      <div class="rs-players">${standings.map(({p,held})=>`
        <div class="rs-player ${held===top&&held>0?'lead':''}" style="--pc:${PCOLORS[p.idx]}">
          <span class="dot"></span><b>${esc(p.name)}</b>
          <span class="rs-stat"><b>${held}</b> held</span>
          <span class="rs-stat">\u26A1 ${shownEnergy(p)}</span>
          <span class="rs-stat">${p.hand.length} in hand</span>
        </div>`).join('')}</div>
      <p class="rs-next">Everyone draws ${RULES.drawPerRound} and gains ${RULES.energyPerRound} Energy, then cards in slots they match pay out.</p>
      <div class="rs-tap">Tap to continue</div>
      <div class="rs-bar"><i style="animation-duration:${ROUND_MS}ms"></i></div>
    </div>
  </div>`;
}

/** The beat before the Game End effects: the round is over, these cards fire
    now, in this order. Same frame as the round screen, a different note. */
function gameEndScreenHTML(rs){
  const cards = rs.uids.map(uid=>findCardByUid(uid)).filter(Boolean);
  return `<div class="round-screen game-end" data-act="roundgo" role="dialog" aria-label="Game End effects">
    <div class="rs-inner">
      <div class="rs-kicker">Round ${rs.ended} of ${G.rounds} is over</div>
      <div class="rs-title"><em>Game End</em></div>
      <div class="rs-final">Before the final tally</div>
      <ol class="ge-list">${cards.map((c,i)=>{
        const at = locate(c.uid);
        return `<li style="--pc:${PCOLORS[c.owner]}">
          <span class="ge-n">${i+1}</span>
          <span class="ge-art">${artHTML(c.art, c.name)}</span>
          <span class="ge-txt"><b>${esc(c.name)}</b><span>${esc(G.players[c.owner].name)}${at?' \u00B7 '+esc(G.planets[at.planetIdx].name):''}</span></span>
        </li>`;
      }).join('')}</ol>
      <p class="rs-next">${cards.length===1?'Its Game End effect fires now.':'Their Game End effects fire now, in the order they were played.'} Then Power is counted on every planet.</p>
      <div class="rs-tap">Tap to continue</div>
      <div class="rs-bar"><i style="animation-duration:${rs.ms}ms"></i></div>
    </div>
  </div>`;
}

/* Only revealed cards count. Everything is face up by scoring time, so this
   is both the live display total and the final total. */
function planetScore(pl){
  return pl.board.map(row => row.reduce((s,c)=> s + (c && c.faceUp ? powerOf(c) : 0), 0));
}

function finishGame(){
  const rows = G.planets.map(pl=>{
    const scores = planetScore(pl);
    const best = Math.max(...scores);
    const winners = scores.map((s,i)=>({s,i})).filter(o=>o.s===best && o.s>0).map(o=>o.i);
    return { name:pl.name, scores, winner: winners.length===1 ? winners[0] : null };
  });
  const won = G.players.map((p,i)=> rows.filter(r=>r.winner===i).length);
  const top = Math.max(...won);
  let cands = won.map((w,i)=>({w,i})).filter(o=>o.w===top).map(o=>o.i);
  let reason = 'planets won';
  if(cands.length>1){
    const h = Math.max(...cands.map(i=>G.players[i].hand.length));
    const c2 = cands.filter(i=>G.players[i].hand.length===h);
    if(c2.length<cands.length){ cands=c2; reason='cards left in hand'; } else cands=c2;
  }
  if(cands.length>1){
    const e = Math.max(...cands.map(i=>G.players[i].energy));
    const c3 = cands.filter(i=>G.players[i].energy===e);
    if(c3.length<cands.length){ cands=c3; reason='Energy left over'; } else cands=c3;
  }
  G.over = true;
  G.phase = 'over';
  G.result = { rows, won, winner: cands.length===1 ? cands[0] : null, reason };
  say(cands.length===1 ? `${G.players[cands[0]].name} wins the game.` : 'The game ends in a draw.');
  UI.gate = false; UI.autoflip = false; UI.review = false;
  UI.reviewSeat = Math.max(0, G.players.findIndex(p=>p.kind==='human'));
  render();
}

/* State changed: run the bot if it is a bot's turn, otherwise draw. */
function afterStateChange(){
  render();
  if(!G || G.over) return;
  /* Placing at once: every bot places as soon as the round opens. */
  if(G.simul && G.phase==='placement' && !G.hold && !G.choice && !UI.transition && botsDrive()){
    G.players.forEach(q=>{
      if(q.kind!=='bot' || q.locked) return;
      const key = G.epoch+':'+G.round+':'+q.idx;
      if(UI.botQueued[key]) return;
      UI.botQueued[key] = true;
      setTimeout(()=>botAct(q.idx), 520);
    });
  }
  const p = currentPlayer();
  if(!p || UI.gate || G.choice || UI.transition) return;
  if(p.kind==='bot'){ if(botsDrive()) setTimeout(()=>botAct(p.idx), 520); return; }
  if(UI.autoflip && G.phase==='reveal' && faceDownOf(p).length){
    setTimeout(()=>{ if(UI.autoflip) autoFlipAll(); }, 260);
  }
}
/** Bots move by themselves, except while a recorded game is being replayed
    (the record already holds their moves). */
const botsDrive = () => !UI.replaying;

/* ------------------------------------------------------------------
   4b. COMMANDS
   Every move a player makes enters the game through dispatch(cmd), and
   nowhere else: the hand, the drag, the bots, the turn timer and (later) the
   network all speak the same small language.

     {t:'place',     seat, uid, p, s}   hand card -> your slot (a held card there swaps back to hand)
     {t:'move',      seat, uid, p, s}   your card on the board -> another of your slots
     {t:'unplace',   seat, uid}         a card committed this round -> back to hand
     {t:'lock',      seat}              done placing ("Lock in" / "Play nothing")
     {t:'flip',      seat, uid}         turn one of your face-down cards over
     {t:'activate',  seat, uid}         use a card's activated ability
     {t:'endReveal', seat, early?}      end your reveal turn (early: the timer ran out)
     {t:'choose',    seat, uid | i}     answer the open choice (a card by uid, or option i)
     {t:'sandbox',   seat, op, …}       the sandbox bench (never online)
     {t:'standin',   seat, target, on}  online, the host only: a bot plays for a
                                        seat whose player has dropped (on), or
                                        hands it back when they return (off)

   dispatch checks that `seat` may act right now and that the move is legal,
   applies it, and appends it to G.cmdLog. The same seed plus the same log
   replays the same game, so a server can hold the real game and every device
   can be checked against it. Commands carry no UI state: what is selected,
   dragged or animating stays on the device.
   ------------------------------------------------------------------ */

/* The network hook. Online, a device doesn't apply its own moves: it sends
   them to whoever holds the game (`NET.send`) and draws what comes back.
   Section 9 connects it: the host's browser holds G, guests send commands. */
const NET = { seat:null, send:null, applying:false };   // section 9 (ONLINE) fills these in

/** The seat this device acts for when nobody is passing it around: online,
    its own seat; at a table with one human, that human. */
function localSeat(){
  if(!G) return null;
  if(G.isView) return G.viewer;
  if(G.online) return NET.seat;
  return lockedSeat();
}
const revealerSeat = () => (G && G.phase==='reveal') ? G.order[G.revealer] : null;
/** Who answers an open choice: the caster, or for a hand pick, the chooser. */
const chooserOf = ch => !ch ? null : ch.kind==='discard' ? (ch.chooser!=null ? ch.chooser : ch.player) : ch.owner;

/** Why `cmd` can't be applied right now, or '' if it can. */
function cmdCheck(cmd){
  if(!G || G.over) return 'over';
  if(!cmd || typeof cmd.t!=='string') return 'malformed';
  const p = G.players[cmd.seat];
  if(!p) return 'seat';
  if(cmd.t==='sandbox') return (G.sandbox && !G.online) ? '' : 'nosandbox';
  if(cmd.t==='choose') return !G.choice ? 'nochoice' : chooserOf(G.choice)===cmd.seat ? '' : 'notyours';
  if(cmd.t==='standin') return (G.online && cmd.seat===0 && G.players[cmd.target] && cmd.target!==0) ? '' : 'notyours';
  if(G.choice) return 'choice';
  if(G.hold || G.flipping || G.fxQueue) return 'busy';
  const slotOk = Number.isInteger(cmd.p) && Number.isInteger(cmd.s) && G.planets[cmd.p] && cmd.s>=0 && cmd.s<G.planets[cmd.p].slots.length;
  switch(cmd.t){
    case 'place':
      if(!slotOk) return 'slot';
      return placingSeats().includes(cmd.seat) ? '' : 'turn';
    case 'unplace': case 'lock':
      return placingSeats().includes(cmd.seat) ? '' : 'turn';
    case 'move':
      if(!slotOk) return 'slot';
      if(G.phase==='placement') return placingSeats().includes(cmd.seat) ? '' : 'turn';
      return (revealerSeat()===cmd.seat && RULES.rearrangeRevealed && !faceDownOf(p).length) ? '' : 'turn';
    case 'flip': case 'activate': case 'endReveal':
      return revealerSeat()===cmd.seat ? '' : 'turn';
  }
  return 'unknown';
}

/** The one way in. Returns {ok, why}. */
function dispatch(cmd){
  if(G && G.online && NET.send && !NET.applying){
    /* A guest checks a move against its own view first, so a tap that
       can't work says so at once instead of after a round trip. */
    const why = cmdCheck(cmd) || dryRun(cmd);
    if(why) return {ok:false, why};
    NET.send(cmd); return {ok:true, sent:true};
  }
  const why = cmdCheck(cmd);
  if(why) return {ok:false, why};
  const rec = Object.assign({n: G.cmdLog.length+1}, cmd);
  G.cmdLog.push(rec);                       // logged first: anything it sets off comes after it
  let ok = false;
  try{ ok = applyCommand(cmd)!==false; }
  finally{ if(!ok){ const i = G.cmdLog.indexOf(rec); if(i>=0) G.cmdLog.splice(i,1); } }
  return {ok, why: ok ? '' : 'illegal'};
}

/** Try a placement-type command on a throwaway copy of the view. */
function dryRun(cmd){
  if(!['place','move','unplace'].includes(cmd.t)) return '';
  const real = G;
  try{ G = JSON.parse(JSON.stringify(real)); return applyCommand(cmd)!==false ? '' : 'illegal'; }
  catch(e){ return ''; }
  finally{ G = real; }
}

function applyCommand(cmd){
  const p = G.players[cmd.seat];
  switch(cmd.t){
    case 'place':{
      if(!p.hand.some(c=>c.uid===cmd.uid)) return false;
      return G.planets[cmd.p].board[p.idx][cmd.s] ? swapWithHand(p, cmd.uid, cmd.p, cmd.s)
                                                   : placeCard(p, cmd.uid, cmd.p, cmd.s);
    }
    case 'move':{
      const at = whereIs(p, cmd.uid);
      return !!at && at.from==='board' && moveCard(p, at.planetIdx, at.slotIdx, cmd.p, cmd.s);
    }
    case 'unplace':{
      const at = whereIs(p, cmd.uid);
      return !!at && at.from==='board' && unplaceCard(p, at.planetIdx, at.slotIdx);
    }
    case 'lock':      lockIn(p.idx); return true;
    case 'flip':
      if(!faceDownOf(p).some(f=>f.card.uid===cmd.uid)) return false;
      flipCard(cmd.uid); return true;
    case 'activate':{
      const o = locate(cmd.uid);
      if(!o || o.playerIdx!==p.idx || actBlock(o.card, p)) return false;
      activateCard(cmd.uid); return true;
    }
    case 'endReveal':
      if(faceDownOf(p).length && !cmd.early) return false;
      endReveal(p.idx, !!cmd.early); return true;
    case 'choose':  return applyChoice(cmd);
    case 'sandbox': return applySandbox(cmd);
    case 'standin': return applyStandIn(cmd);
  }
  return false;
}
/** Online: a bot takes a dropped player's seat, or gives it back. A choice
    that seat still owes is made for it, as a timer would. */
function applyStandIn(cmd){
  const q = G.players[cmd.target];
  if(!!cmd.on === !!q.standIn) return false;
  if(cmd.on){ q.kind = 'bot'; q.standIn = true; say(`A bot plays for ${q.name} until they're back.`); }
  else { q.kind = 'human'; delete q.standIn; say(`${q.name} is back.`); }
  if(cmd.on && G.choice && chooserOf(G.choice)===q.idx) setTimeout(()=>{ if(G && G.choice && chooserOf(G.choice)===q.idx) autoResolveChoice(); }, 0);
  setTimeout(()=>{ if(G && !G.over) afterStateChange(); }, 0);
  return true;
}

/** Answer the open choice, after checking the answer is one of its options. */
function applyChoice(cmd){
  const ch = G.choice;
  switch(ch.kind){
    case 'discard':{
      const pool = ch.ctx ? handPool(ch.player, ch.f, ch.ctx) : handPool(ch.player);
      if(!pool.some(o=>o.card.uid===cmd.uid)) return false;
      resolveDiscard(cmd.uid); return true;
    }
    case 'pickcard':
      if(!ch.pool.some(o=>o.card.uid===cmd.uid)) return false;
      resolvePickCard(cmd.uid); return true;
    case 'pickplayer':
      if(!ch.options.includes(cmd.i)) return false;
      resolvePickPlayer(cmd.i); return true;
    case 'pickplanet':
      if(!ch.options.includes(cmd.i)) return false;
      resolvePickPlanet(cmd.i); return true;
    case 'pickmode':
      if(!ch.live.includes(cmd.i)) return false;
      togglePickMode(cmd.i); return true;
  }
  return false;
}

function applySandbox(cmd){
  switch(cmd.op){
    case 'energy': sbEnergy(cmd.i, cmd.v); return true;
    case 'add':    sbAddCard(cmd.i, cmd.id); return true;
    case 'draw':   sbDraw(cmd.i); return true;
    case 'round':  sbRound(cmd.v); return true;
    case 'grave':  sbEmptyGrave(); return true;
    case 'reset':  resetBoard(); return true;
  }
  return false;
}

/** The seat a tap on this device acts for: online, this device's seat; in
    pass-and-play, whoever is answering the open choice or taking their turn. */
/** End turn, tapped. Pressed while something is still resolving, it waits for
    that to finish rather than being ignored — but only for the same turn. */
function endRevealTap(seat){
  const p = currentPlayer();
  if(!p) return;
  if(seat!=null && p.idx!==seat) return;
  const r = dispatch({t:'endReveal', seat:p.idx});
  if(!r.ok && r.why==='busy' && !G.choice){ clearTimeout(UI.endRevealT); UI.endRevealT = setTimeout(()=>endRevealTap(p.idx), 120); }
}
/** The sandbox bench acts for whoever is at the device. */
const sbSeat = () => { const s = uiSeat(); return s!=null ? s : 0; };

function uiSeat(){
  if(!G) return null;
  if(G.online) return NET.seat;
  if(G.choice) return chooserOf(G.choice);
  const p = currentPlayer();
  return p ? p.idx : localSeat();
}

/* ------------------------------------------------------------------
   4c. WHAT EACH PLAYER MAY SEE
   playerView(state, seat) is the game as one seat is allowed to know it:
   what a server sends that seat's device. Everything secret is gone, not
   just hidden on screen:
     - every deck's order and contents (only how many cards are left),
     - other players' hands (only how many), unless this seat is choosing
       from that hand right now (the rules show it to them),
     - other players' face-down cards (just the back; and while everyone is
       placing at once, not even that — they appear when the reveal starts),
     - other players' committed Energy and placement receipts,
     - the seed and both random streams, the command log, the engine's
       working queues, and log lines and events meant for someone else.
   A device can draw a view exactly like a full game: set G to it and render.
   ------------------------------------------------------------------ */
const ENGINE_ONLY = ['rng','botRng','seed','cmdLog','fxQueue','trigBuf','fxAfter'];
function playerView(state, seat){
  const g = state || G;
  const v = JSON.parse(JSON.stringify(g, function(k, val){ return (this===g && ENGINE_ONLY.includes(k)) ? undefined : val; }));
  const ch = g.choice;
  const chooser = chooserOf(ch);
  const shownHand = ch && ch.kind==='discard' && chooser===seat ? ch.player : null;
  const back = c => ({uid:c.uid, owner:c.owner, faceUp:false, hidden:true});
  v.players.forEach(p=>{
    p.deck = p.deck.map(()=>({hidden:true}));
    if(p.idx===seat) return;
    if(p.idx!==shownHand) p.hand = p.hand.map(()=>({hidden:true}));
    p.planned = 0; p.placed = [];
  });
  const fresh = g.simul && g.phase==='placement';
  v.planets.forEach(pl=>pl.board.forEach((row, pi)=>{
    if(pi===seat) return;
    row.forEach((c, si)=>{ if(c && !c.faceUp) row[si] = fresh ? null : back(c); });
  }));
  if(ch && chooser!==seat) v.choice = {kind:ch.kind, owner:ch.owner, chooser, waiting:true};
  v.log = v.log.filter(l=>!l.vis || l.vis.includes(seat));
  v.events = v.events.filter(e=>!e.vis || e.vis.includes(seat)).map(e=>{
    /* a card arriving in someone else's hand: that it arrived, not which card */
    if(e.k==='arrive' && e.kind==='draw' && e.owner!==seat){ const o = Object.assign({}, e); delete o.uid; return o; }
    return e;
  });
  /* Last, a sweep: a hidden card's id is opaque, but still nobody else's
     business — wherever one turns up (an event that pointed at a card in a
     hand, say), it is blanked. */
  const secret = new Set();
  g.players.forEach(p=>{
    p.deck.forEach(c=>secret.add(c.uid));
    if(p.idx!==seat && p.idx!==shownHand) p.hand.forEach(c=>secret.add(c.uid));
  });
  (function scrub(o){
    for(const k in o){
      const x = o[k];
      if(typeof x==='string'){ if(secret.has(x)) o[k] = null; }
      else if(x && typeof x==='object') scrub(x);
    }
  })(v);
  v.viewer = seat;
  v.isView = true;
  return v;
}

/** Record something that happened, for a screen to animate (and, online, for
    the devices to replay in order). Events are numbered; `vis` limits who
    hears about one. The last few hundred are kept. */
function emit(k, data){
  if(!G || !G.events || G.isView) return null;
  const e = Object.assign({n: ++G.eventN, k, round:G.round}, data||{});
  G.events.push(e);
  if(G.events.length > 400) G.events.splice(0, G.events.length - 400);
  return e;
}

/** Everything that decides the game, as text: two games in the same state
    give the same string. Used to check a replay matches the original. */
function stateDigest(g){
  g = g || G;
  const skip = ['log','events','eventN','botRng','cmdLog','epoch','hold','flipping','dice'];
  return JSON.stringify(g, function(k, val){ return (this===g && skip.includes(k)) ? undefined : val; });
}

/* ------------------------------------------------------------------
   5. ABILITY ENGINE
   A card's abilities are a list of effects that resolve in order. Anything
   that needs a person to decide pauses (G.choice) and resumes from the same
   place. Located cards are passed around as
     {card, zone:'board'|'hand'|'grave', playerIdx, planetIdx?, slotIdx?}.
   Face-down cards don't exist as far as abilities are concerned: no pool,
   group, count or "last card played" ever includes one.
   ------------------------------------------------------------------ */

function cardsOnPlanet(planetIdx, filter){
  if(planetIdx==null || !G.planets[planetIdx]) return [];
  const out = [];
  G.planets[planetIdx].board.forEach((row,pi)=>row.forEach((card,si)=>{
    if(card && card.faceUp && (!filter || filter(card,pi,si))) out.push({card, zone:'board', playerIdx:pi, planetIdx, slotIdx:si});
  }));
  return out;
}

/** Find a card on any planet by uid, face up or not. */
function locate(uid){
  if(!uid) return null;
  for(let pi=0; pi<G.planets.length; pi++){
    const board = G.planets[pi].board;
    for(let p=0; p<board.length; p++){
      const si = board[p].findIndex(c=>c && c.uid===uid);
      if(si>=0) return {card:board[p][si], zone:'board', playerIdx:p, planetIdx:pi, slotIdx:si};
    }
  }
  return null;
}

/** The ability's own card, wherever it is now (it may have moved, or gone). */
/** This card wherever it is — a hand or the graveyard, for a passive. */
function selfAnywhere(ctx){
  if(!ctx.uid) return null;
  for(const p of G.players){ const c = p.hand.find(x=>x.uid===ctx.uid); if(c) return {card:c, zone:'hand', playerIdx:p.idx}; }
  const g = G.grave.find(x=>x.uid===ctx.uid);
  return g ? {card:g, zone:'grave'} : null;
}
function selfOf(ctx){
  if(ctx.uid) return locate(ctx.uid);
  if(ctx.planetIdx==null) return null;
  const c = G.planets[ctx.planetIdx].board[ctx.owner][ctx.slotIdx];
  return c ? {card:c, zone:'board', playerIdx:ctx.owner, planetIdx:ctx.planetIdx, slotIdx:ctx.slotIdx} : null;
}

const nameOf = o => o.card.faceUp ? o.card.name : 'a face-down card';
const isBot = idx => G.players[idx] && G.players[idx].kind==='bot';
const othersOf = idx => G.players.map(p=>p.idx).filter(i=>i!==idx);
function fail(){ G.fxLastSuccess = false; return 'ok'; }
function succeed(){ G.fxLastSuccess = true; return 'ok'; }
/** Carry on after a pause (a choice, a beam): first let whatever that step
    set moving finish, so the next effect's animations don't overlap it. */
function continueAfter(r){
  if(r==='pause'){ render(); return; }
  if(animOn()){
    render();
    const t = fxIdleIn();
    if(t > 0){
      UI.animLock = true;
      const game = G, epoch = G.epoch;
      setTimeout(()=>{ if(G!==game || G.epoch!==epoch) return; UI.animLock = false; processQueue(); }, t + 20);
      return;
    }
  }
  processQueue();
}

/* --- conditions and filters -------------------------------------------- */

function compare(a, op, b, b2){
  switch(op){
    case '<=': return a<=b; case '>=': return a>=b; case '==': return a===b; case '<': return a<b; case '>': return a>b;
    case 'between': return a>=Math.min(b,b2) && a<=Math.max(b,b2);
  }
  return false;
}
/** The right-hand side of a condition or filter: a number, or a value read from the game. */
function rhs(spec, ctx){ return spec.valFrom ? resolveAmount({nFrom:spec.valFrom}, ctx) : (+spec.val||0); }
function rhs2(spec, ctx){ return spec.valFrom2 ? resolveAmount({nFrom:spec.valFrom2}, ctx) : (+spec.val2||0); }

/* Values read off an enemy card here. With no enemy card there, there's
   nothing to read, so a condition or filter that uses one simply fails. */
const ENEMY_CARD_SOURCES = ['enemyMaxPower','enemyMinPower','enemyMaxCost','enemyMinCost'];
const readsEnemyCard = spec => !!spec && [spec.src, spec.valFrom, spec.valFrom2].some(k=>ENEMY_CARD_SOURCES.includes(k));
const noEnemyHere = ctx => cardsOnPlanet(ctx.planetIdx,(c,pi)=>pi!==ctx.owner).length===0;

/** An effect's condition, read as it comes up. No condition always holds. */
function condHolds(c, ctx){
  if(!c) return true;
  if(readsEnemyCard(c) && noEnemyHere(ctx)) return false;
  return compare(resolveAmount({nFrom:c.src}, ctx), c.op, rhs(c, ctx), rhs2(c, ctx));
}
/** Why a condition failed, for the log. */
const condWhyNot = (c, ctx) => readsEnemyCard(c) && noEnemyHere(ctx) ? 'there is no enemy card here' : condCore(c)+' isn\u2019t true';
function statOf(card, stat){ return stat==='cost' ? card.cost : stat==='bonus' ? card.bonus : powerOf(card); }
/** The card filter, as a predicate on located cards. No filter lets everything through. */
function passes(f, ctx){
  const only = f && f.only;
  if(only && only.stat==='playedTurn') return o => !!o.card.faceUp && o.card.playedTurn===turnKey();
  if(only && readsEnemyCard(only) && noEnemyHere(ctx)) return () => false;
  return o => !only || compare(statOf(o.card, only.stat), only.op, rhs(only, ctx), rhs2(only, ctx));
}

/* --- group targets (every matching card at once) ----------------------- */

function resolveTargets(t, ctx, f){
  const me = ctx.owner, here = ctx.planetIdx;
  const keep = passes(f, ctx);
  const self = selfOf(ctx);
  const selfUid = self ? self.card.uid : null;
  const enemies = () => cardsOnPlanet(here,(c,pi)=>pi!==me).filter(keep);
  switch(t){
    case 'self': return (self && self.card.faceUp) ? [self].filter(keep) : [];
    case 'alliesHere': return cardsOnPlanet(here,(c,pi)=>pi===me && c.uid!==selfUid).filter(keep);
    case 'yoursHere':  return cardsOnPlanet(here,(c,pi)=>pi===me).filter(keep);
    case 'enemiesHere':return enemies();
    case 'randomEnemyHere':   { const o = pickBy('random',    enemies()); return o ? [o] : []; }
    case 'weakestEnemyHere':  { const o = pickBy('weakest',   enemies()); return o ? [o] : []; }
    case 'strongestEnemyHere':{ const o = pickBy('strongest', enemies()); return o ? [o] : []; }
    case 'yoursElsewhere':{
      const out = [];
      G.planets.forEach((pl,pi)=>{ if(pi!==here) out.push(...cardsOnPlanet(pi,(c,p)=>p===me)); });
      return out.filter(keep);
    }
    case 'yoursAll':{
      const out = [];
      G.planets.forEach((pl,pi)=>out.push(...cardsOnPlanet(pi,(c,p)=>p===me)));
      return out.filter(keep);
    }
    case 'creator':{
      /* The card whose Create or Summon made this token — if it's still face up on a planet. */
      const mine = self || selfAnywhere(ctx);
      const o = mine && mine.card.creator ? locate(mine.card.creator) : null;
      return (o && o.card.faceUp) ? [o].filter(keep) : [];
    }
  }
  return [];
}

/* --- pools, one per zone, each narrowed by the effect's filter ----------- */

function boardPool(ownerIdx, ctx, hereOnly, f){
  const keep = passes(f, ctx);
  if(hereOnly) return cardsOnPlanet(ctx.planetIdx, (c,pi)=>pi===ownerIdx).filter(keep);
  const out = [];
  G.planets.forEach((pl,pi)=> out.push(...cardsOnPlanet(pi, (c,p)=>p===ownerIdx)));
  return out.filter(keep);
}
const cardPoolFor = boardPool;          // the name an earlier build used
function handPool(ownerIdx, f, ctx){
  const all = G.players[ownerIdx].hand.map(card=>({card, zone:'hand', playerIdx:ownerIdx}));
  return ctx ? all.filter(passes(f, ctx)) : all;
}
function gravePool(spec, ctx, f){
  const who = (spec && spec.owner) || 'any';
  return G.grave
    .filter(c => who==='any' || (who==='yours' ? c.owner===ctx.owner : c.owner!==ctx.owner))
    .map(card=>({card, zone:'grave', playerIdx:card.owner}))
    .filter(passes(f, ctx));
}

/** Settle on one entry by a fixed rule. undefined means "a person decides". */
function pickBy(rule, pool){
  if(!pool.length) return null;
  const by = (fn, dir)=>{ const m = Math[dir](...pool.map(o=>fn(o.card))); return pick(pool.filter(o=>fn(o.card)===m)); };
  switch(rule){
    case 'strongest':   return by(powerOf, 'max');
    case 'weakest':     return by(powerOf, 'min');
    case 'lowestCost':  return by(c=>c.cost, 'min');
    case 'highestCost': return by(c=>c.cost, 'max');
    case 'random':      return pick(pool);
  }
  return undefined;
}

/* --- amounts and "that card" -------------------------------------------- */

const snap = c => ({cost:c.cost, power:powerOf(c), bonus:c.bonus, uid:c.uid});

/** Record what an effect touched, so a later effect can say "that card's
    Power". Several cards add up. An effect that touched nothing leaves the
    previous record alone. */
function remember(ctx, snaps){
  snaps = (snaps||[]).filter(Boolean);
  if(!snaps.length) return;
  ctx.memo = snaps.reduce((m,x)=>({cost:m.cost+x.cost, power:m.power+x.power, bonus:m.bonus+x.bonus,
                                    count:m.count+1, uids:m.uids.concat(x.uid ? [x.uid] : [])}),
                         {cost:0, power:0, bonus:0, count:0, uids:[]});
}

/** A fixed amount, or one read live from the game. `o` is this effect's own
    target when it has one, for the "its own …" sources. */
function resolveAmount(f, ctx, o){
  const src = LEGACY_SOURCES[f.nFrom] || f.nFrom;
  if(!src) return f.n||0;
  const me = G.players[ctx.owner];
  const m = ctx.memo || {cost:0, power:0, bonus:0};
  let v = 0;
  switch(src){
    case 'grave':       v = G.grave.length; break;
    case 'hand':        v = me.hand.length; break;
    case 'energy':      v = me.energy; break;
    case 'deck':        v = me.deck.length; break;
    case 'round':       v = G.round; break;
    case 'yoursHere':   v = cardsOnPlanet(ctx.planetIdx,(c,pi)=>pi===ctx.owner).length; break;
    case 'enemiesHere': v = cardsOnPlanet(ctx.planetIdx,(c,pi)=>pi!==ctx.owner).length; break;
    case 'leading':     v = G.planets.filter(pl=>{
                          const sc = planetScore(pl), mine = sc[ctx.owner];
                          return mine>0 && sc.every((x,i)=>i===ctx.owner || x<mine);
                        }).length; break;
    case 'tgtCost':     v = o ? o.card.cost      : m.cost;  break;
    case 'tgtPower':    v = o ? powerOf(o.card)  : m.power; break;
    case 'tgtBonus':    v = o ? o.card.bonus     : m.bonus; break;
    case 'prevCost':    v = m.cost;  break;
    case 'prevPower':   v = m.power; break;
    case 'prevBonus':   v = m.bonus; break;
    case 'prevCount':   v = m.count||0; break;
    case 'selfPower':   { const me = selfOf(ctx) || selfAnywhere(ctx); v = me ? powerOf(me.card) : 0; break; }
    case 'selfCost':    { const me = selfOf(ctx) || selfAnywhere(ctx); v = me ? me.card.cost : 0; break; }
    case 'enemyMaxPower': case 'enemyMinPower': case 'enemyMaxCost': case 'enemyMinCost': {
      /* Every face-up enemy card on this card's planet. No enemies: 0. */
      const foes = cardsOnPlanet(ctx.planetIdx,(c,pi)=>pi!==ctx.owner).map(o=>/Cost$/.test(src) ? o.card.cost : powerOf(o.card));
      v = !foes.length ? 0 : /Max/.test(src) ? Math.max(...foes) : Math.min(...foes);
      break;
    }
    case 'all':         v = o ? o.card.bonus : 0; break;
    default:            return f.n||0;
  }
  return Math.max(0, v);             // a count or a stat is never negative
}

/* --- the queue ------------------------------------------------------------ */

/* An item is {f, ctx}. `reset` starts a fresh chain (a new package of
   effects); `restore` puts the chain state back after something ran in the
   middle of ours (a summoned card's ability, a passive trigger, a chosen
   option); `fixedUid` is a "next card played" effect whose card has now
   been settled. G.fxAfter says what happens when the queue empties: the
   reveal carries on ('flip', the default), or normal play resumes ('resume'). */
function runAbility(card, ctx, prefix, when){
  const own = (card.fx||[]).filter(f=>whenOf(f)===(when||'reveal')).map(f=>({f, ctx}));
  if(own.length) own[0].reset = true;
  G.fxQueue = (prefix||[]).concat(own);
  G.fxAfter = null;
  G.fxLastSuccess = true;
  G.fxGateNext = false;
  G.trigCount = 0;
  processQueue();
}

/* An effect flagged `.then` gates the NEXT effect: if it didn't actually do
   anything, the next one is skipped outright — "'Verb 1' in order to 'Verb 2'".
   A skip counts as failure, so a chain stops at its first broken link. An
   effect whose condition isn't met counts as not working, too. */
function processQueue(){
  for(;;){
    /* Passive abilities set off by the last effect run now, before the next
       one, and then the chain carries on exactly where it was. */
    if(G.trigBuf && G.trigBuf.length){
      const buf = G.trigBuf; G.trigBuf = [];
      G.fxQueue = buf.concat([{restore:{gate:G.fxGateNext, last:G.fxLastSuccess}}], G.fxQueue||[]);
    }
    if(!G.fxQueue || !G.fxQueue.length) break;
    const item = G.fxQueue.shift();
    if(item.restore){ G.fxGateNext = item.restore.gate; G.fxLastSuccess = item.restore.last; continue; }
    const {f, ctx} = item;
    if(item.reset) G.fxGateNext = false;
    if(G.fxGateNext && !G.fxLastSuccess){
      G.fxGateNext = !!f.then;
      G.fxLastSuccess = false;
      continue;
    }
    G.fxGateNext = !!f.then;          // set before running — a pause relies on it
    if(f.if && !condHolds(f.if, ctx)){
      say(`“${verbPhrase(f, true)}” doesn’t fire — ${condWhyNot(f.if, ctx)}.`, ctx.owner);
      G.fxLastSuccess = false;
      continue;
    }
    let r;
    if(item.fixedUid){
      const o = locate(item.fixedUid);
      r = (o && o.card.faceUp && passes(f, ctx)(o)) ? actOnCards(f, ctx, [o]) : fail();
    }else r = applyEffect(f, ctx);
    if(r==='pause'){ render(); return; }
    /* One effect's animations finish before the next effect starts. Cards
       hit by the same effect move together; the next effect waits its turn. */
    if(animOn()){
      render();
      const t = fxIdleIn();
      if(t > 0){
        UI.animLock = true;
        const game = G, epoch = G.epoch;
        setTimeout(()=>{ if(G!==game || G.epoch!==epoch) return; UI.animLock = false; processQueue(); }, t + 20);
        return;
      }
    }
  }
  G.fxQueue = null;
  const after = G.fxAfter || 'flip';
  G.fxAfter = null;
  G.trigCount = 0;
  if(after==='flip') afterFlip();
  else if(after==='roundover') endOfRoundContinue();
  else afterStateChange();
}

/** Put a card's own on-reveal ability in front of what's left of ours, then
    carry on with our chain exactly where it was. */
function queueOwnAbility(card, ctx){
  const fx = (card.fx||[]).filter(f=>whenOf(f)==='reveal');
  if(!fx.length) return;
  const sub = fx.map(f=>({f:migrateFx(f), ctx}));
  sub[0].reset = true;
  sub.push({restore:{gate:G.fxGateNext, last:true}});
  G.fxQueue = sub.concat(G.fxQueue||[]);
}

/* --- passive abilities ---------------------------------------------------- */

const TRIGGER_CAP = 250;

/** Something happened to this card (or to the graveyard it watches): queue
    whatever it has to say about it. It runs after the effect that caused it. */
function fireTrigger(card, when, ctx){
  if(!G || !card) return;
  const fx = (card.fx||[]).filter(f=>whenOf(f)===when);
  if(!fx.length) return;
  G.trigCount = (G.trigCount||0) + 1;
  if(G.trigCount > TRIGGER_CAP){
    if(G.trigCount===TRIGGER_CAP+1) say('Abilities keep setting each other off — the rest are skipped this time.');
    return;
  }
  const items = fx.map(f=>({f:migrateFx(f), ctx}));
  items[0].reset = true;
  say(`${card.name}: ${WHEN[when].label.toLowerCase()}.`, ctx.owner);
  (G.trigBuf = G.trigBuf || []).push(...items);
  if(!G.fxQueue){                      // nothing running: open a queue of its own
    G.fxQueue = []; G.fxAfter = G.fxAfter || 'resume';
    setTimeout(()=>{ if(G && G.fxQueue && !G.choice) processQueue(); }, 0);
  }
}

/** Every face-up card on a planet that watches the graveyard. */
function graveWatchers(when, card){
  G.planets.forEach((pl,pi)=>pl.board.forEach((row,p)=>row.forEach((c,si)=>{
    if(c && c.faceUp && c!==card) fireTrigger(c, when, {owner:p, planetIdx:pi, slotIdx:si, uid:c.uid});
  })));
}

/* --- "the next card played" and "the last card played" ------------------- */

const isPrev = k => !!k && /^prev/.test(k);
/** Does this effect read "that card" — the card the effect before it touched? */
const readsThatCard = f => isPrev(f.nFrom) || (f.if && (isPrev(f.if.src) || isPrev(f.if.valFrom))) || (f.only && isPrev(f.only.valFrom));

/** Park an effect until the player in question next turns a card over — this
    round or a later one. Whatever depends on it waits with it: an "in order
    to" chain hanging off it, and any effect right after it that reads "that
    card", which can only mean the card it is waiting for. */
function registerNext(f, ctx, forIdx, T){
  const tail = [];
  let link = !!f.then;
  while(G.fxQueue && G.fxQueue.length){
    const it = G.fxQueue[0];
    if(it.reset || it.restore || it.fixedUid) break;
    if(!link && !readsThatCard(it.f)) break;
    G.fxQueue.shift();
    tail.push(it.f);
    link = !!it.f.then;
  }
  G.fxGateNext = false;               // nothing left behind is gated by what was parked
  T = T || f.target || {};
  const standing = T.rule==='thisRound';     // hits every card they play for the rest of this round
  G.pending.push({
    forIdx, planetIdx: T.here ? ctx.planetIdx : null, until: standing ? G.round : null,
    f, tail, ctx:{owner:ctx.owner, planetIdx:ctx.planetIdx, slotIdx:ctx.slotIdx, uid:ctx.uid}
  });
  const where = T.here&&ctx.planetIdx!=null ? ' on '+G.planets[ctx.planetIdx].name : '';
  say(standing ? `For the rest of this round, an effect hits every card ${G.players[forIdx].name} plays${where}.`
               : `An effect is waiting for ${G.players[forIdx].name}’s next card${where}.`, ctx.owner);
  return succeed();
}

/** Called as a card is played: hand back everything waiting for it. */
function takePendingFor(playerIdx, planetIdx, uid){
  const out = [];
  G.pending = G.pending.filter(pk=>{
    if(pk.until!=null && pk.until!==G.round) return false;       // a "this round" effect from an earlier round
    if(pk.forIdx!==playerIdx) return true;
    if(pk.planetIdx!=null && pk.planetIdx!==planetIdx) return true;
    if(pk.ctx.uid && pk.ctx.uid===uid) return true;               // never the card that set it up
    const ctx = Object.assign({}, pk.ctx, {memo:null});
    out.push({f:pk.f, ctx, reset:true, fixedUid:uid});
    pk.tail.forEach(f=>out.push({f, ctx}));
    return pk.until!=null;                                          // a standing effect stays for the next card
  });
  return out;
}

/** The card that player most recently turned over, if it is still face up on
    a planet (and passes the effect's filter). */
function lastPlayed(forIdx, ctx, hereOnly, f){
  for(let i=G.plays.length-1; i>=0; i--){
    const pl = G.plays[i];
    if(pl.playerIdx!==forIdx || pl.uid===ctx.uid) continue;
    if(hereOnly && pl.planetIdx!==ctx.planetIdx) continue;
    const o = locate(pl.uid);
    return (o && o.card.faceUp && o.playerIdx===forIdx && passes(f, ctx)(o)) ? o : null;
  }
  return null;
}

/* --- applying an effect --------------------------------------------------- */

const handSpec = f => {
  const T = f.target || {player:'self', rule:'choice'};
  return (f.v==='steal' && T.player==='self') ? Object.assign({}, T, {player:'choose'}) : T;
};

function applyEffect(f, ctx){
  migrateFx(f);
  const p = G.players[ctx.owner];

  if(BOARD_VERBS.includes(f.v) && !(f.v==='steal' && f.what==='card')){
    if(f.target) return settlePlayer(f, ctx, f.target, 'board');
    /* "All of an opponent's cards here": one opponent's cards, not every
       opponent's — the caster picks whose when there's more than one. */
    if(f.t==='enemiesHere') return settlePlayer(f, ctx, {player:'choose', here:true, rule:'all'}, 'board');
    return actOnCards(f, ctx, resolveTargets(f.t||'self', ctx, f));
  }

  switch(f.v){
    case 'steal':    return settlePlayer(f, ctx, handSpec(f), 'hand');      // a card from a hand
    case 'discard':  return settlePlayer(f, ctx, handSpec(f), 'hand');
    case 'choose':   return beginChoose(f, ctx);
    case 'summon':   return settlePlayer(f, ctx, {player:f.side||'self'}, 'side');
    case 'draw':{
      if(f.from==='grave') return graveTake(f, ctx, null);
      const n = resolveAmount(f, ctx);
      const got = [];
      for(let i=0;i<n;i++){ const c = drawCard(p, true); if(c) got.push(snap(c)); }
      say(got.length ? `${p.name} draws ${got.length}.` : `${p.name} has no cards left to draw.`, ctx.owner);
      remember(ctx, got);
      return got.length ? succeed() : fail();
    }
    case 'gainEnergy':{
      const n = resolveAmount(f, ctx);
      p.energy += n;
      fxEnergy(ctx.owner, n, {uid: ctx.uid});
      say(`${p.name} gains ${n} Energy.`, ctx.owner);
      return n>0 ? succeed() : fail();
    }
    case 'create':{
      const def = defById(f.tok);
      const n = resolveAmount(f, ctx);
      if(!def || n<=0) return fail();
      const made = [];
      for(let i=0;i<n;i++){ const c = instance(def, ctx.owner); c.creator = ctx.uid || null; c.creatorName = creatorNameOf(ctx); p.hand.push(c); fxArrive(c, 'draw'); made.push(snap(c)); }
      say(`${p.name} creates ${n} ${def.name}.`, ctx.owner);
      remember(ctx, made);
      return succeed();
    }
  }
  return fail();
}

/* ------------------------------------------------------------------
   5b. PICKING ONE CARD
   verb -> whose (yourself / choose another / random) -> which card, in
   whichever zone the verb reaches into. Each stage settles at once when it
   can; a person choosing between two or more real options pauses. Bots never
   pause — they pick at random.
   ------------------------------------------------------------------ */

/** Stage 1: whose cards (or, for a summon, whose side). */
function settlePlayer(f, ctx, T, zone){
  const caster = ctx.owner;
  if(T.player==='self') return settleCard(f, ctx, caster, zone, T);
  const others = othersOf(caster);
  if(!others.length) return fail();
  if(T.player==='random') return settleCard(f, ctx, pick(others), zone, T);

  /* "Choose another": only offer players there is something to aim at. A
     card someone has yet to play always counts. */
  const live = others.filter(i=>{
    if(zone==='side') return summonPlanets(f, ctx, i).length>0;
    if(zone==='hand') return handPool(i, f, ctx).length>0;
    if(T.rule==='next' || T.rule==='thisRound') return true;
    if(T.rule==='last') return !!lastPlayed(i, ctx, T.here, f);
    return boardPool(i, ctx, T.here, f).length>0;
  });
  if(!live.length) return fail();
  if(live.length===1) return settleCard(f, ctx, live[0], zone, T);
  if(isBot(caster)) return settleCard(f, ctx, pick(live), zone, T);
  G.choice = {kind:'pickplayer', owner:caster, options:live, f, ctx, zone, T};
  return 'pause';
}

function settleCard(f, ctx, ownerIdx, zone, T){
  if(zone==='hand') return takeFromHand(f, ctx, ownerIdx, T);
  if(zone==='side') return summonAt(f, ctx, ownerIdx);
  return resolveCardTarget(f, ctx, ownerIdx, T);
}

function resolvePickPlayer(ownerIdx){
  const ch = G.choice;
  if(!ch || ch.kind!=='pickplayer' || !ch.options.includes(ownerIdx)) return;
  G.choice = null;
  continueAfter(settleCard(ch.f, ch.ctx, ownerIdx, ch.zone||'board', ch.T || ch.f.target));
}

/** Stage 2, on a planet: which of that player's cards. */
function resolveCardTarget(f, ctx, ownerIdx, T){
  T = T || f.target;
  if(T.rule==='next' || T.rule==='thisRound') return registerNext(f, ctx, ownerIdx, T);
  if(T.rule==='last'){
    const o = lastPlayed(ownerIdx, ctx, T.here, f);
    return o ? actOnCards(f, ctx, [o]) : fail();
  }
  let pool = boardPool(ownerIdx, ctx, T.here, f);
  /* "A card of your choice" means another card: never the one whose ability it is. */
  if(T.rule==='choice') pool = pool.filter(o=>o.card.uid!==ctx.uid);
  if(!pool.length) return fail();
  if(T.rule==='all') return actOnCards(f, ctx, pool);
  const o = pickBy(T.rule, pool);
  if(o) return actOnCards(f, ctx, [o]);
  if(pool.length===1 || isBot(ctx.owner)) return actOnCards(f, ctx, [pool.length===1 ? pool[0] : pick(pool)]);
  G.choice = {kind:'pickcard', purpose:'board', owner:ctx.owner, verb:f.v, pool, f, ctx};
  return 'pause';
}

const finishTargetedVerb = (f, ctx, o) => actOnCards(f, ctx, [o]);   // kept for older tests

function resolvePickCard(uid){
  const ch = G.choice;
  if(!ch || ch.kind!=='pickcard') return;
  const o = ch.pool.find(x=>x.card.uid===uid);
  G.choice = null;
  if(!o){ G.fxLastSuccess = false; processQueue(); return; }
  if(ch.purpose==='grave'){ continueAfter(graveChosen(ch, o)); return; }
  if(ch.purpose==='swap'){
    ch.moved.push(...swapPair(locate(ch.mover.card.uid) || ch.mover, o, ch.ctx));
    continueAfter(doSwap(ch.f, ch.ctx, ch.list, ch.destIdx, ch.k+1, ch.moved));
    return;
  }
  continueAfter(actOnCards(ch.f, ch.ctx, [o]));
}

/* --- what each board verb does to the cards it settled on ----------------- */

function removeFromBoard(o){
  G.planets[o.planetIdx].board[o.playerIdx][o.slotIdx] = null;
  const owner = G.players[o.playerIdx];
  const rec = owner.placed.findIndex(r=>r.uid===o.card.uid);
  if(rec>=0){ owner.placed.splice(rec,1); owner.planned -= o.card.cost; }
}

/** Burn takes from bonus Power first, then from base Power, and never more
    than the card actually has. Returns how much was removed. */
function burnCard(card, n){
  n = Math.min(Math.max(0,n), powerOf(card));
  const fromBonus = Math.min(n, Math.max(0, card.bonus));
  card.bonus -= fromBonus;
  const fromBase = Math.min(n - fromBonus, Math.max(0, card.base));
  card.base -= fromBase;
  return fromBonus + fromBase;
}

function actOnCards(f, ctx, list){
  list = (list||[]).filter(Boolean);
  if(!list.length) return fail();
  return withBeams(ctx, list.map(o=>o.card.uid), ()=>actOnCardsNow(f, ctx, list));
}
function actOnCardsNow(f, ctx, list){
  switch(f.v){
    case 'givePower':{
      const after = [], gave = [];
      list.forEach(o=>{ const n = resolveAmount(f, ctx, o); o.card.bonus += n; gave.push(n); after.push(snap(o.card)); });
      const sign = n => (n>0?'+':'')+n;
      say(list.length===1 ? `${nameOf(list[0])} gets ${sign(gave[0])} Power.`
                          : `${list.length} cards get ${gave.every(n=>n===gave[0]) ? sign(gave[0]) : 'their'} Power.`, ctx.owner);
      if(!f._noMemo) remember(ctx, after);
      return succeed();
    }
    case 'burn':{
      let total = 0;
      list.forEach(o=>{ total += burnCard(o.card, resolveAmount(f, ctx, o)); });
      remember(ctx, list.map(o=>snap(o.card)));
      say(total ? `${list.length===1?nameOf(list[0]):list.length+' cards'} lose${list.length===1?'s':''} ${total} Power.` : 'Nothing to burn.', ctx.owner);
      return total>0 ? succeed() : fail();
    }
    case 'destroy':{
      const before = list.map(o=>snap(o.card));
      list.forEach(o=>{
        fxVanish(o.card);
        removeFromBoard(o);
        say(`${o.card.name} is destroyed on ${G.planets[o.planetIdx].name}.`, ctx.owner);
        fireTrigger(o.card, 'destroyed', {owner:o.playerIdx, planetIdx:o.planetIdx, slotIdx:o.slotIdx, uid:o.card.uid});
        toGrave(o.card);
      });
      remember(ctx, before);
      return succeed();
    }
    case 'recall':{
      const before = list.map(o=>snap(o.card));
      list.forEach(o=>{
        removeFromBoard(o);
        resetCard(o.card);
        o.card.faceUp = false;
        const owner = G.players[o.playerIdx];
        owner.hand.push(o.card);
        say(`${o.card.name} is recalled to ${owner.name}'s hand.`, ctx.owner);
      });
      remember(ctx, before);
      return succeed();
    }
    case 'move':  return moveCards(f, ctx, list);
    case 'steal': return stealFrom(f, ctx, list);
  }
  return fail();
}

/* --- Move ------------------------------------------------------------------ */

/** Planets the cards could go to: never somewhere every one of them already
    is, and only with a free slot on the owner's side for at least one. */
function moveCandidates(list, swap){
  /* Somewhere else with room — or, for a swap, a face-up card of the same
     player's to trade places with. */
  return G.planets.map((pl,pi)=>pi).filter(pi=>
    list.some(o=> o.planetIdx!==pi && (G.planets[pi].board[o.playerIdx].indexOf(null)>=0
      || (swap && cardsOnPlanet(pi,(c,p)=>p===o.playerIdx).length>0))));
}

function moveCards(f, ctx, list){
  const dest = f.dest || 'here';
  let options = moveCandidates(list, !!f.swap);
  if(dest==='here') options = options.filter(pi=>pi===ctx.planetIdx);
  if(!options.length){ say('There is nowhere to move it.', ctx.owner); return fail(); }
  if(dest==='choice' && options.length>1 && !isBot(ctx.owner)){
    G.choice = {kind:'pickplanet', purpose:'move', owner:ctx.owner, options, f, ctx, list};
    return 'pause';
  }
  return doMove(f, ctx, list, dest==='here' ? options[0] : pick(options));
}

function doMove(f, ctx, list, destIdx){
  if(f.swap) return doSwap(f, ctx, list, destIdx, 0, []);
  const moved = [];
  list.forEach(o=>{
    if(o.planetIdx===destIdx) return;
    const row = G.planets[destIdx].board[o.playerIdx];
    const free = row.indexOf(null);
    if(free<0) return;
    fxSlideStart(o.card);
    G.planets[o.planetIdx].board[o.playerIdx][o.slotIdx] = null;
    row[free] = o.card;                               // bonus Power travels with it
    const rec = G.players[o.playerIdx].placed.find(r=>r.uid===o.card.uid);
    if(rec){ rec.planetIdx = destIdx; rec.slotIdx = free; }
    if(ctx.uid && o.card.uid===ctx.uid){ ctx.planetIdx = destIdx; ctx.slotIdx = free; }   // "here" follows this card
    say(`${nameOf(o)} moves to ${G.planets[destIdx].name}.`, ctx.owner);
    moved.push(snap(o.card));
  });
  remember(ctx, moved);
  return moved.length ? succeed() : fail();
}

/** Swap: each card goes to the destination and a face-up card of the same
    player's there comes back to the slot it left. With several to choose from,
    the caster picks (a bot picks at random); with none, it's a plain move if
    there's room. `k` and `moved` carry the work across a pause. */
function doSwap(f, ctx, list, destIdx, k, moved){
  for(; k<list.length; k++){
    const cur = locate(list[k].card.uid);
    if(!cur || cur.planetIdx===destIdx) continue;
    const partners = cardsOnPlanet(destIdx,(c,p)=>p===cur.playerIdx).filter(x=>!list.some(l=>l.card.uid===x.card.uid));
    if(!partners.length){ const s = moveOneTo(cur, destIdx, ctx); if(s) moved.push(s); continue; }
    if(partners.length>1 && !isBot(ctx.owner)){
      G.choice = {kind:'pickcard', purpose:'swap', owner:ctx.owner, verb:'swap', pool:partners, f, ctx, list, k, moved, destIdx, mover:cur};
      return 'pause';
    }
    moved.push(...swapPair(cur, partners.length>1 ? pick(partners) : partners[0], ctx));
  }
  remember(ctx, moved.filter(s=>list.some(l=>l.card.uid===s.uid)));
  return moved.length ? succeed() : fail();
}
function moveOneTo(o, destIdx, ctx){
  const row = G.planets[destIdx].board[o.playerIdx];
  const free = row.indexOf(null);
  if(free<0) return null;
  fxSlideStart(o.card);
  G.planets[o.planetIdx].board[o.playerIdx][o.slotIdx] = null;
  row[free] = o.card;
  followCard(o.card, o.playerIdx, destIdx, free, ctx);
  say(`${nameOf(o)} moves to ${G.planets[destIdx].name}.`, ctx.owner);
  return snap(o.card);
}
/** Trade the two cards' slots. Both keep their bonus Power. */
function swapPair(a, b, ctx){
  fxSlideStart(a.card); fxSlideStart(b.card);
  const ra = G.planets[a.planetIdx].board[a.playerIdx], rb = G.planets[b.planetIdx].board[b.playerIdx];
  ra[a.slotIdx] = b.card; rb[b.slotIdx] = a.card;
  followCard(a.card, a.playerIdx, b.planetIdx, b.slotIdx, ctx);
  followCard(b.card, b.playerIdx, a.planetIdx, a.slotIdx, ctx);
  say(`${nameOf(a)} and ${nameOf(b)} swap places: ${G.planets[b.planetIdx].name} \u21C4 ${G.planets[a.planetIdx].name}.`, ctx.owner);
  return [snap(a.card), snap(b.card)];
}
/** Keep the placement record and "here" pointing at a card that moved. */
function followCard(card, playerIdx, planetIdx, slotIdx, ctx){
  const rec = G.players[playerIdx].placed.find(r=>r.uid===card.uid);
  if(rec){ rec.planetIdx = planetIdx; rec.slotIdx = slotIdx; }
  if(ctx.uid && card.uid===ctx.uid){ ctx.planetIdx = planetIdx; ctx.slotIdx = slotIdx; }
}

function resolvePickPlanet(pi){
  const ch = G.choice;
  if(!ch || ch.kind!=='pickplanet' || !ch.options.includes(pi)) return;
  G.choice = null;
  continueAfter(ch.purpose==='summon' ? summonInto(ch.f, ch.ctx, ch.side, pi) : doMove(ch.f, ch.ctx, ch.list, pi));
}

/* --- Steal Power ----------------------------------------------------------- */

/** Is there anything for the stolen Power to go to? Checked before taking
    it, so Power is never stolen into thin air. */
function recipientAvailable(f, ctx){
  const to = f.to;
  if(!to || to==='self'){ const me = selfOf(ctx); return !!(me && me.card.faceUp); }
  if(to.rule==='next') return true;
  const players = to.player==='self' ? [ctx.owner] : othersOf(ctx.owner);
  return players.some(i => to.rule==='last' ? !!lastPlayed(i, ctx, to.here)
    : boardPool(i, ctx, to.here).filter(o=>to.rule!=='choice' || o.card.uid!==ctx.uid).length>0);
}

/** Take bonus Power — only bonus, never base — from each source, then hand
    the total to the recipient through an ordinary Give Power. */
function stealFrom(f, ctx, list){
  if(!recipientAvailable(f, ctx)){ say('There is nothing to give the stolen Power to.', ctx.owner); return fail(); }
  const before = list.map(o=>snap(o.card));
  let taken = 0;
  list.forEach(o=>{
    const want = f.nFrom || f.n!=null ? resolveAmount(f, ctx, o) : Math.max(0, o.card.bonus);
    const take = Math.min(want, Math.max(0, o.card.bonus));
    o.card.bonus -= take;
    taken += take;
  });
  if(!taken){ say('There is no bonus Power to steal.', ctx.owner); return fail(); }
  remember(ctx, before);
  say(`${taken} bonus Power is stolen.`, ctx.owner);
  const give = (!f.to || f.to==='self')
    ? {v:'givePower', n:taken, t:'self', _noMemo:true}
    : {v:'givePower', n:taken, target:f.to, _noMemo:true};
  return applyEffect(give, ctx);
}

/* --- Discard and Steal, from any hand -------------------------------------- */

function discardCard(ownerIdx, card){
  const p = G.players[ownerIdx];
  const i = p.hand.indexOf(card);
  if(i<0) return null;
  fxHole(card, p, i);
  fxVanish(card);
  p.hand.splice(i,1);
  const s = snap(card);
  fireTrigger(card, 'discarded', {owner:ownerIdx, planetIdx:null, slotIdx:null, uid:card.uid});
  toGrave(card);
  return s;
}

/** Take a card from someone's hand into yours. It's yours now. */
function stealCard(ctx, ownerIdx, card){
  const victim = G.players[ownerIdx];
  const i = victim.hand.indexOf(card);
  if(i<0) return null;
  victim.hand.splice(i,1);
  card.owner = ctx.owner;
  card.faceUp = false;
  G.players[ctx.owner].hand.push(card);
  return snap(card);
}

const handAct = (f, ctx, ownerIdx, card) => f.v==='steal' ? stealCard(ctx, ownerIdx, card) : discardCard(ownerIdx, card);

function takeFromHand(f, ctx, ownerIdx, T){
  T = T || handSpec(f);
  const victim = G.players[ownerIdx];
  const pool = handPool(ownerIdx, f, ctx);
  const n = Math.min(resolveAmount(f, ctx), pool.length);
  if(n<=0) return fail();
  const act = f.v==='steal' ? 'steal' : 'discard';
  if(T.rule==='choice' && !isBot(ctx.owner) && pool.length>n){
    G.choice = {kind:'discard', act, player:ownerIdx, chooser:ctx.owner, left:n, f, ctx, gone:[]};
    return 'pause';
  }
  /* Settle which cards first, so the beam can point at them; then take them. */
  const picks = [], left = pool.slice();
  for(let i=0;i<n;i++){
    const o = (T.rule==='choice') ? pick(left) : pickBy(T.rule, left);
    if(!o) break;
    picks.push(o); left.splice(left.indexOf(o), 1);
  }
  return withBeams(ctx, picks.map(o=>o.card.uid), ()=>takeFromHandNow(f, ctx, ownerIdx, victim, act, picks));
}
function takeFromHandNow(f, ctx, ownerIdx, victim, act, picks){
  const gone = [];
  picks.forEach(o=>{ const s = handAct(f, ctx, ownerIdx, o.card); if(s) gone.push(s); });
  const caster = G.players[ctx.owner].name;
  say(act==='steal' ? `${caster} steals ${gone.length} from ${victim.name}’s hand.`
                    : `${victim.name} discards ${gone.length}${ownerIdx!==ctx.owner?' ('+caster+'’s ability)':''}.`, ctx.owner);
  remember(ctx, gone);
  return gone.filter(Boolean).length ? succeed() : fail();
}
const discardFrom = takeFromHand;      // the name an earlier build used

function resolveDiscard(uid){
  const ch = G.choice;
  if(!ch || ch.kind!=='discard') return;
  const victim = G.players[ch.player];
  const pool = ch.ctx ? handPool(ch.player, ch.f, ch.ctx) : handPool(ch.player);
  const o = pool.find(x=>x.card.uid===uid);
  if(!o) return;
  const chooser = ch.chooser!=null ? ch.chooser : ch.player;
  const steal = ch.act==='steal';
  const s = steal ? stealCard(ch.ctx, ch.player, o.card) : discardCard(ch.player, o.card);
  (ch.gone = ch.gone||[]).push(s);
  /* which card was stolen is for the two players involved; a discard lands face up for all to see */
  if(steal) say(`${G.players[chooser].name} steals ${o.card.name} from ${victim.name}’s hand.`, chooser, [chooser, ch.player]);
  else say(`${G.players[chooser].name} discards ${o.card.name}${ch.player!==chooser?' from '+victim.name+'’s hand':''}.`, chooser);
  ch.left--;
  const rest = ch.ctx ? handPool(ch.player, ch.f, ch.ctx) : handPool(ch.player);
  if(ch.left<=0 || !rest.length){
    G.choice = null;
    if(ch.ctx) remember(ch.ctx, ch.gone);
    G.fxLastSuccess = true;
    processQueue();
  }else render();
}

/* --- Summon: whose side, which planet, what -------------------------------- */

/** Planets where a summon for this side could land. */
function summonPlanets(f, ctx, sideIdx){
  const roomy = G.planets.map((pl,i)=>i).filter(pi=>G.planets[pi].board[sideIdx].indexOf(null)>=0);
  if((f.at||'here')==='here') return roomy.filter(pi=>pi===ctx.planetIdx);
  return roomy;
}

function summonAt(f, ctx, sideIdx){
  const options = summonPlanets(f, ctx, sideIdx);
  if(!options.length){ say('No room to summon there.', ctx.owner); return fail(); }
  if(f.from==='grave' && !gravePool(f.pick, ctx, f).length) return fail();
  if(f.from==='prev' && !thatCardInHand(ctx)) return fail();
  if(f.at==='choice' && options.length>1 && !isBot(ctx.owner)){
    G.choice = {kind:'pickplanet', purpose:'summon', owner:ctx.owner, options, f, ctx, side:sideIdx};
    return 'pause';
  }
  return summonInto(f, ctx, sideIdx, f.at==='random' ? pick(options) : options[0]);
}

function summonInto(f, ctx, sideIdx, planetIdx){
  const place = {side:sideIdx, planet:planetIdx};
  if(f.from==='grave') return graveTake(f, ctx, place);
  if(f.from==='prev'){
    /* "That card": the card the effect before touched, if it's in a hand now
       (drawn, created, recalled, stolen). It comes out free, face up. */
    const held = thatCardInHand(ctx);
    if(!held) return fail();
    held.player.hand.splice(held.player.hand.indexOf(held.card), 1);
    const s = placeSummoned(held.card, ctx, place);
    if(!s){ held.player.hand.push(held.card); return fail(); }
    remember(ctx, [s]);
    return succeed();
  }
  const def = defById(f.tok);
  if(!def) return fail();
  const tok = instance(def, sideIdx);
  tok.creator = ctx.uid || null;
  tok.creatorName = creatorNameOf(ctx);
  const s = placeSummoned(tok, ctx, place);
  remember(ctx, [s]);
  return s ? succeed() : fail();
}

/** The most recent card "that card" names, if it's sitting in someone's hand. */
function thatCardInHand(ctx){
  const uids = (ctx.memo && ctx.memo.uids) || [];
  for(let i=uids.length-1; i>=0; i--){
    for(const pl of G.players){ const c = pl.hand.find(x=>x.uid===uids[i]); if(c) return {card:c, player:pl}; }
  }
  return null;
}

/** Put a summoned card face up in a free slot on that side of that planet,
    and queue its own on-reveal ability under its new owner. */
function placeSummoned(card, ctx, place){
  const row = G.planets[place.planet].board[place.side];
  const free = row.indexOf(null);
  if(free<0) return null;
  card.owner = place.side;
  card.faceUp = true;
  row[free] = card;
  markInPlay(card);
  fxArrive(card, 'summon');
  const forWhom = place.side===ctx.owner ? '' : ` for ${G.players[place.side].name}`;
  say(`${G.players[ctx.owner].name} summons ${card.name}${forWhom} on ${G.planets[place.planet].name}.`, ctx.owner);
  queueOwnAbility(card, {owner:place.side, planetIdx:place.planet, slotIdx:free, uid:card.uid});
  return snap(card);
}

/* --- Draw / Summon from the graveyard ------------------------------------- */

/** Take one card out of the graveyard: into the taker's hand, or onto a
    planet. Whoever takes it now owns it. */
function takeFromGrave(f, ctx, card, place){
  const i = G.grave.indexOf(card);
  if(i<0) return null;
  if(f.v==='summon'){
    if(!place || G.planets[place.planet].board[place.side].indexOf(null)<0) return null;
    G.grave.splice(i,1);
    resetCard(card);
    const s = placeSummoned(card, ctx, place);
    graveWatchers('graveOut', card);
    return s;
  }
  G.grave.splice(i,1);
  resetCard(card);
  card.owner = ctx.owner;
  card.faceUp = false;
  G.players[ctx.owner].hand.push(card);
  say(`${G.players[ctx.owner].name} takes ${card.name} from the graveyard into hand.`, ctx.owner);
  fireTrigger(card, 'drawn', {owner:ctx.owner, planetIdx:null, slotIdx:null, uid:card.uid});
  graveWatchers('graveOut', card);
  return snap(card);
}

function graveTake(f, ctx, place){
  const spec = f.pick || {owner:'any', rule:'choice'};
  const pool = gravePool(spec, ctx, f);
  const n = Math.min(f.v==='summon' ? 1 : resolveAmount(f, ctx), pool.length);
  if(n<=0) return fail();
  if(spec.rule==='choice' && !isBot(ctx.owner) && pool.length>n){
    G.choice = {kind:'pickcard', purpose:'grave', owner:ctx.owner, verb:f.v, pool, f, ctx, left:n, got:[], place};
    return 'pause';
  }
  const got = [];
  for(let i=0;i<n;i++){
    const now = gravePool(spec, ctx, f);
    const o = spec.rule==='choice' ? pick(now) : pickBy(spec.rule, now);
    if(!o) break;
    const s = takeFromGrave(f, ctx, o.card, place);
    if(s) got.push(s);
  }
  remember(ctx, got);
  return got.length ? succeed() : fail();
}

function graveChosen(ch, o){
  const s = takeFromGrave(ch.f, ch.ctx, o.card, ch.place);
  if(s) ch.got.push(s);
  ch.left--;
  const spec = ch.f.pick || {owner:'any', rule:'choice'};
  const pool = gravePool(spec, ch.ctx, ch.f);
  if(ch.left>0 && pool.length){
    if(pool.length>ch.left){ ch.pool = pool; G.choice = ch; return 'pause'; }
    pool.forEach(x=>{ const s2 = takeFromGrave(ch.f, ch.ctx, x.card, ch.place); if(s2) ch.got.push(s2); });
  }
  remember(ch.ctx, ch.got);
  return ch.got.length ? succeed() : fail();
}

/* --- Choose N of a set ----------------------------------------------------- */

/** Offer the options whose own condition holds. If there are no more of them
    than must be picked, take them all without asking. */
function beginChoose(f, ctx){
  const opts = f.opts || [];
  const live = opts.map((o,i)=>i).filter(i=>condHolds(opts[i].if, ctx));
  if(!live.length) return fail();
  const n = clamp(f.n||1, 1, opts.length);
  if(live.length<=n) return queueOptions(f, ctx, live);
  if(isBot(ctx.owner)) return queueOptions(f, ctx, shuffle(live).slice(0,n).sort((a,b)=>a-b));
  G.choice = {kind:'pickmode', owner:ctx.owner, f, ctx, n, live, picked:[]};
  return 'pause';
}

/** Run the chosen options next, each on its own, then carry on. */
function queueOptions(f, ctx, idxs){
  const items = idxs.map(i=>({f:migrateFx(f.opts[i]), ctx, reset:true}));
  say(`${G.players[ctx.owner].name} chooses: ${idxs.map(i=>verbPhrase(f.opts[i])).join(' / ')}.`, ctx.owner);
  G.fxQueue = items.concat([{restore:{gate:G.fxGateNext, last:true}}], G.fxQueue||[]);
  return succeed();
}

function togglePickMode(i){
  const ch = G.choice;
  if(!ch || ch.kind!=='pickmode' || !ch.live.includes(i)) return;
  const at = ch.picked.indexOf(i);
  if(at>=0) ch.picked.splice(at,1); else ch.picked.push(i);
  if(ch.picked.length>=Math.min(ch.n, ch.live.length)){
    G.choice = null;
    continueAfter(queueOptions(ch.f, ch.ctx, ch.picked.slice().sort((a,b)=>a-b)));
  }else render();
}

/* ------------------------------------------------------------------
   6. BOT  — good enough to test pacing against
   ------------------------------------------------------------------ */

function botAct(seat){
  if(!G || G.over || !botsDrive()) return;
  if(UI.dice || G.hold){ setTimeout(()=>botAct(seat), 120); return; }
  const p = seat!=null ? G.players[seat] : currentPlayer();
  if(!p || p.kind!=='bot') return;
  const send = cmd => dispatch(Object.assign({seat:p.idx}, cmd));     // a bot's moves go in like anyone's

  if(G.phase==='placement'){
    if(!placingSeats().includes(p.idx)) return;
    let guard = 20;
    while(guard-- > 0){
      const playable = p.hand.filter(c=>canPlace(p,c));
      if(!playable.length) break;
      playable.sort((a,b)=> (powerOf(b)/Math.max(1,b.cost)) - (powerOf(a)/Math.max(1,a.cost)));
      let done = false;
      for(const card of playable){
        const spots = [];
        G.planets.forEach((pl,pi)=>pl.board[p.idx].forEach((s,si)=>{
          if(s) return;
          const sc = planetScore(pl);
          const mine = sc[p.idx], best = Math.max(...sc.filter((_,i)=>i!==p.idx), 0);
          let v = slotMet(pi, si, card, p.idx) ? 6 : 0;
          v += (best - mine) * 0.35;            // contest planets we are losing
          v += botRand()*2;
          spots.push({pi,si,v});
        }));
        if(!spots.length) continue;
        spots.sort((a,b)=>b.v-a.v);
        if(send({t:'place', uid:card.uid, p:spots[0].pi, s:spots[0].si}).ok){ done = true; break; }
      }
      if(!done) break;
      if(p.hand.length===0) break;
    }
    send({t:'lock'});
    return;
  }

  if(G.phase==='reveal'){
    if(revealerSeat()!==p.idx) return;
    const rest = faceDownOf(p);
    if(!rest.length){
      /* Everything's face up: use what abilities it can afford, mostly. */
      const ready = readyActs(p);
      if(ready.length && botRand()<0.85){ send({t:'activate', uid:ready[0].card.uid}); return; }
      send({t:'endReveal'});
      return;
    }
    rest.sort((a,b)=>a.card.cost-b.card.cost);
    send({t:'flip', uid:rest[0].card.uid});
  }
}

/* ------------------------------------------------------------------
   6b. ABILITY ANIMATIONS
   Purely visual. The engine pauses for one thing only — the beam, which has
   to land before the ability does anything — and it pauses the same way a
   choice does ('pause', then continueAfter). Everything else is drawn from
   UI.fx state, so a re-render mid-animation picks up where it left off, or
   lives in a fixed overlay (#fxlayer) that rendering never touches.
   Off when the player turns it off, asks the OS for reduced motion, or
   there is no real layout (headless tests).
   ------------------------------------------------------------------ */

const FX_MS = { beam:420, glow:950, tickStep:80, tickHold:260, vanish:760, draw:620, summon:720,
                slide:480, energyFly:1200, energyGap:75, hole:260 };
const freshFx = () => ({ glow:{}, ticks:{}, arrive:{}, seen:{}, slides:{}, energy:{}, held:{}, holes:{}, busyUntil:0 });
UI.fx = freshFx();

/* --- one clock for "is anything still animating?" ------------------------
   Every animation that matters to the order of play pushes busyUntil out.
   The queue waits on it between effects, and turn changes, beats and the
   round screen wait on it before they happen. */
function fxBusyFor(ms){ UI.fx.busyUntil = Math.max(UI.fx.busyUntil||0, Date.now() + ms); }
function fxIdleIn(){ return animOn() ? Math.max(0, (UI.fx.busyUntil||0) - Date.now()) : 0; }
/** Run `cb` once nothing is animating — straight away if nothing is. Input is
    held meanwhile, and a reset or new game cancels it. */
function whenFxIdle(cb){
  const t = fxIdleIn();
  if(!t){ UI.fxWait = false; return cb(); }
  UI.fxWait = true;
  const game = G, epoch = G ? G.epoch : 0;
  setTimeout(()=>{ if(G!==game || (G && G.epoch!==epoch)){ UI.fxWait = false; return; } whenFxIdle(cb); }, t + 20);
}

function animOn(){
  if(LIB && LIB.settings && LIB.settings.anim===false) return false;
  if(typeof window.matchMedia==='function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return false;
  return document.documentElement.getBoundingClientRect().width > 0;
}
function fxLayer(){
  let el = document.getElementById('fxlayer');
  if(!el){ el = document.createElement('div'); el.id = 'fxlayer'; el.setAttribute('aria-hidden','true'); document.body.appendChild(el); }
  return el;
}
function fxReset(){ UI.fx = freshFx(); UI.animLock = false; UI.fxWait = false; UI.roundScreen = null; UI.roundGo = null; UI.dice = null; clearInterval(UI.diceSpin); const l = document.getElementById('fxlayer'); if(l) l.innerHTML = ''; }
/** The face of a card on screen: a board card's mini, or a hand card. */
function cardEl(uid){
  if(!uid) return null;
  return document.querySelector(`#app .mini[data-uid="${uid}"]:not(.back)`) || document.querySelector(`#app .card[data-uid="${uid}"]`);
}
function rectOf(uid){
  const el = cardEl(uid);
  if(!el) return null;
  const r = el.getBoundingClientRect();
  return r.width ? r : null;
}
const casterColour = ctx => PCOLORS[ctx && ctx.owner] || '#eaf3f0';

/** A beam from the caster to each target. Returns true if any was drawn, in
    which case the caller waits FX_MS.beam before the ability lands. */
function startBeams(ctx, uids){
  if(!animOn() || !uids.length) return false;
  let from = rectOf(ctx.uid);
  if(!from){ render(); from = rectOf(ctx.uid); }        // a card that just arrived isn't drawn yet
  const pc = casterColour(ctx);
  if(!from){ uids.forEach(u=>glowCard(u, pc)); return false; }
  let drew = false;
  uids.forEach(u=>{
    if(u===ctx.uid) return;                               // targeting itself: it just glows
    const to = rectOf(u);
    if(!to) return;
    drawBeam(from, to, pc);
    drew = true;
  });
  return drew;
}
function drawBeam(a, b, pc){
  const x1 = a.left + a.width/2, y1 = a.top + a.height/2, x2 = b.left + b.width/2, y2 = b.top + b.height/2;
  const d = Math.hypot(x2-x1, y2-y1), ang = Math.atan2(y2-y1, x2-x1);
  const beam = document.createElement('div');
  beam.className = 'fx-beam';
  beam.style.cssText = `left:${x1}px;top:${y1}px;width:${d}px;--a:${ang}rad;--d:${d}px;--fxc:${pc};--ms:${FX_MS.beam}ms`;
  beam.innerHTML = '<i class="fx-beam-line"></i><i class="fx-beam-head"></i>';
  fxLayer().appendChild(beam);
  setTimeout(()=>beam.remove(), FX_MS.beam + 360);
}
/** A target glows from the moment the beam lands until the ability is done with it. */
function glowCard(uid, pc){
  if(!animOn() || !uid) return;
  UI.fx.glow[uid] = {start: Date.now(), pc};
  clearTimeout(UI.fx.glowTimer);
  UI.fx.glowTimer = setTimeout(()=>{ if(UI.screen==='game') render(); }, FX_MS.glow + 30);
}
function glowAttr(uid){
  const g = UI.fx.glow[uid];
  if(!g) return '';
  const age = Date.now() - g.start;
  if(age > FX_MS.glow){ delete UI.fx.glow[uid]; return ''; }
  return ` fx-target" data-fxc="${g.pc}" data-glowage="${age}`;
}

/** Wrap an action on cards in "beam first, then act". `go` does the work and
    returns the engine result; the uids are what it will touch. */
function withBeams(ctx, uids, go){
  emit('beam', {from:ctx.uid || null, to:uids.slice(), seat:ctx.owner});
  if(UI.animLock || !startBeams(ctx, uids)) { uids.forEach(u=>glowCard(u, casterColour(ctx))); return go(); }
  UI.animLock = true;
  const game = G, epoch = G.epoch;
  setTimeout(()=>{
    if(G!==game || G.epoch!==epoch){ UI.animLock = false; return; }
    UI.animLock = false;
    uids.forEach(u=>glowCard(u, casterColour(ctx)));
    continueAfter(go());
  }, FX_MS.beam);
  return 'pause';
}

/* --- Power ticking up and down ------------------------------------------- */

/** Before drawing: any card on show whose Power differs from what was last
    drawn starts ticking from the old number to the new one. */
function notePowerChanges(){
  if(!G || !animOn()) return;
  const now = Date.now(), seen = UI.fx.seen, vis = [];
  G.planets.forEach(pl=>pl.board.forEach(row=>row.forEach(c=>{ if(c && c.faceUp) vis.push(c); })));
  if(UI.screen==='game'){ const me = G.players[viewerIdx()]; if(me) vis.push(...me.hand); }
  vis.forEach(c=>{
    const v = powerOf(c);
    if(seen[c.uid]!=null && seen[c.uid]!==v){
      const t = UI.fx.ticks[c.uid];
      const from = t ? tickShown(t, now) : seen[c.uid];
      UI.fx.ticks[c.uid] = {from, to:v, start:now, dur: Math.min(900, Math.abs(v-from)*FX_MS.tickStep + 120)};
      fxBusyFor(UI.fx.ticks[c.uid].dur + 80);
    }
    seen[c.uid] = v;
  });
  if(Object.keys(UI.fx.ticks).length) tickLoop();
}
const tickShown = (t, now) => {
  const k = Math.min(1, (now - t.start) / t.dur);
  return Math.round(t.from + (t.to - t.from) * k);
};
/** The number a Power badge should show right now, and its extra class. */
function tickState(card){
  const t = UI.fx.ticks[card.uid];
  if(!t) return {v: powerOf(card), cls:''};
  return {v: tickShown(t, Date.now()), cls: ' ticking '+(t.to>t.from?'tick-up':'tick-down')};
}
function tickLoop(){
  if(UI.fx.ticking) return;
  UI.fx.ticking = true;
  const step = ()=>{
    const now = Date.now();
    let live = 0;
    Object.entries(UI.fx.ticks).forEach(([uid,t])=>{
      const els = document.querySelectorAll(`[data-pw="${uid}"]`);
      if(now - t.start > t.dur + FX_MS.tickHold){
        els.forEach(el=>{ el.textContent = t.to; el.classList.remove('ticking','tick-up','tick-down'); });
        delete UI.fx.ticks[uid];
        return;
      }
      live++;
      els.forEach(el=>{ el.textContent = tickShown(t, now); });
    });
    if(live) requestAnimationFrame(step); else UI.fx.ticking = false;
  };
  requestAnimationFrame(step);
}

/* --- leaving and arriving ---------------------------------------------------- */

/** A card destroyed or discarded crumbles away, top to bottom, from where it was drawn. */
function fxVanish(card){
  if(card) emit('vanish', {uid:card.uid, owner:card.owner});
  if(!animOn() || !card) return;
  const el = cardEl(card.uid);
  if(!el) return;
  const r = el.getBoundingClientRect();
  if(!r.width) return;
  const ghost = document.createElement('div');
  ghost.className = 'fx-ghost';
  ghost.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;--ms:${FX_MS.vanish}ms`;
  const copy = el.cloneNode(true);
  copy.classList.remove('sel','flippable');
  copy.classList.add('fx-vanish');
  ghost.appendChild(copy);
  const pc = getComputedStyle(el).getPropertyValue('--pc') || '#fff';
  for(let i=0;i<18;i++){
    const y = Math.random(), x = Math.random();
    const dot = document.createElement('i');
    dot.className = 'fx-dust';
    dot.style.cssText = `left:${x*100}%;top:${y*100}%;--dx:${(Math.random()*36-10).toFixed(0)}px;--dy:${(-14-Math.random()*26).toFixed(0)}px;`+
                        `animation-delay:${Math.round(y*FX_MS.vanish*0.7)}ms;--fxc:${pc}`;
    ghost.appendChild(dot);
  }
  fxLayer().appendChild(ghost);
  fxBusyFor(FX_MS.vanish);
  setTimeout(()=>ghost.remove(), FX_MS.vanish + 420);
}
/** A card leaving the hand you're looking at leaves its space behind until
    it has finished crumbling; only then do the others close up. */
function fxHole(card, p, i){
  if(!animOn()) return;
  const el = cardEl(card.uid);
  if(!el || !el.closest('.tray')) return;
  const next = p.hand[i+1];
  UI.fx.holes[card.uid] = {before: next ? next.uid : null, start: Date.now()};
  fxBusyFor(FX_MS.vanish + FX_MS.hole);
  setTimeout(()=>{ delete UI.fx.holes[card.uid]; if(UI.screen==='game') render(); }, FX_MS.vanish + FX_MS.hole + 20);
}
/** A hand's cards with any closing gaps in their places. */
function handCardsHTML(cards, one){
  const holes = UI.fx.holes || {}, ids = Object.keys(holes);
  if(!ids.length) return cards.map(one).join('');
  const inHand = new Set(cards.map(c=>c.uid));
  /* A gap sits before the card that followed it — or, if that one went too,
     before whatever followed that. Longer chains come first. */
  const anchor = uid => { let b = holes[uid].before, n = 0; while(b && !inHand.has(b) && holes[b]){ b = holes[b].before; n++; } return {b: inHand.has(b) ? b : null, n}; };
  const placed = ids.map(uid=>Object.assign({uid}, anchor(uid))).sort((x,y)=>y.n-x.n);
  /* it holds its width while the card crumbles, then closes: the delay is
     counted from when the discard happened, so re-renders don't restart it */
  const gap = h => `<div class="card fx-hole" aria-hidden="true" style="--hc:${FX_MS.hole}ms;animation-delay:${FX_MS.vanish-(Date.now()-holes[h.uid].start)}ms"></div>`;
  let out = '';
  cards.forEach(c=>{ placed.filter(h=>h.b===c.uid).forEach(h=>{ out += gap(h); }); out += one(c); });
  placed.filter(h=>h.b===null).forEach(h=>{ out += gap(h); });
  return out;
}

/** Remember that a card just arrived, so it's drawn arriving. */
function fxArrive(card, kind){
  if(card) emit('arrive', {uid:card.uid, kind, owner:card.owner});
  if(!animOn() || !card) return;
  UI.fx.arrive[card.uid] = {kind, start: Date.now(), shown:false};
}
function arriveAttr(uid){
  const a = UI.fx.arrive[uid];
  if(!a) return '';
  /* The clock starts the first time it's actually drawn — an arrival made
     while the screen was hidden still plays when the screen comes back. */
  if(!a.shown){ a.shown = true; a.start = Date.now(); fxBusyFor(a.kind==='summon' ? FX_MS.summon : FX_MS.draw); }
  const age = Date.now() - a.start, dur = a.kind==='summon' ? FX_MS.summon : FX_MS.draw;
  if(age > dur){ delete UI.fx.arrive[uid]; return ''; }
  return ` fx-${a.kind}" data-fxage="${age}`;
}

/* --- Energy flying into the pool -------------------------------------------
   A gain is queued against the player who got it, with where it came from.
   It plays the next time that player's own board is on screen and not
   veiled — so in pass-and-play each player watches their own income after
   pressing Start turn. Until an icon lands, the pool shows the old number. */
function fxEnergy(playerIdx, amount, src){
  if(G && amount>0) emit('energy', {seat:playerIdx, n:amount, from:(src && src.uid) || null});
  if(!animOn() || !(amount>0) || !G) return;
  const p = G.players[playerIdx];
  if(!p || p.kind!=='human') return;
  (UI.fx.energy[playerIdx] = UI.fx.energy[playerIdx] || []).push({amount, src});
}
const pendingEnergy = i => (UI.fx.energy[i]||[]).reduce((t,e)=>t+e.amount, 0) + (UI.fx.held[i]||0);
/** The number the pool shows: real Energy minus what hasn't landed yet. */
const shownEnergy = p => Math.max(0, p.energy - pendingEnergy(p.idx));

function flushEnergy(){
  if(!G || UI.screen!=='game' || UI.gate || UI.transition || UI.roundScreen || UI.dice || G.over) return;
  const me = G.players[viewerIdx()];
  const queue = me && UI.fx.energy[me.idx];
  if(!queue || !queue.length) return;
  const pool = document.querySelector('.hud .pill.energy');
  if(!pool){ return; }
  UI.fx.energy[me.idx] = [];
  const to = pool.getBoundingClientRect();
  const tx = to.left + 18, ty = to.top + to.height/2;
  let k = 0, last = 0;
  queue.forEach(entry=>{
    const from = (entry.src && entry.src.uid && rectOf(entry.src.uid))
              || (document.querySelector('.hud .round') || pool).getBoundingClientRect();
    const fx = from.left + from.width/2, fy = from.top + from.height/2;
    const icons = Math.min(entry.amount, 6);
    const shares = Array.from({length:icons}, (_,i)=> Math.floor(entry.amount/icons) + (i < entry.amount%icons ? 1 : 0));
    UI.fx.held[me.idx] = (UI.fx.held[me.idx]||0) + entry.amount;
    shares.forEach(share=>{
      const delay = k++ * FX_MS.energyGap;
      const ic = document.createElement('i');
      ic.className = 'fx-energy';
      ic.textContent = '\u26A1';
      ic.style.cssText = `left:${fx}px;top:${fy}px;--dx:${tx-fx}px;--dy:${ty-fy}px;--ms:${FX_MS.energyFly}ms;animation-delay:${delay}ms`;
      fxLayer().appendChild(ic);
      const land = delay + FX_MS.energyFly;
      last = Math.max(last, land);
      setTimeout(()=>{
        ic.remove();
        UI.fx.held[me.idx] = Math.max(0, (UI.fx.held[me.idx]||0) - share);
        bumpPool(me);
      }, land);
    });
  });
  fxBusyFor(last + 180);
}
/** An icon landed: the pool counts up to its new number and pulses. */
function bumpPool(p){
  const pill = document.querySelector('.hud .pill.energy');
  const num = pill && pill.querySelector('[data-en]');
  if(!num) return;
  const target = shownEnergy(p);
  let cur = parseInt(num.textContent,10); if(isNaN(cur)) cur = target;
  pill.classList.remove('en-hit'); void pill.offsetWidth; pill.classList.add('en-hit');
  const step = ()=>{ if(cur < target){ cur++; num.textContent = cur; setTimeout(step, 55); } else num.textContent = target; };
  step();
  const spend = document.querySelector('[data-spend]');
  if(spend) spend.textContent = Math.max(0, target - p.planned);
}

/* --- cards sliding between places ------------------------------------------
   A slot clips what's inside it, so the card itself can't travel: a copy
   flies from the old spot to the new one while the real card waits hidden. */
function fxSlideStart(card){
  if(card) emit('slide', {uid:card.uid});
  if(!animOn() || !card) return;
  const el = cardEl(card.uid);
  if(!el) return;
  const r = el.getBoundingClientRect();
  if(!r.width) return;
  const ghost = document.createElement('div');
  ghost.className = 'fx-slide';
  ghost.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px`;
  const copy = el.cloneNode(true);
  copy.classList.remove('sel','flippable','fx-summon','fx-draw');
  ghost.appendChild(copy);
  fxLayer().appendChild(ghost);
  UI.fx.slides[card.uid] = {ghost, from:r, running:false};
  fxBusyFor(FX_MS.slide + 200);                        // until it is placed and set going
}
/** After drawing: set every waiting slide going toward where its card now is. */
function fxSlideRun(){
  Object.entries(UI.fx.slides).forEach(([uid, sl])=>{
    const el = cardEl(uid);
    if(sl.running){ if(el) el.classList.add('fx-hidden'); return; }
    if(!el){ sl.ghost.remove(); delete UI.fx.slides[uid]; return; }
    el.classList.add('fx-hidden');
    const to = el.getBoundingClientRect();
    sl.running = true;
    const g = sl.ghost;
    g.style.transition = `transform ${FX_MS.slide}ms cubic-bezier(.45,.05,.25,1), width ${FX_MS.slide}ms, height ${FX_MS.slide}ms`;
    requestAnimationFrame(()=>{
      g.style.transform = `translate(${to.left - sl.from.left}px, ${to.top - sl.from.top}px)`;
      g.style.width = to.width+'px'; g.style.height = to.height+'px';
    });
    fxBusyFor(FX_MS.slide + 40);
    setTimeout(()=>{
      g.remove();
      delete UI.fx.slides[uid];
      const now = cardEl(uid);
      if(now) now.classList.remove('fx-hidden');
    }, FX_MS.slide + 30);
  });
}
const slidingAttr = uid => UI.fx.slides && UI.fx.slides[uid] ? ' fx-hidden' : '';

/* ------------------------------------------------------------------
   7. RENDERING
   ------------------------------------------------------------------ */

let scrollMemo = {strip:0, hand:0};

function render(){
  const strip = $('.strip'), hand = $('.hand');
  if(strip) scrollMemo.strip = strip.scrollLeft;
  if(hand)  scrollMemo.hand  = hand.scrollLeft;

  notePowerChanges();
  let html = '';
  switch(UI.screen){
    case 'title':  html = viewTitle(); break;
    case 'setup':  html = viewSetup(); break;
    case 'game':   html = (G && G.over && !UI.review) ? viewResult() : viewBoard(); break;
    case 'studio': html = viewStudio(); break;
    case 'decks':  html = viewDecks(); break;
    case 'sprites':html = viewSprites(); break;
    case 'rules':  html = viewRules(); break;
    case 'online': html = viewOnline(); break;
  }
  $('#app').innerHTML = html;
  $('#overlay').innerHTML = viewOverlays();
  if(G && G.online && !G.isView && ON.role==='host') hostBroadcast();     // guests see what the host sees

  const s2 = $('.strip'), h2 = $('.hand');
  if(s2) s2.scrollLeft = scrollMemo.strip;
  if(h2) h2.scrollLeft = scrollMemo.hand;
  if(UI.justFlipped){ const el = document.querySelector('[data-uid="'+UI.justFlipped+'"]'); if(el) el.classList.add('justflipped'); }

  /* The card is drawn back-up, then flipped on the next frame so the browser
     has something to animate from. */
  if(UI.flipAnim){
    const el = document.querySelector('[data-flip="'+UI.flipAnim+'"]');
    if(el) requestAnimationFrame(()=>requestAnimationFrame(()=>el.classList.add('is-flipped')));
  }
  document.body.classList.toggle('dragging', !!UI.drag);
  /* An arrival redrawn mid-way carries on from where it was, not from the start. */
  document.querySelectorAll('[data-fxage]').forEach(el=>{ el.style.animationDelay = '-'+el.dataset.fxage+'ms'; });
  document.querySelectorAll('.fx-target').forEach(el=>{ el.style.setProperty('--fxc', el.dataset.fxc); el.style.animationDelay = '-'+el.dataset.glowage+'ms'; });
  if(animOn()){ fxSlideRun(); flushEnergy(); }
  if(G && boardPicking() && UI.pickShown!==G.choice){
    UI.pickShown = G.choice;
    const first = document.querySelector('.slot.pickable');
    if(first && first.scrollIntoView) first.scrollIntoView({block:'nearest', inline:'center', behavior:'smooth'});
  }
}

function topbar(title, extra){
  return `<div class="topbar">
    <button class="back-btn" data-act="home" aria-label="Back to the main menu"><span class="arr">\u2190</span>Menu</button>
    <h2>${esc(title)}</h2><div class="spacer"></div>${extra||''}
    <button class="icon-btn" data-act="theme" aria-label="Switch theme">\u25D0</button>
  </div>`;
}

/* --- TITLE ----------------------------------------------------- */

function viewTitle(){
  const stars = Array.from({length:46},()=>{
    const x=Math.random()*100, y=Math.random()*100, r=Math.random()*1.1+.3, o=Math.random()*.6+.2;
    return `<circle cx="${x}%" cy="${y}%" r="${r}" fill="#dff6ee" opacity="${o.toFixed(2)}"/>`;
  }).join('');
  return `<div class="title-wrap">
    <svg class="starfield" aria-hidden="true">${stars}</svg>
    <div class="title-inner">
      <div class="orbit-row" aria-hidden="true">
        <span class="orbit" style="--o:#4fd6b0"></span><span class="orbit" style="--o:#f5b95c"></span>
        <span class="orbit" style="--o:#a482f0"></span><span class="orbit" style="--o:#5cbfe4"></span>
        <span class="orbit" style="--o:#f2856c"></span>
      </div>
      <h1 class="wordmark">Terri<em>tory</em></h1>
      <p class="tagline">Six rounds. Five worlds. Hold the most ground when the last card turns over.</p>
      <div class="title-actions">
        ${inRoom() ? `<button class="btn primary" data-on="backtoroom">Back to room ${esc(ON.code)}<span class="k">${G && (G.online||G.isView) ? 'game in progress' : 'lobby'}</span></button>` : ''}
        <button class="btn ${inRoom()?'':'primary'}" data-act="newgame" data-v="0">Start a game<span class="k">2\u20134 players, one device</span></button>
        <button class="btn" data-on="open">Play online<span class="k">each on their own device</span></button>
        <button class="btn" data-act="newgame" data-v="1">Sandbox<span class="k">test anything</span></button>
        <button class="btn" data-act="go" data-screen="studio">Studio<span class="k">cards &amp; planets</span></button>
        <button class="btn" data-act="go" data-screen="decks">Decks<span class="k">${LIB.decks.length} saved</span></button>
        <button class="btn" data-act="go" data-screen="sprites">Art &amp; data<span class="k">sprites, import, export</span></button>
        <button class="btn" data-act="go" data-screen="rules">How it plays</button>
      </div>
    </div>
  </div>`;
}

/* --- SETUP ----------------------------------------------------- */

/** Taking turns or placing at once. Pass-and-play has to take turns (one
    screen can't hide two hands at the same moment), so with two or more humans
    the second option is shown but switched off, with the reason beside it. */
function placementSetupHTML(s){
  const kinds = Array.from({length:s.players}, (_,i)=>s.kinds[i]||'human');
  const humans = kinds.filter(k=>k==='human').length;
  const mode = placementModeFor(s, kinds);
  const blocked = humans>1;
  return `<div class="card-panel stack" style="gap:8px">
    <div class="row" style="gap:6px">
      <b style="flex:1">Placement</b>
      <button class="chip ${mode==='turns'?'on':''}" data-act="placement" data-v="turns">Take turns</button>
      <button class="chip ${mode==='simultaneous'?'on':''}" data-act="placement" data-v="simultaneous" ${blocked?'disabled':''}>All at once</button>
    </div>
    <p class="tiny muted" style="margin:0">${mode==='simultaneous'
      ? 'Everyone places at the same time, then locks in. Nobody sees where anyone else put a card until the reveal starts. This is how online games play.'
      : blocked && s.placement==='simultaneous'
        ? 'Pass-and-play always takes turns \u2014 one screen can\u2019t hide two hands at once. All at once is for one human against bots here, and for online games.'
        : 'Players place one after another, in the order the dice decide.'}</p>
  </div>`;
}

function viewSetup(){
  const s = LIB.settings;
  const deckOpts = i => LIB.decks.map(d=>`<option value="${d.id}" ${s.deckOf[i]===d.id?'selected':''}>${esc(d.name)} (${d.cards.length})</option>`).join('');
  const seats = Array.from({length:s.players},(_,i)=>`
    <div class="card-panel">
      <div class="row" style="margin-bottom:10px">
        <span class="dot" style="--pc:${PCOLORS[i]}"></span>
        <b>${PNAMES[i]}</b>
        <div class="spacer" style="flex:1"></div>
        <button class="chip ${s.kinds[i]!=='bot'?'on':''}" data-act="kind" data-i="${i}" data-v="human">Human</button>
        <button class="chip ${s.kinds[i]==='bot'?'on':''}" data-act="kind" data-i="${i}" data-v="bot">Bot</button>
      </div>
      <label class="field"><span>Deck</span>
        <select data-act="seatdeck" data-i="${i}">${deckOpts(i)}</select></label>
    </div>`).join('');

  const short = LIB.decks.filter(d=>d.cards.length<6);
  return `${topbar(s.sandbox?'New sandbox':'New game')}
  <div class="page stack">
    <div class="grid3">
      <label class="field"><span>Players</span>
        <select data-act="set" data-k="players">${[2,3,4].map(n=>`<option value="${n}" ${s.players===n?'selected':''}>${n}</option>`).join('')}</select></label>
      <label class="field"><span>Planets</span>
        <select data-act="set" data-k="planets">${[3,4,5,6,7,8].filter(n=>n<=LIB.planets.length).map(n=>`<option value="${n}" ${s.planets===n?'selected':''}>${n}</option>`).join('')}</select></label>
      <label class="field"><span>Rounds</span>
        <select data-act="set" data-k="rounds">${[4,5,6,7,8].map(n=>`<option value="${n}" ${s.rounds===n?'selected':''}>${n}</option>`).join('')}</select></label>
    </div>
    ${seats}
    ${placementSetupHTML(s)}
    <label class="row" style="gap:8px">
      <input type="checkbox" data-act="hide" ${s.hide?'checked':''} style="width:auto">
      <span class="tiny">Hide each player's hand behind a pass-the-device screen</span>
    </label>
    <div class="grid2">
      <label class="field"><span>Turn timer</span>
        <select data-act="timerpreset">${TIMER_PRESETS.map(([v,l])=>`<option value="${v}" ${timerPreset(s)===String(v)?'selected':''}>${l}</option>`).join('')}</select></label>
      ${timerPreset(s)==='custom' ? `<label class="field"><span>Seconds per turn</span>
        <input type="number" min="10" max="900" step="5" data-act="timersecs" value="${s.turnTimer||60}"></label>` : '<div></div>'}
    </div>
    ${s.turnTimer ? `<div class="grid2">
      <label class="field"><span>Ability choice timer</span>
        <select data-act="set" data-k="choiceTimer">${CHOICE_PRESETS.map(([v,l])=>`<option value="${v}" ${(s.choiceTimer||30)===v?'selected':''}>${l}</option>`).join('')}</select></label>
      <div></div>
    </div>
    <p class="tiny muted" style="margin:-4px 0 0">Each human turn gets ${fmtClock(s.turnTimer*1000)}, with a warning at 10 seconds. When it runs out the turn finishes itself: cards placed stay placed and cards still face down are turned over. A pop-up asking you to choose for an ability gets ${fmtClock((s.choiceTimer||30)*1000)} of its own, and the turn clock waits meanwhile; if it runs out the choice is made at random.</p>` : ''}
    <label class="row" style="gap:8px;flex-wrap:nowrap;align-items:flex-start">
      <input type="checkbox" data-act="sandbox" ${s.sandbox?'checked':''} style="width:auto">
      <span class="tiny"><b>Sandbox mode</b> \u2014 a \u{1F9EA} bench in the game to add Energy, put any card in a hand, change the round and reset the board. Hands stay visible.</span>
    </label>
    ${short.length?`<p class="callout">Deck${short.length>1?'s':''} with fewer than 6 cards will run dry: ${short.map(d=>esc(d.name)).join(', ')}.</p>`:''}
    <button class="btn primary wide" data-act="begin">Deal the opening hands</button>
  </div>`;
}
/* --- BOARD -----------------------------------------------------
   Layout, top to bottom, is one continuous chain of ownership:
     opponents' rows → the planet itself → the slot rules → your row
   so the closer something is to your thumb, the more it belongs to you.
   ---------------------------------------------------------------- */

/** With a single human at the table there is nobody to hand the device to, so
    the board never turns around: it stays on that seat's side all game and the
    bots play in the rows above. */
function lockedSeat(){
  if(!G || G.over) return null;
  const humans = G.players.filter(p=>p.kind==='human');
  return humans.length===1 ? humans[0].idx : null;
}

/** Whose eyes the board is drawn through: the locked seat, the active player,
    or the seat being inspected once the game is over. */
function viewerIdx(){
  if(G && G.isView) return G.viewer;        // a device drawing a server's view of the game
  if(G && G.online && NET.seat!=null && !G.over) return NET.seat;   // the host's own seat
  const lock = lockedSeat();
  if(lock!=null) return lock;
  const p = currentPlayer();
  if(p){ UI.lastSeat = p.idx; return p.idx; }
  if(G && G.over) return clamp(UI.reviewSeat, 0, G.players.length-1);
  return G ? clamp(UI.lastSeat||0, 0, G.players.length-1) : 0;   // mid-beat: hold the last view
}

/** The seat we are watching is also the seat that can act right now. */
function myTurn(){
  const p = currentPlayer();
  return !!(p && p.idx === viewerIdx());
}

function selCard(){ return UI.sel ? findCardByUid(UI.sel) : null; }
function placing(){ return !!(G && G.phase==='placement' && !G.over && !busy() && !UI.gate && myTurn()); }
/** The end of your reveal turn: everything is face up, so revealed cards can
    change slots on their own planet before you press End turn. */
function rearranging(){
  const p = G && currentPlayer();
  return !!(p && G.phase==='reveal' && !G.over && !busy() && !UI.gate && myTurn() && p.kind==='human'
    && RULES.rearrangeRevealed && RULES.revealEndTurn && !faceDownOf(p).length);
}
const arranging = () => placing() || rearranging();

function viewBoard(){
  const meIdx = viewerIdx();
  const me = G.players[meIdx];
  const live = currentPlayer();
  const mine = myTurn();
  const phaseLabel = G.over ? 'Final board' : (G.phase==='placement' ? 'Placement' : 'Reveal');
  const lifted = (live && mine && UI.sel) ? whereIs(live, UI.sel) : null;
  const liftedKind = (lifted && lifted.from==='board') ? pickupKind(live, lifted.planetIdx, lifted.slotIdx) : null;

  const simulPlace = G.simul && G.phase==='placement' && !G.over;
  const others = simulPlace ? G.players.filter(q=>!q.locked && q.idx!==meIdx) : [];
  const waiting = simulPlace
    ? (me.locked ? (others.length ? `Locked in \u2014 waiting for ${others.map(q=>esc(q.name)).join(', ')}\u2026` : 'Everyone is in \u2014 revealing\u2026') : null)
    : (live && !mine && !G.over)
    ? `${esc(live.name)} is ${G.phase==='placement' ? 'placing cards' : 'turning cards over'}\u2026`
    : null;
  const hint = G.over
    ? 'Every card is face up. Switch seats to read the board from another side.'
    : waiting ? waiting
    : G.phase==='placement'
      ? (liftedKind ? 'Tap another slot to move it, or send it back to your hand.'
        : UI.sel ? 'Drop it on one of your slots. Nothing is paid until it flips.'
        : simulPlace ? 'Everyone places at once. Drag cards onto slots, then lock in.'
        : 'Drag a card onto a slot, or tap the card then the slot.')
      : (live && mine && !faceDownOf(live).length && live.kind==='human' && RULES.revealEndTurn
          ? (liftedKind ? 'Tap one of the lit slots on this planet. A card already there swaps places.'
            : readyActs(live).length ? 'Tap a card marked \u2699 to use it, or drag a card to another slot on its planet. End turn when you\u2019re done.'
            : 'Drag a card to another slot on its planet if you like, then End turn.')
        : live && mine && readyActs(live).length
          ? (faceDownOf(live).length ? 'Turn your cards over in any order. Cards marked \u2699 can use their ability once.'
                                     : 'Tap a card marked \u2699 to use its ability, or End turn to finish.')
          : 'Turn your cards over in the order you want them to resolve.');

  /* The bar names whoever is acting. The rail at the bottom always names you. */
  const barIdx = (live && !G.over) ? live.idx : meIdx;
  const barName = G.over ? esc(me.name)+'\u2019s view' : simulPlace ? 'Everyone' : esc(G.players[barIdx].name);

  return `<div class="board ${G.over?'is-review':''} ${UI.transition?'is-holding':''} ${boardPicking()?'is-picking':''}">
    <div class="hud">
      <div>
        <div class="round">${G.over?'Game over':'Round '+G.round+' of '+G.rounds}</div>
        <div class="phase">${phaseLabel}${G.over?'':' phase'}</div>
      </div>
      <div class="spacer"></div>
      ${G.over ? '' : `<span class="pill energy">\u26A1 <b data-en="${me.idx}">${shownEnergy(me)}</b>${me.planned?` <span class="planned">\u2212${me.planned}</span>`:''}</span>`}
      <button class="icon-btn grave-btn" data-act="sheet" data-v="grave" aria-label="Graveyard, ${G.grave.length} cards">\u{1FAA6}${G.grave.length?`<span class="count">${G.grave.length}</span>`:''}</button>
      ${G.sandbox?`<button class="icon-btn sb-btn" data-act="sheet" data-v="sandbox" aria-label="Sandbox tools">\u{1F9EA}</button>`:''}
      <button class="icon-btn" data-act="sheet" data-v="log" aria-label="Game log">\u2261</button>
      <button class="icon-btn" data-act="sheet" data-v="menu" aria-label="Menu">\u22EF</button>
    </div>

    <div class="turnbar ${waiting?'waiting':''}">
      <span class="dot" style="--pc:${PCOLORS[barIdx]}"></span>
      <b>${barName}</b>
      <span class="turnhint">${hint}</span>
      ${timerHTML()}
    </div>
    ${simulPlace ? lockBarHTML(meIdx) : ''}

    ${G.over ? seatSwitchHTML(meIdx) : ''}

    <div class="strip">${G.planets.map((pl,i)=>planetHTML(pl,i,meIdx)).join('')}</div>

    ${G.over ? reviewFootHTML(me) : trayHTML(me, !live || !mine || !!UI.transition)}
  </div>`;
}

/** Placing at once: one chip per player, filled in their colour once they've
    locked in — the same mark for the same state, so the row reads at a glance
    as "who are we still waiting for". */
function lockBarHTML(meIdx){
  return `<div class="lockbar" role="status" aria-label="Who has locked in">${G.players.map(q=>`
    <span class="lockchip ${q.locked?'in':''} ${q.idx===meIdx?'me':''}" style="--pc:${PCOLORS[q.idx]}">
      <span class="dot" style="--pc:${PCOLORS[q.idx]}"></span>${esc(q.idx===meIdx?'You':q.name)}
      <i>${q.locked ? '\u2713 locked in' : 'placing\u2026'}</i>
    </span>`).join('')}</div>`;
}

function seatSwitchHTML(meIdx){
  return `<div class="seatbar">${G.players.map((p,i)=>`
    <button class="chip seat ${i===meIdx?'on':''}" data-act="reviewseat" data-i="${i}" style="--pc:${PCOLORS[i]}">
      <span class="dot" style="--pc:${PCOLORS[i]}"></span>${esc(p.name)}
    </button>`).join('')}</div>`;
}

function reviewFootHTML(me){
  return `<div class="tray">
    ${scoreRailHTML(me)}
    <div class="tray-head">
      <span>${me.hand.length} left in hand \u00B7 \u26A1${me.energy} unspent</span>
      <div style="flex:1"></div>
      <button class="btn sm primary" data-act="closereview">Back to the result</button>
    </div>
    <div class="hand">${me.hand.map(c=>cardHTML(c,false,false)).join('') || '<div class="empty-note">Nothing left in hand.</div>'}</div>
  </div>`;
}

/* --- one planet ------------------------------------------------- */

function planetHTML(pl, pi, meIdx){
  const scores = planetScore(pl);
  const best = Math.max(...scores);
  const maxBar = Math.max(best, 10);
  const tally = G.players.map((p,i)=>{
    const lead = scores[i]===best && best>0 && scores.filter(s=>s===best).length===1;
    return `<div class="tally-row ${lead?'lead':''}" style="--pc:${PCOLORS[i]}">
      <span class="dot" style="--pc:${PCOLORS[i]}"></span>
      <span class="bar"><i style="width:${Math.round(scores[i]/maxBar*100)}%"></i></span>
      <b>${scores[i]}</b>${lead?'<span class="crown">\u25C6</span>':'<span style="width:8px"></span>'}
    </div>`;
  }).join('');

  const others = G.players.filter(p=>p.idx!==meIdx);
  const otherRows = others.map(p=>`
    <div class="side">
      <div class="side-label"><span class="dot" style="--pc:${PCOLORS[p.idx]}"></span>${esc(p.name)}</div>
      <div class="slots">${pl.slots.map((s,si)=>slotHTML(pl,pi,p.idx,si,false)).join('')}</div>
    </div>`).join('');

  const sel = selCard();
  const hot = sel && placing() && pl.board[meIdx].some(x=>!x);

  /* The rule sits above the slot and stays there once a card lands on it. */
  /* a revealed card can't leave its planet, so other planets' rules stay quiet */
  const selHere = sel && !(sel.faceUp && locate(sel.uid) && locate(sel.uid).planetIdx!==pi);
  const rules = pl.slots.map((s,si)=>{
    const met = selHere ? slotMet(pi, si, sel, meIdx) : false;
    return `<div class="rule ${selHere?(met?'match':'miss'):''}" ${condAttr(s.cond)} data-p="${pi}" data-s="${si}">
      <span class="cond">${condShort(s.cond)}</span>
      <span class="rew ${s.rew.type==='draw'?'draw':''}">${rewText(s.rew)}</span>
    </div>`;
  }).join('');

  const zone = arranging() ? `data-drop="planet" data-p="${pi}"` : '';
  return `<div class="planet ${hot?'hot':''}" data-planet="${pi}" ${zone}>
    <div class="planet-head">
      <div class="orb" style="--po:${pl.hue}">${artHTML(pl.art, pl.name)}</div>
      <div style="min-width:0">
        <div class="planet-name">${esc(pl.name)}</div>
        <div class="planet-sub">${holdText(scores, meIdx)}</div>
      </div>
    </div>
    <div class="tally">${tally}</div>
    ${otherRows}
    <div class="side mine">
      <div class="rules">${rules}</div>
      <div class="slots">${pl.slots.map((s,si)=>slotHTML(pl,pi,meIdx,si,true)).join('')}</div>
      <div class="side-label you"><span class="dot" style="--pc:${PCOLORS[meIdx]}"></span>Your slots</div>
    </div>
  </div>`;
}

function holdText(scores, meIdx){
  const mine = scores[meIdx];
  const best = Math.max(...scores.filter((_,i)=>i!==meIdx), 0);
  if(mine>best) return `You hold it by ${mine-best}`;
  if(mine<best) return `Behind by ${best-mine}`;
  return mine===0 ? 'Nobody has landed yet' : 'Level \u2014 nobody holds it';
}

/* --- one slot ---------------------------------------------------- */

function slotHTML(pl, pi, playerIdx, si, isMine){
  const slot = pl.slots[si];
  let card = pl.board[playerIdx][si];
  /* Placing at once, nobody sees where anyone else is putting cards until the
     reveal: an opponent's fresh commitment draws as an empty slot. */
  if(card && !card.faceUp && G.simul && G.phase==='placement' && !G.over && playerIdx!==viewerIdx()) card = null;
  const pc = PCOLORS[playerIdx];
  const meIdx = viewerIdx();
  const mine = playerIdx === meIdx;
  const sel = selCard();

  /* Where the lifted card may go: anywhere while placing a hand card or a
     committed one; a revealed card only on its own planet. */
  const selAt = sel ? locate(sel.uid) : null;
  const selFits = !!sel && (selAt && sel.faceUp ? selAt.planetIdx===pi : placing());
  /* A revealed card in the air: every one of your three slots on its planet is
     a destination (an occupied one swaps), and your slots elsewhere step back. */
  const shuffling = isMine && !!sel && !!selAt && sel.faceUp && rearranging();
  const dest = shuffling ? (selAt.planetIdx===pi ? (slotMet(pi, si, sel, playerIdx) ? 'dest match' : 'dest plain') : 'blocked') : '';

  /* Empty */
  if(!card){
    const open = isMine && (placing() || (rearranging() && selFits));
    const met = open && sel ? slotMet(pi, si, sel, playerIdx) : false;
    const cls = ['slot','empty', open?'open':'', (open&&sel)?(met?'match':'plain'):'', shuffling&&!open?dest:''].filter(Boolean).join(' ');
    const drop = (isMine && arranging()) ? `data-drop="slot" data-p="${pi}" data-s="${si}" ${condAttr(slot.cond)}` : '';
    const act  = (open && sel && selFits) ? `data-act="drop" data-p="${pi}" data-s="${si}"` : '';
    return `<button class="${cls}" ${drop} ${act} ${act?'':'disabled'} aria-label="Slot ${si+1}, ${condText(slot.cond)}, ${rewLong(slot.rew)}">
      <span class="slot-mark">${open&&sel?(met?'\u2713':'+'):''}</span>
    </button>`;
  }

  /* Picking a target on the board itself: what can be picked glows, everything else greys. */
  if(boardPicking() && card.faceUp){
    const ok = G.choice.pool.some(o=>o.card.uid===card.uid);
    const met0 = condMet(slot.cond, card);
    return `<button class="slot filled ${ok?'pickable':'unpickable'}" ${ok?`data-act="targetcard" data-uid="${card.uid}" aria-label="Choose ${esc(card.name)}"`:''}
      style="--fxc:${PCOLORS[G.choice.owner]}">${miniHTML(card, pc, met0, false, false, null)}</button>`;
  }
  const committed = mine && !card.faceUp && G.phase==='placement';
  const revealHidden = !card.faceUp && (!mine || G.phase!=='placement');
  const peeking = mine && revealHidden && UI.peekBoard;
  const met = card.faceUp && slotMet(pi, si, card, playerIdx);
  const flippable = mine && myTurn() && G.phase==='reveal' && !card.faceUp && !busy() && !UI.gate;
  const owner = G.players[card.owner] || null;
  const hasAct = card.faceUp && !!actSpec(card);
  const activatable = hasAct && mine && myTurn() && G.phase==='reveal' && !busy() && !UI.gate && !actBlock(card, owner);
  const actState = !hasAct ? null : activatable ? 'ready' : (G.over ? 'idle' : actBlock(card, owner) || 'idle');
  const animating = UI.flipAnim === card.uid;

  let inner;
  if(animating){
    inner = `<div class="flipper" data-flip="${card.uid}">
      <div class="flip-inner">
        <div class="flip-face fb">${backHTML(card, pc, true)}</div>
        <div class="flip-face ff">${miniHTML(card, pc, false)}</div>
      </div></div>`;
  }else if(revealHidden && !peeking){
    inner = backHTML(card, pc, mine, flippable);
  }else{
    inner = miniHTML(card, pc, met, committed, peeking, actState);
  }

  const harvest = (met && card.faceUp) ? `<span class="harvest ${slot.rew.type==='draw'?'draw':''}">${rewText(slot.rew)}</span>` : '';

  /* Face-down commitments go anywhere; cards already turned over shuffle
     between the slots of the planet they are on. */
  const kind = (isMine && arranging()) ? pickupKind(currentPlayer(), pi, si) : null;
  const liftable = !!kind;
  const lifted = liftable && UI.sel===card.uid;
  const drop = (isMine && arranging()) ? `data-drop="slot" data-p="${pi}" data-s="${si}" ${condAttr(slot.cond)}` : '';
  const drag = liftable ? `data-drag="board" data-kind="${kind}" data-uid="${card.uid}" data-p="${pi}" data-s="${si}"` : '';
  /* With something already in the air, this slot becomes a destination —
     that is how a tap-only player swaps two cards over. That comes before
     activating, so a ⚙ card can still be swapped with. */
  const act = flippable ? `data-act="flip" data-uid="${card.uid}"`
            : (drop && sel && UI.sel!==card.uid && selFits) ? `data-act="drop" data-p="${pi}" data-s="${si}"`
            : activatable && !lifted ? `data-act="activate" data-uid="${card.uid}"`
            : liftable ? `data-act="lift" data-uid="${card.uid}"`
            : (card.faceUp || mine) ? `data-act="peek" data-uid="${card.uid}"` : '';

  return `<button class="slot filled ${committed?'committed':''} ${kind==='revealed'?'movable':''} ${lifted?'lifted':''} ${dest} ${activatable?'activatable':''}${card.faceUp?glowAttr(card.uid):''}" ${drop} ${drag} ${act||'disabled'}
    ${activatable?`aria-label="Activate ${esc(card.name)}"`:''}>${inner}${harvest}</button>`;
}

/** The face of a card, sized for a slot. */
function miniHTML(card, pc, met, committed, peeking, actState){
  const cls = powerCls(card);
  const a = actState ? actSpec(card) : null;
  /* ⚙ marks a card with an activated ability; its state is the chip's weight
     (ready = lit, otherwise dimmed), its cost the number beside it. */
  const chip = a ? `<span class="act-chip ${actState}" title="${esc(actState==='ready'?'Tap to activate':ACT_WHY[actState]||'Activated ability')}">\u2699${a.cost?`<b>${a.cost}</b>`:''}</span>` : '';
  const tk = tickState(card);
  return `<div class="mini ${met?'met':''} ${committed?'pending':''} ${peeking?'peeking':''}${slidingAttr(card.uid)}${arriveAttr(card.uid)}" style="--pc:${pc}" data-rarity="${rarityOf(card)}" data-uid="${card.uid}">
    <span class="c">${card.cost}</span><span class="p ${cls}${tk.cls}" data-pw="${card.uid}">${tk.v}</span>
    <div class="art">${artHTML(card.art, card.name)}</div>
    <div class="nm">${esc(card.name)}</div>
    ${committed?'<span class="pinned">held</span>':''}
    ${chip}
  </div>`;
}

/** The back of a card. Yours keeps its Energy pip so you can plan the order
    you pay in; an opponent's tells you nothing at all. */
function backHTML(card, pc, mine, flippable){
  return `<div class="mini back ${flippable?'flippable':''}" style="--pc:${pc}" data-uid="${card.uid}">
    <span class="rings" aria-hidden="true"></span>
    <span class="sigil">\u25C7</span>
    ${mine?`<span class="c">${card.cost}</span>`:''}
  </div>`;
}

/* --- the bottom cluster ------------------------------------------ */

/** Where the current player stands, on every planet, at all times. */
function scoreRailHTML(me){
  let held = 0, level = 0;
  const pips = G.planets.map((pl,i)=>{
    const sc = planetScore(pl);
    const mine = sc[me.idx];
    const best = Math.max(...sc.filter((_,j)=>j!==me.idx), 0);
    const state = mine>best ? 'win' : (mine<best ? 'lose' : 'tie');
    if(state==='win') held++; else if(mine>0||best>0) level++;
    return `<button class="pip ${state}" data-act="goplanet" data-p="${i}"
        style="--po:${pl.hue};--pc:${PCOLORS[me.idx]}" aria-label="${esc(pl.name)}: ${mine} versus ${best}">
      <span class="pip-orb">${artHTML(pl.art, pl.name)}</span>
      <span class="pip-num"><b>${mine}</b><i>${best}</i></span>
    </button>`;
  }).join('');

  return `<div class="rail">
    <div class="rail-who" style="--pc:${PCOLORS[me.idx]}">
      <span class="dot" style="--pc:${PCOLORS[me.idx]}"></span>
      <b>${esc(me.name)}</b>
      <span class="rail-count"><b>${held}</b> of ${G.planets.length}</span>
    </div>
    <div class="rail-pips">${pips}</div>
  </div>`;
}

/* `held` covers the beat between turns: the cluster stays exactly where it is,
   minus the controls, so nothing jumps when play resumes. */
function trayHTML(me, held){
  if(!me) return '';

  if(G.phase==='reveal'){
    const left = faceDownOf(me).length;
    const mineNow = !held && myTurn();
    const acts = mineNow ? readyActs(me).length : 0;
    const ends = mineNow && !left && me.kind==='human' && RULES.revealEndTurn;
    const title = left ? `${left} card${left===1?'':'s'} face down` : acts ? `All face up \u00B7 ${acts} abilit${acts===1?'y':'ies'} ready` : 'All face up';
    return `<div class="tray">
      ${scoreRailHTML(me)}
      <div class="tray-head">
        <b class="tray-title">${title}</b>
        <div style="flex:1"></div>
        ${held||!left?'':`<button class="btn sm ghost" data-act="peekboard">${UI.peekBoard?'Hide mine':'Peek at mine'}</button>`}
        ${!held&&left>1?`<button class="btn sm" data-act="autoflip">Flip the rest</button>`:''}
        ${ends||(mineNow&&!left&&acts)?`<button class="btn sm primary" data-act="endreveal">End turn</button>`:''}
      </div>
      <div class="hand">${handCardsHTML(me.hand, c=>cardHTML(c,false,true)) || '<div class="empty-note">Hand empty.</div>'}</div>
    </div>`;
  }

  const spend = Math.max(0, shownEnergy(me) - me.planned);
  const lifted = !held && UI.sel && whereIs(me, UI.sel);
  const onBoard = lifted && lifted.from==='board'
    && pickupKind(me, lifted.planetIdx, lifted.slotIdx)==='committed';
  return `<div class="tray">
    ${scoreRailHTML(me)}
    <div class="tray-head">
      <span>Hand \u00B7 ${me.hand.length}</span>
      <span class="spend">\u26A1 <span data-spend>${spend}</span> to spend</span>
      <div style="flex:1"></div>
      ${onBoard?`<button class="btn sm ghost" data-act="tohand">Return to hand</button>`:''}
      ${held?'':`<button class="btn sm ${me.placed.length?'primary':''}" data-act="endturn">${me.placed.length?'Lock in '+me.placed.length:'Play nothing'}</button>`}
      ${held && G.simul && me.locked ? `<span class="locked-tag">\u2713 Locked in</span>` : ''}
    </div>
    <div class="hand" data-drop="hand">${handCardsHTML(me.hand, c=>cardHTML(c, UI.sel===c.uid, !canPlace(me,c)))
      || '<div class="empty-note">Hand empty. Lock in to continue.</div>'}</div>
  </div>`;
}

function cardHTML(card, selected, dim, big){
  const tx = fxText(card.fx);
  const draggable = !big && G && !G.over && G.phase==='placement';
  const tk = big ? {v:powerOf(card), cls:''} : tickState(card);
  const fx = big ? '' : glowAttr(card.uid) || arriveAttr(card.uid);
  return `<button class="card ${big?'big':''} ${selected?'sel':''} ${dim?'unaffordable':''}${fx}"
      style="--pc:${PCOLORS[card.owner]||'var(--p1)'}" data-rarity="${rarityOf(card)}" data-act="hand" data-uid="${card.uid}"
      ${draggable?`data-drag="hand"`:''}>
    <div class="top"><span class="badge e">${card.cost}</span><span class="badge p ${powerCls(card)}${tk.cls}" ${big?'':`data-pw="${card.uid}"`}>${tk.v}</span></div>
    <div class="art">${artHTML(card.art, card.name)}</div>
    <div class="nm">${esc(card.name)}</div>
    <div class="tx">${esc(tx)}</div>
  </button>`;
}
/* --- RESULTS --------------------------------------------------- */

function viewResult(){
  const r = G.result;
  const wname = r.winner==null ? 'A draw' : G.players[r.winner].name+' wins';
  const pc = r.winner==null ? 'var(--ui-text)' : PCOLORS[r.winner];
  const rows = r.rows.map(row=>`
    <div class="score-line">
      <span class="pl">${esc(row.name)}</span>
      ${row.scores.map((s,i)=>`<span class="vs ${row.winner===i?'win':''}" style="${row.winner===i?'color:'+PCOLORS[i]:''}">${s}</span>`).join('<span class="vs" style="opacity:.4">\u2013</span>')}
      <span style="width:64px;text-align:right;font-size:12.5px;color:${row.winner==null?'var(--ui-faint)':PCOLORS[row.winner]}">
        ${row.winner==null?'contested':esc(G.players[row.winner].name)}</span>
    </div>`).join('');

  return `<div class="result-hero">
      <div class="tiny" style="color:var(--ink-dim)">After ${G.rounds} rounds</div>
      <div class="who" style="--pc:${pc}">${esc(wname)}</div>
      <div class="tiny" style="color:var(--ink-dim)">${r.won.map((w,i)=>esc(G.players[i].name)+': '+w).join(' \u00B7 ')} planets${r.winner!=null&&r.reason!=='planets won'?' \u2014 decided on '+esc(r.reason):''}</div>
    </div>
    <div class="page stack">
      <div>${rows}</div>
      <div class="row">
        ${G.players.map((p,i)=>`<span class="chip">${esc(p.name)}: ${p.hand.length} in hand \u00B7 \u26A1${p.energy}</span>`).join('')}
      </div>
      <div class="row">
        <button class="btn primary" data-act="review">Review the board</button>
        <button class="btn" data-act="sheet" data-v="grave">Graveyard</button>
        ${G.online || G.isView
          ? (ON.role==='host' ? `<button class="btn" data-on="lobby">Back to the lobby</button>` : `<p class="tiny muted" style="margin:0;text-align:center">The host can take everyone back to the lobby for another game.</p>`)
          : `<button class="btn" data-act="begin">Play again</button>`}
        <button class="btn" data-act="sheet" data-v="log">Read the log</button>
        <button class="btn ghost" data-act="home">Menu</button>
      </div>
    </div>`;
}

/* --- OVERLAYS -------------------------------------------------- */

const VERB_CHOICE_LABEL = { givePower:'give Power to', destroy:'destroy', recall:'recall', move:'move',
  steal:'steal bonus Power from', burn:'burn Power from', draw:'take into your hand', summon:'summon', discard:'discard' };

/** Is a card being chosen straight off the board right now? Only when the
    person choosing is the one looking at it; otherwise it's a sheet. */
function boardPicking(){
  const ch = G && G.choice;
  return !!(ch && ch.kind==='pickcard' && (ch.purpose==='board' || ch.purpose==='swap')
    && !isBot(ch.owner) && ch.owner===viewerIdx() && UI.screen==='game' && UI.choicePeek!==ch);
}
function pickBannerHTML(){
  const ch = G.choice;
  const what = ch.purpose==='swap' ? `Choose a card to swap ${esc(ch.mover.card.name)} with`
             : `Choose a card to ${VERB_CHOICE_LABEL[ch.verb]||'target'}`;
  const src = ch.ctx && (findCardByUid(ch.ctx.uid) || null);
  return `<div class="pick-banner" style="--pc:${PCOLORS[ch.owner]}" role="status">
    <div><b>${what}</b><span>${src?esc(src.name)+' \u00B7 ':''}tap one of the ${ch.pool.length} glowing cards</span></div>
    ${choiceTimerHTML()}
  </div>${choiceSideHTML()}`;
}

/** One card in a choice sheet. An opponent's card that hasn't flipped yet
    stays hidden: you can choose it, but you choose it blind. */
function choiceCardHTML(o, act, chooserIdx, caption){
  const hidden = o.zone==='board' && !o.card.faceUp && o.playerIdx!==chooserIdx;
  if(hidden) return `
    <button class="card facedown" style="--pc:${PCOLORS[o.playerIdx]}" data-act="${act}" data-uid="${o.card.uid}">
      <div class="top"><span class="badge e">?</span><span class="badge p">?</span></div>
      <div class="art">\u25C7</div>
      <div class="nm">Face-down card</div>
      <div class="tx">${esc(caption||'')}</div>
    </button>`;
  return `
    <button class="card" style="--pc:${PCOLORS[o.playerIdx]||'var(--p1)'}" data-rarity="${rarityOf(o.card)}" data-act="${act}" data-uid="${o.card.uid}">
      <div class="top"><span class="badge e">${o.card.cost}</span><span class="badge p ${powerCls(o.card)}">${powerOf(o.card)}</span></div>
      <div class="art">${artHTML(o.card.art,o.card.name)}</div>
      <div class="nm">${esc(o.card.name)}</div>
      <div class="tx">${esc(caption!=null ? caption : fxText(o.card.fx))}</div>
    </button>`;
}

const capFirst = t => t ? t.charAt(0).toUpperCase()+t.slice(1) : t;
const sandboxBtn = () => G.sandbox ? `<button class="btn sm ghost" data-act="sheet" data-v="sandbox" title="Sandbox tools">\u{1F9EA}</button>` : '';

/** The card whose ability opened this choice, if it can be found. */
function choiceSource(ch){
  return ch && ch.ctx && ch.ctx.uid ? anyCardByUid(ch.ctx.uid) : null;
}
/** The strip across the top of every ability pop-up: which card is acting
    (tap it to read it), whose it is, and the time left to choose. */
function choiceSrcHTML(ch){
  const src = choiceSource(ch);
  const seat = src ? src.owner : (ch.owner!=null ? ch.owner : chooserOf(ch));
  const pc = PCOLORS[seat] || 'var(--p1)';
  const who = G.players[seat] ? G.players[seat].name : '';
  const body = src
    ? `<span class="cs-art">${artHTML(src.art, src.name)}</span>
       <span class="cs-txt"><b>${esc(src.name)}</b><span>${esc(who)}\u2019s ability</span></span>`
    : `<span class="cs-txt"><b>An ability</b><span>${esc(who)}</span></span>`;
  return `<div class="choice-src" style="--pc:${pc}">
    ${src ? `<button class="cs-card" data-act="peek" data-uid="${src.uid}" aria-label="Read ${esc(src.name)}">${body}</button>` : `<div class="cs-card">${body}</div>`}
    ${choiceTimerHTML()}
  </div>`;
}
/** The tab on the side of a pop-up: put the choice aside and look at the
    board (read any card, open the graveyard), then come back to it. */
function choiceSideHTML(){
  const away = UI.choicePeek===G.choice;
  return `<button class="choice-side ${away?'away':''}" data-act="choicepeek" aria-label="${away?'Back to the choice':'Look at the board'}">
    <span class="cs-ico" aria-hidden="true">${away?'\u21A9':'\u{1F441}'}</span><span class="cs-lbl">${away?'Choice':'Board'}</span>
    ${away?choiceTimerHTML(true):''}
  </button>`;
}

/** The sheet for whatever choice is open, or ''. */
function choiceSheetHTML(){
  const ch = G.choice;
  if(!ch) return '';
  if(ch.kind==='discard'){
    const victim = G.players[ch.player];
    const chooser = ch.chooser!=null ? ch.chooser : ch.player;
    const theirs = ch.player!==chooser;
    const stealing = ch.act==='steal';
    const pool = ch.f ? handPool(ch.player, ch.f, ch.ctx) : handPool(ch.player);
    const title = (stealing ? 'Steal ' : 'Discard ')+ch.left+(theirs?(stealing?' from ':' from ')+esc(victim.name)+'’s hand':'');
    const note = stealing ? 'Their hand is shown to you for this choice. The card you pick goes into your hand.'
      : theirs ? 'Their hand is shown to you for this choice. Pick a card to send to the graveyard.'
      : 'Choose a card to send to the graveyard.';
    const only = ch.f && ch.f.only ? ' Only cards that match are offered'+filterPhrase(ch.f.only).replace(/^ \(only/,' —').replace(/\)$/,'')+'.' : '';
    return `<div class="scrim"></div><div class="sheet choice">${choiceSrcHTML(ch)}
      <div class="sheet-head"><h3>${title}</h3>${sandboxBtn()}</div>
      <p class="tiny muted" style="margin-top:-6px">${note}${esc(only)}</p>
      <div class="hand" style="padding:6px 0">${pool.map(o=>choiceCardHTML(o,'pickdiscard',chooser)).join('')}</div>
    </div>`;
  }
  if(ch.kind==='pickmode'){
    const need = Math.min(ch.n, ch.live.length);
    return `<div class="scrim"></div><div class="sheet choice">${choiceSrcHTML(ch)}
      <div class="sheet-head"><h3>Choose ${NUMBER_WORDS[need]||need}</h3>${sandboxBtn()}</div>
      <p class="tiny muted" style="margin-top:-6px">Pick ${need===1?'one option':need+' options'}${ch.picked.length?' · '+ch.picked.length+' picked':''}. Greyed options have a condition that isn’t met.</p>
      <div class="stack" style="padding:6px 0">${ch.f.opts.map((o,i)=>{
        const on = ch.picked.includes(i), live = ch.live.includes(i);
        return `<button class="btn mode-opt${on?' on':''}" data-act="pickmode" data-i="${i}"${live?'':' disabled'}>
          <span class="mode-tick">${on?'✓':''}</span><span>${esc(capFirst(verbPhrase(o)))}</span></button>`;
      }).join('')}</div>
    </div>`;
  }
  if(ch.kind==='pickplayer'){
    const what = ch.zone==='hand' ? (ch.f.v==='steal' ? 'whose hand to steal from' : 'whose hand to discard from')
      : ch.zone==='side' ? 'whose side the summoned card lands on (it joins that player)'
      : 'whose cards to '+(VERB_CHOICE_LABEL[ch.f.v]||'target');
    return `<div class="scrim"></div><div class="sheet choice">${choiceSrcHTML(ch)}
      <div class="sheet-head"><h3>${ch.zone==='side'?'Summon for which player?':'Choose a player'}</h3>${sandboxBtn()}</div>
      <p class="tiny muted" style="margin-top:-6px">Pick ${esc(what)}.</p>
      <div class="stack" style="padding:6px 0">${ch.options.map(i=>`
        <button class="btn" data-act="pickplayer" data-i="${i}">
          <span class="dot" style="--pc:${PCOLORS[i]};display:inline-block;margin-right:7px"></span>${esc(G.players[i].name)}
          <span class="muted tiny" style="margin-left:auto">${G.players[i].hand.length} in hand</span></button>`).join('')}</div>
    </div>`;
  }
  if(ch.kind==='pickplanet'){
    return `<div class="scrim"></div><div class="sheet choice">${choiceSrcHTML(ch)}
      <div class="sheet-head"><h3>${ch.purpose==='summon'?'Summon on which planet?':'Move to which planet?'}</h3>${sandboxBtn()}</div>
      <p class="tiny muted" style="margin-top:-6px">${ch.purpose==='summon'
        ? 'Summoning for '+esc(G.players[ch.side].name)+'. Only planets with an open slot on that side are offered.'
        : 'Moving '+esc(ch.list.length===1?nameOf(ch.list[0]):ch.list.length+' cards')+'. Only planets with room are offered.'}</p>
      <div class="stack" style="padding:6px 0">${ch.options.map(pi=>{
        const pl = G.planets[pi], sc = planetScore(pl);
        return `<button class="btn planet-pick" data-act="movedest" data-i="${pi}">
          <span class="orb" style="--po:${pl.hue};width:26px;height:26px;font-size:13px">${artHTML(pl.art,pl.name)}</span>
          ${esc(pl.name)}<span class="muted tiny" style="margin-left:auto">${sc.map((v,i)=>`<b style="color:${PCOLORS[i]}">${v}</b>`).join(' \u00B7 ')}</span></button>`;
      }).join('')}</div>
    </div>`;
  }
  if(ch.kind==='pickcard'){
    const fromGrave = ch.purpose==='grave';
    const multi = !fromGrave && (ch.pool.some(o=>o.planetIdx!==ch.ctx.planetIdx) || new Set(ch.pool.map(o=>o.playerIdx)).size>1);
    const title = fromGrave
      ? (ch.verb==='summon' ? 'Summon which card from the graveyard?' : `Take ${ch.left>1?ch.left+' cards':'a card'} from the graveyard`)
      : ch.purpose==='swap' ? `Swap ${nameOf(ch.mover)} with which card?`
      : `Choose a card to ${VERB_CHOICE_LABEL[ch.verb]||'target'}`;
    return `<div class="scrim"></div><div class="sheet choice">${choiceSrcHTML(ch)}
      <div class="sheet-head"><h3>${esc(title)}</h3>${sandboxBtn()}</div>
      <div class="hand" style="padding:6px 0">${ch.pool.map(o=>{
        const cap = fromGrave ? 'was '+G.players[o.playerIdx].name+'\u2019s'
                  : multi ? G.players[o.playerIdx].name+' \u00B7 '+G.planets[o.planetIdx].name : null;
        return choiceCardHTML(o, 'targetcard', ch.owner, cap);
      }).join('')}</div>
    </div>`;
  }
  return '';
}



/** The sandbox bench. Opens from the 🧪 button, and on top of a choice. */
function sandboxSheetHTML(){
  const sel = clamp(UI.sbPlayer|0, 0, G.players.length-1);
  const all = LIB.cards.map(c=>[c,false]).concat(LIB.tokens.map(c=>[c,true]))
    .sort((a,b)=>a[0].name.localeCompare(b[0].name));
  const q = (UI.sbQuery||'').toLowerCase();
  return `<div class="scrim" data-act="closesheet"></div><div class="sheet sb-sheet">
    <div class="sheet-head"><h3>\u{1F9EA} Sandbox</h3>
      <button class="btn sm ghost" data-act="closesheet">${G.choice?'Back to the choice':'Close'}</button></div>
    <p class="tiny muted" style="margin-top:-6px">Changes here skip the rules: nothing is paid and no ability fires, except a real draw.</p>

    <div class="sb-group"><div class="sb-label">Energy &amp; cards</div>
      ${G.players.map(p=>`<div class="sb-row">
        <span class="dot" style="--pc:${PCOLORS[p.idx]}"></span><b>${esc(p.name)}</b>
        <span class="pill energy">⚡ ${p.energy}</span>
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm" data-act="sbenergy" data-i="${p.idx}" data-v="-1" aria-label="Remove 1 Energy">−1</button>
        <button class="btn sm" data-act="sbenergy" data-i="${p.idx}" data-v="1" aria-label="Add 1 Energy">+1</button>
        <button class="btn sm" data-act="sbenergy" data-i="${p.idx}" data-v="5" aria-label="Add 5 Energy">+5</button>
        <button class="btn sm ghost" data-act="sbdraw" data-i="${p.idx}" title="Draw from the deck (fires 'when drawn')">Draw · ${p.deck.length}</button>
      </div>`).join('')}
    </div>

    <div class="sb-group"><div class="sb-label">Add a card to a hand</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${G.players.map(p=>`
        <button class="chip ${p.idx===sel?'on':''}" data-act="sbplayer" data-i="${p.idx}">
          <span class="dot" style="--pc:${PCOLORS[p.idx]};display:inline-block"></span> ${esc(p.name)}</button>`).join('')}
        <input class="sb-search" type="search" placeholder="Search cards…" data-act="sbquery" value="${esc(UI.sbQuery||'')}" aria-label="Search cards">
      </div>
      <div class="sb-list">${all.map(([c,tok])=>`
        <button class="sb-card" data-act="sbadd" data-id="${c.id}" data-name="${esc(c.name.toLowerCase())}" data-rarity="${tok?'token':(c.rarity||'basic')}"${q && !c.name.toLowerCase().includes(q)?' hidden':''}>
          <span class="badge e">${c.cost}</span><span class="badge p">${c.power}</span>
          <span class="nm">${esc(c.name)}</span>${tok?'<span class="tiny muted">token</span>':''}</button>`).join('')}</div>
    </div>

    <div class="sb-group"><div class="sb-label">Table</div>
      <div class="row" style="gap:6px;flex-wrap:wrap">
        <button class="btn sm" data-act="sbround" data-v="-1">−</button>
        <span class="chip">Round ${G.round} of ${G.rounds}</span>
        <button class="btn sm" data-act="sbround" data-v="1">+</button>
        <span class="spacer" style="flex:1"></span>
        <button class="btn sm" data-act="sbgrave">Empty graveyard · ${G.grave.length}</button>
      </div>
      <div class="row" style="gap:6px;margin-top:8px;flex-wrap:wrap">
        <button class="btn danger" data-act="sbreset">Reset the board</button>
        <button class="btn" data-act="begin">Restart the game</button>
      </div>
      <p class="tiny muted" style="margin:6px 0 0">Reset clears every planet, the graveyard and any ability mid-way, and restarts this round’s placement. Hands, decks and Energy stay.</p>
    </div>
  </div>`;
}

/** One shared graveyard. Cards keep their last owner's colour. */
function graveSheetHTML(){
  const mine = G.grave.filter(c=>c.owner===viewerIdx()).length;
  return `<div class="scrim" data-act="closesheet"></div><div class="sheet">
    <div class="sheet-head"><h3>Graveyard \u00B7 ${G.grave.length}</h3>
      <button class="btn sm ghost" data-act="closesheet">${G.choice && UI.choicePeek!==G.choice?'Back to the choice':'Close'}</button></div>
    <p class="tiny muted" style="margin-top:-6px">Shared by every player, newest last. ${mine} of these ${mine===1?'was':'were'} yours.</p>
    <div class="hand" style="padding:6px 0">${G.grave.length
      ? G.grave.map(c=>cardHTML(c,false,false)).join('')
      : '<div class="empty-note">Nothing has gone to the graveyard yet.</div>'}</div>
  </div>`;
}

function viewOverlays(){
  let out = '';
  if(UI.screen==='game' && G && (G.online || G.isView)){ const nb = netStatusHTML(); if(nb) out += `<div class="net-banners">${nb}</div>`; }
  if(UI.screen==='game' && G && UI.transition){
    const tr = UI.transition;
    const pc = tr.pi==null ? 'var(--p1)' : PCOLORS[tr.pi];
    out += `<div class="beat" style="--pc:${pc}" role="status">
      ${tr.pi==null?'':`<span class="dot" style="--pc:${pc}"></span>`}
      <div class="beat-text">
        <div class="beat-title">${esc(tr.title)}</div>
        <div class="beat-sub">${esc(tr.sub||'')}</div>
      </div>
      <div class="beat-bar"><i></i></div>
    </div>`;
  }
  if(UI.screen==='game' && G && UI.roundScreen) return out + roundScreenHTML();
  if(UI.screen==='game' && G && UI.dice) return out + diceHTML();
  if(UI.screen==='game' && G && !G.over){
    if(UI.gate){
      const p = currentPlayer();
      const phase = G.phase==='placement' ? 'place cards' : 'reveal';
      out += `<div class="veil">
        <p>Hand the device over.</p>
        <div class="who"><span class="dot" style="--pc:${PCOLORS[p.idx]}"></span>${esc(p.name)}</div>
        <p>Round ${G.round} \u00B7 your turn to ${phase}.</p>
        <button class="btn primary" data-act="ungate">Start turn</button>
      </div>`;
      return out;
    }
    if(G.choice){
      if(UI.sheet==='peek' && UI.peek) return out + inspectSheetHTML(UI.peek);
      /* someone else is choosing (a view from the server says only that) */
      if(G.choice.waiting || (G.online && !G.isView && chooserOf(G.choice)!==NET.seat)){
        const who = chooserOf(G.choice);
        return out + `<div class="pick-banner" style="--pc:${PCOLORS[who]}" role="status">
        <div><b>${esc(G.players[who].name)} is choosing\u2026</b><span>Play carries on once they pick.</span></div>${G.isView ? netTimerHTML('choice') : choiceTimerHTML()}</div>`;
      }
      if(UI.sheet==='grave') return out + graveSheetHTML();
      if(UI.sheet==='sandbox' && G.sandbox) return out + sandboxSheetHTML();
      if(UI.choicePeek===G.choice) return out + choiceSideHTML();
      if(boardPicking()) return out + pickBannerHTML();
      const sheet = choiceSheetHTML();
      return out + sheet + (sheet ? choiceSideHTML() : '');
    }
  }

  if(UI.sheet==='log' && G){
    const items = G.log.slice(-160).map(l=> l.rd
      ? `<div class="rd">${esc(l.t)}</div>`
      : `<div>${l.who!=null?`<b style="color:${PCOLORS[l.who]}">\u25CF</b> `:''}${esc(l.t)}</div>`).join('');
    out += `<div class="scrim" data-act="closesheet"></div><div class="sheet">
      <div class="sheet-head"><h3>Game log</h3><button class="btn sm ghost" data-act="closesheet">Close</button></div>
      <div class="log">${items}</div></div>`;
  }

  if(UI.sheet==='menu' && G){
    out += `<div class="scrim" data-act="closesheet"></div><div class="sheet">
      <div class="sheet-head"><h3>Game menu</h3><button class="btn sm ghost" data-act="closesheet">Close</button></div>
      <div class="stack">
        <div class="row">
          ${G.players.map(p=>`<span class="chip"><span class="dot" style="--pc:${PCOLORS[p.idx]};display:inline-block"></span> ${esc(p.name)}${(G.online||G.isView) && p.kind!=='bot' && p.idx!==viewerIdx() ? (seatOnline(p.idx)?'':' (away)') : ''}${p.standIn?' (bot standing in)':''} \u00B7 \u26A1${p.energy} \u00B7 ${p.hand.length} in hand \u00B7 ${p.deck.length} in deck</span>`).join('')}
        </div>
        <p class="tiny muted" style="margin:0">Press and hold any card (or right-click it) to read it in full, with what its words mean.</p>
        <button class="btn" data-act="theme">Switch light / dark</button>
        <button class="btn" data-act="toggleanim">Ability animations: ${LIB.settings.anim===false?'off':'on'}</button>
        ${G.online || G.isView ? `
        <button class="btn" data-act="home">Main menu <span class="muted tiny">(the game carries on)</span></button>
        <button class="btn danger" data-on="endgame">${ON.role==='host' ? 'End the game for everyone' : 'Leave the game'}</button>` : `
        <button class="btn" data-act="begin">Restart with the same setup</button>
        <button class="btn danger" data-act="home">Quit to menu</button>`}
      </div></div>`;
  }

  if(UI.sheet==='grave' && G) out += graveSheetHTML();
  if(UI.sheet==='sandbox' && G && G.sandbox) out += sandboxSheetHTML();

  if(UI.sheet==='peek' && UI.peek) out += inspectSheetHTML(UI.peek);
  return out;
}

/* --- inspecting a card ----------------------------------------------------
   Any card you can see can be read in full at any moment: tap it when tapping
   does nothing else, or press and hold (right-click on a desktop) anywhere —
   in hand, on the board, mid-choice, mid-animation. Below the card: what each
   rules word on it means. */
const GLOSSARY = {
  givePower:['Give Power','Adds Power tokens to a card. The bonus moves with the card and is lost if it leaves the board.'],
  burn:['Burn','Takes Power away \u2014 bonus Power first, then base Power, down to 0. A burned card\u2019s Power shows in red.'],
  steal:['Steal','Takes only bonus Power (never base) from a card and gives it to another.'],
  stealCard:['Steal a card','Takes a card from an opponent\u2019s hand into yours. It\u2019s yours from then on.'],
  move:['Move','Sends a card to another planet with its bonus Power. Only planets with room count.'],
  swap:['Swap','The card goes to that planet and one of the same player\u2019s face-up cards there takes its old slot.'],
  destroy:['Destroy','From a planet to the graveyard. Bonus Power is lost.'],
  recall:['Recall','From a planet back to its owner\u2019s hand. Bonus Power is lost.'],
  draw:['Draw','From your deck \u2014 or, if it says so, out of the graveyard.'],
  gainEnergy:['Gain Energy','Adds to your Energy pool straight away.'],
  discard:['Discard','From a hand to the graveyard. Yours is your choice unless it says random.'],
  create:['Create','Puts a copy of a token card into your hand.'],
  summon:['Summon','Puts a card straight onto a planet, face up and free, and fires its on-reveal ability. Nothing happens without an open slot.'],
  choose:['Choose','Pick that many of the options; each then runs on its own. Options whose condition isn\u2019t met can\u2019t be picked.'],
  next:['The next card played','Waits until that player turns their next card over \u2014 this round or a later one.'],
  last:['The last card played','The card that player turned over most recently, if it\u2019s still on a planet.'],
  thisRound:['Each card played this round','Every card that player turns over for the rest of this round.'],
  choice:['Of your choice','You pick \u2014 never this card itself. If there\u2019s nothing else to pick, nothing happens.'],
  yoursAll:['All of your cards','Every one of your face-up cards, on every planet, this one included.'],
  creator:['The card that created this','The card whose Create or Summon made this token, if it\u2019s still on a planet.'],
  thatCard:['That card','The card the effect just before this one acted on. Several cards\u2019 values add up.'],
  inOrderTo:['In order to','The second part only happens if the first actually did something.'],
  cond:['If \u2026','Checked as the effect comes up; if it isn\u2019t true, the effect is skipped. A value read off an enemy card fails when there is none.'],
  only:['Only cards with \u2026','A filter: the effect can only pick cards that pass it.'],
  played:['Played this turn','Turned over (or summoned) during the current player\u2019s reveal turn.'],
  facedown:['Face-down cards','Abilities never see them: they can\u2019t be picked, counted or watched until they flip.'],
  activate:['Activate (\u2026)','Tap the card during your reveal turn, from the round after it was played, once per round. It costs that Energy and has that many uses in all.']
};
function glossaryFor(fx){
  const keys = [];
  const add = k => { if(GLOSSARY[k] && !keys.includes(k)) keys.push(k); };
  const walk = list => (list||[]).forEach(f=>{
    if(f.v==='steal' && f.what==='card') add('stealCard');
    else if(f.v==='move' && f.swap) add('swap');
    else add(f.v);
    const T = f.target;
    if(T && T.rule) add(T.rule);
    if(f.t==='yoursAll' || f.t==='creator') add(f.t);
    if(/^prev/.test(f.nFrom||'') || (f.if && /^prev/.test(f.if.src+' '+(f.if.valFrom||''))) || f.from==='prev') add('thatCard');
    if(f.then) add('inOrderTo');
    if(f.if) add('cond');
    if(f.only) add(f.only.stat==='playedTurn' ? 'played' : 'only');
    if(whenOf(f)==='activate') add('activate');
    if(f.opts) walk(f.opts);
  });
  walk(fx);
  /* passive and timed triggers explain themselves by their own words */
  const whens = [...new Set((fx||[]).map(whenOf).filter(w=>w!=='reveal' && w!=='activate'))];
  return keys.map(k=>GLOSSARY[k]).concat(whens.map(w=>[WHEN[w].label, w==='roundStart'||w==='roundEnd'||w==='nextRound'||w==='gameEnd'
    ? 'Fires for this card while it\u2019s face up on a planet. Cards fire in the order they were played.'
    : 'A passive ability: it waits on the card and fires right after whatever set it off.']));
}
/** The name of the card whose ability is running, kept on what it makes so the
    reader can still say who made a token after its maker has left the board. */
function creatorNameOf(ctx){
  const c = ctx && ctx.uid ? (findCardByUid(ctx.uid) || (G && G.grave.find(x=>x.uid===ctx.uid))) : null;
  return c ? c.name : null;
}
/** Token definitions a card's abilities make: Create, or Summon of a token. */
function tokensMadeBy(fx){
  const ids = [];
  const walk = list => (list||[]).forEach(f=>{
    if(f && f.tok && (f.v==='create' || (f.v==='summon' && f.from!=='grave' && f.from!=='prev')) && !ids.includes(f.tok)) ids.push(f.tok);
    if(f && f.opts) walk(f.opts);
  });
  walk(fx);
  return ids.map(defById).filter(d=>d && (LIB.tokens||[]).some(t=>t.id===d.id));
}
/** Library cards (and tokens) whose abilities make this token. */
function makersOf(tokId){
  return LIB.cards.concat(LIB.tokens||[]).filter(c=>c.id!==tokId && tokensMadeBy(c.fx).some(d=>d.id===tokId));
}
/** A card anywhere in the game, wherever it has got to. */
function anyCardByUid(uid){
  if(!G || !uid) return null;
  return findCardByUid(uid) || G.grave.find(c=>c.uid===uid) || G.players.flatMap(p=>p.deck).find(c=>c.uid===uid) || null;
}
/** One row linking to another card's reader. `uid` opens a live card,
    otherwise `def` opens a look at the library definition. */
function insLinkHTML(card, opts){
  const o = opts || {};
  const act = o.uid ? `data-act="peek" data-uid="${o.uid}"` : `data-act="peekdef" data-id="${card.id||card.def}"`;
  const power = o.uid ? powerOf(card) : (card.power!=null ? card.power : card.base);
  return `<button class="ins-link" ${act} data-rarity="${card.token?'token':rarityOf(card)}" style="--pc:${o.pc||'var(--ui-line-2)'}">
    <span class="ins-link-art">${artHTML(card.art||E('⬛'), card.name)}</span>
    <span class="ins-link-nm"><b>${esc(card.name)}</b>${o.note?`<i>${esc(o.note)}</i>`:''}</span>
    <span class="ins-link-st"><span class="badge e">${card.cost}</span><span class="badge p">${power}</span></span>
  </button>`;
}
/** Under a token: what made it. Under a card that makes tokens: those tokens. */
function insTokensHTML(card){
  let out = '';
  if(card.token){
    let rows = '';
    const maker = card.creator ? anyCardByUid(card.creator) : null;
    const seen = maker && (maker.faceUp || G.grave.includes(maker) || maker.owner===viewerIdx());
    if(maker && seen){
      const where = locate(maker.uid);
      const note = where ? 'on '+G.planets[where.planetIdx].name : G.grave.includes(maker) ? 'now in the graveyard' : 'now in a hand';
      rows = insLinkHTML(maker, {uid:maker.uid, pc:PCOLORS[maker.owner], note:esc(G.players[maker.owner].name)+' · '+note});
    }else if(card.creatorName){
      const def = LIB.cards.concat(LIB.tokens||[]).find(c=>c.name===card.creatorName);
      rows = def ? insLinkHTML(def, {note:'no longer in play'}) : `<div class="tiny muted">${esc(card.creatorName)}</div>`;
    }else{
      const makers = makersOf(card.def || card.id);
      rows = makers.length ? makers.map(m=>insLinkHTML(m)).join('')
           : '<div class="tiny muted">No card in the library makes this token.</div>';
      if(makers.length) return `<div class="ins-rel"><div class="sb-label">Made by</div>${rows}</div>`;
    }
    out += `<div class="ins-rel"><div class="sb-label">Created by</div>${rows}</div>`;
  }
  const toks = tokensMadeBy(card.fx).filter(d=>d.id!==(card.def||card.id));
  if(toks.length) out += `<div class="ins-rel"><div class="sb-label">${toks.length===1?'The token it makes':'Tokens it makes'}</div>${toks.map(d=>insLinkHTML(d)).join('')}</div>`;
  return out;
}

function inspectSheetHTML(card){
  const live = G && !card.preview;
  const owner = live && G.players[card.owner];
  const where = live ? locate(card.uid) : null;
  const inGrave = live && G.grave.includes(card);
  const place = where ? (card.faceUp ? 'On '+G.planets[where.planetIdx].name : 'Face down on '+G.planets[where.planetIdx].name)
              : inGrave ? 'In the graveyard' : 'In hand';
  const power = powerOf(card), printed = card.printed!=null ? card.printed : card.base;
  const delta = power - printed;
  const words = glossaryFor(card.fx);
  return `<div class="scrim" data-act="closesheet"></div><div class="sheet inspect">
    <div class="sheet-head">${UI.peekStack && UI.peekStack.length ? `<button class="btn sm ghost" data-act="peekback" aria-label="Back to ${esc(UI.peekStack[UI.peekStack.length-1].name)}">←</button>` : ''}<h3>${esc(card.name)}</h3><button class="btn sm ghost" data-act="closesheet">${G && G.choice && UI.choicePeek!==G.choice ? 'Back to the choice' : 'Close'}</button></div>
    <div class="preview-wrap">
      ${cardHTML(card,false,false,true)}
      <div class="stack" style="flex:1;min-width:170px;gap:8px">
        <div class="ins-tags">
          <span class="chip" data-rarity="${rarityOf(card)}"><span class="rar-dot" data-rarity="${rarityOf(card)}"></span> ${card.token?'Token':RARITIES[rarityOf(card)]}</span>
          ${owner?`<span class="chip"><span class="dot" style="--pc:${PCOLORS[owner.idx]};display:inline-block"></span> ${esc(owner.name)}</span>`:''}
          ${live?`<span class="chip">${esc(place)}</span>`:''}
        </div>
        <div class="ins-stats">
          <span><b>${card.cost}</b> Energy</span>
          <span><b>${power}</b> Power${delta?` <i class="${delta<0?'neg':'pos'}">(${printed} printed, ${delta>0?'+':''}${delta})</i>`:''}</span>
        </div>
        <div class="ins-text">${esc(fxText(card.fx) || 'No ability \u2014 just Power.')}</div>
        ${live ? peekActHTML(card) : ''}
        ${insTokensHTML(card)}
      </div>
    </div>
    ${words.length ? `<div class="ins-words">
      <div class="sb-label">What the words mean</div>
      ${words.map(([t,d])=>`<div class="ins-word"><b>${esc(t)}</b><span>${esc(d)}</span></div>`).join('')}
    </div>` : ''}
  </div>`;
}
/** Open the reader for a card, if the viewer is allowed to see it. */
function inspectCard(uid){
  if(!uid) return false;
  const card = findCardByUid(uid) || (G && G.grave.find(c=>c.uid===uid))
            || (G && G.players.flatMap(p=>p.deck).find(c=>c.uid===uid)) || null;
  if(!card) return false;
  if(G){
    const at = locate(uid);
    if(at && !card.faceUp && at.playerIdx!==viewerIdx()) return false;          // an opponent's face-down card stays secret
    const holder = G.players.find(p=>p.hand.includes(card));
    if(holder && holder.idx!==viewerIdx() && !(G.choice && G.choice.kind==='discard')) return false;
  }
  if(UI.sheet==='peek' && UI.peek && UI.peek!==card && UI.peekLink) (UI.peekStack = UI.peekStack || []).push(UI.peek);
  else if(UI.sheet!=='peek') UI.peekStack = [];
  UI.peekLink = false;
  UI.peek = card; UI.sheet = 'peek';
  render();
  return true;
}
/** Read a library card or token that isn't in the game (a token a card makes). */
function inspectDef(id){
  const def = defById(id);
  if(!def) return;
  const c = previewInstance(def, UI.peek ? UI.peek.owner : 0);
  c.preview = true;
  if(UI.sheet==='peek' && UI.peek) (UI.peekStack = UI.peekStack || []).push(UI.peek);
  UI.peek = c; UI.sheet = 'peek';
  render();
}

/** In the card sheet: what its activated ability costs, how many uses are
    left, and — on your turn, when it's ready — the button. */
function peekActHTML(card){
  const a = actSpec(card);
  if(!a || !G) return '';
  const left = usesLeft(card);
  const p = currentPlayer();
  const where = locate(card.uid);
  const yours = where && p && where.playerIdx===p.idx && p.idx===viewerIdx();
  const why = where ? actBlock(card, G.players[where.playerIdx]) : 'facedown';
  const can = yours && G.phase==='reveal' && !why && !busy() && !UI.gate;
  return `<div class="act-info">
    <div class="tiny"><b>\u2699 Activated</b> \u00B7 ${a.cost?a.cost+' Energy':'free'} \u00B7 ${left===Infinity?'unlimited uses':left+' use'+(left===1?'':'s')+' left'}</div>
    ${can ? `<button class="btn sm primary" data-act="activate" data-uid="${card.uid}">Activate${a.cost?` \u00B7 ${a.cost}\u26A1`:''}</button>`
          : `<div class="tiny muted">${esc(where ? (why ? ACT_WHY[why] : 'Ready on your reveal turn.') : 'Works once it\u2019s on a planet, face up.')}</div>`}
  </div>`;
}

/* --- RULES ----------------------------------------------------- */

function viewRules(){
  return `${topbar('How it plays')}
  <div class="page stack">
    <p>Each round every player draws a card and gains ${RULES.energyPerRound} Energy, then plays cards face down onto planets. When the round flips over, cards pay their cost and fire their ability. After ${LIB.settings.rounds} rounds, whoever holds the most planets wins.</p>

    <div class="section-head"><h3>A round, step by step</h3></div>
    <ol class="stack tiny" style="padding-left:18px;gap:8px">
      <li><b>Roll for first.</b> Everyone rolls a die. The highest goes first this round (a tie for the top rolls again), and play runs clockwise from them.</li>
      <li><b>Income.</b> Draw ${RULES.drawPerRound}, gain ${RULES.energyPerRound} Energy.</li>
      <li><b>Harvest.</b> Every card already sitting in a slot whose condition it satisfies pays that slot's reward. Round one has nothing on the board, so nothing happens.</li>
      <li><b>Placement.</b> In turn order, each player commits cards face down. You may commit anything you could afford right now, into any of your open slots, on any planet. Nothing is spent yet. At a table set to place <b>all at once</b> (online, or one human against bots), everyone places at the same time instead and locks in; nobody sees anyone else\u2019s new cards until the reveal.</li>
      <li><b>Reveal.</b> The first player turns their cards over one at a time, in whatever order they like. Each card pays its Energy as it flips, then its ability resolves. Once all of theirs are face up they can still move revealed cards between slots on the same planet and use activated abilities, then press <b>End turn</b>. Then the next player does the same.</li>
    </ol>

    <div class="section-head"><h3>Winning</h3></div>
    <p class="tiny">Add up the Power on each planet. Highest total takes it; a tie means nobody does. Most planets wins the game. Ties break on cards left in hand, then Energy left over.</p>

    <div class="section-head"><h3>Ability words</h3></div>
    <div class="stack tiny">
      <div><b>Give Power</b> — stack Power tokens on a card. The bonus travels with it.</div>
      <div><b>Burn</b> — take Power away: bonus Power goes first, then base Power, down to 0.</div>
      <div><b>Steal</b> — take <i>bonus</i> Power only (never base) from one card and give it to another; or take a card (your choice or random) out of an opponent's hand into yours. It's yours from then on.</div>
      <div><b>Move</b> — send a card to another planet, its bonus Power with it: to this card's planet, one you choose, or a random one. Only planets with room count.</div>
      <div><b>Swap</b> — Move's other version: the card goes to that planet and one of the same player's face-up cards there comes back to the slot it left. You pick which when there are several; with none, it's an ordinary move.</div>
      <div><b>Discard</b> — from a hand to the graveyard. It can be your hand or an opponent's.</div>
      <div><b>Destroy</b> — from a planet to the graveyard. Bonus Power is lost.</div>
      <div><b>Recall</b> — from a planet back to its owner's hand. Bonus Power is lost.</div>
      <div><b>Create</b> — put a token card into a hand.</div>
      <div><b>Summon</b> — put a token, or a card from the graveyard, straight onto a planet, free, and fire its ability: here, on a planet you choose, or a random one; on your side or an opponent's (it then belongs to them). <i>Summon that card</i> puts the card the previous effect touched — one you just drew, say — straight from a hand onto a planet. Nothing happens if there's no open slot.</div>
      <div><b>Choose N</b> — pick that many of the listed options; each then runs on its own, in the order listed. Options whose condition isn't met aren't offered.</div>
      <div><b>Draw</b> — from your deck, or out of the graveyard.</div>
    </div>

    <div class="section-head"><h3>Targets</h3></div>
    <div class="stack tiny">
      <div>Some abilities hit a group — <i>all of an opponent's cards here</i> (you pick which opponent when there's more than one). Others pick <b>one card</b>: first whose cards (yours, an opponent's, or a random opponent's), then which one (your choice, random, strongest, weakest, cheapest, or most expensive), here or anywhere.</div>
      <div><b>Each card played this round</b> — like the next card played, but it keeps going: every card that player turns over for the rest of the round.</div>
      <div><b>The next card played</b> waits: the effect fires when that player next turns a card over, this round or any later one. <b>The last card played</b> is the one they turned over most recently before this one, if it's still on a planet.</div>
      <div>When the choice is yours, play pauses right after the card flips so you can pick. A card already on a planet is picked right there on the board: the cards you can pick glow, everything else greys out, and a banner at the bottom says what you're choosing. Picks from a hand or the graveyard open a list instead. Choosing from an opponent's hand shows it to you.</div>
      <div><b>Of your choice</b> never means the card itself: a card can't choose itself. If there's nothing else to pick, the ability does nothing.</div>
      <div><b>Face-down cards don't exist</b> as far as abilities go: they're never targeted, counted, or "the last card played", and their passives stay asleep until they flip.</div>
      <div><b>All of your cards</b> — every one of your face-up cards, on every planet, this one included. <b>The card that created this</b> (tokens only) — the card whose Create or Summon made the token, if it's still on a planet.</div>
      <div><b>Only cards played this turn</b> — a filter for cards turned over (or summoned) during the current player's reveal turn.</div>
      <div><b>Only cards with…</b> — a filter: the ability can only pick cards whose Energy cost, Power or bonus Power meets it (<i>Energy cost at most 3</i>, <i>Power more than the cards in your hand</i>).</div>
      <div><b>A in order to B</b> — B only happens if A actually did something. Discarding with an empty hand, or destroying when there is nothing to destroy, means B never fires.</div>
    </div>

    <div class="section-head"><h3>Amounts</h3></div>
    <div class="stack tiny">
      <div>An amount can be a number, or read from the game as the ability resolves: the cards in your hand, your Energy, your deck, the graveyard, the round, your cards or enemy cards here, the planets you're winning, this card's own Power or cost, and the strongest / weakest enemy Power or highest / lowest enemy Energy cost here (0 when there are none).</div>
      <div><b>The number of those cards</b> — how many cards the previous effect acted on (discarded, destroyed, drew, moved…): discard your hand, in order to draw that many. 0 if it touched nothing.</div>
      <div><b>Its own…</b> — the target's own Energy cost, Power or bonus Power. <b>That card's…</b> — the card the previous effect touched: the one it destroyed, drew, summoned, discarded or moved.</div>
    </div>

    <div class="section-head"><h3>When abilities fire</h3></div>
    <div class="stack tiny">
      <div><b>On reveal</b> is the default. <b>Passive</b> abilities wait on the card instead: <i>when this card is drawn</i>, <i>discarded</i> or <i>destroyed</i>, or <i>whenever a card goes to / leaves the graveyard</i>. They resolve right after whatever set them off.</div>
      <div><b>Timed</b> abilities belong to face-up cards on planets: <i>at the start of each round</i> (after income and harvest), <i>at the end of each round</i> (after the last reveal), <i>at the start of the next round</i> (once, the round after the card was played) and <i>at the end of the game</i> (before the final tally). They go off in the order the cards were played — the log lists them.</div>
      <div><b>Activate (2 Energy, twice): …</b> — tap the card during your own reveal turn to use it, from the round after it was played, once per round. It costs that much Energy (no Energy, no ability) and has that many uses in all, or unlimited. Cards with one show ⚙; once every card is face up your turn waits for <b>End turn</b>, so there's always a moment to use them.</div>
      <div><b>… if X is at least N</b> — a condition, checked as the effect comes up: the round number, your Energy, your hand, the planets you're winning… If it isn't true, that effect (and anything chained to it) is skipped. A range works too: <i>if the round number is between 3 and 4</i> (both ends count).</div>
      <div>A condition or filter that reads an enemy card here (its strongest or weakest Power, highest or lowest cost) fails when there's no enemy card here at all.</div>
    </div>

    <div class="section-head"><h3>Reading a card</h3></div>
    <p class="tiny">Press and hold any card you can see (right-click with a mouse) — in your hand, on a planet, in the graveyard, mid-choice — to open it full size with its whole ability, its current and printed Power, and what each rules word on it means. Tapping a card does the same whenever a tap wouldn't do anything else. An opponent's hand and face-down cards stay hidden.</p>

    <div class="section-head"><h3>Turn timer</h3></div>
    <p class="tiny">Optional, set in setup: every human turn (placing, then revealing) gets the same time, shown in the turn bar. It pauses for hand-overs, the round screen and animations. At 10 seconds it turns red and warns you. At zero the turn finishes itself: cards you placed stay, cards still face down flip over in order, abilities you haven't activated are skipped, and any open choice is made at random.</p>

    <div class="section-head"><h3>Rarity</h3></div>
    <p class="tiny">The outline: <b>white</b> is Basic, <b style="color:var(--rar-elite)">green</b> is Elite, <b style="color:var(--rar-exotic)">purple</b> is Exotic — Exotics also glow, in hand and on the board. Tokens have no rarity and wear a <b style="color:#8a9599">dark grey</b> edge. A Power badge turns <b style="color:var(--danger)">red</b> when a card has been burned below its printed Power.</p>

    <div class="section-head"><h3>Sandbox</h3></div>
    <p class="tiny">Start one from the title screen (or tick it in setup). The \u{1F9EA} bench in the game adds or removes Energy for anyone, puts any card or token in any hand, draws for real, moves the round, empties the graveyard and resets the board — even in the middle of a choice. Hands stay visible.</p>

    <div class="section-head"><h3>The graveyard</h3></div>
    <p class="tiny">One pile, shared by everyone. Destroyed and discarded cards go there face up, and anyone can look through it any time from the \u{1FAA6} button — even mid-choice. A card drawn or summoned out of it belongs to whoever took it.</p>

    <div class="section-head"><h3>Special slots</h3></div>
    <div class="stack tiny">
      <div>\u{1F3C6} <b>Strongest wins</b> — compares the card in that exact slot across every player. Only the single strongest is paid; a tie pays nobody. While you hold a card, a 🏆 slot lights up if that card would be the strongest there — counting the cards you can see; an opponent's face-down card is still a mystery.</div>
      <div>\u2014 <b>No reward</b> — a place to hold ground that pays nothing.</div>
    </div>

    <div class="section-head"><h3>Choices this build made for you</h3><p>where the design doc left room</p></div>
    <div class="stack tiny">
      <div>Who goes first is rolled again at the start of every round: everyone rolls a die, the highest goes first (a tie for the top re-rolls), and play runs clockwise from them for both placing and revealing.</div>
      <div>Each player reveals their whole board before the next player begins.</div>
      <div>Several effects can wait on the same trigger; they run in the order they're written, after the effect that set them off finishes.</div>
      <div>A passive that needs a choice from a player other than the one taking their turn shows its choice on the shared screen.</div>
      <div>If an ability drains you below a card's cost, that card fizzles into the graveyard when it flips.</div>
      <div>Energy carries over between rounds.</div>
    </div>
  </div>`;
}

/* --- STUDIO ---------------------------------------------------- */

let studioTab = 'cards';

function viewStudio(){
  const tabs = [['cards','Cards'],['tokens','Tokens'],['planets','Planets'],['import','Import & export']];
  const flagged = LIB.cards.filter(c=>c.review).length;
  const bar = `<div class="row" style="gap:6px">${tabs.map(([k,l])=>
    `<button class="chip ${studioTab===k?'on':''}" data-act="tab" data-v="${k}">${l}${k==='cards'&&flagged?` <span class="flagdot">${flagged}</span>`:''}</button>`).join('')}</div>`;
  const body = studioTab==='planets' ? planetStudio()
             : studioTab==='import'  ? importStudio()
             : cardStudio(studioTab==='tokens');
  return `${topbar('Studio')}<div class="page stack">${bar}${body}</div>`;
}

function importStudio(){
  const parsed = UI.importRows;
  const deckOpts = LIB.decks.map(d=>`<option value="${d.id}" ${UI.importDeck===d.id?'selected':''}>${esc(d.name)}</option>`).join('');
  const sprites = LIB.cards.concat(LIB.tokens, LIB.planets).filter(c=>c.art && c.art.t==='img').length;

  /* Export: one tile per file, each with the same two actions. */
  const tile = (kind, icon, title, sub, copy) => `
    <div class="io-file">
      <span class="io-ico" aria-hidden="true">${icon}</span>
      <span class="io-nm">${title}<small>${sub}</small></span>
      <button class="btn sm primary" data-act="exportfile" data-v="${kind}">Download</button>
      ${copy?`<button class="btn sm ghost" data-act="copyfile" data-v="${kind}">Copy</button>`:''}
    </div>`;
  const exportPanel = `
  <div class="card-panel stack io-panel">
    <div class="section-head" style="margin:0"><h3>Export</h3><p>save to a file — open it in any spreadsheet</p></div>
    <div class="io-files">
      ${tile('cards', '\u{1F0CF}', 'Cards &amp; tokens <span class="kbd">.csv</span>', `${LIB.cards.length} cards · ${LIB.tokens.length} tokens · one row each, ability as text`, true)}
      ${tile('planets', '\u{1FA90}', 'Planets <span class="kbd">.csv</span>', `${LIB.planets.length} planets · a condition and a reward column per slot`, true)}
      ${tile('library', '\u{1F5C3}️', 'Whole library <span class="kbd">.json</span>', 'cards, planets, decks and sprites — a full backup', false)}
    </div>
    <label class="io-check">
      <input type="checkbox" data-act="exportsprites" ${UI.exportSprites?'checked':''}>
      <span class="tiny">Embed sprite images in the CSVs${sprites?` (${sprites} uploaded)`:''}. Off, they’re written as <span class="kbd">${SPRITE_MARK}</span> and kept on re-import — spreadsheets cut off long cells, so leave this off if you’ll edit the file.</span>
    </label>
    ${UI.exportText?`<div class="stack" style="gap:6px">
      <textarea readonly rows="6" class="io-box" aria-label="Exported file">${esc(UI.exportText)}</textarea>
      <div class="row"><span class="tiny muted" style="flex:1">${esc(UI.exportName||'')} — select all and copy it into a file.</span>
        <button class="btn sm ghost" data-act="exportclose">Close</button></div></div>`:''}
  </div>`;

  const intro = `
    <div class="section-head" style="margin:0"><h3>Import</h3><p>cards or planets — told apart by the header row</p></div>
    <p class="tiny muted" style="margin:0">Paste rows from a spreadsheet, a CSV, or a markdown table, or load a file. A file exported above reads back exactly; edit it in a spreadsheet and the changed rows are checked like anything you type.</p>
    <label class="field" style="max-width:340px"><span>Rows that match an existing card or planet (same id, or same name)</span>
      <select data-act="importmatch">
        <option value="update" ${UI.importMatch!=='copy'?'selected':''}>Update it in place</option>
        <option value="copy" ${UI.importMatch==='copy'?'selected':''}>Add it as a second copy</option>
      </select></label>
    <textarea id="csvbox" rows="7" placeholder="name, cost, power, ability&#10;Spore Drone, 1, 2,&#10;Drift Kelp, 1, 1, Give your other cards here +1 Power&#10;Husk Reaper, 4, 3, Destroy the weakest enemy here&#10;Bloomcaller, 3, 2, Summon a Sapling here">${esc(UI.importText||'')}</textarea>
    <div class="row">
      <button class="btn sm primary" data-act="readcsv">Read the table</button>
      <label class="btn sm">Load a .csv file<input type="file" accept=".csv,.tsv,.txt,text/csv" data-up="csvfile" hidden></label>
      <button class="btn sm ghost" data-act="csvsample">Paste an example</button>
      ${parsed?`<button class="btn sm ghost" data-act="csvclear">Clear</button>`:''}
    </div>
    <details class="io-help"><summary>Card columns</summary>
    <p class="tiny muted"><span class="kbd">name</span>, <span class="kbd">cost</span>, <span class="kbd">power</span>,
      <span class="kbd">ability</span>, and optionally <span class="kbd">art</span> (an emoji or a data: URL),
      <span class="kbd">rarity</span> (Basic, Elite or Exotic), <span class="kbd">type</span> (card or token),
      <span class="kbd">id</span> and <span class="kbd">fx</span> (the exact effects, written by Export). A header row is used if there is one.</p>
    <p class="tiny muted">Ability text is read against the verbs in the design doc —
      Give Power, Discard, Destroy, Recall, Create, Summon, plus Draw and Gain Energy. One card or a group:
      <i>a card of your choice</i>, <i>an enemy card here</i>, <i>your cheapest card</i>, <i>all enemy cards here</i>.
      Also <i>the next card you play</i>, <i>Move … to a planet of your choice</i>, <i>Steal all bonus Power from … and give it to …</i>,
      <i>Burn 3 Power from …</i>, <i>a random card from an opponent's hand</i>, <i>a card of your choice from the graveyard</i>.
      Chain two effects with <i>in order to</i>; read an amount from the game with <i>equal to your Energy</i>, <i>equal to that card's Power</i>, <i>equal to its own cost</i>…
      Conditions: <i>… if the round number is at least 4</i>, <i>… between 3 and 4</i>. Filters: <i>… (only cards with Energy cost at most 3)</i>.
      Options: <i>Choose one: draw a card / gain 2 Energy</i>. Passives open a sentence: <i>When this card is destroyed: …</i>,
      <i>Whenever a card goes to the graveyard: …</i>, <i>At the start of each round: …</i>, <i>At the end of the game: …</i>,
      <i>Activate (2 Energy, twice): …</i>. Summons: <i>… for an opponent on a planet of your choice</i>, <i>Draw a card, in order to summon that card here</i>.
      Also <i>each card you play this round</i>, <i>this card's Power</i>, <i>the strongest enemy Power here</i>, <i>the number of those cards</i>,
      <i>all of your cards</i>, <i>the card that created this</i>, <i>(only cards played this turn)</i>, <i>Swap this card with a card on a planet of your choice</i>.
      Anything that does not resolve cleanly still imports, flagged for review, with your original wording kept.</p></details>
    <details class="io-help"><summary>Planet columns</summary>
    <p class="tiny muted"><span class="kbd">name</span>, then <span class="kbd">slot1</span> and <span class="kbd">slot1 reward</span> through slot ${RULES.slotsPerPlayer};
      optionally <span class="kbd">id</span>, <span class="kbd">art</span> and <span class="kbd">hue</span> (a colour like #4fd6b0).
      Conditions: <i>Any card</i>, <i>Strongest wins</i>, <i>Cost &lt;= 3</i>, <i>Power &gt;= 5</i> (also ≤ ≥ &lt; &gt; =, or <i>at most</i> / <i>at least</i>).
      Rewards: <i>+2 Energy</i>, <i>Draw 1</i>, <i>None</i>.</p></details>`;

  const importPanel = body => `<div class="card-panel stack">${intro}${body||''}</div>`;
  if(!parsed) return exportPanel + importPanel();

  const rows = parsed.rows;
  const planets = parsed.kind==='planets';
  const noun = planets ? 'planet' : 'card';
  if(!rows.length) return exportPanel + importPanel(`<p class="callout">No ${noun} rows found in that table.</p>`);

  const keep = rows.filter(r=>!r.skip);
  const flagged = keep.filter(r=>r.issues.length).length;
  const updates = keep.filter(r=>r.match).length;

  /* A row that keeps its art (none in the file) shows the art it will keep. */
  const artOf = r => r.art || (r.match && (planets ? (LIB.planets.find(p=>p.id===r.match)||{}).art : (defById(r.match)||{}).art)) || null;
  const hueOf = r => r.hue || (r.match && (LIB.planets.find(p=>p.id===r.match)||{}).hue) || '#333';
  const state = r => r.issues.length ? ['warn','Check'] : r.match ? ['upd','Update'] : ['ok','New'];
  const list = rows.map((r,i)=>{
    const [cls, label] = state(r);
    const head = planets
      ? `<span class="imp-art" style="background:${hueOf(r)};border-radius:50%">${artOf(r)?artHTML(artOf(r), r.name):'·'}</span>
         <span class="imp-name">${esc(r.name)}<small>${r.slots.map(s=>esc(slotCondText(s.cond)+' → '+slotRewText(s.rew))).join(' · ')}</small></span>`
      : `<span class="imp-art">${artOf(r)?artHTML(artOf(r), r.name):'·'}</span>
         <span class="imp-name"><span class="rar-dot" data-rarity="${r.rarity||'basic'}"></span> ${esc(r.name)}${r.token?' <span class="tiny muted">token</span>':''}
           <small>${r.cost}⚡ / ${r.power}✦ · ${esc(fxText(r.fx) || 'No ability')}</small></span>`;
    return `
    <div class="imp ${r.skip?'skipped':''} ${r.issues.length?'flagged':''}">
      <div class="imp-head">${head}
        <span class="imp-state ${cls}">${label}</span>
        <button class="btn sm ghost" data-act="csvskip" data-i="${i}">${r.skip?'Include':'Skip'}</button>
      </div>
      ${r.issues.length?`<ul class="imp-issues">${r.issues.map(x=>`<li>${esc(x)}</li>`).join('')}</ul>`:''}
      ${r.issues.length&&r.abilityText?`<div class="imp-raw">Your wording is kept: ${esc(r.abilityText)}</div>`:''}
    </div>`;
  }).join('');

  const fresh = keep.length - updates;
  const verb = [fresh?`add ${fresh}`:'', updates?`update ${updates}`:''].filter(Boolean).join(', ');
  const cleanN = keep.length - flagged;
  return exportPanel + importPanel() + `
    <div class="section-head"><h3>${keep.length} ${noun}${keep.length===1?'':'s'} to import</h3>
      <p>${flagged?flagged+' need a look':'all read cleanly'}${updates?` · ${updates} update${updates===1?'':'s'} an existing one`:''}</p></div>
    ${parsed.note?`<p class="callout">${esc(parsed.note)}</p>`:''}
    <div class="imp-list">${list}</div>
    ${planets?'':`<div class="row">
      <label class="field" style="width:200px"><span>Also add new cards to a deck</span>
        <select data-act="importdeck"><option value="">Don't add to a deck</option>${deckOpts}</select></label>
    </div>`}
    <div class="row">
      <button class="btn primary" data-act="csvadd" ${keep.length?'':'disabled'}>${keep.length?capFirst(verb):'Nothing to import'}</button>
      ${flagged&&cleanN?`<button class="btn" data-act="csvaddclean">Only the ${cleanN} clean one${cleanN===1?'':'s'}</button>`:''}
    </div>`;
}

/* --- the studio's effect editor ------------------------------------------- */

/** A labelled dropdown bound to one key of effect `i`. */
function fxSelect(i, key, label, options, current){
  return `<label class="field"><span>${label}</span><select data-fx="${i}" data-key="${key}">
    ${options.map(([v,l])=>`<option value="${v}" ${String(current)===String(v)?'selected':''}>${esc(l)}</option>`).join('')}
  </select></label>`;
}

/** Whose → where → which card, for a one-card pick on a planet. `pre` is
    'target' or 'to' (Steal's recipient). */
function hierarchyFields(i, pre, T, zone){
  const rules = pre==='to' ? recipientRules() : rulesFor(zone);
  return fxSelect(i, pre+'.player', 'Whose cards', Object.entries(PLAYER_SCOPES), T.player)
    + (zone==='board' ? fxSelect(i, pre+'.here', 'Where', [['here','At this location'],['any','Anywhere']], T.here?'here':'any') : '')
    + fxSelect(i, pre+'.rule', 'Which card', rules.map(k=>[k, CARD_RULES[k].label]), T.rule);
}

/** The amount dropdown: a number, or a value read from the game. */
function amountFields(f, i){
  const label = {givePower:'Power', burn:'Power to burn', steal:'How much', draw:'How many', discard:'How many',
                 create:'How many', gainEnergy:'Energy'}[f.v] || 'Amount';
  const groups = {};
  Object.entries(AMOUNT_SOURCES).forEach(([k,src])=>{
    if(src.for && !src.for.includes(f.v)) return;
    (groups[src.group] = groups[src.group] || []).push([k, src.label]);
  });
  const cur = LEGACY_SOURCES[f.nFrom] || f.nFrom || 'fixed';
  const order = ['Target or that card','This card','You','Enemies here','Game'];
  return `<label class="field"><span>${label}</span><select data-fx="${i}" data-key="namode">
      <option value="fixed" ${cur==='fixed'?'selected':''}>A fixed number</option>
      ${order.filter(g=>groups[g]).map(g=>`<optgroup label="${g}">${groups[g].map(([k,l])=>
        `<option value="${k}" ${cur===k?'selected':''}>${esc(l)}</option>`).join('')}</optgroup>`).join('')}
    </select></label>
    ${cur==='fixed' ? `<label class="field narrow"><span>&nbsp;</span><input type="number" data-fx="${i}" data-key="n" value="${f.n==null?1:f.n}"></label>` : ''}`;
}

/** A value compared against: a fixed number, or something read from the game. */
function compareValueFields(i, pre, spec){
  const range = spec.op==='between';
  const one = (label, cur, modeKey, valKey, num) => {
    const groups = {};
    condSources().forEach(k=>{ const src = AMOUNT_SOURCES[k]; (groups[src.group] = groups[src.group]||[]).push([k, src.label]); });
    return `<label class="field"><span>${label}</span><select data-fx="${i}" data-key="${pre}.${modeKey}">
        <option value="fixed" ${cur==='fixed'?'selected':''}>A fixed number</option>
        ${Object.keys(groups).map(g=>`<optgroup label="${g}">${groups[g].map(([k,l])=>
          `<option value="${k}" ${cur===k?'selected':''}>${esc(l)}</option>`).join('')}</optgroup>`).join('')}
      </select></label>
      ${cur==='fixed' ? `<label class="field narrow"><span>&nbsp;</span><input type="number" data-fx="${i}" data-key="${pre}.${valKey}" value="${num}"></label>` : ''}`;
  };
  const lo = spec.valFrom || 'fixed', hi = spec.valFrom2 || 'fixed';
  return one(range ? 'From' : 'Than', lo, 'valmode', 'val', +spec.val||0)
    + (range ? one('To (both included)', hi, 'val2mode', 'val2', +spec.val2||0) : '')
    + [lo, range ? hi : null].filter(k=>k && helpOf(k)).filter((k,j,a)=>a.indexOf(k)===j).map(k=>`<p class="fx-help">${esc(helpOf(k))}</p>`).join('');
}
const OP_CHOICES = Object.entries(OP_WORDS);

/** A dropdown of values read from the game, in the same sections everywhere. */
function sourceSelect(i, key, label, keys, current){
  const groups = {};
  keys.forEach(k=>{ const src = AMOUNT_SOURCES[k]; (groups[src.group] = groups[src.group]||[]).push([k, src.label]); });
  return `<label class="field"><span>${label}</span><select data-fx="${i}" data-key="${key}">
    ${Object.keys(groups).map(g=>`<optgroup label="${g}">${groups[g].map(([k,l])=>`<option value="${k}" ${current===k?'selected':''}>${esc(l)}</option>`).join('')}</optgroup>`).join('')}
  </select></label>`;
}

/** The "only if" condition and the "only cards with" filter, as one strip. */
function gateFields(f, i){
  let html = fxSelect(i, 'ifmode', 'Fires', [['always','Always'],['if','Only if…']], f.if?'if':'always');
  if(f.if){
    html += sourceSelect(i, 'if.src', 'This', condSources(), f.if.src)
          + fxSelect(i, 'if.op', 'Is', OP_CHOICES, f.if.op)
          + compareValueFields(i, 'if', f.if)
          + (helpOf(f.if.src) ? `<p class="fx-help">${esc(helpOf(f.if.src))}</p>` : '');
  }
  if(filterable(f)){
    html += fxSelect(i, 'only.stat', 'Only cards with', [['none','Any card']].concat(Object.entries(CARD_STATS), Object.entries(FILTER_FLAGS)), f.only?f.only.stat:'none');
    if(f.only && !FILTER_FLAGS[f.only.stat]) html += fxSelect(i, 'only.op', 'Is', OP_CHOICES, f.only.op) + compareValueFields(i, 'only', f.only);
  }
  return `<div class="fx-gates">${html}</div>`;
}

/** `i` is the effect's path: "2" for the third effect, "2.1" for the second
    option inside it. Options are effects too, minus a trigger of their own. */
function effectRowHTML(f, i, count, nested){
  const needs = needsOf(f);
  let html = '';
  if(!nested) html += fxSelect(i, 'when', 'Trigger', Object.entries(WHEN).map(([k,w])=>[k, w.label]), whenOf(f));
  html += fxSelect(i, 'v', 'Verb', Object.entries(VERBS).filter(([k])=>!(nested && k==='choose')).map(([k,v])=>[k, v.label]), f.v);

  if(needs.includes('what')) html += fxSelect(i, 'what', 'Steal', [['power','Power from a card'],['card','A card from a hand']], f.what||'power');
  /* A card (or cards) on a planet: a whole group at once, or one card
     settled through whose -> where -> which. */
  if(needs.includes('target')){
    const sel = selectedCardDef();
    const isTok = !!(sel && sel.token);
    const mode = f.target ? 'single' : f.t==='yoursAll' ? 'mine' : 'group';
    html += fxSelect(i, 'mode', f.v==='steal' ? 'Steal from' : 'Targets',
      [['group','All matching cards'],['mine','All of your cards'],['single','One card']], mode);
    if(mode==='single') html += hierarchyFields(i, 'target', f.target, 'board');
    else if(mode==='group') html += fxSelect(i, 't', 'Target', groupTargets(isTok || f.t==='creator').map(k=>[k, k==='creator' ? TARGETS[k]+' (tokens)' : TARGETS[k]]), f.t||'self');
  }
  if(f.v==='move') html += fxSelect(i, 'swap', 'How', [['move','Move'],['swap','Swap places']], f.swap?'swap':'move');
  if(needs.includes('dest')) html += fxSelect(i, 'dest', f.swap ? 'Swap with a card on' : 'Move to', Object.entries(MOVE_DEST), f.dest||'choice');
  if(needs.includes('to')){
    const one = f.to && f.to!=='self';
    html += fxSelect(i, 'tomode', 'Give it to', [['self','This card'],['single','One card']], one?'single':'self');
    if(one) html += hierarchyFields(i, 'to', f.to, 'board');
  }
  if(needs.includes('hand')){
    const T = f.target||{player:'self',rule:'choice'};
    const scopes = f.v==='steal' ? Object.entries(PLAYER_SCOPES).filter(([k])=>k!=='self') : Object.entries(PLAYER_SCOPES);
    html += fxSelect(i, 'target.player', 'Whose hand', scopes, T.player)
          + fxSelect(i, 'target.rule', 'Which card', rulesFor('hand').map(k=>[k, CARD_RULES[k].label]), T.rule);
  }
  if(needs.includes('from')){
    const src = f.v==='summon' ? [['token','A token'],['grave','The graveyard'],['prev','That card (from a hand)']] : [['deck','Your deck'],['grave','The graveyard']];
    html += fxSelect(i, 'from', 'From', src, f.from || src[0][0]);
    if(f.from==='grave'){
      const spec = f.pick || {owner:'any', rule:'choice'};
      html += fxSelect(i, 'pick.owner', 'Whose cards', Object.entries(GRAVE_OWNERS), spec.owner)
            + fxSelect(i, 'pick.rule', 'Which card', rulesFor('grave').map(k=>[k, CARD_RULES[k].label]), spec.rule);
    }
  }
  if(needs.includes('token')) html += fxSelect(i, 'tok', 'Token', LIB.tokens.map(t=>[t.id, t.name]), f.tok);
  if(needs.includes('at'))   html += fxSelect(i, 'at', 'Where', Object.entries(SUMMON_AT), f.at||'here');
  if(needs.includes('side')) html += fxSelect(i, 'side', 'On whose side', Object.entries(SUMMON_SIDE), f.side||'self');
  if(needs.includes('amount')) html += amountFields(f, i);

  /* The price of an activated ability sits on its first effect. */
  let actBlockHTML = '';
  if(!nested && whenOf(f)==='activate'){
    const sel = selectedCardDef();
    const first = sel ? (sel.fx||[]).find(x=>whenOf(x)==='activate') : f;
    actBlockHTML = first===f
      ? `<div class="fx-act">
          <label class="field narrow"><span>Energy cost</span><input type="number" min="0" data-fx="${i}" data-key="actCost" value="${f.actCost|0}"></label>
          <label class="field narrow"><span>Uses (0 = unlimited)</span><input type="number" min="0" data-fx="${i}" data-key="actUses" value="${f.actUses|0}"></label>
          <span class="tiny muted" style="flex:1 1 180px">Tap the card during your reveal, from the round after it\u2019s played \u2014 once per round.</span>
        </div>`
      : `<p class="tiny muted" style="margin:6px 0 0">Part of the same activated ability \u2014 price and uses are set on the first one.</p>`;
  }

  let optsBlock = '';
  if(f.v==='choose'){
    const opts = f.opts||[];
    html += fxSelect(i, 'n', 'Pick', opts.map((_,k)=>[k+1, (NUMBER_WORDS[k+1]||k+1)+' of '+opts.length]), f.n||1);
    optsBlock = `<div class="fx-opts">${opts.map((o,j)=>effectRowHTML(o, i+'.'+j, opts.length, true)).join('')}
      <button class="btn sm" data-act="addopt" data-i="${i}">Add an option</button></div>`;
  }

  const thenBlock = !nested && i<count-1 ? `
    <label class="field check"><input type="checkbox" data-fx="${i}" data-key="then" ${f.then?'checked':''}>
      <span>→ only if this works, do the next effect</span></label>` : '';
  return `<div class="fx-row${nested?' fx-opt':''}">
    <div class="fx-row-say">${esc(nested ? capFirst(verbPhrase(f)) : (whenOf(f)!=='reveal' ? whenText(f)+': ' : '')+verbPhrase(f))}</div>
    <div class="fx-row-fields">${html}
      <button class="btn sm ghost danger" data-act="delfx" data-i="${i}" aria-label="Remove this ${nested?'option':'effect'}">✕</button>
      ${needs.includes('amount') && helpOf(f.nFrom) ? `<p class="fx-help">${esc(helpOf(f.nFrom))}</p>` : ''}
    </div>
    ${actBlockHTML}
    ${gateFields(f, i)}
    ${optsBlock}
    ${thenBlock}
  </div>`;
}

/** Fill in whatever a verb needs and drop what it can't use, so an effect is
    always in a state the engine and the text agree on. `nested` is an option
    inside Choose: no trigger, no chaining, and no Choose of its own. */
function normalizeFx(f, nested){
  if(nested && f.v==='choose'){ f.v = 'draw'; delete f.opts; }
  if(f.v==='steal' && f.what!=='card') f.what = 'power';
  if(f.v!=='steal') delete f.what;
  const needs = needsOf(f);
  if(needs.includes('target')){
    if(!f.target && !f.t) f.t = 'self';
    if(f.target && !rulesFor('board').includes(f.target.rule)) f.target.rule = 'choice';
  }else if(!needs.includes('hand')){ delete f.target; delete f.t; }
  if(needs.includes('hand')){
    delete f.t;
    f.target = f.target || {player: f.v==='steal' ? 'choose' : 'self', rule: f.v==='steal' ? 'random' : 'choice'};
    delete f.target.here;
    if(f.v==='steal' && f.target.player==='self') f.target.player = 'choose';
    if(!rulesFor('hand').includes(f.target.rule)) f.target.rule = 'choice';
  }
  if(!needs.includes('dest')) delete f.dest; else f.dest = f.dest || 'choice';
  if(f.v!=='move' || !f.swap) delete f.swap; else f.swap = true;
  if(!needs.includes('to')) delete f.to; else if(f.to==null) f.to = 'self';
  if(f.to && f.to!=='self' && !recipientRules().includes(f.to.rule)) f.to.rule = 'next';
  if(needs.includes('from')){
    const ok = f.v==='summon' ? ['token','grave','prev'] : ['deck','grave'];
    if(!ok.includes(f.from)) f.from = ok[0];
    if(f.from==='grave') f.pick = f.pick || {owner:'any', rule:'choice'}; else delete f.pick;
  }else{ delete f.from; delete f.pick; }
  const usesToken = needsOf(f).includes('token');
  if(usesToken){ if(!f.tok) f.tok = LIB.tokens[0] ? LIB.tokens[0].id : null; } else delete f.tok;
  if(needs.includes('at'))  { if(!SUMMON_AT[f.at]) f.at = 'here'; } else delete f.at;
  if(needs.includes('side')){ if(!SUMMON_SIDE[f.side]) f.side = 'self'; } else delete f.side;
  if(f.v==='choose'){
    if(!Array.isArray(f.opts) || !f.opts.length) f.opts = [{v:'draw', n:1}, {v:'gainEnergy', n:1}];
    f.opts = f.opts.map(o=>normalizeFx(o, true));
    f.n = clamp(parseInt(f.n,10)||1, 1, f.opts.length);
    delete f.nFrom;
  }else{
    delete f.opts;
    if(needs.includes('amount')){
      const src = AMOUNT_SOURCES[f.nFrom];
      if(f.nFrom && (!src || (src.for && !src.for.includes(f.v)))) delete f.nFrom;
      if(f.v==='steal' && f.what!=='card' && f.n==null && !f.nFrom) f.nFrom = 'all';
      if(!f.nFrom && f.n==null) f.n = 1;
    }else{ delete f.n; delete f.nFrom; }
  }
  /* condition */
  if(f.if){
    if(!condSources().includes(f.if.src)) f.if.src = 'round';
    if(!OP_WORDS[f.if.op]) f.if.op = '>=';
    if(f.if.valFrom && !condSources().includes(f.if.valFrom)) delete f.if.valFrom;
    if(f.if.valFrom) delete f.if.val; else f.if.val = +f.if.val||0;
    normalizeRange(f.if);
  }else delete f.if;
  /* filter */
  if(f.only && filterable(f) && FILTER_FLAGS[f.only.stat]){
    f.only = {stat:f.only.stat};
  }else if(f.only && filterable(f)){
    if(!CARD_STATS[f.only.stat]) f.only.stat = 'cost';
    if(!OP_WORDS[f.only.op]) f.only.op = '<=';
    if(f.only.valFrom && !condSources().includes(f.only.valFrom)) delete f.only.valFrom;
    if(f.only.valFrom) delete f.only.val; else f.only.val = +f.only.val||0;
    normalizeRange(f.only);
  }else delete f.only;
  if(nested || f.when==='reveal' || (f.when && !WHEN[f.when])) delete f.when;
  if(f.when==='activate'){
    f.actCost = Math.max(0, parseInt(f.actCost,10)||0);
    const u = parseInt(f.actUses,10)||0;
    if(u>0) f.actUses = u; else delete f.actUses;
  }else{ delete f.actCost; delete f.actUses; }
  if(nested) delete f.then;
  delete f.rand;
  return f;
}

/** A range's upper end: a number or a value read from the game. Fixed ends
    are kept low-to-high. Anything but 'between' has no upper end. */
function normalizeRange(spec){
  if(spec.op!=='between'){ delete spec.val2; delete spec.valFrom2; return; }
  if(spec.valFrom2 && !condSources().includes(spec.valFrom2)) delete spec.valFrom2;
  if(spec.valFrom2) delete spec.val2;
  else spec.val2 = spec.val2==null ? (spec.valFrom ? 0 : (+spec.val||0)) : (+spec.val2||0);
  if(!spec.valFrom && !spec.valFrom2 && spec.val2 < spec.val){ const t = spec.val; spec.val = spec.val2; spec.val2 = t; }
}

/** Chaining only links effects that fire together. */
function normalizeFxList(list){
  (list||[]).forEach((f,i)=>{
    normalizeFx(f);
    if(f.then && (i===list.length-1 || whenOf(list[i+1])!==whenOf(f))) delete f.then;
  });
  /* One activated ability per card: every activate effect shares the first one's price. */
  const acts = (list||[]).filter(f=>whenOf(f)==='activate');
  acts.slice(1).forEach(f=>{ f.actCost = acts[0].actCost; if(acts[0].actUses) f.actUses = acts[0].actUses; else delete f.actUses; });
  return list;
}

/** The effect at a studio path ("2" or "2.1"), with the list it lives in. */
function fxAtPath(sel, path){
  const parts = String(path).split('.').map(Number);
  let list = sel.fx || [], f = list[parts[0]];
  if(parts.length>1 && f){ list = f.opts || []; f = list[parts[1]]; }
  return {f, list, idx: parts[parts.length-1], parent: parts.length>1 ? sel.fx[parts[0]] : null};
}

function cardStudio(isToken){
  const arr = isToken ? LIB.tokens : LIB.cards;
  const sel = arr.find(c=>c.id===UI.editCard) || arr[0];
  if(sel) UI.editCard = sel.id;

  const list = `<div class="list">${arr.map(cd=>`
    <button class="list-item ${sel&&cd.id===sel.id?'on':''}" data-act="pickcard" data-id="${cd.id}" data-tok="${isToken?1:0}">
      <span class="thumb">${artHTML(cd.art, cd.name)}</span>
      <span class="nm"><span class="rar-dot" data-rarity="${rarityOf(cd)}" title="${RARITIES[rarityOf(cd)]}"></span> ${esc(cd.name)}${cd.review?' <span class="flagdot">check</span>':''}<small>${esc(fxText(cd.fx)||'No ability')}</small></span>
      <span class="stat">${cd.cost}\u26A1 / ${cd.power}\u2726</span>
    </button>`).join('')}</div>`;

  const add = `<div class="row"><button class="btn sm" data-act="newcard" data-tok="${isToken?1:0}">Add a ${isToken?'token':'card'}</button>
    ${sel?`<button class="btn sm" data-act="dupcard" data-tok="${isToken?1:0}">Duplicate</button>
    <button class="btn sm danger" data-act="delcard" data-tok="${isToken?1:0}">Delete</button>`:''}</div>`;

  if(!sel) return `${list}${add}`;

  const preview = previewInstance(sel, 0);
  const fxList = sel.fx || [];
  const fxRows = fxList.map((f,i)=>effectRowHTML(f, i, fxList.length)).join('');

  return `${list}${add}
  <div class="card-panel stack">
    ${sel.review?`<div class="review-note">
      <div class="review-head"><b>Imported \u2014 worth a look</b>
        <button class="btn sm ghost" data-act="clearreview" data-id="${sel.id}">Looks right</button></div>
      <ul>${(Array.isArray(sel.review)?sel.review:[sel.review]).map(x=>`<li>${esc(x)}</li>`).join('')}</ul>
      ${sel.abilityText?`<div class="tiny muted">Your wording: ${esc(sel.abilityText)}</div>`:''}
    </div>`:''}
    <div class="preview-wrap">
      <div id="preview">${cardHTML(preview,false,false,true)}</div>
      <div class="stack" style="flex:1;min-width:190px;gap:10px">
        <label class="field"><span>Name</span><input type="text" data-bind="name" value="${esc(sel.name)}"></label>
        <div class="grid2">
          <label class="field"><span>Energy cost</span><input type="number" min="0" data-bind="cost" value="${sel.cost}"></label>
          <label class="field"><span>Power</span><input type="number" data-bind="power" value="${sel.power}"></label>
        </div>
        ${isToken ? `<p class="tiny muted" style="margin:0">Tokens have no rarity \u2014 they wear a dark grey edge.</p>` : `<label class="field"><span>Rarity</span><select data-bind="rarity">${Object.entries(RARITIES).map(([k,l])=>
          `<option value="${k}" ${rarityOf(sel)===k?'selected':''}>${l}${k==='basic'?' \u00B7 white':k==='elite'?' \u00B7 green':' \u00B7 purple, glows'}</option>`).join('')}</select></label>`}
      </div>
    </div>
    <div class="row">
      <label class="field" style="flex:1"><span>Art \u2014 an emoji, or upload a sprite</span>
        <input type="text" data-bind="artemoji" value="${sel.art&&sel.art.t==='emoji'?esc(sel.art.v):''}" placeholder="\u{1F331}"></label>
      <label class="btn sm">Upload<input type="file" accept="image/*" data-up="card" hidden></label>
      ${sel.art&&sel.art.t==='img'?`<button class="btn sm ghost" data-act="clearart">Remove image</button>`:''}
    </div>
    <div>
      <div class="section-head" style="margin:4px 0 8px"><h3>Ability</h3><p>on reveal unless its trigger says otherwise</p></div>
      ${fxRows || '<p class="tiny muted" style="margin:0 0 8px">No ability. This card is vanilla.</p>'}
      <button class="btn sm" data-act="addfx">Add an effect</button>
    </div>
  </div>`;
}

function planetStudio(){
  const arr = LIB.planets;
  const sel = arr.find(p=>p.id===UI.editPlanet) || arr[0];
  if(sel) UI.editPlanet = sel.id;

  const list = `<div class="list">${arr.map(p=>`
    <button class="list-item ${sel&&p.id===sel.id?'on':''}" data-act="pickplanet" data-id="${p.id}">
      <span class="thumb" style="background:${p.hue||'#333'}">${artHTML(p.art,p.name)}</span>
      <span class="nm">${esc(p.name)}<small>${p.slots.map(s=>condShort(s.cond)+' '+rewText(s.rew)).join(' \u00B7 ')}</small></span>
    </button>`).join('')}</div>`;

  const add = `<div class="row"><button class="btn sm" data-act="newplanet">Add a planet</button>
    ${sel?`<button class="btn sm danger" data-act="delplanet">Delete</button>`:''}</div>`;
  if(!sel) return `${list}${add}`;

  const slots = sel.slots.map((s,i)=>`
    <div class="slot-edit">
      <div class="lbl">Slot ${i+1}</div>
      <div class="grid3" style="margin-bottom:7px">
        <label class="field"><span>Check</span><select data-ps="${i}" data-key="stat">
          <option value="any" ${s.cond.stat==='any'?'selected':''}>Any card</option>
          <option value="cost" ${s.cond.stat==='cost'?'selected':''}>Energy cost</option>
          <option value="power" ${s.cond.stat==='power'?'selected':''}>Power</option>
          <option value="winner" ${s.cond.stat==='winner'?'selected':''}>Strongest here wins it</option>
        </select></label>
        <label class="field"><span>Is</span><select data-ps="${i}" data-key="op" ${s.cond.stat==='any'||s.cond.stat==='winner'?'disabled':''}>
          ${OPS.map(o=>`<option value="${o}" ${s.cond.op===o?'selected':''}>${OPSYM[o]}</option>`).join('')}
        </select></label>
        <label class="field"><span>Value</span><input type="number" data-ps="${i}" data-key="val" value="${s.cond.val}" ${s.cond.stat==='any'||s.cond.stat==='winner'?'disabled':''}></label>
      </div>
      ${s.cond.stat==='winner'?`<p class="tiny muted" style="margin:2px 0 7px">Compares every player's card in this exact slot. Whoever has the most Power there gets the reward; a tie pays nobody.</p>`:''}
      <div class="grid2">
        <label class="field"><span>Reward</span><select data-ps="${i}" data-key="rtype">
          <option value="energy" ${s.rew.type==='energy'?'selected':''}>Energy</option>
          <option value="draw" ${s.rew.type==='draw'?'selected':''}>Card draw</option>
          <option value="none" ${s.rew.type==='none'?'selected':''}>No reward</option>
        </select></label>
        <label class="field"><span>Amount</span><input type="number" min="1" data-ps="${i}" data-key="ramount" value="${s.rew.amount}" ${s.rew.type==='none'?'disabled':''}></label>
      </div>
    </div>`).join('');

  return `${list}${add}
  <div class="card-panel stack">
    <div class="row">
      <div class="orb" style="--po:${sel.hue};width:52px;height:52px;font-size:24px">${artHTML(sel.art,sel.name)}</div>
      <label class="field" style="flex:1;min-width:140px"><span>Name</span><input type="text" data-pbind="name" value="${esc(sel.name)}"></label>
    </div>
    <div class="row">
      <label class="field" style="flex:1"><span>Art</span><input type="text" data-pbind="artemoji" value="${sel.art&&sel.art.t==='emoji'?esc(sel.art.v):''}"></label>
      <label class="field" style="width:92px"><span>Glow</span><input type="text" data-pbind="hue" value="${esc(sel.hue||'#4fd6b0')}"></label>
      <label class="btn sm">Upload<input type="file" accept="image/*" data-up="planet" hidden></label>
    </div>
    <div class="stack" style="gap:8px">${slots}</div>
  </div>`;
}

/* --- DECKS ----------------------------------------------------- */

function viewDecks(){
  const sel = LIB.decks.find(d=>d.id===UI.editDeck) || LIB.decks[0];
  if(sel) UI.editDeck = sel.id;
  const counts = {};
  (sel?sel.cards:[]).forEach(id=>counts[id]=(counts[id]||0)+1);

  const tabs = `<div class="row" style="gap:6px">${LIB.decks.map(d=>
    `<button class="chip ${sel&&d.id===sel.id?'on':''}" data-act="pickdeck" data-id="${d.id}">${esc(d.name)} \u00B7 ${d.cards.length}</button>`).join('')}
    <button class="chip" data-act="newdeck">+ New deck</button></div>`;

  if(!sel) return `${topbar('Decks')}<div class="page stack">${tabs}</div>`;

  const pool = LIB.cards.map(cd=>{
    const n = counts[cd.id]||0;
    return `<div class="list-item">
      <span class="thumb">${artHTML(cd.art,cd.name)}</span>
      <span class="nm">${esc(cd.name)}<small>${cd.cost}\u26A1 / ${cd.power}\u2726 \u00B7 ${esc(fxText(cd.fx)||'No ability')}</small></span>
      <button class="btn sm ghost" data-act="deckminus" data-id="${cd.id}" ${n?'':'disabled'}>\u2212</button>
      <span class="stat" style="min-width:16px;text-align:center;color:${n?'var(--ui-text)':'var(--ui-faint)'}">${n}</span>
      <button class="btn sm ghost" data-act="deckplus" data-id="${cd.id}">+</button>
    </div>`;
  }).join('');

  const curve = [0,1,2,3,4,5,6,7].map(c=>{
    const n = sel.cards.filter(id=>{const d=defById(id); return d && (c===7 ? d.cost>=7 : d.cost===c);}).length;
    return `<div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px">
      <div style="width:100%;height:${Math.max(3,n*13)}px;background:var(--ui-accent);border-radius:4px;opacity:${n?1:.18}"></div>
      <span class="tiny muted">${c===7?'7+':c}</span></div>`;
  }).join('');

  return `${topbar('Decks')}<div class="page stack">
    ${tabs}
    <div class="row">
      <label class="field" style="flex:1"><span>Deck name</span><input type="text" data-dbind="name" value="${esc(sel.name)}"></label>
      <span class="deck-count" style="align-self:flex-end;padding-bottom:9px">${sel.cards.length} cards</span>
      ${LIB.decks.length>1?`<button class="btn sm danger" style="align-self:flex-end" data-act="deldeck">Delete</button>`:''}
    </div>
    <div class="row" style="gap:4px;align-items:flex-end;height:110px">${curve}</div>
    <p class="tiny muted" style="margin:0">You draw ${RULES.startHand} to open and one per round, so about ${RULES.startHand+LIB.settings.rounds} cards get seen. Duplicates are allowed.</p>
    <div class="list">${pool}</div>
  </div>`;
}

/* --- ART & DATA ------------------------------------------------ */

function viewSprites(){
  const rows = LIB.cards.concat(LIB.tokens).map(cd=>`
    <div class="list-item">
      <span class="thumb">${artHTML(cd.art,cd.name)}</span>
      <span class="nm">${esc(cd.name)}<small>${cd.art&&cd.art.t==='img'?'custom sprite':'emoji'}</small></span>
      <label class="btn sm">Upload<input type="file" accept="image/*" data-up="byid" data-id="${cd.id}" hidden></label>
    </div>`).join('');

  const planetRows = LIB.planets.map(p=>`
    <div class="list-item">
      <span class="thumb" style="background:${p.hue}">${artHTML(p.art,p.name)}</span>
      <span class="nm">${esc(p.name)}<small>${p.art&&p.art.t==='img'?'custom sprite':'emoji'}</small></span>
      <label class="btn sm">Upload<input type="file" accept="image/*" data-up="byplanet" data-id="${p.id}" hidden></label>
    </div>`).join('');

  return `${topbar('Art &amp; data')}<div class="page stack">
    <p class="callout">Sprites are stored inside this page's own browser storage, so they travel with the artifact for you but not for anyone else. Square images read best: they are scaled to 256&nbsp;px and re-encoded on upload.</p>

    <div class="section-head"><h3>Cards</h3><p>tap Upload to replace the emoji</p></div>
    <div class="list">${rows}</div>

    <div class="section-head"><h3>Planets</h3></div>
    <div class="list">${planetRows}</div>

    <div class="section-head"><h3>Bulk sprite pack</h3><p>match art to names in one paste</p></div>
    <p class="tiny muted" style="margin:0">Paste a JSON object mapping names to images, then apply it. Names must match exactly, and the values must be <span class="kbd">data:</span> URLs \u2014 a link to an image on another site will not load once this page is published.</p>
    <textarea id="packbox" rows="5" placeholder='{ "cards": { "Spore Drone": "data:image/png;base64,..." }, "planets": { "Verdance": "data:image/png;base64,..." } }'></textarea>
    <div class="row">
      <button class="btn sm primary" data-act="applypack">Apply sprite pack</button>
      <label class="btn sm">Load a .json file<input type="file" accept=".json,application/json" data-up="packfile" hidden></label>
    </div>

    <div class="section-head"><h3>Back up everything</h3><p>cards, planets, decks, sprites</p></div>
    <div class="row">
      <button class="btn sm primary" data-act="downloadlib">Download a backup</button>
      <button class="btn sm" data-act="dumplib">Show my library JSON</button>
      <button class="btn sm" data-act="copylib">Copy to clipboard</button>
      <label class="btn sm">Restore from a file<input type="file" accept=".json,application/json" data-up="libfile" hidden></label>
      <button class="btn sm" data-act="shippedlib">Take this site\u2019s card library</button>
      <button class="btn sm danger" data-act="resetlib">Reset to the built-in set</button>
    </div>
    <textarea id="libbox" rows="6" placeholder="Your library JSON appears here. Paste one in and press Restore to load it."></textarea>
    <button class="btn sm" data-act="restorelib">Restore from the box above</button>
  </div>`;
}

/* ------------------------------------------------------------------
   8. EVENTS
   ------------------------------------------------------------------ */

function toast(msg){
  const el = document.createElement('div');
  el.textContent = msg;
  el.style.cssText = 'position:fixed;left:50%;bottom:calc(22px + env(safe-area-inset-bottom));transform:translateX(-50%);'+
    'background:var(--ui-text);color:var(--ui-bg);padding:9px 16px;border-radius:99px;z-index:90;font-size:13.5px;'+
    'box-shadow:0 8px 24px rgba(0,0,0,.28);max-width:88vw;text-align:center';
  document.body.appendChild(el);
  setTimeout(()=>el.remove(), 2600);
}

function selectedCardDef(){
  return LIB.cards.find(c=>c.id===UI.editCard) || LIB.tokens.find(c=>c.id===UI.editCard) || null;
}
function selectedPlanet(){ return LIB.planets.find(p=>p.id===UI.editPlanet) || null; }
function selectedDeck(){ return LIB.decks.find(d=>d.id===UI.editDeck) || null; }

function findCardByUid(uid){
  if(!G) return null;
  for(const p of G.players){
    const h = p.hand.find(c=>c.uid===uid); if(h) return h;
  }
  for(const pl of G.planets) for(const row of pl.board) for(const c of row) if(c && c.uid===uid) return c;
  return null;
}

function freshId(prefix){
  let n = 1, id;
  do { id = prefix+'-'+n++; } while(defById(id) || LIB.planets.some(p=>p.id===id) || LIB.decks.some(d=>d.id===id));
  return id;
}

/* ------------------------------------------------------------------
   PLACING — one resolver, used by both the tap path and the drag path
   ------------------------------------------------------------------ */

function whereIs(p, uid){
  if(p.hand.some(c=>c.uid===uid)) return {from:'hand'};
  for(let pi=0; pi<G.planets.length; pi++){
    const si = G.planets[pi].board[p.idx].findIndex(c=>c && c.uid===uid);
    if(si>=0) return {from:'board', planetIdx:pi, slotIdx:si};
  }
  return null;
}

function dropSelected(p, planetIdx, slotIdx){
  const uid = UI.sel;
  const src = uid ? whereIs(p, uid) : null;
  if(!src){ UI.sel = null; render(); return; }

  const target = G.planets[planetIdx].board[p.idx][slotIdx];
  let ok;
  if(src.from==='hand'){
    ok = dispatch({t:'place', seat:p.idx, uid, p:planetIdx, s:slotIdx}).ok;
    if(!ok){
      if(target && !committedHere(p, planetIdx, slotIdx)) toast('That card is already revealed. It stays where it is.');
      else toast('Not enough Energy for that.');
    }
  }else{
    const kind = pickupKind(p, src.planetIdx, src.slotIdx);
    const targetKind = target ? pickupKind(p, planetIdx, slotIdx) : 'empty';
    ok = dispatch({t:'move', seat:p.idx, uid, p:planetIdx, s:slotIdx}).ok;
    if(!ok){
      if(src.planetIdx!==planetIdx && (kind==='revealed' || targetKind==='revealed'))
        toast('A card that has been turned over can only change slots on its own planet.');
      else if(target && !targetKind)
        toast('That card cannot move out of the way.');
    }
  }
  UI.sel = null;
  render();
}

/* ------------------------------------------------------------------
   DRAGGING — pointer events, so one code path covers touch and mouse.
   From the hand a card is lifted upward (the row still scrolls sideways);
   on the board a committed card can be dragged anywhere it is allowed.
   ------------------------------------------------------------------ */

const DRAG = {uid:null, src:null, ghost:null, x0:0, y0:0, live:false, hot:null, raf:0, x:0, y:0,
              el:null, pid:null, home:null, kind:null};
let dragEndAt = 0;
const justDragged = () => Date.now() - dragEndAt < 260;

function draggableNow(){
  const p = currentPlayer();
  return !!(G && !G.over && p && p.kind==='human' && !UI.gate && !busy() && myTurn() && (G.phase==='placement' || rearranging()));
}

/* Press and hold any card to read it. Moving more than a few pixels (a drag or
   a scroll) cancels; the click that ends a hold that opened the reader is eaten. */
const HOLD = {timer:null, x:0, y:0, ate:false};
const holdTarget = el => {
  const c = el && el.closest('.mini[data-uid], .card[data-uid], .sb-card[data-id]');
  if(!c || c.closest('.fx-ghost,.fx-slide')) return null;
  return c.dataset.uid || null;
};
document.addEventListener('pointerdown', e=>{
  if(e.button!==undefined && e.button!==0) return;
  HOLD.ate = false;
  const uid = holdTarget(e.target);
  if(!uid || UI.screen!=='game' || !G) return;
  clearTimeout(HOLD.timer);
  HOLD.x = e.clientX; HOLD.y = e.clientY;
  HOLD.timer = setTimeout(()=>{
    HOLD.timer = null;
    if(DRAG.live) return;
    DRAG.uid = null;
    if(inspectCard(uid)) HOLD.ate = true;
  }, 450);
}, true);
window.addEventListener('pointermove', e=>{ if(HOLD.timer && Math.hypot(e.clientX-HOLD.x, e.clientY-HOLD.y) > 8){ clearTimeout(HOLD.timer); HOLD.timer = null; } }, true);
window.addEventListener('pointerup', ()=>{
  clearTimeout(HOLD.timer); HOLD.timer = null;
  if(HOLD.ate) setTimeout(()=>{ HOLD.ate = false; }, 350);    // the reader re-rendered the card, so a click may never come
}, true);
window.addEventListener('click', e=>{ if(HOLD.ate){ HOLD.ate = false; e.stopPropagation(); e.preventDefault(); } }, true);
document.addEventListener('contextmenu', e=>{
  const uid = holdTarget(e.target);
  if(uid && UI.screen==='game' && G){ e.preventDefault(); inspectCard(uid); }
});

document.addEventListener('pointerdown', e=>{
  if(e.button!==undefined && e.button!==0) return;
  const el = e.target.closest('[data-drag]');
  if(!el || !draggableNow()) return;
  DRAG.uid = el.dataset.uid;
  DRAG.src = el.dataset.drag;
  DRAG.el = el;
  DRAG.pid = e.pointerId;
  DRAG.home = (el.dataset.p!=null) ? {planetIdx:+el.dataset.p, slotIdx:+el.dataset.s} : null;
  DRAG.kind = el.dataset.kind || (DRAG.src==='hand' ? 'hand' : 'committed');
  DRAG.x0 = DRAG.x = e.clientX; DRAG.y0 = DRAG.y = e.clientY;
  DRAG.live = false;
});

window.addEventListener('pointermove', e=>{
  if(!DRAG.uid) return;
  DRAG.x = e.clientX; DRAG.y = e.clientY;
  const dx = e.clientX - DRAG.x0, dy = e.clientY - DRAG.y0;

  if(!DRAG.live){
    const far = Math.hypot(dx,dy);
    if(DRAG.src==='hand'){
      if(Math.abs(dx) > Math.abs(dy) && far > 10){ DRAG.uid = null; return; }  // that is a scroll
      if(far < 11) return;
    }else if(far < 8) return;
    startDrag();
  }
  e.preventDefault();
  moveGhost();
}, {passive:false});

window.addEventListener('pointerup', e=>{ if(DRAG.uid) endDrag(true); });
window.addEventListener('pointercancel', ()=>{ if(DRAG.uid) endDrag(false); });

function startDrag(){
  const p = currentPlayer();
  const card = findCardByUid(DRAG.uid);
  if(!p || !card){ DRAG.uid = null; return; }
  DRAG.live = true;
  UI.sel = DRAG.uid;
  UI.drag = {uid:DRAG.uid, src:DRAG.src};

  /* A touch pointer is implicitly captured by the element it started on, so the
     board is decorated in place rather than re-rendered — rebuilding the DOM
     here would take that element out from under the gesture and the drag would
     die on the first move. The capture is released as well, in case the element
     goes away for any other reason mid-drag. */
  try{
    if(DRAG.el && DRAG.pid!=null && DRAG.el.hasPointerCapture && DRAG.el.hasPointerCapture(DRAG.pid))
      DRAG.el.releasePointerCapture(DRAG.pid);
  }catch(err){}

  decorateFor(card, DRAG.kind==='revealed' && DRAG.home ? DRAG.home.planetIdx : null);
  if(DRAG.el) DRAG.el.classList.add('is-source');

  const g = document.createElement('div');
  g.className = 'drag-ghost';
  g.innerHTML = cardHTML(card, false, false);
  document.body.appendChild(g);
  DRAG.ghost = g;
  moveGhost();
  edgeScroll();
}

/** Light up the slots a given card could land on, without a re-render.
    Pass null to clear. `onlyPlanet` keeps a card that has been turned over
    from lighting up slots it is not allowed to reach. */
function decorateFor(card, onlyPlanet){
  document.querySelectorAll('.slot[data-drop]').forEach(el=>{
    el.classList.remove('open','match','plain','blocked');
    if(!card) return;
    if(onlyPlanet!=null && +el.dataset.p !== onlyPlanet){ el.classList.add('blocked'); return; }
    const met = metAt(el, card);
    if(!el.classList.contains('filled')) el.classList.add('open');
    el.classList.add(met ? 'match' : 'plain');
  });
  document.querySelectorAll('.rule[data-cond]').forEach(el=>{
    el.classList.remove('match','miss');
    if(!card) return;
    el.classList.add(metAt(el, card) ? 'match' : 'miss');
  });
  document.body.classList.toggle('dragging', !!card);
}

/** Does a card meet the slot behind this element? A 🏆 slot is judged where it is. */
function metAt(el, card){
  const cond = condFromAttr(el.dataset.cond);
  if(cond.stat==='winner' && el.dataset.p!=null && el.dataset.s!=null) return slotWins(+el.dataset.p, +el.dataset.s, card, card.owner);
  return condMet(cond, card);
}

function moveGhost(){
  if(!DRAG.ghost) return;
  DRAG.ghost.style.left = DRAG.x+'px';
  DRAG.ghost.style.top  = DRAG.y+'px';
  if(DRAG.ghost) DRAG.ghost.style.visibility = 'hidden';
  const under = document.elementFromPoint(DRAG.x, DRAG.y);
  if(DRAG.ghost) DRAG.ghost.style.visibility = '';
  let target = under && under.closest ? under.closest('[data-drop]') : null;
  if(!legalDrop(target)) target = null;
  if(target !== DRAG.hot){
    if(DRAG.hot) DRAG.hot.classList.remove('drop-hot');
    DRAG.hot = target;
    if(DRAG.hot) DRAG.hot.classList.add('drop-hot');
  }
}

/** A card already turned over stays on its planet and never returns to hand,
    so those targets never light up in the first place. */
function legalDrop(el){
  if(!el) return false;
  if(DRAG.kind!=='revealed') return true;
  if(el.dataset.drop==='hand') return false;
  return DRAG.home!=null && +el.dataset.p === DRAG.home.planetIdx;
}

/* Nudge the planet strip along when a card is held near either edge. */
function edgeScroll(){
  if(!DRAG.live){ DRAG.raf = 0; return; }
  const strip = $('.strip');
  if(strip){
    const r = strip.getBoundingClientRect();
    const edge = 56;
    if(DRAG.y > r.top && DRAG.y < r.bottom){
      if(DRAG.x < r.left + edge) strip.scrollLeft -= 12;
      else if(DRAG.x > r.right - edge) strip.scrollLeft += 12;
    }
  }
  DRAG.raf = requestAnimationFrame(edgeScroll);
}

function endDrag(commit){
  const target = DRAG.hot;
  const live = DRAG.live;
  const home = DRAG.home;
  if(DRAG.ghost) DRAG.ghost.remove();
  if(DRAG.hot) DRAG.hot.classList.remove('drop-hot');
  if(DRAG.el) DRAG.el.classList.remove('is-source');
  if(DRAG.raf) cancelAnimationFrame(DRAG.raf);
  DRAG.uid = null; DRAG.ghost = null; DRAG.hot = null; DRAG.live = false; DRAG.raf = 0;
  DRAG.el = null; DRAG.pid = null; DRAG.home = null; DRAG.kind = null;
  UI.drag = null;
  if(!live){ decorateFor(null); return; }
  dragEndAt = Date.now();

  const p = currentPlayer();
  if(!commit || !p){ UI.sel = null; render(); return; }

  const kind = target ? target.dataset.drop : null;

  if(kind==='slot'){
    const tp = +target.dataset.p, ts = +target.dataset.s;
    if(home && home.planetIdx===tp && home.slotIdx===ts){ UI.sel = null; render(); return; }  // back where it started
    dropSelected(p, tp, ts);
  }
  else if(kind==='planet'){
    /* Dropped on the planet but not squarely on a slot: take the first slot of
       yours that is free, so a near miss still lands. */
    const pi = +target.dataset.p;
    const src = whereIs(p, UI.sel);
    const revealed = src && src.from==='board' && pickupKind(p, src.planetIdx, src.slotIdx)==='revealed';
    if(revealed && src.planetIdx!==pi){
      UI.sel = null; render();
      toast('A card that has been turned over can only change slots on its own planet.');
    }else{
      const free = G.planets[pi].board[p.idx].indexOf(null);
      if(free>=0) dropSelected(p, pi, free);
      else { UI.sel = null; render(); toast('No free slot of yours on '+G.planets[pi].name+'.'); }
    }
  }
  else if(kind==='hand'){
    const src = whereIs(p, UI.sel);
    if(src && src.from==='board'){
      if(pickupKind(p, src.planetIdx, src.slotIdx)==='committed') dispatch({t:'unplace', seat:p.idx, uid:UI.sel});
      else toast('That card has already been paid for and turned over. It stays on its planet.');
    }
    UI.sel = null; render();
  }
  else { UI.sel = null; render(); }            // dropped on nothing: put it back
}

const BOARD_ACTS = {hand:1, drop:1, takeback:1, endturn:1, flip:1, autoflip:1, peekboard:1, lift:1, tohand:1};

document.addEventListener('click', e=>{
  const t = e.target.closest('[data-act]');
  if(!t) return;
  const a = t.dataset.act;
  const p = currentPlayer();

  if(justDragged()) return;                       // the drag already did the work
  if(BOARD_ACTS[a] && (UI.transition || UI.flipAnim)) return;

  switch(a){
    /* navigation */
    case 'home': UI.screen='title'; UI.sheet=null; render(); break;
    case 'go': UI.screen = t.dataset.screen; UI.sheet=null; render(); break;
    case 'tab': studioTab = t.dataset.v; render(); break;
    case 'sheet': UI.sheet = t.dataset.v; render(); break;
    case 'closesheet': UI.sheet=null; UI.peek=null; UI.peekStack=[]; render(); break;
    case 'peekdef': inspectDef(t.dataset.id); break;
    case 'choicepeek': if(G && G.choice){ UI.choicePeek = UI.choicePeek===G.choice ? null : G.choice; UI.sheet = null; UI.peek = null; UI.sel = null; render(); } break;
    case 'peekback': { const back = UI.peekStack && UI.peekStack.pop(); if(back){ UI.peek = back; render(); } break; }
    case 'theme': {
      const cur = document.documentElement.dataset.theme;
      const next = cur==='dark' ? 'light' : cur==='light' ? '' : 'light';
      if(next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
      try{ localStorage.setItem(KEY+'.theme', next); }catch(err){}
      break;
    }

    /* setup */
    case 'kind': {
      const i = +t.dataset.i;
      LIB.settings.kinds[i] = t.dataset.v; save(); render(); break;
    }
    case 'begin': UI.screen='game'; UI.sheet=null; newGame(); break;
    case 'placement': LIB.settings.placement = t.dataset.v; saveSoon(); render(); break;

    /* placement */
    case 'hand': {
      if(!G) break;
      if(!p || G.choice){ inspectCard(t.dataset.uid); break; }   // locked in, not your turn, or a choice set aside: just read it
      const card = findCardByUid(t.dataset.uid);
      if(G.phase!=='placement'){ inspectCard(card && card.uid); break; }
      UI.sel = (UI.sel === t.dataset.uid) ? null : t.dataset.uid;
      render(); break;
    }
    case 'drop': {
      if(!G || !p || !UI.sel) break;
      dropSelected(p, +t.dataset.p, +t.dataset.s);
      break;
    }
    case 'lift': {
      if(!G || !p) break;
      UI.sel = (UI.sel === t.dataset.uid) ? null : t.dataset.uid;
      render(); break;
    }
    case 'tohand': {
      if(!G || !p || !UI.sel) break;
      const src = whereIs(p, UI.sel);
      if(src && src.from==='board') dispatch({t:'unplace', seat:p.idx, uid:UI.sel});
      UI.sel = null; render(); break;
    }
    case 'takeback': {
      if(!G || !p) break;
      { const c = G.planets[+t.dataset.p] && G.planets[+t.dataset.p].board[p.idx][+t.dataset.s];
        if(c) dispatch({t:'unplace', seat:p.idx, uid:c.uid}); }
      UI.sel = null; render(); break;
    }
    case 'endturn': if(G && p) dispatch({t:'lock', seat:p.idx}); break;

    /* reveal */
    case 'flip': if(!p) break; UI.justFlipped=null; dispatch({t:'flip', seat:p.idx, uid:t.dataset.uid}); break;
    case 'activate': {
      if(!p) break;
      const r = dispatch({t:'activate', seat:p.idx, uid:t.dataset.uid});
      if(!r.ok && r.why==='illegal'){ const o = locate(t.dataset.uid), why = o && actBlock(o.card, p); if(why) toast(ACT_WHY[why]); }
      break;
    }
    case 'endreveal': endRevealTap(); break;
    case 'toggleanim': LIB.settings.anim = LIB.settings.anim===false; saveSoon(); if(LIB.settings.anim===false) fxReset(); render(); break;
    case 'autoflip': autoFlipAll(); break;
    case 'peekboard': UI.peekBoard = !UI.peekBoard; render(); break;
    case 'pickdiscard': dispatch({t:'choose', seat:uiSeat(), uid:t.dataset.uid}); break;
    case 'pickplayer': dispatch({t:'choose', seat:uiSeat(), i:+t.dataset.i}); break;
    case 'movedest': dispatch({t:'choose', seat:uiSeat(), i:+t.dataset.i}); break;
    case 'pickmode': dispatch({t:'choose', seat:uiSeat(), i:+t.dataset.i}); break;
    case 'sbenergy': dispatch({t:'sandbox', seat:sbSeat(), op:'energy', i:+t.dataset.i, v:+t.dataset.v}); break;
    case 'sbdraw': dispatch({t:'sandbox', seat:sbSeat(), op:'draw', i:+t.dataset.i}); break;
    case 'sbplayer': UI.sbPlayer = +t.dataset.i; render(); break;
    case 'sbadd': dispatch({t:'sandbox', seat:sbSeat(), op:'add', i:clamp(UI.sbPlayer|0,0,G.players.length-1), id:t.dataset.id}); break;
    case 'sbround': dispatch({t:'sandbox', seat:sbSeat(), op:'round', v:+t.dataset.v}); break;
    case 'sbgrave': dispatch({t:'sandbox', seat:sbSeat(), op:'grave'}); break;
    case 'sbreset': UI.sheet = null; dispatch({t:'sandbox', seat:sbSeat(), op:'reset'}); break;
    case 'newgame': LIB.settings.sandbox = t.dataset.v==='1'; saveSoon(); UI.screen='setup'; UI.sheet=null; render(); break;
    case 'targetcard': dispatch({t:'choose', seat:uiSeat(), uid:t.dataset.uid}); break;
    case 'peek': UI.peekLink = UI.sheet==='peek'; inspectCard(t.dataset.uid); break;
    case 'ungate': UI.gate=false; afterStateChange(); break;
    case 'roundgo': if(UI.roundGo) UI.roundGo(); break;
    case 'dicego': if(UI.diceGo) UI.diceGo(); break;

    /* after the game */
    case 'review': UI.review = true; UI.sheet = null; render(); break;
    case 'closereview': UI.review = false; render(); break;
    case 'reviewseat': UI.reviewSeat = +t.dataset.i; render(); break;
    case 'goplanet': {
      const el = document.querySelectorAll('.planet')[+t.dataset.p];
      if(el){
        el.scrollIntoView({behavior:'smooth', inline:'center', block:'nearest'});
        el.classList.add('ping'); setTimeout(()=>el.classList.remove('ping'), 700);
      }
      break;
    }

    /* studio — cards */
    case 'pickcard': UI.editCard = t.dataset.id; render(); break;
    case 'newcard': {
      const isTok = t.dataset.tok==='1';
      const id = freshId(isTok?'token':'card');
      const def = {id, name:isTok?'New token':'New card', cost:2, power:3, art:E('\u2B50'), fx:[], token:isTok};
      (isTok?LIB.tokens:LIB.cards).push(def);
      UI.editCard = id; save(); render(); break;
    }
    case 'dupcard': {
      const sel = selectedCardDef(); if(!sel) break;
      const isTok = t.dataset.tok==='1';
      const copy = clone(sel); copy.id = freshId(isTok?'token':'card'); copy.name = sel.name+' copy';
      (isTok?LIB.tokens:LIB.cards).push(copy);
      UI.editCard = copy.id; save(); render(); break;
    }
    case 'delcard': {
      const sel = selectedCardDef(); if(!sel) break;
      const isTok = t.dataset.tok==='1';
      const arr = isTok?LIB.tokens:LIB.cards;
      arr.splice(arr.findIndex(c=>c.id===sel.id),1);
      LIB.decks.forEach(d=>{ d.cards = d.cards.filter(id=>id!==sel.id); });
      UI.editCard = arr.length?arr[0].id:null; save(); render(); break;
    }
    case 'addfx': {
      const sel = selectedCardDef(); if(!sel) break;
      sel.fx = sel.fx||[]; sel.fx.push(normalizeFx({v:'givePower', t:'self', n:1}));
      save(); render(); break;
    }
    case 'delfx': {
      const sel = selectedCardDef(); if(!sel) break;
      const at = fxAtPath(sel, t.dataset.i);
      if(at.parent && at.list.length<=1){ toast('Choose needs at least one option.'); break; }
      at.list.splice(at.idx,1);
      if(at.parent) normalizeFx(at.parent);
      normalizeFxList(sel.fx); save(); render(); break;
    }
    case 'addopt': {
      const sel = selectedCardDef(); if(!sel) break;
      const f = fxAtPath(sel, t.dataset.i).f; if(!f || f.v!=='choose') break;
      f.opts.push(normalizeFx({v:'givePower', t:'self', n:1}, true));
      save(); render(); break;
    }
    case 'clearart': {
      const sel = selectedCardDef(); if(!sel) break;
      sel.art = E('\u2B50'); save(); render(); break;
    }
    case 'clearreview': {
      const sel = defById(t.dataset.id); if(!sel) break;
      delete sel.review; save(); render(); break;
    }

    /* studio — importing a table */
    case 'readcsv': {
      const box = $('#csvbox');
      UI.importText = box ? box.value : '';
      UI.importRows = readImportTable(UI.importText);
      render();
      const flagged = UI.importRows.rows.filter(r=>r.issues.length).length;
      const noun = UI.importRows.kind==='planets' ? 'planet' : 'card';
      if(!UI.importRows.rows.length) toast(`No ${noun} rows in that table.`);
      else if(flagged) toast(`${flagged} of ${UI.importRows.rows.length} need a look.`);
      else toast(`${UI.importRows.rows.length} ${noun}s read cleanly.`);
      break;
    }
    case 'csvsample': {
      UI.importText = SAMPLE_TABLE;
      UI.importRows = readImportTable(UI.importText);
      render(); break;
    }
    case 'csvclear': { UI.importRows = null; UI.importText = ''; render(); break; }
    case 'csvskip': {
      if(!UI.importRows) break;
      const r = UI.importRows.rows[+t.dataset.i];
      if(r) r.skip = !r.skip;
      render(); break;
    }
    case 'csvadd':
    case 'csvaddclean': {
      if(!UI.importRows) break;
      const cleanOnly = a==='csvaddclean';
      const parsed = UI.importRows;
      const take = parsed.rows.filter(r=>!r.skip && (!cleanOnly || !r.issues.length));
      if(!take.length){ toast('Nothing selected to import.'); break; }
      const res = commitImport(parsed, take, parsed.kind==='planets' ? null : UI.importDeck);
      parsed.rows = parsed.rows.filter(r=>!take.includes(r));
      if(!parsed.rows.length){ UI.importRows = null; UI.importText = ''; }
      if(res.firstFlagged){ studioTab = res.firstKind; UI.editCard = res.firstFlagged; }   // straight to the first one to check
      save(); render();
      const noun = parsed.kind==='planets' ? 'planet' : 'card';
      const parts = [res.added?`Added ${res.added}`:'', res.updated?`${res.added?'updated':'Updated'} ${res.updated}`:''].filter(Boolean).join(', ');
      toast(parts + ` ${noun}${take.length===1?'':'s'}.` + (res.flagged ? ` ${res.flagged} flagged for review.` : ''));
      break;
    }
    case 'exportfile': { const f = exportFile(t.dataset.v); saveFile(f.name, f.text); break; }
    case 'copyfile': { const f = exportFile(t.dataset.v); copyText(f.text, t.dataset.v==='planets'?'Planets':'Cards'); break; }
    case 'exportclose': UI.exportText = ''; UI.exportName = ''; render(); break;
    case 'downloadlib': { const f = exportFile('library'); saveFile(f.name, f.text); break; }

    /* studio — planets */
    case 'pickplanet': UI.editPlanet = t.dataset.id; render(); break;
    case 'newplanet': {
      const id = freshId('planet');
      LIB.planets.push({id, name:'New planet', art:E('\u{1FA90}'), hue:'#4fd6b0',
        slots:[{cond:any(),rew:rE(1)},{cond:any(),rew:rE(1)},{cond:any(),rew:rD(1)}]});
      UI.editPlanet = id; save(); render(); break;
    }
    case 'delplanet': {
      const sel = selectedPlanet(); if(!sel || LIB.planets.length<=1) break;
      LIB.planets.splice(LIB.planets.findIndex(p2=>p2.id===sel.id),1);
      LIB.settings.planets = clamp(LIB.settings.planets,1,LIB.planets.length);
      UI.editPlanet = LIB.planets[0].id; save(); render(); break;
    }

    /* decks */
    case 'pickdeck': UI.editDeck = t.dataset.id; render(); break;
    case 'newdeck': {
      const id = freshId('deck');
      LIB.decks.push({id, name:'Deck '+(LIB.decks.length+1), cards:clone(DEFAULT_DECK)});
      UI.editDeck = id; save(); render(); break;
    }
    case 'deldeck': {
      const sel = selectedDeck(); if(!sel || LIB.decks.length<=1) break;
      LIB.decks.splice(LIB.decks.findIndex(d=>d.id===sel.id),1);
      LIB.settings.deckOf = LIB.settings.deckOf.map(id=> id===sel.id ? LIB.decks[0].id : id);
      UI.editDeck = LIB.decks[0].id; save(); render(); break;
    }
    case 'deckplus': { const d = selectedDeck(); if(d){ d.cards.push(t.dataset.id); save(); render(); } break; }
    case 'deckminus': {
      const d = selectedDeck(); if(!d) break;
      const i = d.cards.lastIndexOf(t.dataset.id);
      if(i>=0){ d.cards.splice(i,1); save(); render(); } break;
    }

    /* art & data */
    case 'applypack': applyPack($('#packbox').value); break;
    case 'dumplib': $('#libbox').value = JSON.stringify(LIB, null, 1); break;
    case 'copylib': {
      const txt = JSON.stringify(LIB);
      if(navigator.clipboard) navigator.clipboard.writeText(txt).then(()=>toast('Library copied.'),()=>toast('Copy blocked — use the box below.'));
      else { $('#libbox').value = txt; toast('Copied into the box below.'); }
      break;
    }
    case 'restorelib': {
      try{
        const data = JSON.parse($('#libbox').value);
        if(!data.cards || !data.planets) throw 0;
        adoptLibrary(data); save(); render(); toast(`Library restored: ${LIB.cards.length} cards, ${LIB.planets.length} planets, ${LIB.decks.length} decks.`);
      }catch(err){ toast('That JSON did not look like a Territory library.'); }
      break;
    }
    case 'shippedlib': {
      if(!t.dataset.sure){ t.dataset.sure='1'; t.textContent='Tap again \u2014 this replaces your cards, decks and sprites'; break; }
      fetchShippedLibrary().then(data=>{
        if(!data){ toast('This copy of the game has no card library of its own.'); return; }
        adoptLibrary(data); fillSettings(); save(); render();
        toast(`Library loaded: ${LIB.cards.length} cards, ${LIB.decks.length} decks.`);
      });
      break;
    }
    case 'resetlib': {
      if(!t.dataset.sure){ t.dataset.sure='1'; t.textContent='Tap again to wipe everything'; break; }
      LIB = blankLibrary(); save(); render(); toast('Back to the built-in set.'); break;
    }
  }
});

/* --- form editing ----------------------------------------------- */

function onEdit(e, isChange){
  const el = e.target;
  const d = el.dataset;
  let structural = false;

  if(d.bind){
    const sel = selectedCardDef(); if(!sel) return;
    if(d.bind==='name') sel.name = el.value;
    if(d.bind==='cost') sel.cost = clamp(parseInt(el.value||'0',10)||0, 0, 99);
    if(d.bind==='power') sel.power = clamp(parseInt(el.value||'0',10)||0, -99, 999);
    if(d.bind==='artemoji' && el.value.trim()) sel.art = E(el.value.trim());
    if(d.bind==='rarity'){ if(el.value==='basic') delete sel.rarity; else sel.rarity = el.value; }
    const pv = $('#preview'); if(pv) pv.innerHTML = cardHTML(previewInstance(sel,0),false,false,true);
    saveSoon(); if(isChange) render(); return;
  }
  if(d.pbind){
    const sel = selectedPlanet(); if(!sel) return;
    if(d.pbind==='name') sel.name = el.value;
    if(d.pbind==='hue') sel.hue = el.value;
    if(d.pbind==='artemoji' && el.value.trim()) sel.art = E(el.value.trim());
    saveSoon(); if(isChange) render(); return;
  }
  if(d.dbind){
    const sel = selectedDeck(); if(!sel) return;
    sel.name = el.value; saveSoon(); if(isChange) render(); return;
  }
  if(d.fx!=null && d.key){
    const sel = selectedCardDef(); if(!sel) return;
    const at = fxAtPath(sel, d.fx), f = at.f; if(!f) return;
    const k = d.key, val = el.value;
    const quick = (k==='n' && f.v!=='choose') || k==='if.val' || k==='only.val' || k==='if.val2' || k==='only.val2' || k==='actCost' || k==='actUses';
    if(quick){
      const num = parseInt(val||'0',10)||0;
      if(k==='n') f.n = num;
      else if(k==='actCost' || k==='actUses'){ f[k] = Math.max(0, num); normalizeFxList(sel.fx); }
      else f[k.split('.')[0]][k.split('.')[1]] = num;
      const pv=$('#preview'); if(pv) pv.innerHTML = cardHTML(previewInstance(sel,0),false,false,true);
      const say = el.closest('.fx-row') && el.closest('.fx-row').querySelector('.fx-row-say');
      if(say) say.textContent = at.parent ? capFirst(verbPhrase(f)) : (whenOf(f)!=='reveal' ? whenText(f)+': ' : '')+verbPhrase(f);
      saveSoon(); if(isChange) render(); return;
    }
    if(k==='then') f.then = el.checked;
    else if(k==='mode'){
      if(val==='single'){ f.target = f.target || {player:'self', here:false, rule:'choice'}; delete f.t; }
      else if(val==='mine'){ f.t = 'yoursAll'; delete f.target; }
      else { f.t = (f.t && f.t!=='yoursAll') ? f.t : 'self'; delete f.target; }
    }
    else if(k==='swap'){ if(val==='swap') f.swap = true; else delete f.swap; }
    else if(k==='tomode') f.to = val==='single' ? {player:'self', here:false, rule:'choice'} : 'self';
    else if(k==='namode'){ if(val==='fixed'){ delete f.nFrom; if(f.n==null) f.n = 1; } else f.nFrom = val; }
    else if(k==='ifmode'){ if(val==='if') f.if = f.if || {src:'round', op:'>=', val:3}; else delete f.if; }
    else if(k==='only.stat' && val==='none') delete f.only;
    else if(k==='only.stat' && FILTER_FLAGS[val]) f.only = {stat:val};
    else if(k==='only.stat' && (!f.only || FILTER_FLAGS[f.only.stat])) f.only = {stat:val, op:'<=', val:3};
    else if(k==='if.valmode' || k==='only.valmode'){
      const o = f[k.split('.')[0]]; if(!o) return;
      if(val==='fixed'){ delete o.valFrom; o.val = o.val||0; } else { o.valFrom = val; delete o.val; }
    }
    else if(k==='if.val2mode' || k==='only.val2mode'){
      const o = f[k.split('.')[0]]; if(!o) return;
      if(val==='fixed'){ delete o.valFrom2; o.val2 = o.val2||0; } else { o.valFrom2 = val; delete o.val2; }
    }
    else if(k==='n') f.n = parseInt(val,10)||1;
    else if(k==='what'){ f.what = val; delete f.target; delete f.t; delete f.to; delete f.n; delete f.nFrom; }
    else if(k.includes('.')){
      const [obj, field] = k.split('.');
      if(typeof f[obj]!=='object' || !f[obj]) f[obj] = {};
      f[obj][field] = field==='here' ? (val==='here') : val;
    }
    else f[k] = val;
    if(k==='v' && f.v==='steal' && !f.nFrom && f.n===1) delete f.n;   // a fresh steal takes it all
    normalizeFx(f, !!at.parent);
    if(at.parent) normalizeFx(at.parent);
    normalizeFxList(sel.fx);
    saveSoon(); render(); return;
  }
  if(d.ps!=null && d.key){
    const sel = selectedPlanet(); if(!sel) return;
    const s = sel.slots[+d.ps]; if(!s) return;
    if(d.key==='stat'){ s.cond.stat = el.value; structural = true; }
    if(d.key==='op') s.cond.op = el.value;
    if(d.key==='val') s.cond.val = parseInt(el.value||'0',10)||0;
    if(d.key==='rtype') s.rew.type = el.value;
    if(d.key==='ramount') s.rew.amount = clamp(parseInt(el.value||'1',10)||1, 1, 9);
    saveSoon(); if(isChange || structural) render(); return;
  }
  if(d.act==='set'){
    const k = d.k, v = parseInt(el.value,10);
    LIB.settings[k] = v;
    if(k==='players'){
      for(let i=0;i<v;i++){
        if(!LIB.settings.kinds[i]) LIB.settings.kinds[i] = i===0?'human':'bot';
        if(!LIB.settings.deckOf[i]) LIB.settings.deckOf[i] = LIB.decks[Math.min(i,LIB.decks.length-1)].id;
      }
    }
    saveSoon(); render(); return;
  }
  if(d.act==='importdeck'){ UI.importDeck = el.value; return; }
  if(d.act==='importmatch'){
    UI.importMatch = el.value;
    if(UI.importRows && UI.importText) UI.importRows = readImportTable(UI.importText);   // re-read: matches change what's flagged
    render(); return;
  }
  if(d.act==='exportsprites'){ UI.exportSprites = el.checked; return; }
  if(d.act==='seatdeck'){ LIB.settings.deckOf[+d.i] = el.value; saveSoon(); return; }
  if(d.act==='hide'){ LIB.settings.hide = el.checked; saveSoon(); return; }
  if(d.act==='sandbox'){ LIB.settings.sandbox = el.checked; saveSoon(); render(); return; }
  if(d.act==='timerpreset'){
    LIB.settings.turnTimerCustom = el.value==='custom';
    if(el.value!=='custom') LIB.settings.turnTimer = parseInt(el.value,10)||0;
    else if(!LIB.settings.turnTimer) LIB.settings.turnTimer = 60;
    saveSoon(); render(); return;
  }
  if(d.act==='timersecs'){
    if(!isChange) return;
    LIB.settings.turnTimer = clamp(parseInt(el.value,10)||60, 10, 900);
    saveSoon(); render(); return;
  }
  if(d.act==='sbquery'){
    UI.sbQuery = el.value; const q = el.value.toLowerCase();
    document.querySelectorAll('.sb-card').forEach(b=>{ b.hidden = !!q && !b.dataset.name.includes(q); });
    return;
  }
}
document.addEventListener('input',  e=>onEdit(e,false));
document.addEventListener('change', e=>{ if(e.target.dataset.up) return; onEdit(e,true); });

/* --- sprite uploads --------------------------------------------- */

function readImage(file, cb){
  const fr = new FileReader();
  fr.onerror = ()=>toast('That file could not be read.');
  fr.onload = ()=>{
    const img = new Image();
    img.onerror = ()=>toast('That image could not be decoded.');
    img.onload = ()=>{
      const S = 256, cv = document.createElement('canvas');
      cv.width = cv.height = S;
      const ctx = cv.getContext('2d');
      const scale = Math.max(S/img.width, S/img.height);
      const w = img.width*scale, h = img.height*scale;
      ctx.drawImage(img, (S-w)/2, (S-h)/2, w, h);
      let out = cv.toDataURL('image/webp', .85);
      if(out.indexOf('data:image/webp')!==0) out = cv.toDataURL('image/png');
      cb(out);
    };
    img.src = fr.result;
  };
  fr.readAsDataURL(file);
}

document.addEventListener('change', e=>{
  const el = e.target;
  if(!el.dataset.up) return;
  const file = el.files && el.files[0];
  if(!file) return;
  const kind = el.dataset.up;

  if(kind==='csvfile'){
    const fr = new FileReader();
    fr.onload = ()=>{
      UI.importText = String(fr.result||'');
      UI.importRows = readImportTable(UI.importText);
      render();
      const n = UI.importRows.rows.length;
      const flagged = UI.importRows.rows.filter(r=>r.issues.length).length;
      toast(n ? (flagged ? `${n} rows read, ${flagged} need a look.` : `${n} rows read cleanly.`) : 'No rows in that file.');
    };
    fr.readAsText(file);
    el.value = '';
    return;
  }

  if(kind==='packfile' || kind==='libfile'){
    const fr = new FileReader();
    fr.onload = ()=>{
      if(kind==='packfile'){ $('#packbox').value = fr.result; applyPack(fr.result); }
      else {
        try{
          const data = JSON.parse(fr.result);
          if(!data.cards || !data.planets) throw 0;
          adoptLibrary(data); save(); render(); toast(`Library restored: ${LIB.cards.length} cards, ${LIB.planets.length} planets, ${LIB.decks.length} decks.`);
        }catch(err){ toast('That file is not a Territory library.'); }
      }
    };
    fr.readAsText(file);
    el.value = '';
    return;
  }

  readImage(file, url=>{
    if(kind==='card'){ const s=selectedCardDef(); if(s) s.art={t:'img',v:url}; }
    else if(kind==='planet'){ const s=selectedPlanet(); if(s) s.art={t:'img',v:url}; }
    else if(kind==='byid'){ const s=defById(el.dataset.id); if(s) s.art={t:'img',v:url}; }
    else if(kind==='byplanet'){ const s=LIB.planets.find(p=>p.id===el.dataset.id); if(s) s.art={t:'img',v:url}; }
    try{ save(); }catch(err){}
    render();
    toast('Sprite applied.');
  });
  el.value = '';
});

function applyPack(text){
  let data;
  try{ data = JSON.parse(text); }catch(err){ return toast('That is not valid JSON.'); }
  let n = 0;
  const all = LIB.cards.concat(LIB.tokens);
  Object.entries(data.cards||{}).forEach(([name,url])=>{
    const c = all.find(x=>x.name===name);
    if(c && typeof url==='string'){ c.art = {t:'img', v:url}; n++; }
  });
  Object.entries(data.planets||{}).forEach(([name,url])=>{
    const p = LIB.planets.find(x=>x.name===name);
    if(p && typeof url==='string'){ p.art = {t:'img', v:url}; n++; }
  });
  save(); render();
  toast(n ? `Applied ${n} sprite${n===1?'':'s'}.` : 'No names in that pack matched.');
}

/* ------------------------------------------------------------------
   9. ONLINE
   Host-runs-the-game, through the room relay in server/worker.js:

     - The host's browser holds the real G. Guests send it commands
       ({t:'cmd', cmd}); the host checks and applies them with dispatch,
       exactly like its own taps, with the seat set from who sent it.
     - After every change the host sends each guest its playerView, plus
       what's on the host's screen that isn't game state (the beat bar, the
       round screen, the dice, the clocks). Guests set G to the view, draw
       it, and play the events that are new to them as animations.
     - Long art (uploaded sprites) travels once per guest: a view carries a
       short reference and the image itself rides along the first time.
     - Everyone keeps their seat token, so a dropped connection or a reload
       comes back to the same chair. The host's game is saved after every
       settled step, so a host who reloads picks up where they were. A host
       can let a bot play for someone who has gone, until they return.

   The relay never looks inside a message. Anyone holding the host's
   browser could cheat, so this is for friends, not strangers.
   ------------------------------------------------------------------ */
const ONLINE_KEY = KEY + '.online';          // {code, token, seat, role, name}: this device's room
const HOSTGAME_KEY = KEY + '.hostgame';      // the host's game and lobby, to resume after a reload
const ON = {
  ws:null, code:null, seat:null, token:null, role:null,       // role: 'host' | 'guest'
  status:'idle',            // idle | connecting | open | retry | closed
  seats:[],                 // from the relay: [{seat, name, online}]
  roomSeats:2,
  lobby:null,               // the host's lobby (guests get a copy): {seats:[{deck, bot}], planets, rounds, turnTimer, choiceTimer}
  decks:[],                 // the host's decks, for picking in the lobby
  sent:{},                  // host, per seat: what it last sent {sig, ev, arts:Set}
  bT:null, saveT:null, retries:0, retryT:null, pingT:null,
  lastEv:0, arts:{}, fresh:true,      // guest: the last event played, the art cache
  timers:null, timersAt:0,
  flipAsk:null,             // guest: the last flip sent on "turn the rest over"
  error:'', joinCode:'', intentional:false
};
const onlineAvailable = () => typeof location!=='undefined' && /^https?:$/.test(location.protocol);
const apiURL = path => location.origin + path;
function savedRoom(){ try{ return JSON.parse(localStorage.getItem(ONLINE_KEY)||'null'); }catch(e){ return null; } }
function rememberRoom(){ try{ localStorage.setItem(ONLINE_KEY, JSON.stringify({code:ON.code, token:ON.token, seat:ON.seat, role:ON.role, name:onlineName()})); }catch(e){} }
function forgetRoom(){ try{ localStorage.removeItem(ONLINE_KEY); localStorage.removeItem(HOSTGAME_KEY); }catch(e){} }
const onlineName = () => (LIB.settings.onlineName || '').trim().slice(0, 24);
const inRoom = () => !!(ON.code && ON.status!=='idle' && ON.status!=='closed');
const seatOnline = i => { const s = ON.seats.find(x=>x.seat===i); return !!(s && s.online); };
const seatName = i => { const s = ON.seats.find(x=>x.seat===i); return (s && s.name) || PNAMES[i]; };
const isHost = () => ON.role==='host';

/* --- the connection ------------------------------------------------------- */

async function createRoom(seats){
  ON.error = '';
  try{
    const r = await fetch(apiURL('/api/rooms'), {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({seats})});
    const j = await r.json();
    if(!r.ok) throw new Error(j.error || 'The server said no.');
    ON.role = 'host'; ON.code = j.code; ON.roomSeats = j.seats; ON.token = null;
    ON.lobby = defaultLobby(j.seats);
    connect();
  }catch(e){ ON.error = 'Could not make a room: '+(e.message||e); render(); }
}
async function joinRoom(code, token){
  ON.error = '';
  code = String(code||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(code.length!==5){ ON.error = 'A room code is five letters and numbers.'; render(); return; }
  try{
    const r = await fetch(apiURL('/api/rooms/'+code));
    if(r.status===404){ const sv = savedRoom(); if(sv && sv.code===code) forgetRoom(); throw new Error('There is no room with that code (rooms close a day after everyone leaves).'); }
    const info = await r.json();
    const full = info.players.length >= info.seats && !token;
    if(full) throw new Error('That room is full.');
    ON.code = code; ON.roomSeats = info.seats; ON.token = token || null;
    if(!ON.role) ON.role = 'guest';
    connect();
  }catch(e){ ON.error = e.message || String(e); ON.status = 'idle'; render(); }
}
function connect(){
  clearTimeout(ON.retryT);
  if(ON.ws){ try{ ON.ws.onclose = null; ON.ws.close(); }catch(e){} }
  ON.status = ON.retries ? 'retry' : 'connecting';
  ON.intentional = false;
  const q = new URLSearchParams();
  if(ON.token) q.set('token', ON.token);
  if(onlineName()) q.set('name', onlineName());
  const ws = new WebSocket(apiURL('/api/rooms/'+ON.code+'/socket?'+q).replace(/^http/, 'ws'));
  ON.ws = ws;
  ws.onmessage = e => { ON.lastPong = Date.now(); if(e.data==='pong') return; let m; try{ m = JSON.parse(e.data); }catch(err){ return; } onMessage(m); };
  ws.onclose = () => { if(ON.ws!==ws) return; clearInterval(ON.pingT); if(!ON.intentional) reconnectSoon(); };
  ws.onerror = () => {};
  render();
}
function reconnectSoon(){
  ON.status = 'retry';
  ON.retries++;
  render();
  const wait = Math.min(10000, 800 * Math.pow(1.6, ON.retries-1));
  ON.retryT = setTimeout(async ()=>{
    try{
      const r = await fetch(apiURL('/api/rooms/'+ON.code));
      if(r.status===404){ ON.status = 'closed'; ON.error = 'The room has closed.'; forgetRoom(); render(); return; }
    }catch(e){ return reconnectSoon(); }               // offline: keep trying
    connect();
  }, wait);
}
/** The socket has gone quiet or the device came back online: don't wait
    for the browser to notice, start again now. */
function dropAndRetry(){
  const ws = ON.ws;
  if(!ws || !ON.code) return;
  ON.ws = null; clearInterval(ON.pingT);
  try{ ws.onclose = null; ws.close(); }catch(e){}
  ON.retries = Math.max(ON.retries, 1) - 1;
  reconnectSoon();
}
window.addEventListener('online', ()=>{ if(ON.code && ON.status!=='idle' && ON.status!=='closed' && (!ON.ws || ON.ws.readyState!==1)) dropAndRetry() || (!ON.ws && connect()); });
document.addEventListener('visibilitychange', ()=>{
  if(document.visibilityState!=='visible' || !ON.code || ON.status==='idle' || ON.status==='closed') return;
  if(!ON.ws || ON.ws.readyState>1){ clearTimeout(ON.retryT); connect(); }
  else if(ON.ws.readyState===1){ try{ ON.ws.send('ping'); }catch(e){} }
});

function leaveRoom(){
  if(isHost() && ON.ws && ON.status==='open') relay({data:{t:'closed'}}, 'all');
  ON.intentional = true;
  clearTimeout(ON.retryT); clearInterval(ON.pingT);
  try{ if(ON.ws) ON.ws.close(1000, 'left'); }catch(e){}
  ON.ws = null; ON.status = 'idle'; ON.code = null; ON.role = null; ON.seat = null; ON.token = null;
  ON.seats = []; ON.lobby = null; ON.sent = {}; ON.lastEv = 0; ON.fresh = true; ON.timers = null;
  NET.seat = null; NET.send = null;
  if(G && (G.online || G.isView)) G = null;
  forgetRoom();
}
function relay(msg, to){
  if(!ON.ws || ON.ws.readyState!==1) return false;
  const out = to==null ? msg : Object.assign({to}, msg);
  try{ ON.ws.send(JSON.stringify(out)); return true; }catch(e){ return false; }
}

function onMessage(m){
  if(m.sys==='welcome'){
    ON.seat = m.seat; ON.token = m.token; ON.seats = m.seats; if(m.size) ON.roomSeats = m.size;
    ON.role = m.seat===0 ? 'host' : 'guest';
    ON.status = 'open'; ON.retries = 0; ON.error = '';
    rememberRoom();
    clearInterval(ON.pingT);
    ON.lastPong = Date.now();
    /* keep-alive, and a check that the line is really still there: phones
       drop sockets without saying so */
    ON.pingT = setInterval(()=>{
      if(!ON.ws) return;
      if(ON.ws.readyState>1 || Date.now() - ON.lastPong > 50000){ dropAndRetry(); return; }
      if(ON.ws.readyState!==1) return;
      try{ ON.ws.send('ping'); }catch(e){}
    }, 20000);
    if(isHost()){
      NET.seat = 0; NET.send = null;
      if(!ON.lobby) ON.lobby = defaultLobby(ON.roomSeats);
      if(G && G.online) G.players.forEach(p=>{ if(ON.sent[p.idx]) ON.sent[p.idx].sig = ''; });
      hostSync();
    }else{
      NET.seat = m.seat; NET.send = cmd => relay({data:{t:'cmd', cmd}});
      ON.fresh = true;
      relay({data:{t:'hello'}});
      if(!G || !G.isView){ UI.screen = 'online'; }
    }
    render();
    return;
  }
  if(m.sys==='seats'){
    ON.seats = m.seats;
    if(isHost()){
      if(m.joined!=null && m.joined!==0){
        ON.sent[m.joined] = null;                        // a fresh device: send it everything again
        const p = G && G.online && G.players[m.joined];
        if(p && p.standIn) dispatch({t:'standin', seat:0, target:m.joined, on:false});
      }
      hostSync();
    }
    render();
    return;
  }
  if(m.sys==='error'){ console.warn('relay:', m.why); return; }
  const d = m.data;
  if(!d || typeof d!=='object') return;
  if(isHost()) hostReceive(m.from, d); else guestReceive(d);
}

/* --- the host ---------------------------------------------------------------- */

function defaultLobby(n){
  const decks = LIB.decks;
  return { seats: Array.from({length:n}, (_,i)=>({deck:(LIB.settings.deckOf[i] && decks.some(d=>d.id===LIB.settings.deckOf[i])) ? LIB.settings.deckOf[i] : decks[Math.min(i, decks.length-1)].id})),
           planets: LIB.settings.planets||5, rounds: LIB.settings.rounds||6,
           turnTimer: LIB.settings.turnTimer||0, choiceTimer: LIB.settings.choiceTimer||30 };
}
function lobbyPayload(){
  return {t:'lobby', lobby:ON.lobby, decks:LIB.decks.map(d=>({id:d.id, name:d.name, n:d.cards.length})), playing: !!(G && G.online && !G.over)};
}
/** Bring every guest up to date: the lobby before a game, views during one. */
function hostSync(){
  if(!isHost()) return;
  if(G && G.online) hostBroadcast();
  else relay({data:lobbyPayload()}, 'all');
}
function hostReceive(from, d){
  if(d.t==='hello'){
    if(G && G.online){ ON.sent[from] = null; hostBroadcast(); }
    else relay({data:lobbyPayload()}, from);
    return;
  }
  if(d.t==='deck' && !(G && G.online && !G.over) && ON.lobby && ON.lobby.seats[from] && LIB.decks.some(x=>x.id===d.id)){
    ON.lobby.seats[from].deck = d.id; hostSync(); render(); return;
  }
  if(d.t==='cmd' && d.cmd && typeof d.cmd==='object' && G && G.online){
    const cmd = Object.assign({}, d.cmd, {seat:from});            // a guest only ever acts for its own seat
    if(cmd.t==='sandbox' || cmd.t==='standin') return;
    const r = dispatch(cmd);
    if(!r.ok) relay({data:{t:'nope', why:r.why, c:cmd.t}}, from);
    render();
  }
}
function startOnlineGame(){
  const n = ON.roomSeats, L = ON.lobby;
  const kinds = Array.from({length:n}, (_,i)=> i===0 || ON.seats.some(s=>s.seat===i) ? 'human' : 'bot');
  const names = Array.from({length:n}, (_,i)=> kinds[i]==='bot' ? 'Bot '+(i+1) : seatName(i));
  LIB.settings.turnTimer = L.turnTimer; LIB.settings.turnTimerCustom = false; LIB.settings.choiceTimer = L.choiceTimer;
  saveSoon();
  ON.sent = {};
  NET.seat = 0; NET.send = null;
  UI.screen = 'game'; UI.sheet = null;
  newGame({online:true, players:n, kinds, names, deckOf:L.seats.map(s=>s.deck), planets:L.planets, rounds:L.rounds,
           sandbox:false, hide:false, placement:'simultaneous'});
  hostBroadcast();
}
/** Back to the lobby after a game, everyone together. */
function hostBackToLobby(){
  G = null; UI.screen = 'online'; UI.review = false;
  try{ localStorage.removeItem(HOSTGAME_KEY); }catch(e){}
  relay({data:Object.assign(lobbyPayload(), {reset:true})}, 'all');
  render();
}

/* What the host's screen is doing that isn't game state, for guests to mirror. */
function hostScreenState(){
  const left = t => t ? Math.max(0, Math.round(t.left)) : null;
  const turn = UI.timer && LIB.settings.turnTimer ? {left:left(UI.timer), paused: timerPaused() || !!UI.ctimer} : null;
  const choice = UI.ctimer ? {left:left(UI.ctimer), paused: !!(UI.transition || UI.animLock || UI.fxWait || UI.flipAnim)} : null;
  return {
    transition: UI.transition || null,
    roundScreen: UI.roundScreen ? JSON.parse(JSON.stringify(UI.roundScreen)) : null,
    dice: UI.dice ? {round:UI.dice.round, landed:!!UI.dice.landed} : null,
    timers: (turn || choice) ? {turn, choice} : null
  };
}
function hostBroadcast(){
  if(!isHost()) return;
  clearTimeout(ON.bT);
  ON.bT = setTimeout(hostSendViews, 30);
}
function hostSendViews(){
  if(!isHost() || !G || !G.online || !ON.ws || ON.ws.readyState!==1) return;
  const screen = hostScreenState();
  const screenSig = JSON.stringify([screen.transition, screen.roundScreen, screen.dice, !!screen.timers]);
  G.players.forEach(p=>{
    if(p.idx===0 || !seatOnline(p.idx)) return;
    const st = ON.sent[p.idx] || (ON.sent[p.idx] = {sig:'', ev:0, arts:new Set()});
    const v = playerView(G, p.idx);
    const lastN = v.events.length ? v.events[v.events.length-1].n : 0;
    v.events = v.events.filter(e=>e.n > st.ev);
    const arts = {};
    packArts(v, st.arts, arts);
    const body = JSON.stringify(v);
    const sig = body.length + ':' + hashStr(body) + ':' + screenSig;
    if(sig===st.sig) return;
    const msg = '{"to":'+p.idx+',"data":{"t":"view","v":'+body+',"ui":'+JSON.stringify(screen)+',"arts":'+JSON.stringify(arts)+'}}';
    if(msg.length > 1000000){ toast('Too much art to send in one go — put large sprites in the site’s art/ folder.'); return; }
    try{ ON.ws.send(msg); st.sig = sig; st.ev = lastN; }catch(e){}
  });
  hostSaveSoon();
}
/* the clocks tick without a re-render: keep guests' copies honest */
setInterval(()=>{
  if(!isHost() || !G || !G.online || G.over || !ON.ws || ON.ws.readyState!==1) return;
  const s = hostScreenState();
  if(s.timers) relay({data:{t:'clock', timers:s.timers}}, 'all');
}, 3000);

/** Save the host's game whenever it is settled, to resume after a reload. */
function hostSaveSoon(){
  if(ON.saveT) return;                 // one pending save at a time: a busy game can't starve it
  ON.saveT = setTimeout(()=>{
    ON.saveT = null;
    if(!isHost() || !G || !G.online) return;
    const settled = !G.hold && !G.flipping && !(G.fxQueue && G.fxQueue.length) && !G.choice && !UI.animLock && !UI.fxWait && !UI.transition && !UI.roundScreen && !UI.flipAnim;   // the dice are only a show: the round has already begun
    if(!settled) return hostSaveSoon();
    try{ localStorage.setItem(HOSTGAME_KEY, JSON.stringify({code:ON.code, g:G, lobby:ON.lobby, roomSeats:ON.roomSeats, at:Date.now()})); }catch(e){}
  }, 400);
}
function hostResume(saved){
  const room = savedRoom();
  if(!room || room.role!=='host') return false;
  ON.role = 'host'; ON.code = room.code; ON.token = room.token;
  let hg = null;
  try{ hg = JSON.parse(localStorage.getItem(HOSTGAME_KEY)||'null'); }catch(e){}
  if(hg && hg.code===room.code && hg.g){
    G = hg.g; ON.lobby = hg.lobby; ON.roomSeats = hg.roomSeats || G.players.length;
    adoptRng(G); UID_LIVE = G.uids;
    UI.transition = null; UI.flipAnim = null; UI.autoflip = false; UI.drag = null; UI.sel = null;
    UI.sheet = null; UI.gate = false; UI.botQueued = {}; UI.review = false;
    fxReset();
    NET.seat = 0; NET.send = null;
    UI.screen = 'game';
    setTimeout(()=>{ if(G && G.online) afterStateChange(); }, 300);
  }else{
    ON.lobby = defaultLobby(ON.roomSeats);
    UI.screen = 'online';
  }
  joinRoom(room.code, room.token);
  return true;
}

/* Long strings (uploaded images) go once per guest; views point at them. */
const ART_MIN = 1500, ART_TAG = '\u0000art:';
function hashStr(s){ let h = 2166136261; for(let i=0;i<s.length;i++){ h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return (h>>>0).toString(36); }
function packArts(o, have, out){
  for(const k in o){
    const x = o[k];
    if(typeof x==='string' && x.length>=ART_MIN && x.startsWith('data:')){
      const key = hashStr(x) + x.length.toString(36);
      if(!have.has(key)){ have.add(key); out[key] = x; }
      o[k] = ART_TAG + key;
    }else if(x && typeof x==='object') packArts(x, have, out);
  }
}
function unpackArts(o){
  for(const k in o){
    const x = o[k];
    if(typeof x==='string' && x.startsWith(ART_TAG)) o[k] = ON.arts[x.slice(ART_TAG.length)] || '';
    else if(x && typeof x==='object') unpackArts(x);
  }
  return o;
}

/* --- a guest ----------------------------------------------------------------- */

function guestReceive(d){
  if(d.t==='lobby'){
    ON.lobby = d.lobby; ON.decks = d.decks || [];
    if(d.reset || (!d.playing && G && G.isView && !G.over)){ G = null; UI.review = false; }
    if(!G || d.reset){ UI.screen = 'online'; UI.sheet = null; }
    ON.fresh = true;
    render();
    return;
  }
  if(d.t==='view'){ guestView(d); return; }
  if(d.t==='clock'){ ON.timers = d.timers; ON.timersAt = Date.now(); return; }
  if(d.t==='nope'){
    if(d.why==='busy') return;                          // a tap during a beat: nothing to say
    toast(d.why==='turn' ? 'Not your turn.' : d.why==='choice' ? 'Answer the open choice first.' : 'That move didn’t go through.');
    return;
  }
  if(d.t==='closed'){
    ON.intentional = true; leaveRoom();
    UI.screen = 'online'; ON.error = 'The host ended the game and closed the room.';
    render();
  }
}

function guestView(d){
  Object.assign(ON.arts, d.arts||{});
  const v = unpackArts(d.v);
  const first = ON.fresh || !G || !G.isView;
  const evs = first ? [] : (v.events||[]).filter(e=>e.n > ON.lastEv);
  const maxN = (v.events||[]).reduce((m,e)=>Math.max(m, e.n), ON.lastEv);
  ON.lastEv = first ? Math.max(maxN, v.eventN||0) : maxN;
  ON.fresh = false;
  const onBoard = UI.screen==='game' && !first && animOn();

  /* leaving and sliding play from where the card was: before the new view is drawn */
  if(onBoard) evs.forEach(e=>{
    if(e.k==='vanish' && e.uid) fxVanish({uid:e.uid, owner:e.owner});
    else if(e.k==='slide' && e.uid) fxSlideStart({uid:e.uid});
  });

  const hadChoice = G && G.choice;
  G = v; NET.seat = v.viewer;
  if(UI.choicePeek && UI.choicePeek!==G.choice && !(hadChoice && G.choice && hadChoice.kind===G.choice.kind)) UI.choicePeek = null;
  else if(UI.choicePeek) UI.choicePeek = G.choice;      // the same choice, in a fresh copy
  const ui = d.ui || {};
  UI.transition = ui.transition || null;
  UI.roundScreen = ui.roundScreen || null;
  UI.roundGo = null;
  mirrorDice(ui.dice);
  ON.timers = ui.timers || null; ON.timersAt = Date.now();
  if(first){ UI.screen = 'game'; UI.sheet = null; }
  if(UI.sel && !findCardByUid(UI.sel)) UI.sel = null;
  if(UI.peek && UI.sheet==='peek' && !anyCardByUid(UI.peek.uid) && !UI.peek.preview){ UI.sheet = null; UI.peek = null; }
  else if(UI.peek && UI.sheet==='peek' && !UI.peek.preview){ const fresh = anyCardByUid(UI.peek.uid); if(fresh) UI.peek = fresh; }

  let flip = null;
  if(onBoard) evs.forEach(e=>{
    if(e.k==='arrive' && e.uid) fxArrive({uid:e.uid, owner:e.owner}, e.kind);
    else if(e.k==='energy' && e.seat===G.viewer) fxEnergy(e.seat, e.n, e.from ? {uid:e.from} : null);
    else if(e.k==='flip' && e.uid) flip = e.uid;
  });
  if(flip){
    UI.flipAnim = flip;
    clearTimeout(ON.flipT);
    ON.flipT = setTimeout(()=>{ if(UI.flipAnim===flip){ UI.flipAnim = null; render(); } }, FLIP_MS);
  }
  render();
  if(onBoard) evs.forEach(e=>{
    if(e.k==='beam' && e.to && e.to.length){
      const ctx = {uid:e.from, owner:e.seat};
      startBeams(ctx, e.to.filter(Boolean));
      e.to.filter(Boolean).forEach(u=>glowCard(u, casterColour(ctx)));
    }
  });
  guestAfterView();
}
function mirrorDice(dice){
  if(!dice){ if(UI.dice){ clearInterval(UI.diceSpin); UI.dice = null; } UI.diceGo = null; return; }
  const wasRolling = UI.dice && !UI.dice.landed;
  UI.dice = {round:dice.round, landed:dice.landed || !animOn()};
  UI.diceGo = null;
  if(!UI.dice.landed && !wasRolling){
    clearInterval(UI.diceSpin);
    UI.diceSpin = setInterval(()=>{ document.querySelectorAll('.die[data-rolling]').forEach(el=>{ el.innerHTML = pipsHTML(1 + uiRnd(6)); }); }, 75);
  }
  if(UI.dice.landed) clearInterval(UI.diceSpin);
}
/** "Turn the rest over", on a guest: one flip at a time, each after the last has landed. */
function guestAfterView(){
  const me = G && G.players[G.viewer];
  const mine = me && G.phase==='reveal' && G.order[G.revealer]===me.idx;
  if(!mine){ UI.autoflip = false; return; }
  if(!UI.autoflip) return;
  const down = faceDownOf(me);
  if(!down.length){ UI.autoflip = false; return; }
  if(G.hold || G.flipping || G.choice || UI.transition || UI.roundScreen || UI.dice) return;
  const uid = down[0].card.uid;
  if(ON.flipAsk && ON.flipAsk.uid===uid && Date.now()-ON.flipAsk.at < 2500) return;
  ON.flipAsk = {uid, at:Date.now()};
  setTimeout(()=>{ if(UI.autoflip && G && G.isView) dispatch({t:'flip', seat:me.idx, uid}); }, 260);
}

/* the host's clocks, as a guest shows them: counted down locally between updates */
function netTimeLeft(t){
  if(!t) return null;
  return t.paused ? t.left : Math.max(0, t.left - (Date.now() - ON.timersAt));
}
function netTimerHTML(which, compact){
  const t = ON.timers && ON.timers[which];
  if(!t || !G) return '';
  if(which==='choice' && G.choice && !G.choice.waiting && chooserOf(G.choice)!==G.viewer) return '';
  const left = netTimeLeft(t);
  return which==='turn'
    ? `<span class="turn-timer ${left<=TIMER_WARN?'warn':''}" data-timer aria-label="Time left this turn">⏱ ${fmtClock(left)}</span>`
    : `<span class="turn-timer choice-timer ${compact?'compact':''} ${left<=TIMER_WARN?'warn':''}" data-ctimer aria-label="Time left to choose">⏱ ${fmtClock(left)}</span>`;
}
function netTimerTick(){
  if(!ON.timers) return;
  [['turn','[data-timer]'],['choice','[data-ctimer]']].forEach(([k, sel])=>{
    const t = ON.timers[k]; if(!t) return;
    const left = netTimeLeft(t);
    document.querySelectorAll(sel).forEach(el=>{ el.textContent = '⏱ '+fmtClock(left); el.classList.toggle('warn', left<=TIMER_WARN); });
  });
}

/* --- screens ----------------------------------------------------------------- */

function viewOnline(){
  if(!onlineAvailable()) return `${topbar('Play online')}
    <div class="page stack"><div class="callout">Online play works on the website copy of Territory, not a file opened from your computer. Deploy it (see DEPLOY.md) and open the address it gives you.</div></div>`;
  if(inRoom() && ON.seat!=null && ON.lobby) return viewLobby();
  if(inRoom()) return `${topbar('Play online')}<div class="page stack"><div class="net-wait"><span class="spinner"></span>${ON.status==='retry'?'Reconnecting to':'Connecting to'} room <b>${esc(ON.code||'')}</b>…</div>
    <button class="btn ghost" data-on="leave">Cancel</button></div>`;
  const saved = savedRoom();
  const name = esc(LIB.settings.onlineName||'');
  return `${topbar('Play online')}
  <div class="page stack online-page">
    ${ON.error?`<div class="callout">${esc(ON.error)}</div>`:''}
    <label class="field"><span>Your name</span><input data-on-input="name" maxlength="24" placeholder="What the others will see" value="${name}" autocomplete="nickname"></label>
    ${saved ? `<div class="card-panel online-resume">
      <div class="row"><b>Room ${esc(saved.code)}</b><span class="muted tiny" style="margin-left:auto">${saved.role==='host'?'you were hosting':'you were '+esc(PNAMES[saved.seat]||'a player')}</span></div>
      <div class="row" style="gap:8px;margin-top:10px">
        <button class="btn primary" data-on="resume">${saved.role==='host'?'Resume hosting':'Rejoin'}</button>
        <button class="btn ghost" data-on="forget">Forget it</button>
      </div></div>` : ''}
    <div class="card-panel">
      <h3 class="op-h">Host a game</h3>
      <p class="tiny muted" style="margin:0 0 10px">Make a room, then send its code or link to your friends. Your device runs the game; empty seats can be bots.</p>
      <div class="row" style="gap:8px;align-items:flex-end">
        <label class="field" style="flex:1"><span>Players</span>
          <select data-on-input="seats">${[2,3,4].map(n=>`<option value="${n}" ${(UI.onSeats||2)===n?'selected':''}>${n}</option>`).join('')}</select></label>
        <button class="btn primary" data-on="host" style="flex:1">Make a room</button>
      </div>
    </div>
    <div class="card-panel">
      <h3 class="op-h">Join a game</h3>
      <div class="row" style="gap:8px;align-items:flex-end">
        <label class="field" style="flex:1"><span>Room code</span>
          <input data-on-input="code" class="code-input" maxlength="5" placeholder="ABCDE" autocapitalize="characters" autocomplete="off" spellcheck="false" value="${esc(ON.joinCode||'')}"></label>
        <button class="btn primary" data-on="join" style="flex:1">Join</button>
      </div>
    </div>
    <p class="tiny muted">Everyone places at once on their own device, then cards turn over in order. Your deck comes from the host’s library.</p>
  </div>`;
}

function viewLobby(){
  const L = ON.lobby, host = isHost(), n = L.seats.length;
  const decks = host ? LIB.decks.map(d=>({id:d.id, name:d.name, n:d.cards.length})) : ON.decks;
  const deckName = id => { const d = decks.find(x=>x.id===id); return d ? `${d.name} (${d.n})` : 'A deck'; };
  const link = location.origin + location.pathname + '?room=' + ON.code;
  const rows = Array.from({length:n}, (_,i)=>{
    const s = ON.seats.find(x=>x.seat===i);
    const me = i===ON.seat;
    const status = me ? 'You' : !s ? (host ? 'Empty — a bot plays' : 'Waiting…') : s.online ? 'Here' : 'Away';
    const canPick = me || (host && !s);
    const deck = canPick
      ? `<select data-on-input="deck" data-i="${i}" aria-label="Deck for ${esc(s?s.name:PNAMES[i])}">${decks.map(d=>`<option value="${d.id}" ${L.seats[i].deck===d.id?'selected':''}>${esc(d.name)} (${d.n})</option>`).join('')}</select>`
      : `<span class="tiny muted">${esc(deckName(L.seats[i].deck))}</span>`;
    return `<div class="lobby-seat ${s&&s.online||me?'here':''}" style="--pc:${PCOLORS[i]}">
      <span class="dot"></span>
      <div class="ls-name"><b>${esc(s ? s.name : (host ? 'Bot '+(i+1) : PNAMES[i]))}</b><span>${i===0?'Host · ':''}${status}</span></div>
      <div class="ls-deck">${deck}</div>
    </div>`;
  }).join('');
  const others = ON.seats.filter(s=>s.seat!==0 && s.online).length;
  const opts = (arr, cur, fmt) => arr.map(v=>`<option value="${v}" ${cur===v?'selected':''}>${fmt?fmt(v):v}</option>`).join('');
  const settings = host ? `<div class="grid2">
      <label class="field"><span>Planets</span><select data-on-input="planets">${opts([3,4,5,6,7,8].filter(k=>k<=LIB.planets.length), L.planets)}</select></label>
      <label class="field"><span>Rounds</span><select data-on-input="rounds">${opts([4,5,6,7,8], L.rounds)}</select></label>
      <label class="field"><span>Turn timer</span><select data-on-input="turnTimer">${opts([0,30,45,60,90,120], L.turnTimer, v=>v?fmtClock(v*1000):'Off')}</select></label>
      ${L.turnTimer ? `<label class="field"><span>Ability choice timer</span><select data-on-input="choiceTimer">${opts(CHOICE_PRESETS.map(x=>x[0]), L.choiceTimer, v=>fmtClock(v*1000))}</select></label>` : '<div></div>'}
    </div>` : `<p class="tiny muted" style="margin:0">${L.planets} planets · ${L.rounds} rounds · ${L.turnTimer ? fmtClock(L.turnTimer*1000)+' turns, '+fmtClock(L.choiceTimer*1000)+' choices' : 'no turn timer'}</p>`;
  return `${topbar('Room '+ON.code)}
  <div class="page stack online-page">
    ${netStatusHTML()}
    <div class="room-code" aria-label="Room code ${ON.code.split('').join(' ')}">
      <span class="rc-label">Room code</span>
      <span class="rc-code">${ON.code.split('').map(c=>`<i>${c}</i>`).join('')}</span>
      <div class="row" style="gap:8px;justify-content:center">
        <button class="btn sm" data-on="copylink" data-v="${esc(link)}">Copy invite link</button>
        ${navigator.share ? `<button class="btn sm ghost" data-on="share" data-v="${esc(link)}">Share…</button>` : ''}
      </div>
    </div>
    <div class="lobby-seats">${rows}</div>
    ${settings}
    ${host
      ? `<button class="btn primary wide" data-on="start" ${others?'':'disabled'}>${others ? 'Start the game' : 'Waiting for someone to join…'}</button>
         ${others && others < n-1 ? `<p class="tiny muted" style="margin:-4px 0 0;text-align:center">Empty seats are played by bots.</p>` : ''}`
      : `<div class="net-wait"><span class="spinner"></span>Waiting for ${esc(seatName(0))} to start…</div>`}
    <button class="btn ghost" data-on="leave">${host?'Close the room':'Leave the room'}</button>
  </div>`;
}

/** A line across the top when the connection isn't simply fine. */
function netStatusHTML(){
  if(!inRoom()) return '';
  if(ON.status==='retry' || ON.status==='connecting') return `<div class="net-banner warn" role="status"><span class="spinner"></span>Reconnecting…</div>`;
  if(!isHost() && ON.seats.length && !seatOnline(0)) return `<div class="net-banner warn" role="status"><span class="spinner"></span>${esc(seatName(0))} (the host) lost connection. Waiting for them…</div>`;
  if(isHost() && G && G.online && !G.over){
    const gone = G.players.filter(p=>p.idx!==0 && (p.kind==='human' || p.standIn) && ON.seats.some(s=>s.seat===p.idx) && !seatOnline(p.idx));
    if(gone.length) return gone.map(p=>`<div class="net-banner" role="status">
      <span class="dot" style="--pc:${PCOLORS[p.idx]}"></span><span class="nb-txt"><b>${esc(p.name)}</b> ${p.standIn?'is away — a bot is playing for them.':'lost connection.'}</span>
      ${p.standIn ? '' : `<button class="btn sm" data-on="standin" data-i="${p.idx}">Let a bot play</button>`}
    </div>`).join('');
  }
  return '';
}

/* --- taps and edits ------------------------------------------------------------ */

document.addEventListener('click', e=>{
  const t = e.target.closest('[data-on]');
  if(!t) return;
  const a = t.dataset.on;
  switch(a){
    case 'open': ON.error = ''; UI.screen = 'online'; UI.sheet = null; render(); break;
    case 'host': if(!onlineName()) return askName(); createRoom(UI.onSeats||2); break;
    case 'join': if(!onlineName()) return askName(); ON.role = 'guest'; joinRoom(ON.joinCode); break;
    case 'resume': {
      const r = savedRoom(); if(!r) break;
      if(r.role==='host') hostResume(); else { ON.role = 'guest'; joinRoom(r.code, r.token); }
      break;
    }
    case 'forget': forgetRoom(); render(); break;
    case 'leave': leaveRoom(); UI.screen = 'online'; render(); break;
    case 'start': if(isHost()) startOnlineGame(); break;
    case 'copylink': copyText(t.dataset.v, 'Invite link'); break;
    case 'share': navigator.share({title:'Territory', text:'Join my game of Territory: room '+ON.code, url:t.dataset.v}).catch(()=>{}); break;
    case 'standin': if(isHost()){ dispatch({t:'standin', seat:0, target:+t.dataset.i, on:true}); render(); } break;
    case 'lobby': if(isHost()) hostBackToLobby(); break;
    case 'endgame': UI.sheet = null; leaveRoom(); UI.screen = 'title'; render(); break;
    case 'backtoroom': UI.screen = G && (G.online || G.isView) ? 'game' : 'online'; render(); break;
  }
});
function askName(){
  ON.error = 'Put in a name first, so the others know who you are.'; render();
  const el = document.querySelector('[data-on-input="name"]'); if(el) el.focus();
}
document.addEventListener('input', e=>{
  const el = e.target, k = el.dataset && el.dataset.onInput;
  if(!k) return;
  if(k==='name'){ LIB.settings.onlineName = el.value.slice(0,24); saveSoon(); return; }
  if(k==='code'){ ON.joinCode = el.value.toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5); if(el.value!==ON.joinCode) el.value = ON.joinCode; return; }
});
document.addEventListener('change', e=>{
  const el = e.target, k = el.dataset && el.dataset.onInput;
  if(!k || k==='name' || k==='code') return;
  if(k==='seats'){ UI.onSeats = +el.value; return; }
  if(k==='deck'){
    const i = +el.dataset.i;
    if(isHost()){ ON.lobby.seats[i].deck = el.value; hostSync(); }
    else { ON.lobby.seats[i].deck = el.value; relay({data:{t:'deck', id:el.value}}); }
    render(); return;
  }
  if(isHost() && ON.lobby && ['planets','rounds','turnTimer','choiceTimer'].includes(k)){ ON.lobby[k] = +el.value; hostSync(); render(); }
});

/* A link with ?room=CODE opens the join screen with the code filled in, or
   goes straight back in if this device already holds a seat there. A reload
   while in a room goes straight back in, too. */
function onlineBoot(){
  if(!onlineAvailable()) return;
  const code = (new URLSearchParams(location.search).get('room')||'').toUpperCase().replace(/[^A-Z0-9]/g,'').slice(0,5);
  const saved = savedRoom();
  if(code){
    history.replaceState(null, '', location.pathname);
    if(saved && saved.code===code){ if(saved.role==='host') hostResume(); else { ON.role = 'guest'; UI.screen = 'online'; joinRoom(code, saved.token); } return; }
    ON.joinCode = code; UI.screen = 'online'; render();
    return;
  }
  /* reloaded mid-room: straight back in */
  if(saved && saved.code){ if(saved.role==='host') hostResume(); else { ON.role = 'guest'; UI.screen = 'online'; joinRoom(saved.code, saved.token); } }
}

/* ------------------------------------------------------------------
   BOOT
   ------------------------------------------------------------------ */

LIB = blankLibrary();
const hadSaved = load();
try{ const th = localStorage.getItem(KEY+'.theme'); if(th) document.documentElement.dataset.theme = th; }catch(err){}
fillSettings();
render();
/* first visit to a copy on the web: start from the library it ships with */
if(!hadSaved) fetchShippedLibrary().then(data=>{
  if(!data || G) return;                       // nothing shipped, or a game already started
  adoptLibrary(data); fillSettings(); save(); render();
});
downloadsCap();   // ask early, so the first Download doesn't wait on it
onlineBoot();

window.addEventListener('pagehide', ()=>{ clearTimeout(saveTimer); save(); });
document.addEventListener('visibilitychange', ()=>{ if(document.visibilityState==='hidden'){ clearTimeout(saveTimer); save(); } });

