/* Music widget, shared by the /gm Music tab, the Map Editor's Zone music box and the Story Workshop's Music block (pasted in by gm.mjs). */
/* Plain ES5 on purpose: the panel's scripts are inlined as-is, so a double-slash comment must be the last thing on its line. */
var musicWidgetAudio=null,musicWidgetUrl=""; // One preview at a time across every widget on the page, played from a blob: URL (a plain src cannot carry the bearer token).
function musicWidgetEl(tag,cls,text){var n=document.createElement(tag);if(cls)n.className=cls;if(text!==undefined)n.textContent=text;return n;} // textContent only: titles are GM-typed text.
function musicWidgetStop(){
 if(musicWidgetAudio){musicWidgetAudio.pause();musicWidgetAudio=null;}
 if(musicWidgetUrl){URL.revokeObjectURL(musicWidgetUrl);musicWidgetUrl="";} // Free the last preview's bytes.
}
function musicWidgetId(data,value){ // Slot value -> content-hash id, or "" for inherit / silence / unknown.
 if(!value||value===data.silence)return "";
 if(value.indexOf(data.uploadPrefix)===0)return value.slice(data.uploadPrefix.length);
 for(var i=0;i<data.catalog.length;i++)if(data.catalog[i].name===value)return data.catalog[i].id;
 return "";
}
function musicWidgetLabel(data,value){ // Slot value -> what a GM reads: library name, upload title, or silence.
 if(!value)return "";
 if(value===data.silence)return "silence";
 if(value.indexOf(data.uploadPrefix)===0){var id=value.slice(data.uploadPrefix.length);for(var i=0;i<data.uploads.length;i++)if(data.uploads[i].id===id)return data.uploads[i].title+" (upload)";return "missing upload";}
 return value;
}
function musicWidgetPreview(data,value,token,say){ // Fetch the mp3 with the bearer token and loop it.
 musicWidgetStop();var id=musicWidgetId(data,value);
 if(!id){say("err","Nothing to preview.");return;}
 fetch("/gm/music/file/"+id+".mp3",{headers:{Authorization:"Bearer "+token()},cache:"no-store"}).then(function(response){
  if(!response.ok)throw new Error("No preview for "+musicWidgetLabel(data,value)+" (HTTP "+response.status+").");
  return response.blob();
 }).then(function(blob){
  musicWidgetStop();musicWidgetUrl=URL.createObjectURL(blob);musicWidgetAudio=new Audio(musicWidgetUrl);musicWidgetAudio.loop=true;
  return musicWidgetAudio.play();
 }).catch(function(error){say("err",error.message);});
}
function musicWidgetSelect(data,slot,value,label){ // slot: "track" (inherit + silence), "battle"/"boss" (game default) or "story" (songs only).
 var s=musicWidgetEl("select");s.setAttribute("aria-label",label);
 if(slot!=="story"){var first=musicWidgetEl("option",null,slot==="track"?"(inherit)":"(game default)");first.value="";s.appendChild(first);}
 if(slot==="track"){var off=musicWidgetEl("option",null,"(silence)");off.value=data.silence;s.appendChild(off);}
 var lib=musicWidgetEl("optgroup");lib.label="Library";
 data.catalog.forEach(function(t){var o=musicWidgetEl("option",null,t.name+" ("+Math.round(t.seconds)+"s)");o.value=t.name;lib.appendChild(o);});
 s.appendChild(lib);
 if(data.uploads.length){
  var up=musicWidgetEl("optgroup");up.label="Uploaded songs";
  data.uploads.forEach(function(u){var o=musicWidgetEl("option",null,u.title+" ("+Math.round(u.seconds)+"s)");o.value=data.uploadPrefix+u.id;up.appendChild(o);});
  s.appendChild(up);
 }
 s.value=value||"";
 if(value&&s.value!==value){var lost=musicWidgetEl("option",null,musicWidgetLabel(data,value)+" (not available)");lost.value=value;s.appendChild(lost);s.value=value;} // A song removed since keeps showing what is saved.
 return s;
}
function musicWidgetRow(data,zone){return data.mapping[zone]||{track:null,battle:null,boss:null,volume:100};} // Saved row, or an empty one.
function musicWidgetEffective(data,z){ // What the Field slot really plays here and why: zone -> parent hub -> Default (same walk as the client).
 var own=musicWidgetRow(data,z.id).track;if(own)return {track:own,from:"this zone"};
 if(z.parent){var up=musicWidgetRow(data,z.parent).track;if(up)return {track:up,from:"its hub"};}
 var fallback=musicWidgetRow(data,data.defaultZone).track;if(fallback&&z.id!==data.defaultZone)return {track:fallback,from:"Default"};
 return {track:"",from:"nothing mapped"};
}
function musicWidgetPlayButton(data,getValue,token,say,label){ // The small ▶ next to a select.
 var play=musicWidgetEl("button","sm","▶");play.type="button";play.title="Preview";play.setAttribute("aria-label","Preview "+label);
 play.addEventListener("click",function(){musicWidgetPreview(data,getValue(),token,say);});
 return play;
}
/* musicWidget(host, {zone, data, post, token, say, onSaved}): one zone's Field/Battle/Boss, volume, Save/Clear and the "Plays" hint. */
/* zone: {id,name,parent?}; post(body) -> Promise of the /gm/action reply; token() -> bearer; say(kind,text); onSaved() reloads data. */
function musicWidget(host,o){
 var data=o.data,z=o.zone,saved=musicWidgetRow(data,z.id),box=musicWidgetEl("div","music-zone"),selects={};
 box.dataset.find=(z.name+" "+z.id).toLowerCase();
 var head=musicWidgetEl("div","music-head");head.appendChild(musicWidgetEl("strong",null,z.name));
 head.appendChild(musicWidgetEl("span","note",z.id===data.defaultZone?" used where nothing else is set":" "+z.id+(z.parent?" · in "+z.parent:"")));box.appendChild(head);
 [["track","Field"],["battle","Battle"],["boss","Boss"]].forEach(function(pair){
  var line=musicWidgetEl("label","music-line"),s=musicWidgetSelect(data,pair[0],saved[pair[0]],pair[1]+" music for "+z.name);
  line.appendChild(musicWidgetEl("span","music-slot",pair[1]));line.appendChild(s);
  line.appendChild(musicWidgetPlayButton(data,function(){return s.value||(pair[0]==="track"?musicWidgetEffective(data,z).track:"");},o.token,o.say,pair[1]+" music for "+z.name));
  box.appendChild(line);selects[pair[0]]=s;
 });
 var volLine=musicWidgetEl("label","music-line"),vol=musicWidgetEl("input");vol.type="number";vol.min="0";vol.max="100";vol.step="1";vol.style.width="70px";vol.value=String(saved.volume==null?100:saved.volume);
 volLine.appendChild(musicWidgetEl("span","music-slot","Volume"));volLine.appendChild(vol);box.appendChild(volLine);
 var eff=musicWidgetEffective(data,z);
 box.appendChild(musicWidgetEl("div","note","Plays: "+(eff.track?musicWidgetLabel(data,eff.track)+" (from "+eff.from+")":"keeps whatever was playing")));
 var stories=(data.overrides||[]).filter(function(v){return v.zone===z.id||v.zone===data.defaultZone;}); // Quest stages that override this zone (Story Workshop).
 if(stories.length&&z.id!==data.defaultZone)box.appendChild(musicWidgetEl("div","note","Story overrides: "+stories.map(function(v){return v.quest+" / "+v.stage+(v.zone===data.defaultZone?" (any zone)":"")+" -> "+(musicWidgetLabel(data,v.track||"")||"battle/boss only");}).join("; ")));
 var actions=musicWidgetEl("div","row"),save=musicWidgetEl("button","go sm","Save"),clear=musicWidgetEl("button","sm","Clear");save.type="button";clear.type="button";
 save.addEventListener("click",function(){
  save.disabled=true;
  o.post({action:"music_set",zone:z.id,track:selects.track.value||null,battle:selects.battle.value||null,boss:selects.boss.value||null,volume:Number(vol.value)}).then(function(){o.say("ok","Music saved for "+z.name+".");o.onSaved();}).catch(function(error){o.say("err",error.message);}).then(function(){save.disabled=false;});
 });
 clear.disabled=!data.mapping[z.id];
 clear.addEventListener("click",function(){
  clear.disabled=true;
  o.post({action:"music_clear",zone:z.id}).then(function(){o.say("ok","Music cleared for "+z.name+"; it inherits again.");o.onSaved();}).catch(function(error){o.say("err",error.message);clear.disabled=false;});
 });
 actions.appendChild(save);actions.appendChild(clear);box.appendChild(actions);
 host.appendChild(box);return box;
}
