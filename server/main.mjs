import {mkdirSync} from 'node:fs';
import {resolve} from 'node:path';
import {createWalletClient} from './wallet.mjs';
import {createQuestService} from './service.mjs';
const directory=resolve(process.env.DATA_DIR??'data');mkdirSync(directory,{recursive:true,mode:0o700});
const walletClient=createWalletClient({baseUrl:process.env.LIDOLLCOIN_API_URL??'https://lidoll.dev/tracker/api/lidollcoin/v1/',key:process.env.LIDOLLCOIN_REWARD_KEY});
const {server}=createQuestService({filename:resolve(directory,'quest.sqlite'),walletClient});
server.listen(Number(process.env.PORT??4191),process.env.HOST??'127.0.0.1',()=>console.log('LiDollQuest server listening on port '+server.address().port));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>server.close()); // Drain accepted requests before closing SQLite.
