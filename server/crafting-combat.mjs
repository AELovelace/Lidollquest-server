export function mealMultiplier(loadout,kind){const b=loadout?.player_info?.meal_buff;return b?.turns>0&&b.kind===kind?1+(Number(b.amount)||0)/100:1;}
export function tickMeal(loadout,turns=1){const p=loadout?.player_info;if(!p?.meal_buff)return;if(p.meal_buff.kind==='stamina')p.stamina=Math.min(p.stamina_max??100,(p.stamina??0)+Math.min(turns,p.meal_buff.turns)*p.meal_buff.amount/100);p.meal_buff.turns-=turns;if(p.meal_buff.turns<=0)delete p.meal_buff;} // Called only for committed gameplay turns; porridge supplies modest sustained recovery.
export function weaponEffects(state,{weapon,actual,raw,roll,mitigate,enemies=[]}){
 if(actual<=0)return;const r=state.run,properties=weapon?.weapon_properties??[];
 if(properties.includes('lifesteal')){const heal=Math.min(r.maxHp-r.hp,Math.max(1,Math.floor(actual*.1)));r.hp+=heal;if(heal)r.log.push('Lifesteal restores '+heal+' HP.');}
 if(properties.includes('burn')&&r.enemy.hp>0&&roll(10000)<2500){const damage=Math.max(1,Math.floor(actual*.2)),old=r.dots.find(dot=>dot.spell_id==='crafted_burn');if(old){old.damage=Math.max(old.damage,damage);old.turns_left=2;}else r.dots.push({spell_id:'crafted_burn',damage,turns_left:2});r.log.push(r.enemy.name+' is burning.');}
 if(properties.includes('chain_lightning')&&roll(10000)<2000){const other=enemies.find(e=>e!==r.enemy&&e.hp>0);if(other){const damage=Math.max(1,mitigate(Math.floor(raw*.5),other.def));other.hp=Math.max(0,other.hp-damage);r.log.push('Lightning strikes '+other.name+' for '+damage+' damage.');}}
} // Secondary damage never calls this routine, so properties cannot recurse.
