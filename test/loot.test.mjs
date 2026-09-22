import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createLootRoller,describeLoot,buildName,eligible,itemSlots,LOOT_STAT_KEYS,LOOT_SLOTS,RARITY_ORDER} from '../server/loot.mjs';
import {createEnchanter} from '../server/enchantment.mjs';

// The Adjective + Item + Rarity roller is the authoritative copy for shared Dive loot.
// These hold its contract: determinism from the chest key, the tier rules (no affixes
// on common, a suffix only from rare up, a title and a forced blessing on legendary),
// the garment gate and tag exclusion, the two-pass dress, and the hands-off list.

const data=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8'));
const table=data.loot;
const items=data.items;
const pick=predicate=>{const id=Object.keys(items).sort().find(id=>predicate(items[id]));assert.ok(id,'catalog has a matching item');return structuredClone(items[id]);};

test('the shipped table is well formed and matches the client constants',()=>{
 assert.ok(Array.isArray(table.affixes)&&table.affixes.length>=20);
 assert.deepEqual(table.tuning.rarity_order,[...RARITY_ORDER]);
 const ids=new Set();
 for(const affix of table.affixes){
  assert.ok(/^[a-z][a-z0-9_]{2,47}$/.test(affix.id),affix.id);
  assert.ok(!ids.has(affix.id),'unique id '+affix.id);ids.add(affix.id);
  assert.ok(affix.adjective||affix.suffix_title||affix.bonus_only===true,affix.id+' needs a role');
  for(const slot of affix.slots)assert.ok(slot==='*'||LOOT_SLOTS.includes(slot),affix.id+' slot '+slot);
  assert.ok(!affix.slots.includes('dress'),'a dress asks the torso and pants pools');
  assert.ok(RARITY_ORDER.includes(affix.min_rarity),affix.id+' min_rarity');
  for(const line of affix.stats){
   assert.ok(LOOT_STAT_KEYS.includes(line.key),affix.id+' stat '+line.key);
   assert.notEqual(line.key,'is_diaper','diaper is identity, not a stat');
  }
 }
 assert.ok(table.legendary_titles.length>=5);
 for(const tier of RARITY_ORDER)assert.match(table.tuning.rarity[tier].colour,/^#[0-9a-f]{6}$/);
 assert.equal(table.tuning.rarity.common.affixes,0,'Decision Q1: common never gets an adjective');
 assert.equal(table.tuning.rarity.legendary.force_blessing,true);
 assert.equal(table.tuning.rarity.legendary.curse_mult,0);
});

test('a roll is deterministic from the chest key and untouched by the global RNG',()=>{
 const roller=createLootRoller(table);
 const base=pick(item=>item.category==='panties'&&item.is_diaper);
 const a=roller.roll(structuredClone(base),'route:ed:1:alice:chest-1',{level:20,luck:'chest'});
 Math.random();
 const b=roller.roll(structuredClone(base),'route:ed:1:alice:chest-1',{level:20,luck:'chest'});
 assert.deepEqual(a,b);
 assert.equal(a.base_name,base.name,'the authored name survives on base_name');
 assert.equal(a.is_diaper,base.is_diaper,'no roll ever changes is_diaper');
 assert.equal(a.loot.rolled,true);
 assert.ok(a.loot.ilvl>=19&&a.loot.ilvl<=22,'level 20 source with -1..+2 jitter');
});

test('tier rules: common is plain, rare adds a suffix, legendary adds a title and forces a blessing',()=>{
 const roller=createLootRoller(table),enchant=createEnchanter(data.enchantments);
 const base=pick(item=>item.category==='panties'&&item.is_diaper&&!item.cursed&&!item.blessed&&!(item.magical_effects?.length)); // authored story curses are outside the roll
 const seen={};
 for(let seed=0;seed<600;seed++){
  const item=roller.roll(structuredClone(base),'tiers:'+seed,{level:30,luck:'boss'});
  enchant(item,'tiers:'+seed,roller.enchantMods(item));
  const tier=item.loot.rarity;
  seen[tier]=(seen[tier]??0)+1;
  const affixCount=(item.loot.prefix?1:0)+(item.loot.suffix?1:0)+item.loot.bonus.length;
  assert.ok(affixCount<=table.tuning.rarity[tier].affixes,tier+' affix budget');
  if(tier==='common'){assert.equal(item.name,base.name);assert.equal(affixCount,0);}
  if(tier==='uncommon')assert.equal(item.loot.suffix,undefined,'suffix only from rare up');
  const untitled=item.loot.title?item.name.slice(item.loot.title.length+3):item.name; // drop the quoted legendary title
  if(item.loot.prefix)assert.ok(untitled.startsWith(item.loot.prefix.adjective+' '),item.name);
  if(item.loot.suffix)assert.ok(item.name.endsWith(' '+item.loot.suffix.title),item.name);
  if(tier==='legendary'){
   assert.ok(table.legendary_titles.includes(item.loot.title),'quoted title');
   assert.ok(item.name.startsWith('"'+item.loot.title+'" '));
   assert.equal(item.cursed,undefined,'a legendary can never be cursed');
   assert.equal(item.blessed,true,'a legendary is always blessed');
  }else assert.equal(item.loot.title,'');
  assert.equal(item.name,buildName(item));
  assert.ok(item.value>=base.value,'rarity and level never lower the coin value');
 }
 for(const tier of RARITY_ORDER)assert.ok(seen[tier]>0,'boss luck reaches '+tier);
});

test('affixes obey the garment gate and never share a tag on one item',()=>{
 const roller=createLootRoller(table);
 const byId=new Map(table.affixes.map(a=>[a.id,a]));
 for(const category of ['weapon','panties','shoes','head']){
  const base=pick(item=>item.category===category);
  for(let seed=0;seed<300;seed++){
   const item=roller.roll(structuredClone(base),category+':'+seed,{level:50,luck:'boss'});
   const records=[item.loot.prefix,item.loot.suffix,...item.loot.bonus].filter(Boolean);
   const tags=[];
   for(const record of records){
    const affix=byId.get(record.id);
    assert.ok(affix,'known affix '+record.id);
    assert.ok(affix.slots.includes('*')||affix.slots.includes(category),affix.id+' is legal on '+category);
    for(const tag of affix.tags){assert.ok(!tags.includes(tag),'tag '+tag+' twice on one item');tags.push(tag);}
    for(const [key,value] of Object.entries(record.stats))assert.ok(LOOT_STAT_KEYS.includes(key)&&value!==0);
   }
  }
 }
});

test('a dress counts as two slots and rolls both the torso and pants pools',()=>{
 const roller=createLootRoller(table);
 const dress=pick(item=>item.category==='dress');
 assert.deepEqual(itemSlots(dress),['torso','pants']);
 let doubled=0;
 for(let seed=0;seed<300;seed++){
  const item=roller.roll(structuredClone(dress),'dress:'+seed,{level:40,luck:'boss'});
  const count=(item.loot.prefix?1:0)+(item.loot.suffix?1:0)+item.loot.bonus.length;
  const budget=table.tuning.rarity[item.loot.rarity].affixes;
  assert.ok(count<=budget*2,'two passes');
  if(count>budget)doubled++;
 }
 assert.ok(doubled>0,'some dresses carry more affixes than a single-slot item could');
});

test('consumables, quest gear and locked gear never roll, and a rolled copy never rolls twice',()=>{
 const roller=createLootRoller(table);
 const food=pick(item=>item.category==='food');
 const rolledFood=roller.roll(structuredClone(food),'food:1',{level:50});
 assert.equal(rolledFood.loot,undefined);
 assert.equal(rolledFood.name,food.name);
 assert.equal(eligible({...pick(item=>item.category==='weapon'),quest_item:true}),false);
 assert.equal(eligible({...pick(item=>item.category==='weapon'),loot_locked:true}),false);
 const weapon=pick(item=>item.category==='weapon');
 const once=roller.roll(structuredClone(weapon),'w:1',{level:10,luck:'boss'});
 const twice=roller.roll(structuredClone(once),'w:2',{level:99,luck:'boss'});
 assert.deepEqual(twice,once);
});

test('base stats scale with item level and the tier budget, theme stats do not',()=>{
 const roller=createLootRoller(table);
 const base=pick(item=>item.category==='torso'&&item.def>0);
 const low=roller.roll(structuredClone(base),'lvl:1',{level:1,luck:'shop'});
 const high=roller.roll(structuredClone(base),'lvl:1',{level:100,luck:'shop'});
 assert.ok(high.def>low.def,'DEF grows with level');
 assert.equal(high.childish,base.childish??undefined,'childish only moves via affixes');
 assert.equal(roller.routeLevel('frostveil-taiga',3),54,'route base 48 + 2 floors x 3');
 assert.equal(roller.routeLevel('nowhere',1),5,'unknown routes use the default band');
 assert.equal(roller.routeLevel('nowhere',1,77),77,'a chest may carry its own level');
 assert.equal(describeLoot(low).startsWith(low.loot.rarity+' - Item Level '),true);
 assert.equal(describeLoot(pick(item=>item.category==='food')),'');
});

test('a missing table is a no-op roller so routes without loot data behave as before',()=>{
 const roller=createLootRoller(null);
 const base=pick(item=>item.category==='weapon');
 const item=roller.roll(structuredClone(base),'k',{level:50});
 assert.equal(item.loot,undefined);
 assert.equal(item.name,base.name);
 assert.deepEqual(roller.enchantMods(item),{curseMult:1,blessMult:1,force:''});
});
