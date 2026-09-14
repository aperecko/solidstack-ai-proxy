import https from 'https';
import { readFileSync } from 'fs';
const TOKEN = readFileSync('/tmp/mint_token.txt','utf8').trim();
const BODY = JSON.stringify({"project":"aicode-consumers","model":"gemini-3.1-flash-lite","request":{"contents":[{"role":"user","parts":[{"text":"Say OK"}]}],"model":"gemini-3.1-flash-lite","generationConfig":{"maxOutputTokens":30}},"requestType":"agent","requestId":"agent-test","userAgent":"antigravity"});
function req(name, headers) {
  return new Promise((resolve) => {
    const r = https.request('https://daily-cloudcode-pa.googleapis.com/v1internal:streamGenerateContent?alt=sse', { method:'POST', headers:{'Content-Type':'application/json','Authorization':`Bearer ${TOKEN}`,...headers,'Content-Length':Buffer.byteLength(BODY)}, timeout:15000 }, (res) => {
      let d=''; res.on('data',c=>d+=c.toString()); res.on('end',()=>resolve({name,status:res.statusCode,data:d.slice(0,80)}));
    });
    r.on('error',e=>resolve({name,error:e.message}));
    r.write(BODY); r.end();
  });
}
console.log(JSON.stringify(await req('node-no-UA', {})));
console.log(JSON.stringify(await req('node-ua-antigravity', {'User-Agent':'antigravity/1.0'})));
console.log(JSON.stringify(await req('node-ua-Electron', {'User-Agent':'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) imposter/7.6.0 Chrome/124.0.0.0 Electron/30.0.10 Safari/537.36'})));
console.log(JSON.stringify(await req('node-ua-VSCode', {'User-Agent':'vscode-codeium/1.5.0'})));
