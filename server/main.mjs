import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {worldWorkerBudget} from './zone-shards.mjs';
import {createWalletClient} from './wallet.mjs';
import {createQuestService} from './service.mjs';
const directory=resolve(process.env.DATA_DIR??'data');mkdirSync(directory,{recursive:true,mode:0o700});
const walletClient=createWalletClient({baseUrl:process.env.LIDOLLCOIN_API_URL??'https://lidoll.dev/tracker/api/lidollcoin/v1/',key:process.env.LIDOLLCOIN_REWARD_KEY});
const {zoneWorkers,workerCount}=worldWorkerBudget(process.env.QUEST_ZONE_WORKERS??'auto',process.env.QUEST_COMPUTE_WORKERS??'auto'); // Reserve coordinator/host headroom while sharing cores between both worker pools.
const {server,prepare}=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient,workerCount,zoneWorkers});
await prepare(); // Generate missing weekly floors across the pool before accepting players; existing floors load without regeneration.
server.listen(Number(process.env.PORT??4191),process.env.HOST??'127.0.0.1',()=>console.log('LiDollQuest server listening on port '+server.address().port+' ('+zoneWorkers+' zone workers, '+workerCount+' generation/pathfinding workers)')); // Log the effective pool sizes so a preserved environment file is easy to verify after deployment.
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close()); // Drain accepted requests before closing SQLite.
