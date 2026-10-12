// Companion experiences: what a hired companion saw happen, turned into memory text with plain templates (no AI).
// followers.remember() queues an event inside the game command's transaction; companion-memory.mjs renders it with
// render() after the commit and stores it in the secondary memory database.
//   text        - what the companion remembers about this player ("Doll and I beat ...")
//   gossip      - the same thing with no name, for anonymous gossip to other players ("Someone I traveled with ...")
//   importance  - 1-5, how strongly it competes for a place in the prompt
//   embarrassing- accidents, changes and defeats: only ever said in public as a "slip" (costs Dignity)
//   bond        - how much this event adds to the companion's bond with the player (before the hourly cap)
const ZONE_PREFIX=/^(overworld|dungeon|dive)-/;
export function zoneName(id){ // overworld-autumnal-plains -> the Autumnal Plains; good enough for memory lines.
 const words=String(id??'').replace(ZONE_PREFIX,'').split(/[-_]+/).filter(Boolean).map(w=>w[0].toUpperCase()+w.slice(1));
 return words.length?'the '+words.join(' '):'the wilds';
}
const clip=(v,n=60)=>String(v??'').replace(/[\u0000-\u001f\u007f]+/g,' ').replace(/\s+/g,' ').trim().slice(0,n); // Names and titles come from game data and player names; keep them one short line.

export const EVENT_KINDS=Object.freeze({
 hire:       {importance:1,embarrassing:false,bond:1, text:(p,d)=>`${p} hired me in ${zoneName(d.zone)}.`, gossip:d=>`Someone hired me in ${zoneName(d.zone)} once.`},
 zone:       {importance:2,embarrassing:false,bond:1, text:(p,d)=>`${p} and I explored ${zoneName(d.zone)} together.`, gossip:d=>`I explored ${zoneName(d.zone)} with someone I traveled with.`},
 battle_win: {importance:2,embarrassing:false,bond:2, text:(p,d)=>`${p} and I beat ${clip(d.enemy)||'a monster'} in ${zoneName(d.zone)} together${d.boss?', and it was a boss':''}.`, gossip:d=>`Someone I traveled with and I beat ${clip(d.enemy)||'a monster'} in ${zoneName(d.zone)}.`},
 battle_lost:{importance:3,embarrassing:true, bond:1, text:(p,d)=>`${clip(d.enemy)||'A monster'} beat ${p} in ${zoneName(d.zone)} while I fought beside ${p}, and the aftermath was humiliating.`, gossip:d=>`Someone I traveled with lost to ${clip(d.enemy)||'a monster'} in ${zoneName(d.zone)}, and it was humiliating.`},
 accident:   {importance:3,embarrassing:true, bond:1, text:(p,d)=>`${p} had an accident in ${zoneName(d.zone)} while we were traveling together.`, gossip:d=>`Someone I traveled with had an accident in ${zoneName(d.zone)}.`},
 change:     {importance:2,embarrassing:true, bond:1, text:(p,d)=>`I kept watch while ${p} got changed in ${zoneName(d.zone)}.`, gossip:d=>`I kept watch while someone I traveled with got changed in ${zoneName(d.zone)}.`},
 care:       {importance:3,embarrassing:true, bond:2, text:(p,d)=>`I cleaned up ${p}'s padding in the middle of a fight in ${zoneName(d.zone)}.`, gossip:d=>`I once cleaned up someone's padding in the middle of a fight in ${zoneName(d.zone)}.`},
 revived:    {importance:3,embarrassing:false,bond:3, text:(p,d)=>`${p} was knocked out in ${zoneName(d.zone)} and got back up while I held the line.`, gossip:d=>`Someone I traveled with got knocked out in ${zoneName(d.zone)} and got back up.`},
 quest:      {importance:3,embarrassing:false,bond:5, text:(p,d)=>`${p} and I finished "${clip(d.title)||'a quest'}" together.`, gossip:d=>`I helped someone finish "${clip(d.title)||'a quest'}".`},
});

export function render(kind,data={},player='my friend'){ // -> {text,gossip,importance,embarrassing,bond} or null for an unknown kind.
 const k=EVENT_KINDS[kind];if(!k)return null;
 const p=clip(player,32)||'my friend';
 return {text:k.text(p,data).slice(0,400),gossip:k.gossip(data).slice(0,400),importance:k.importance,embarrassing:k.embarrassing,bond:k.bond};
}
