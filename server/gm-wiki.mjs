import {readFileSync} from 'node:fs';

const root=new URL('./gm-wiki/',import.meta.url);
const chapters=JSON.parse(readFileSync(new URL('pages.json',root),'utf8'));
const types={html:'text/html',css:'text/css',js:'text/javascript',json:'application/json',md:'text/markdown',txt:'text/plain',svg:'image/svg+xml'};
const names=['index.html','wiki.css','wiki.js','pages.json','assets/little-log-logo.svg','vendor/marked.min.js','vendor/purify.min.js','vendor/marked-LICENSE.md','vendor/dompurify-LICENSE.txt',...chapters.map(page=>{
 if(!/^[a-z0-9-]+$/.test(page.slug))throw Error('Invalid GM wiki chapter slug');
 return 'content/'+page.slug+'.md';
})]; // Only release-owned assets can be requested; URL paths are never filesystem paths.
const files=new Map(names.map(name=>[name,{body:readFileSync(new URL(name,root)),type:types[name.split('.').at(-1)]+'; charset=utf-8'}]));

export function serveGmWiki(req,res,url){
 if(url.pathname!=='/gm/wiki'&&!url.pathname.startsWith('/gm/wiki/'))return false;
 const headers={'Cache-Control':'no-cache','X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Content-Security-Policy':"default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"};
 if(!['GET','HEAD'].includes(req.method)){res.writeHead(405,{...headers,Allow:'GET, HEAD'});res.end();return true;}
 if(url.pathname==='/gm/wiki'){res.writeHead(308,{...headers,Location:'/gm/wiki/'+url.search});res.end();return true;} // Canonical trailing slash keeps relative Markdown and script fetches on the wiki path.
 const file=files.get(url.pathname.slice('/gm/wiki/'.length)||'index.html');
 if(!file){res.writeHead(404,{...headers,'Content-Type':'text/plain; charset=utf-8'});res.end(req.method==='HEAD'?undefined:'GM wiki file not found.');return true;}
 res.writeHead(200,{...headers,'Content-Type':file.type,'Content-Length':file.body.length});res.end(req.method==='HEAD'?undefined:file.body);return true;
} // The GM router applies its enabled, TLS and address restrictions first; these static articles contain no staff or character data.
