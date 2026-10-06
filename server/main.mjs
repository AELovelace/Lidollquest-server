import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {worldWorkerBudget} from './zone-shards.mjs';
import {createWalletClient} from './wallet.mjs';
import {createQuestService} from './service.mjs';
import {parseZoneCapacity} from './zone-capacity.mjs';
const directory=resolve(process.env.DATA_DIR??'data');mkdirSync(directory,{recursive:true,mode:0o700});
const walletClient=createWalletClient({baseUrl:process.env.LIDOLLCOIN_API_URL??'https://lidoll.dev/tracker/api/lidollcoin/v1/',key:process.env.LIDOLLCOIN_REWARD_KEY});
const {zoneWorkers,workerCount}=worldWorkerBudget(process.env.QUEST_ZONE_WORKERS??'auto',process.env.QUEST_COMPUTE_WORKERS??'auto'); // Reserve coordinator/host headroom while sharing cores between both worker pools.
const zoneCapacity=parseZoneCapacity(process.env.QUEST_ZONE_CAPACITY); // Missing or blank settings use 256 players per zone.
const {server,prepare}=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient,workerCount,zoneWorkers,zoneCapacity});
await prepare(); // Generate missing weekly floors across the pool before accepting players; existing floors load without regeneration.
server.listen(Number(process.env.PORT??4191),process.env.HOST??'127.0.0.1',()=>console.log('LiDollQuest server listening on port '+server.address().port+' ('+zoneWorkers+' zone workers, '+workerCount+' generation/pathfinding workers, '+zoneCapacity+' players per zone)')); // Log effective capacity and worker counts so preserved environment settings are easy to verify.
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close()); // Drain accepted requests before closing SQLite.
