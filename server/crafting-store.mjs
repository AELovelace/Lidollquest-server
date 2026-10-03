import {craftingData,craftingCatalog,craftingBases,validateCrafting} from './crafting.mjs';
import {gameContext} from './game-context.mjs';

const sections=['recipes','materials','culinary','cooking','regions','wildlife','tuning','catalysts'];
let provider=()=>craftingData;
export const currentCraftingData=()=>(gameContext()?.craftingData??provider)();
export function useCraftingData(read){if(gameContext())gameContext().craftingData=read;else provider=read;}
export function createCraftingStore(db){
 db.exec('CREATE TABLE IF NOT EXISTS crafting_settings(id INTEGER PRIMARY KEY CHECK(id=1),revision INTEGER NOT NULL,body TEXT NOT NULL)');
 let cachedRevision=-1,cached=craftingData;
 function read(){if(db.isOpen===false)return craftingData;const row=db.prepare('SELECT * FROM crafting_settings WHERE id=1').get();if((row?.revision??0)!==cachedRevision){cachedRevision=row?.revision??0;cached={...craftingData,...(row?JSON.parse(row.body):{})};validateCrafting(cached);}return cached;}
 function view({editor=true}={}){const data=read();return {revision:cachedRevision,data:Object.fromEntries(sections.map(k=>[k,data[k]])),...(editor?{options:{items:Object.entries(craftingCatalog(data)).map(([id,item])=>({id,name:item.name??id,category:item.category})),garments:craftingBases(data).garments.map(g=>({id:g.id,name:g.name}))}}:{})};} // Named choices belong to the GM forms; ordinary player snapshots omit the editor catalogue.
 function save(section,value,revision){
  if(!sections.includes(section))throw Object.assign(Error('Choose a crafting section.'),{status:400});
  read();if(revision!==cachedRevision)throw Object.assign(Error('Crafting settings changed. Reload before saving.'),{status:409});
  const data={...read(),[section]:structuredClone(value)};validateCrafting(data);
  const body=Object.fromEntries(sections.map(k=>[k,data[k]]));
  db.prepare('INSERT INTO crafting_settings VALUES (1,?,?) ON CONFLICT(id) DO UPDATE SET revision=excluded.revision,body=excluded.body').run(cachedRevision+1,JSON.stringify(body));return view();
 }
 return {read,view,save};
} // Web edits use revision checks and the same full-content validator as server startup.
