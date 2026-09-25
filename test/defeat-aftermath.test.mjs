import test from 'node:test';
import assert from 'node:assert/strict';
import {applyDefeatAftermath,aftermathPages} from '../server/defeat-aftermath.mjs';
import {pinDefeat,resolvedDefeat} from '../server/defeat-scenes.mjs';
import {createWorldContent} from '../server/world-content.mjs';
import {combatData} from '../server/combat.mjs';
import {hubData} from '../server/hubs.mjs';
import {DEFAULT_TUNING} from '../server/loot.mjs';
import {DatabaseSync} from 'node:sqlite';

const state=()=>({loadout:{player_info:{shame:1024,shame_level:100/3,wet:10,tum:5,hunger:100,thirst:100,stamina:50,stamina_max:100,diaper_wet_absorbed:0},inventory:[],childish:0}}); // shame_level 33.3 is the x1.0 Dignity break-even.
const matron=id=>({id,log:[],enemy:pinDefeat({enemy_id:'harvest_matron',name:'Harvest Matron'})}); // The shipped default scene, pinned like a real encounter.
const runFor=title=>{for(let n=0;n<500;n++){const r=matron('fight-'+n);if(resolvedDefeat(r.enemy.defeat,r.id,'defeat').first.title.includes(title))return r;}throw Error('No receipt picks '+title);}; // Receipts hash to one aftermath variant.

test('the Harvest Matron\'s "Fattened Up" aftermath fills the tummy and bladder and costs Dignity once',()=>{
 const s=state(),r=runFor('Fattened Up');
 const lines=applyDefeatAftermath(s,r,'defeat',DEFAULT_TUNING),p=s.loadout.player_info;
 assert.equal(p.tum,80);assert.equal(p.wet,30);assert.equal(p.shame,1024-15); // set_tum 80, wet_delta +20, shame_delta -15 at x1.0.
 assert.ok(lines.some(l=>l.startsWith('Tummy +75'))&&lines.some(l=>l.startsWith('Bladder +20'))&&lines.some(l=>l.startsWith('Dignity -15')));
 assert.deepEqual(r.log,lines);
 assert.equal(p.diaper_wet_absorbed,0); // Accident beats are the client's job (online_defeat_beats -> _narrative_apply_diaper_fill).
 assert.deepEqual(applyDefeatAftermath(s,r,'defeat',DEFAULT_TUNING),[]);assert.equal(p.shame,1009);assert.equal(p.tum,80); // Same receipt: polling never applies it twice.
});

test('the pages the service settles are exactly the ones the player is shown',()=>{
 for(let n=0;n<20;n++){const r=matron('check-'+n),shown=resolvedDefeat(r.enemy.defeat,r.id,'defeat');
  assert.deepEqual(aftermathPages(r,'defeat'),shown.first.aftermath);assert.deepEqual(shown.first.aftermath,shown.repeat.aftermath);} // First and repeat losses share the aftermath pick.
 const pages=aftermathPages(runFor('Fattened Up'),'defeat');
 assert.deepEqual(pages.map(p=>p.effects),[{set_tum:80,wet_delta:20},{diaper_tum_delta:1,diaper_wet_delta:1,shame_delta:-15}]); // Exported beside the text; diaper_* ride along for the client.
});

test('wins, flights and monsters without a scene change nothing; comfort gives Dignity back',()=>{
 for(const outcome of ['win','flee','abandoned']){const s=state();assert.deepEqual(applyDefeatAftermath(s,matron('w'),outcome,DEFAULT_TUNING),[]);assert.equal(s.loadout.player_info.tum,5);}
 const plain=state();assert.deepEqual(applyDefeatAftermath(plain,{id:'x',log:[],enemy:{enemy_id:'arena_template'}},'defeat',DEFAULT_TUNING),[]);
 const kind=state();kind.loadout.player_info.shame=900;
 applyDefeatAftermath(kind,{id:'c',log:[],enemy:{defeat:{schema:2,first:{dialogues:[{id:'d',pages:[]}],aftermaths:[{id:'a',pages:[{id:'p',text:'',effects:{shame_delta:30,hunger_delta:-40,stamina_delta:500}}]}]}}}},'defeat',DEFAULT_TUNING);
 const p=kind.loadout.player_info;assert.equal(p.shame,930);assert.equal(p.hunger,60);assert.equal(p.stamina,100); // Positive shame_delta restores Dignity; needs and stamina clamp.
});

test('GM monster edits keep validated aftermath effects and reject unknown ones',()=>{
 const db=new DatabaseSync(':memory:');try{
  const live=createWorldContent(db,{spells:combatData.spells,equipment:hubData.equipment});
  const scene=effects=>({schema:2,first:{dialogues:[{id:'d',pages:[{id:'p',text:'Hi'}]}],aftermaths:[{id:'a',title:'After',pages:[{id:'q',text:'Oh no',effects}]}]},repeat:{dialogues:[{id:'d',pages:[{id:'p',text:'Hi'}]}],aftermaths:[{id:'a',title:'After',pages:[{id:'q',text:'Oh no',effects}]}]}});
  const monster=effects=>({id:'test_toad',enemy_id:'test_toad',name:'Test Toad',hp:10,str:1,def:0,dex:1,exp:1,defeat:scene(effects)});
  const saved=live.change({action:'content_save',kind:'monster',id:'test_toad',revision:0,entry:monster({wet_delta:500,diaper_wet_delta:1})},'dm');
  const pages=(saved.entry??live.entry('monster','test_toad')).draft.defeat.first.aftermaths[0].pages;
  assert.deepEqual(pages[0].effects,{wet_delta:100,diaper_wet_delta:1}); // Clamped to the authored range.
  assert.throws(()=>live.change({action:'content_save',kind:'monster',id:'test_toad',revision:1,entry:monster({teleport:1})},'dm'),/Unknown scene effect/);
 }finally{db.close();}
});
