import {AsyncLocalStorage} from 'node:async_hooks';
const contexts=new AsyncLocalStorage();
export const gameContext=()=>contexts.getStore();
export const withGameContext=(context,work)=>contexts.run(context,work);
export function contextualApi(api,context){
 const wrap=object=>Object.fromEntries(Object.entries(object).map(([key,value])=>[key,typeof value==='function'?(...args)=>withGameContext(context,()=>value(...args)):value]));
 const result=wrap(api);result.world={...wrap(api.world),flows:wrap(api.world.flows)};return result;
} // Isolated engines retain their own tuning providers, even across asynchronous generation callbacks.
