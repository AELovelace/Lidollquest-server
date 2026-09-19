import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {readFileSync} from 'node:fs';
import {createEnchantmentStore,validateEntry,validateTuning} from '../server/enchantment-store.mjs';
import {createDiveLootRoller} from '../server/dive-loot.mjs';
import {createEnchanter} from '../server/enchantment.mjs';

// Gamemasters retune the curse/blessing rates and write new entries from the /gm
// panel. Everything is validated on the way in, because a malformed entry would
// otherwise reach the loot roller and break a live dive. These tests hold that
// boundary, plus the promise that an edit lands without restarting the service.

const data=JSON.parse(readFileSync(new URL('../server/dive-data.json',import.meta.url),'utf8'));
const base=data.enchantments;
const store=()=>createEnchantmentStore(new DatabaseSync(':memory:'),{now:()=>1700000000000});

const entry=(over={})=>({
 id:'test_hex',alignment:'curse',name:'Test Hex',family:'CUSTOM',slots:['panties'],
 weight:10,min_score:0,max_score:1,sticky:false,desc_hint:'It hums.',
 effect:{proc_min:120,proc_max:240,chance_percent:85,cooldown:20,log_text:'{item} hums.',stat_delta:{shame:-5}},
 ...over});

test('a valid entry is normalised rather than trusted',()=>{
 const out=validateEntry({...entry(),id:'  Test_HEX  ',name:'  Test Hex  ',effect:{...entry().effect,popup_lines:['  a line  ','','b']}});
 assert.equal(out.id,'test_hex');                       // lower-cased and trimmed
 assert.equal(out.effect.effect_id,'test_hex');         // the client keys tooltips off this
 assert.deepEqual(out.effect.popup_lines,['a line','b']); // blank lines dropped
 assert.equal(out.effect.popup_text,'');                // always sourced from popup_lines
});

test('entries that would break the roller are refused',()=>{
 const cases=[
  [{id:'X'},/Id must be/],                              // uppercase and too short
  [{id:'ok_id',alignment:'chaos'},/curse or blessing/],
  [{slots:[]},/at least one slot/],                     // nothing could ever roll it
  [{slots:['helmet']},/not an item category/],
  [{min_score:0.9,max_score:0.1},/cannot be above/],
  [{effect:{...entry().effect,proc_min:2}},/Proc min/],  // a proc every 2 steps would spam the player
  [{effect:{...entry().effect,stat_delta:{shame:9000}}},/between -200 and 200/],
  [{effect:{...entry().effect,stat_delta:{gold:5}}},/not a stat/],
  [{effect:{proc_min:120,proc_max:240}},/would do nothing/], // no popup, no log, no delta
  [{effect:{...entry().effect,movement_lock:true,lock_release_chance:0}},/Lock release chance/], // unescapable lock
 ];
 for(const [over,pattern] of cases)assert.throws(()=>validateEntry(entry(over)),pattern,JSON.stringify(over));
});

test('only curses may be sticky',()=>{
 assert.equal(validateEntry(entry({sticky:true})).sticky,true);
 assert.equal(validateEntry(entry({alignment:'blessing',sticky:true})).sticky,false); // a sticky buff would trap the player
});

test('tuning is bounded and unknown keys are refused',()=>{
 assert.deepEqual(validateTuning({curse_chance_low_rarity:20}),{curse_chance_low_rarity:20});
 assert.throws(()=>validateTuning({curse_chance_low_rarity:900}),/between 0 and 60/);
 assert.throws(()=>validateTuning({bias_multiplier:0.2}),/between 1 and 10/); // below 1 would invert the bias
 assert.throws(()=>validateTuning({nonsense:1}),/Unknown tuning value/);
 assert.throws(()=>validateTuning({}),/at least one/);
});

test('overrides layer over the shipped table without editing it',()=>{
 const s=store();
 const before=JSON.stringify(base);
 s.tune({curse_chance_low_rarity:30},'gm-1');
 s.save(entry(),'gm-1');
 const live=s.apply(base);
 assert.equal(live.tuning.curse_chance_low_rarity,30);
 assert.equal(live.tuning.bless_chance_high_rarity,base.tuning.bless_chance_high_rarity); // untouched keys survive
 assert.equal(live.curses.length,base.curses.length+1);
 assert.equal(JSON.stringify(base),before,'the shipped baseline must never be mutated');
});

test('editing a shipped entry replaces it rather than duplicating its id',()=>{
 const s=store(),shipped=base.curses[0];
 s.save({...shipped,name:'Renamed',slots:['gloves']},'gm-1');
 const live=s.apply(base);
 assert.equal(live.curses.filter(e=>e.id===shipped.id).length,1); // a duplicate id would make lookups ambiguous
 assert.equal(live.curses.find(e=>e.id===shipped.id).name,'Renamed');
 assert.doesNotThrow(()=>createEnchanter(live));
});

test('an edit may move an entry between the curse and blessing tables',()=>{
 const s=store(),shipped=base.curses[0];
 s.save({...shipped,alignment:'blessing',sticky:false},'gm-1');
 const live=s.apply(base);
 assert.equal(live.curses.some(e=>e.id===shipped.id),false);
 assert.equal(live.blessings.some(e=>e.id===shipped.id),true);
});

test('shipped entries are retired, custom ones are deleted',()=>{
 const s=store(),shipped=base.curses[0];
 // A delete would be undone by the next content export, so a shipped entry keeps a tombstone.
 assert.deepEqual(s.remove(shipped.id,base,'gm-1'),{id:shipped.id,retired:true,source:'shipped'});
 assert.equal(s.apply(base).curses.some(e=>e.id===shipped.id),false);
 s.restore(shipped.id,'gm-1');
 assert.equal(s.apply(base).curses.some(e=>e.id===shipped.id),true);

 s.save(entry(),'gm-1');
 assert.deepEqual(s.remove('test_hex',base,'gm-1'),{id:'test_hex',retired:false,source:'custom'});
 assert.equal(s.apply(base).curses.some(e=>e.id==='test_hex'),false);
 assert.throws(()=>s.remove('never_existed',base,'gm-1'),/does not exist/);
});

test('the roster labels where every entry came from',()=>{
 const s=store();
 s.save(entry(),'gm-1');
 s.save({...base.blessings[0],name:'Tweaked'},'gm-1');
 s.remove(base.curses[0].id,base,'gm-1');
 const rows=s.list(base),by=id=>rows.find(r=>r.id===id);
 assert.equal(by('test_hex').source,'custom');
 assert.equal(by(base.blessings[0].id).source,'edited');
 assert.equal(by(base.curses[0].id).retired,true);
 assert.equal(by(base.curses[1].id).source,'shipped');
 assert.equal(rows.length,base.curses.length+base.blessings.length+1); // every shipped entry plus the custom one
});

test('reset falls back to exactly what the export shipped',()=>{
 const s=store();
 s.tune({curse_chance_low_rarity:30},'gm-1');s.save(entry(),'gm-1');
 s.reset('tuning');
 assert.equal(s.apply(base).tuning.curse_chance_low_rarity,base.tuning.curse_chance_low_rarity);
 assert.equal(s.apply(base).curses.some(e=>e.id==='test_hex'),true,'a tuning reset must not drop entries');
 s.reset('all');
 assert.deepEqual(s.apply(base).tuning,base.tuning);
 assert.equal(s.apply(base).curses.length,base.curses.length);
});

test('the revision changes on every write, so the roller knows to rebuild',()=>{
 const s=store(),start=s.revision();
 s.tune({curse_chance_low_rarity:30},'gm-1');
 const afterTune=s.revision();
 assert.notEqual(afterTune,start);
 s.save(entry(),'gm-1');
 assert.notEqual(s.revision(),afterTune);
});

test('a live retune reaches the next chest without rebuilding the roller',()=>{
 const s=store();
 const roll=createDiveLootRoller(data,{enchantments:s});
 const chest=id=>({id});
 const sweep=()=>{
  let cursed=0;
  for(let n=0;n<400;n++){const item=roll('edition-live','alice',chest('c'+n),{});if(item.enchantment?.alignment==='curse')cursed++;}
  return cursed;
 };
 const before=sweep();
 s.tune({curse_chance_low_rarity:0,curse_chance_high_rarity:0},'gm-1'); // switch curses off entirely
 const after=sweep();
 assert.ok(before>0,'the shipped rates should curse something');
 assert.equal(after,0,'a retune must take effect on the next roll');
 s.reset('all');
 assert.ok(sweep()>0,'and a reset must bring them back');
});

test('loot a player already holds keeps the roll it was given',()=>{
 const s=store();
 const roll=createDiveLootRoller(data,{enchantments:s});
 const rolls={},chest={id:'chest-1'};
 const first=roll('edition-receipt','alice',chest,rolls);
 rolls[chest.id]=first;
 s.tune({curse_chance_low_rarity:0,curse_chance_high_rarity:0,bless_chance_low_rarity:0,bless_chance_high_rarity:0},'gm-1');
 assert.deepEqual(roll('edition-receipt','alice',chest,rolls),first); // receipts are served untouched
});

test('a gamemaster entry actually rolls onto matching loot',()=>{
 const s=store();
 s.reset('all');
 // Retire everything shipped, then write one entry that can only land on panties.
 for(const shipped of [...base.curses,...base.blessings])s.remove(shipped.id,base,'gm-1');
 s.save(entry({id:'panty_signature',slots:['panties'],weight:100}),'gm-1');
 s.tune({curse_chance_low_rarity:60,curse_chance_high_rarity:60},'gm-1'); // make it easy to observe
 const roll=createDiveLootRoller(data,{enchantments:s});
 let seen=0,wrongSlot=0;
 for(let n=0;n<600;n++){
  const item=roll('edition-custom','alice',{id:'k'+n},{});
  if(!item.enchantment)continue;
  assert.equal(item.enchantment.id,'panty_signature'); // nothing else is live
  if(item.category!=='panties')wrongSlot++;
  seen++;
 }
 assert.ok(seen>0,'a gamemaster entry must be reachable by real loot');
 assert.equal(wrongSlot,0,'the garment gate still holds for custom entries');
});
