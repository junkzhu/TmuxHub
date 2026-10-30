const http=require('http'),fs=require('fs'),path=require('path'),os=require('os'),crypto=require('crypto'),{spawn}=require('child_process'),{WebSocketServer}=require('ws');
const token=crypto.randomBytes(24).toString('hex');const root=__dirname;const port=18763;
function hosts(){return [...new Set(fs.readFileSync(path.join(os.homedir(),'.ssh/config'),'utf8').split(/\r?\n/).filter(l=>/^\s*Host\s+/i.test(l)).flatMap(l=>l.trim().split(/\s+/).slice(1)).filter(x=>/^[\w.-]+$/.test(x)))];}
const projects=new (require('./projects.cjs'))(root,hosts);
const origins=['http://127.0.0.1:'+port,'http://localhost:'+port];
const server=http.createServer((req,res)=>{let url=new URL(req.url,'http://localhost');if(url.pathname==='/api/connection'){
 if(req.method!=='GET'){res.writeHead(405,{Allow:'GET'});return res.end()}
 if(req.headers['sec-fetch-site']==='cross-site'||req.headers.origin&&!origins.includes(req.headers.origin)){res.writeHead(403);return res.end()}
 res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});return res.end(JSON.stringify({token}));
}if(url.pathname==='/launch'){res.writeHead(302,{Location:'/index.html#'+token,'Cache-Control':'no-store'});return res.end()}let p;try{p=path.resolve(root,'.'+decodeURIComponent(url.pathname))}catch{res.writeHead(400);return res.end()}if(!p.startsWith(root+path.sep)){res.writeHead(403);return res.end()}const allowed=['assets/coast.jpg','appearance.css','index.html','connection.js','pane-views.js','projects-ui.js','managed-workspace.js','node_modules/@xterm/xterm/css/xterm.css','node_modules/@xterm/xterm/lib/xterm.js','node_modules/@xterm/addon-fit/lib/addon-fit.js'];if(!allowed.includes(path.relative(root,p).replace(/\\/g,'/'))){res.writeHead(404);return res.end()}res.setHeader('Content-Type',p.endsWith('.html')?'text/html; charset=utf-8':p.endsWith('.css')?'text/css':p.endsWith('.jpg')?'image/jpeg':'application/javascript');if(p.endsWith('.html')||p.endsWith('.js')||p.endsWith('.css'))res.setHeader('Cache-Control','no-store');fs.createReadStream(p).on('error',()=>{if(!res.headersSent)res.writeHead(404);res.end()}).pipe(res)});
const wss=new WebSocketServer({noServer:true});server.on('upgrade',(req,socket,head)=>{const url=new URL(req.url,'http://localhost');if(url.searchParams.get('token')!==token||!origins.includes(req.headers.origin)){socket.destroy();return}wss.handleUpgrade(req,socket,head,ws=>wss.emit('connection',ws))});
const heartbeat=setInterval(()=>{for(const ws of wss.clients){if(!ws.isAlive){ws.terminate();continue}ws.isAlive=false;ws.ping()}},30000);
heartbeat.unref();wss.on('close',()=>clearInterval(heartbeat));

function nativeClipboard(mode,text=''){
 const command=mode==='read'?"[Console]::Write([Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string](Get-Clipboard -Raw))))":"$b=[Console]::In.ReadToEnd(); $t=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($b)); Set-Clipboard -Value $t";
 return new Promise((resolve,reject)=>{
 const p=spawn('powershell.exe',['-NoProfile','-NonInteractive','-STA','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{windowsHide:true});
 let out='',done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};
 const timer=setTimeout(()=>{p.kill();finish(new Error('Clipboard timed out'))},8000);
 p.stdout.on('data',d=>out+=d.toString());p.stderr.resume();p.on('error',e=>finish(e));p.on('exit',code=>{if(code!==0)return finish(new Error('Clipboard unavailable'));finish(null,mode==='read'?Buffer.from(out.trim(),'base64').toString('utf8'):'')});
 p.stdin.on('error',()=>{});p.stdin.end(mode==='write'?Buffer.from(text,'utf8').toString('base64'):'');
 });
}
async function sshAddressOptions(host){
 const {stdout}=await require('util').promisify(require('child_process').execFile)('ssh.exe',['-G',host],{windowsHide:true,timeout:5000});
 const config=Object.fromEntries(stdout.split(/\r?\n/).filter(l=>l.includes(' ')).map(l=>[l.slice(0,l.indexOf(' ')),l.slice(l.indexOf(' ')+1)]));
 const hostname=config.hostname;
 if(!hostname||require('net').isIP(hostname)||config.proxyjump&&config.proxyjump!=='none'||config.proxycommand&&config.proxycommand!=='none')return [];
 let timer;try{const {address}=await Promise.race([require('dns').promises.lookup(hostname,{family:4}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('DNS timeout')),5000)})]);
 return ['-o','HostName='+address,'-o','HostKeyAlias='+(config.hostkeyalias&&config.hostkeyalias!=='none'?config.hostkeyalias:hostname)];}finally{clearTimeout(timer)}
}
// Reverse proxies originate on Windows, where the local proxy listens.
// Each tunnel has its own remote watchdog, so an abandoned SSH connection
// releases only its own forwarded port after a network change.
const proxyManager=new (require('./proxy-tunnel.js'))({root});
process.on('exit',()=>proxyManager.shutdown());
// Keep proxies available for remote Codex sessions even when their tabs are closed.
server.on('listening',()=>{try{const available=hosts();for(const host of ['hpc','cislab'])if(available.includes(host))proxyManager.ensure(host)}catch(_){}});
wss.on('connection',ws=>{
 const children=new Map(),launches=new Map();
 const send=(event,...args)=>{if(ws.readyState===1)ws.send(JSON.stringify({event,args}))};
 const stop=entry=>{
  if(entry.monitor){entry.monitor.stdin.end();const monitor=entry.monitor;setTimeout(()=>monitor.kill(),2000).unref();entry.monitor=null}
  // Closing stdin lets the bridge hang up its PTY and reap SSH before WSL exits.
  entry.proc.stdout.resume();entry.proc.stderr.resume();
  entry.proc.stdin.end();
  const timer=setTimeout(()=>entry.proc.kill(),2000);timer.unref();entry.proc.once('close',()=>clearTimeout(timer));
 };
 const connect=async(id,host,options,projectId=id,pane=null)=>{
  if(ws.readyState!==1||children.has(id)||launches.has(id))return;
  const ticket={};launches.set(id,ticket);let addressOptions=[];let project=projects.get(projectId);
  try{project=await projects.bind(project)}catch(error){if(launches.get(id)===ticket){launches.delete(id);send('failure',id,error.message);send('ended',id,{code:1,retryable:false})}return}
  if(host!=='local')try{addressOptions=await sshAddressOptions(host)}catch{}
  if(ws.readyState!==1||launches.get(id)!==ticket)return;
  launches.delete(id);
  if(host==='hpc'||host==='cislab'){proxyManager.ensure(host);addressOptions.push('-o','ClearAllForwardings=yes')}
  const attach=pane?projects.command({...project,action:'attach',pane},'workspace.py').shell:projects.command({...project,action:'attach'}).shell;
  const remote=pane?'exec '+attach:fs.readFileSync(path.join(root,'remote-session.sh'),'utf8').replace(/\r\n?/g,'\n').replace('exec tmux attach-session','exec '+attach).replace('exec tmux new-session -s work','exec '+attach);
  const cmd=host==='local'?['sh','-c',!pane&&id==='local'?'printf "\\033]777;tmux-client;%s\\007" "$(tty)"; exec env TMUX_HUB_GUI=1 $HOME/.local/bin/tmux-desktop':remote]:['ssh.exe',...addressOptions,'-tt','-o','ConnectTimeout=15','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3','-o','TCPKeepAlive=yes',host,remote];
  const script=path.join(root,'bridge.py').replace(/\\/g,'/').replace(/^([A-Za-z]):/,(_,d)=>'/mnt/'+d.toLowerCase());
  const c=spawn('wsl.exe',['-d','Ubuntu-22.04','--','python3',script,Buffer.from(JSON.stringify(cmd)).toString('base64')],{windowsHide:true});
  const entry={proc:c,host,streamId:crypto.randomBytes(12).toString('hex'),flowControl:options?.flowControl===true,pending:0};children.set(id,entry);send('started',id);
  const current=()=>children.get(id)===entry;
  const output=data=>{
   if(!current()||ws.readyState!==1)return;
   if(entry.flowControl){entry.pending+=Buffer.from(data,'base64').length;send('output',id,data,entry.streamId);if(entry.pending>=256*1024){c.stdout.pause();c.stderr.pause()}}
   else send('output',id,data);
  };
  let buffer='';c.stdout.on('data',d=>{buffer+=d.toString();let n;while((n=buffer.indexOf('\n'))>=0){let line=buffer.slice(0,n);buffer=buffer.slice(n+1);try{output(JSON.parse(line).data)}catch{}}});
  c.stderr.on('data',d=>output(Buffer.from(d).toString('base64')));
  c.stdin.on('error',()=>{}); // EPIPE during disconnect is followed by the child's close event.
  c.on('error',e=>{if(current())send('failure',id,e.message)});
  c.on('close',(code,signal)=>{if(entry.monitor){entry.monitor.stdin.end();entry.monitor=null}if(!current())return;children.delete(id);send('ended',id,{code,signal,retryable:code!==0||!!signal})});
 };
 ws.isAlive=true;ws.on('pong',()=>{ws.isAlive=true});ws.on('error',()=>{});
 ws.on('message',raw=>{let m;try{m=JSON.parse(raw)}catch{return}if(!m||!Array.isArray(m.args))return;const [id,host]=m.args;
if(m.event==='ping'){send('pong',...m.args);return}
if(m.event==='clipboard-read'||m.event==='clipboard-write'){
 if(typeof id!=='string'||id.length>80)return;
 if(m.event==='clipboard-write'&&(typeof host!=='string'||Buffer.byteLength(host)>4*1024*1024)){send('clipboard-result',id,false,'剪贴板内容过大');return}
 nativeClipboard(m.event==='clipboard-read'?'read':'write',host).then(value=>send('clipboard-result',id,true,value),()=>send('clipboard-result',id,false,'Windows 剪贴板暂时不可用'));return;
}
if(m.event==='project-rpc'){
 if(typeof id!=='string'||id.length>120)return;
 projects.rpc(host,m.args[2]).then(value=>{send('project-result',id,true,value);if(['create','rename','edit'].includes(host)){const all=projects.list();for(const client of wss.clients)if(client.readyState===1)client.send(JSON.stringify({event:'projects-changed',args:[all]}))}},error=>send('project-result',id,false,error.message));return;
}
if(m.event==='workspace-rpc'){
 if(typeof id!=='string'||id.length>120||!m.args[2]||typeof m.args[2].project!=='string')return;
 const data=m.args[2];projects.workspace(data.project,host,data).then(value=>{
  send('workspace-result',id,true,value);
  if(host==='split'||host==='layout')for(const client of wss.clients)if(client.readyState===1)client.send(JSON.stringify({event:'workspace-changed',args:[data.project,value]}));
 },error=>send('workspace-result',id,false,error.message));return;
}
if(m.event==='pane-connect'){
 const project=projects.get(id);if(!project||typeof host!=='string'||!/^%\d+$/.test(host))return;
 const key=id+'/'+host;const old=children.get(key);
 if(m.args[2]?.reconnect&&old){children.delete(key);stop(old)}
 connect(key,project.host,m.args[2],id,host);return;
}
if(m.event==='hosts'){send('hosts',hosts());return}if(m.event==='connect'||m.event==='reconnect'){
 const project=projects.get(id);if(!project||project.host!==host)return;
 send('failure',id,'终端已升级，请刷新页面使用独立分屏');send('ended',id,{code:0,retryable:false});return;
 if(m.event==='reconnect'){launches.delete(id);const old=children.get(id);if(old){children.delete(id);stop(old)}}
 connect(id,host,m.args[2]);return;
}
const entry=children.get(id);if(!entry)return;const c=entry.proc;
if(m.event==='pane-watch'){
 if(typeof host!=='string'||!/^\/dev\/pts\/\d+$/.test(host)||entry.monitor)return;
 const source=Buffer.from(fs.readFileSync(path.join(root,'pane-monitor.py'),'utf8')).toString('base64');
 const code="import base64;exec(base64.b64decode('"+source+"'))";
 const monitor=entry.host==='local'?spawn('wsl.exe',['-d','Ubuntu-22.04','--exec','python3','-u','-c',code,host],{windowsHide:true}):spawn('ssh.exe',['-T','-o','BatchMode=yes','-o','ClearAllForwardings=yes','-o','ConnectTimeout=10','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=3',entry.host,'python3 -u -c "'+code+'" '+host],{windowsHide:true});
 entry.monitor=monitor;let lines='';
 monitor.stdin.on('error',()=>{});monitor.stderr.resume();monitor.on('error',()=>{});
 monitor.stdout.on('data',chunk=>{lines+=chunk.toString();let n;while((n=lines.indexOf('\n'))>=0){const line=lines.slice(0,n);lines=lines.slice(n+1);try{const layout=JSON.parse(line);if(children.get(id)===entry)send('pane-layout',id,layout)}catch{}}if(lines.length>1024*1024)lines=''});
 monitor.once('close',()=>{if(entry.monitor===monitor){entry.monitor=null;if(children.get(id)===entry)send('pane-layout',id,null)}});
 return;
}
if(m.event==='output-ack'){
 const bytes=m.args[2];if(entry.flowControl&&m.args[1]===entry.streamId&&Number.isSafeInteger(bytes)&&bytes>0){entry.pending=Math.max(0,entry.pending-bytes);if(entry.pending<128*1024){c.stdout.resume();c.stderr.resume()}}return;
}
if(c.stdin.destroyed||c.stdin.writableEnded)return;
if(m.event==='input'&&typeof m.args[1]==='string')c.stdin.write(JSON.stringify({data:m.args[1]})+'\n');if(m.event==='resize'&&Number.isFinite(m.args[1])&&Number.isFinite(m.args[2]))c.stdin.write(JSON.stringify({cols:m.args[1],rows:m.args[2]})+'\n');
 });
 ws.on('close',()=>{launches.clear();const old=[...children.values()];children.clear();for(const entry of old)stop(entry)});
});server.listen(port,'127.0.0.1',()=>console.log('READY'));

function openApp(){spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',['--app=http://127.0.0.1:18763/launch'],{stdio:'ignore'}).unref()}
if(process.argv.includes('--open')){server.on('listening',openApp);server.on('error',e=>{if(e.code==='EADDRINUSE'){openApp();setTimeout(()=>process.exit(0),1000)}else console.error(e)})}
