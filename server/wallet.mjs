import {createHmac,createHash} from 'node:crypto';
import {isIP} from 'node:net';
export function createWalletClient({baseUrl,key,fetcher=fetch}={}){
 const base=new URL(baseUrl);if(!['http:','https:'].includes(base.protocol)||base.username||base.password||base.search||base.hash||!base.pathname.endsWith('/'))throw Error('Invalid wallet API URL');
 const octets=base.hostname.split('.').map(Number),privateHost=['localhost','[::1]'].includes(base.hostname)||(isIP(base.hostname)===4&&(octets[0]===127||octets[0]===10||(octets[0]===172&&octets[1]>=16&&octets[1]<=31)||(octets[0]===192&&octets[1]===168)));
 if(base.protocol!=='https:'&&!privateHost)throw Error('Wallet HTTP is limited to an explicitly configured private or loopback host.'); // Never transmit a player's grant over public cleartext HTTP.
 if(!/^[A-Za-z0-9_-]{43,128}$/.test(key??''))throw Error('Set the server-only LIDOLLCOIN_REWARD_KEY.');
 async function request(token,body){
  const url=new URL(body?'operations':'wallet',base);url.searchParams.set('client_id','lidollquest');
  const signature=body?createHmac('sha256',key).update('lidollquest\n'+token+'\n'+JSON.stringify(body)).digest('hex'):null;
  const response=await fetcher(url,{method:body?'POST':'GET',headers:{Authorization:'Bearer '+token,...(body?{'Content-Type':'application/json','X-Reward-Signature':signature}:{})},body:body?JSON.stringify(body):undefined,redirect:'error',signal:AbortSignal.timeout(5000)});
  const chunks=[];let size=0;for await(const chunk of response.body){size+=chunk.length;if(size>32768)throw Error('Wallet response too large');chunks.push(Buffer.from(chunk));}
  const data=JSON.parse(Buffer.concat(chunks));
  if(!response.ok&&body?.kind==='debit'&&response.status===409&&data.error_description==='Insufficient balance or account balance limit reached.')throw Object.assign(Error('Not enough LiDollCoins.'),{status:409,code:'insufficient_balance'});
  if(!response.ok)throw Object.assign(Error(response.status===401?'Reconnect your linked account.':'The wallet is temporarily unavailable.'),{status:response.status,code:'wallet_unavailable'});return data;
 }
 return {
  async authenticate(token){
   if(typeof token!=='string'||!/^[A-Za-z0-9_-]{20,100}$/.test(token))throw Object.assign(Error('A linked account is required.'),{status:401});
   const data=await request(token);if(!/^[a-f0-9]{64}$/.test(data.account_id??'')||!Number.isSafeInteger(data.balance)||data.balance<0)throw Error('Invalid wallet identity');
   return {owner:data.account_id,id:createHash('sha256').update(token).digest('hex'),client:'lidollquest',coins:data.balance};
  },
  async credit(token,body){const result=await request(token,body);if(result.request_id!==body.request_id||result.currency!=='LiDollCoin'||result.amount!==body.amount||!Number.isSafeInteger(result.balance)||result.balance<0)throw Error('Invalid reward receipt');return result;},
 };
} // Secrets stay on the service. Only verified arena entitlements reach the shared wallet.
