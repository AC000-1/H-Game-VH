const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');

const ROOT = path.resolve(process.env.DOWNLOAD_ROOT || process.cwd());
const HOST = process.env.HOST || '0.0.0.0';
const PORT = Number(process.env.PORT || 8000);
const STREAM_CHUNK = Math.max(64 * 1024, Number(process.env.STREAM_CHUNK || 4 * 1024 * 1024));
const MAX_CONCURRENCY = Math.max(1, Math.min(64, Number(process.env.MAX_CONCURRENCY || 32)));
const ENABLE_CORS = process.env.CORS === '1';
const RANGE_MAX_CONCURRENCY = Math.max(1, Number(process.env.RANGE_MAX_CONCURRENCY || MAX_CONCURRENCY * 2));
let activeRanges = 0;

function safePath(urlPath) {
  let decoded;
  try { decoded = decodeURIComponent(urlPath || '/'); } catch { return null; }
  const rel = decoded.replace(/^[/\\]+/, '');
  const full = path.resolve(ROOT, rel);
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  return full;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>'"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB','MB','GB','TB'];
  let n = bytes, i = -1;
  do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
  return `${n.toFixed(n >= 100 ? 0 : n >= 10 ? 1 : 2)} ${units[i]}`;
}

function contentDisposition(name) {
  return `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function listDir(dir, webPath) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  entries.sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));
  const rows = [];
  if (webPath !== '/') {
    const parent = path.posix.dirname(webPath.replace(/\/$/, '')) || '/';
    rows.push(`<a class="row dir" href="?p=${encodeURIComponent(parent)}"><span>↩️ ..</span><span>parent</span></a>`);
  }
  for (const e of entries) {
    const childWeb = path.posix.join(webPath, e.name);
    if (e.isDirectory()) {
      rows.push(`<a class="row dir" href="?p=${encodeURIComponent(childWeb + '/')}\"><span>📁 ${escapeHtml(e.name)}</span><span>folder</span></a>`);
      continue;
    }
    let st;
    try { st = await fsp.stat(path.join(dir, e.name)); } catch { continue; }
    rows.push(`<div class="row file"><span title="${escapeHtml(e.name)}">📦 ${escapeHtml(e.name)}</span><span>${humanSize(st.size)} <button class="btn turbo" data-file="${escapeHtml(childWeb)}" data-size="${st.size}">Turbo</button> <a class="btn" href="/download?file=${encodeURIComponent(childWeb)}">Normal</a></span></div>`);
  }
  return rows.join('');
}

const page = (rows, current) => `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Codespace Fast Download v3</title>
<style>
:root{color-scheme:dark}*{box-sizing:border-box}body{font-family:system-ui,-apple-system,Segoe UI,sans-serif;background:#0d1117;color:#e6edf3;margin:0;padding:24px}.wrap{max-width:1200px;margin:auto}h1{font-size:24px;margin:0 0 6px}.sub{color:#8b949e;margin-bottom:16px;word-break:break-all}.bar{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}.search{flex:1;min-width:240px;padding:11px;border-radius:9px;border:1px solid #30363d;background:#161b22;color:#fff}.select,.input{padding:9px;border-radius:8px;border:1px solid #30363d;background:#161b22;color:#fff}.list{border:1px solid #30363d;border-radius:12px;overflow:hidden}.row{display:flex;justify-content:space-between;gap:12px;padding:12px 14px;border-bottom:1px solid #21262d;color:#e6edf3;text-decoration:none}.row:last-child{border-bottom:0}.row:hover{background:#161b22}.row span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.file>span:last-child{white-space:nowrap;color:#8b949e}.btn{border:1px solid #444c56;background:#21262d;color:#fff;border-radius:7px;padding:5px 9px;text-decoration:none;cursor:pointer}.turbo{background:#238636;border-color:#2ea043}.status{margin-top:14px;padding:14px;border:1px solid #30363d;border-radius:10px;background:#161b22}.item{padding:12px 0;border-bottom:1px solid #21262d}.item:last-child{border-bottom:0}.progress{height:9px;background:#21262d;border-radius:5px;overflow:hidden;margin:9px 0}.fill{height:100%;width:0;background:#2ea043;transition:width .08s}.small{font-size:12px;color:#8b949e}.danger{color:#ff7b72}.ok{color:#3fb950}.controls{display:flex;gap:8px;flex-wrap:wrap;margin-top:9px}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:6px;margin-top:8px}.metric{background:#0d1117;border:1px solid #21262d;padding:7px 9px;border-radius:7px}.label{color:#8b949e;font-size:11px;display:block}.value{font-variant-numeric:tabular-nums}
</style></head><body><div class="wrap"><h1>Codespace Fast Download v3</h1><div class="sub">Root: ${escapeHtml(ROOT)}<br>Path: ${escapeHtml(current)}<br>Turbo: adaptive 4–${MAX_CONCURRENCY} connections • Range 206 • retry • live ETA</div>
<div class="bar"><input id="search" class="search" placeholder="Search files..."><select id="connections" class="select"><option value="auto" selected>Auto (recommended)</option><option value="4">4 connections</option><option value="8">8 connections</option><option value="12">12 connections</option><option value="16">16 connections</option><option value="24">24 connections</option><option value="32">32 connections</option></select><select id="chunkSize" class="select"><option value="4">4 MiB chunks</option><option value="8" selected>8 MiB chunks</option><option value="16">16 MiB chunks</option><option value="32">32 MiB chunks</option><option value="64">64 MiB chunks</option></select><button class="btn" onclick="location.reload()">Refresh</button></div>
<div class="list" id="list">${rows || '<div class="row">No files</div>'}</div><div id="status" class="status"><div id="downloads"></div></div></div>
<script>
const search=document.getElementById('search'), downloads=document.getElementById('downloads');
search.oninput=()=>{const q=search.value.toLowerCase();document.querySelectorAll('.row').forEach(x=>x.style.display=x.textContent.toLowerCase().includes(q)?'flex':'none')};
function fmt(n){if(!isFinite(n))return '--';if(n<1024)return n.toFixed(0)+' B';const u=['KB','MB','GB','TB','PB'];let i=-1;do{n/=1024;i++}while(n>=1024&&i<u.length-1);return n.toFixed(n>=100?0:n>=10?1:2)+' '+u[i]}
function eta(sec){if(!isFinite(sec)||sec<0)return '--';sec=Math.ceil(sec);if(sec<1)return '<1s';if(sec<60)return sec+'s';const h=Math.floor(sec/3600),m=Math.floor(sec%3600/60),s=sec%60;if(h)return h+'h '+m+'m';if(m)return m+'m '+s+'s';return s+'s'}
function fileName(p){try{return decodeURIComponent(p).split('/').pop()||'download.bin'}catch{return 'download.bin'}}
function sleep(ms){return new Promise(r=>setTimeout(r,ms))}

async function turbo(file,size){
  if(!window.showSaveFilePicker){alert('Turbo cần Chrome/Edge mới. Hãy dùng Normal nếu trình duyệt không hỗ trợ.');return}
  const mode=document.getElementById('connections').value;
  const manual=mode==='auto'?null:Math.max(1,Math.min(32,Number(mode)));
  const chunk=Math.max(4*1024*1024,Number(document.getElementById('chunkSize').value)*1024*1024);
  const handle=await showSaveFilePicker({suggestedName:fileName(file)});
  const writable=await handle.createWritable();
  await writable.truncate(size);
  const ranges=[];for(let s=0;s<size;s+=chunk)ranges.push({s,e:Math.min(size-1,s+chunk-1)});
  const id=crypto.randomUUID();
  const box=document.createElement('div');box.className='item';box.id=id;downloads.prepend(box);
  let completed=0, nextIndex=0, nextWrite=0, failed=false, stopped=false;
  let targetConcurrency=manual||Math.min(8,Math.max(2,ranges.length));
  const maxConcurrency=Math.min(32,ranges.length);
  const pending=new Map();let pendingBytes=0;
  const controller=new AbortController();
  const start=performance.now();
  let lastBytes=0,lastTick=start,smoothSpeed=0,peakSpeed=0;
  let lastTune=start,lastTuneBytes=0,lastTuneSpeed=0,stableTicks=0;

  function render(){
    const now=performance.now(),elapsed=Math.max(.001,(now-start)/1000);
    const avg=completed/elapsed;
    const remain=Math.max(0,size-completed);
    const speed=smoothSpeed||avg;
    const pct=size?completed/size*100:100;
    const conn=manual||targetConcurrency;
    box.innerHTML='<b>'+fileName(file)+'</b><div class="progress"><div class="fill" style="width:'+pct.toFixed(2)+'%"></div></div><div class="grid"><div class="metric"><span class="label">Downloaded</span><span class="value">'+fmt(completed)+' / '+fmt(size)+'</span></div><div class="metric"><span class="label">Speed</span><span class="value">'+fmt(speed)+'/s</span></div><div class="metric"><span class="label">ETA</span><span class="value">'+eta(remain/Math.max(speed,1))+'</span></div><div class="metric"><span class="label">Peak</span><span class="value">'+fmt(peakSpeed)+'/s</span></div></div><div class="small">'+conn+' connections'+(manual?'':' • adaptive')+' • '+fmt(chunk)+' chunks • '+workerCount+' active • '+fmt(pendingBytes)+' buffered • retries per chunk: 6</div><div class="controls"><button class="btn" data-act="stop">Stop</button></div>';
    box.querySelector('[data-act="stop"]').onclick=()=>{stopped=true;controller.abort()};
  }

  async function flush(){
    while(pending.has(nextWrite)){
      const r=ranges[nextWrite], data=pending.get(nextWrite);pending.delete(nextWrite);pendingBytes-=data.byteLength;
      await writable.seek(r.s);await writable.write(data);nextWrite++;
    }
  }

  function updateSpeed(deltaBytes){
    const now=performance.now();completed+=deltaBytes;
    if(now-lastTick>=250){
      const inst=(completed-lastBytes)/((now-lastTick)/1000);
      smoothSpeed=smoothSpeed?((smoothSpeed*0.7)+(inst*0.3)):inst;
      peakSpeed=Math.max(peakSpeed,smoothSpeed,inst);
      lastBytes=completed;lastTick=now;render();
    }
  }

  async function getRange(r){
    for(let attempt=1;attempt<=6;attempt++){
      try{
        const resp=await fetch('/download?file='+encodeURIComponent(file),{headers:{Range:'bytes='+r.s+'-'+r.e},cache:'no-store',signal:controller.signal});
        if(resp.status===206){
          const expected=r.e-r.s+1;
          if(Number(resp.headers.get('content-length'))!==expected)throw new Error('bad length');
          const reader=resp.body?.getReader();
          if(!reader){const buf=new Uint8Array(await resp.arrayBuffer());if(buf.byteLength!==expected)throw new Error('short range');updateSpeed(buf.byteLength);return buf.buffer}
          const parts=[];let total=0;
          while(true){const {done,value}=await reader.read();if(done)break;if(value){parts.push(value);total+=value.byteLength;updateSpeed(value.byteLength)}}
          if(total!==expected)throw new Error('short range');
          const out=new Uint8Array(total);let off=0;for(const p of parts){out.set(p,off);off+=p.byteLength}
          return out.buffer;
        }
        throw new Error('HTTP '+resp.status);
      }catch(e){
        if(stopped||controller.signal.aborted)throw e;
        if(attempt===6)throw new Error('Range failed: '+r.s+'-'+r.e);
        await sleep(Math.min(4000,250*Math.pow(2,attempt-1)));
      }
    }
  }

  function tune(){
    if(manual||maxConcurrency<=1)return;
    const now=performance.now();
    if(now-lastTune<2000)return;
    const speed=smoothSpeed;
    const gain=lastTuneSpeed?speed/lastTuneSpeed:1;
    lastTuneSpeed=speed;lastTune=now;lastTuneBytes=completed;
    if(speed<1024*64)return;
    if(gain>=0.94 && targetConcurrency<maxConcurrency){
      targetConcurrency=Math.min(maxConcurrency,targetConcurrency+4);
      stableTicks=0;
    }else if(gain<0.84 && targetConcurrency>2){
      targetConcurrency=Math.max(2,targetConcurrency-2);
      stableTicks=0;
    }else{
      stableTicks++;
      if(stableTicks>=2 && targetConcurrency<maxConcurrency)targetConcurrency=Math.min(maxConcurrency,targetConcurrency+2);
    }
  }

  const maxBufferedBytes=Math.max(chunk*2,chunk*Math.max(4,(manual||targetConcurrency)*2));

  async function worker(){
    while(!stopped&&!failed){
      if(pendingBytes>=maxBufferedBytes){await sleep(50);continue}
      if(!manual){tune();if(activeWorkers()>=targetConcurrency){await sleep(80);continue}}
      const i=nextIndex++;if(i>=ranges.length)return;
      try{const data=await getRange(ranges[i]);pending.set(i,data);pendingBytes+=data.byteLength;await flush();}
      catch(e){failed=true;throw e}
    }
  }

  const workers=[];let workerCount=0;
  function activeWorkers(){return workerCount}
  function launch(){if(stopped||failed||nextIndex>=ranges.length)return;workerCount++;const p=worker().finally(()=>workerCount--);workers.push(p);}

  try{
    render();
    const initial=manual||Math.min(maxConcurrency,Math.max(2,targetConcurrency));
    for(let i=0;i<initial;i++)launch();
    while(!failed&&!stopped){
      while(!manual&&workerCount<targetConcurrency&&nextIndex<ranges.length)launch();
      while(manual&&workerCount<initial&&nextIndex<ranges.length)launch();
      tune();render();
      if(nextWrite>=ranges.length)break;
      await sleep(200);
      if(workers.length && workers.every(p=>p.status==='fulfilled'))break;
    }
    await Promise.all(workers);
    await flush();
    if(stopped){try{await writable.abort()}catch{};box.innerHTML='<b>'+fileName(file)+'</b> <span class="danger">Stopped</span>';return}
    if(failed)throw new Error('One or more ranges failed');
    await writable.close();
    const totalSec=(performance.now()-start)/1000;
    box.innerHTML='<b>'+fileName(file)+'</b> <span class="ok">✓ Complete — '+fmt(size)+' • '+fmt(size/Math.max(totalSec,.001))+'/s • '+eta(totalSec)+'</span>';
  }catch(e){try{await writable.abort()}catch{}box.innerHTML='<b>'+fileName(file)+'</b> <span class="danger">✕ '+(stopped?'Stopped':e.message)+'</span>'}
}

document.querySelectorAll('.turbo').forEach(b=>b.onclick=()=>turbo(b.dataset.file,Number(b.dataset.size)));
</script></body></html>`;

async function handleList(res,p){
  const full=safePath(p||'/');if(!full)return send(res,403,'Forbidden');
  let st;try{st=await fsp.stat(full)}catch{return send(res,404,'Directory not found')}
  if(!st.isDirectory())return send(res,400,'Not a directory');
  const rows=await listDir(full,p||'/');
  const headers={'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'};if(ENABLE_CORS)headers['Access-Control-Allow-Origin']='*';
  res.writeHead(200,headers);res.end(page(rows,p||'/'));
}

function parseRange(value,size){
  if(!value)return {start:0,end:size-1,status:200};
  const m=/^bytes=(\d*)-(\d*)$/.exec(value.trim());if(!m)return null;
  let start,end;
  if(m[1]===''){const suffix=Number(m[2]);if(!Number.isFinite(suffix)||suffix<=0)return null;start=Math.max(0,size-suffix);end=size-1}
  else{start=Number(m[1]);end=m[2]===''?size-1:Number(m[2])}
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||start>=size||start>end)return null;
  return {start,end:Math.min(end,size-1),status:206};
}

async function handleDownload(req,res,fileParam){
  const full=safePath(fileParam);if(!full)return send(res,403,'Forbidden');
  let st;try{st=await fsp.stat(full)}catch{return send(res,404,'File not found')}
  if(!st.isFile())return send(res,400,'Not a file');
  const size=st.size;
  const r=parseRange(req.headers.range,size);
  if(!r)return send(res,416,'Range Not Satisfiable',{'Content-Range':`bytes */${size}`,'Accept-Ranges':'bytes'});
  const len=r.end-r.start+1;
  const headers={'Accept-Ranges':'bytes','Content-Length':len,'Content-Type':'application/octet-stream','Content-Disposition':contentDisposition(path.basename(full)),'Cache-Control':'no-store','ETag':`W/"${st.size.toString(16)}-${Math.floor(st.mtimeMs).toString(16)}"`};
  if(r.status===206)headers['Content-Range']=`bytes ${r.start}-${r.end}/${size}`;
  if(ENABLE_CORS){headers['Access-Control-Allow-Origin']='*';headers['Access-Control-Expose-Headers']='Content-Length,Content-Range,Accept-Ranges,ETag'}
  if(r.status===206&&activeRanges>=RANGE_MAX_CONCURRENCY){return send(res,429,'Too Many Range Requests',{'Retry-After':'1','Accept-Ranges':'bytes'})}
  res.writeHead(r.status,headers);
  if(req.method==='HEAD'){res.end();return}
  if(r.status===206)activeRanges++;
  const stream=fs.createReadStream(full,{start:r.start,end:r.end,highWaterMark:STREAM_CHUNK});
  let released=false;const release=()=>{if(r.status===206&&!released){released=true;activeRanges--}};
  const cleanup=()=>{release();stream.destroy()};
  req.on('aborted',cleanup);res.on('close',()=>{if(!res.writableFinished)cleanup()});
  stream.on('error',()=>{release();try{res.destroy()}catch{}});stream.on('close',release);stream.pipe(res);
}

function send(res,code,msg,extra={}){res.writeHead(code,{'Content-Type':'text/plain; charset=utf-8',...extra});res.end(msg)}

const server=http.createServer(async(req,res)=>{
  try{
    if(req.method!=='GET'&&req.method!=='HEAD')return send(res,405,'Method Not Allowed',{'Allow':'GET, HEAD'});
    const u=new URL(req.url,`http://${req.headers.host||'localhost'}`);
    if(u.pathname==='/download')return handleDownload(req,res,u.searchParams.get('file'));
    if(u.pathname==='/'||u.pathname==='/browse')return handleList(res,u.searchParams.get('p')||'/');
    return send(res,404,'Not found');
  }catch(e){console.error(e);if(!res.headersSent)send(res,500,'Internal Server Error')}
});
server.keepAliveTimeout=120000;server.headersTimeout=130000;server.requestTimeout=0;server.maxConnections=1000;
server.listen(PORT,HOST,()=>console.log(`Codespace Fast Download v3 running on http://${HOST}:${PORT}\nRoot: ${ROOT}\nMax Turbo connections: ${MAX_CONCURRENCY}\nServer Range limit: ${RANGE_MAX_CONCURRENCY}\nStream chunk: ${humanSize(STREAM_CHUNK)}`));
