const fs=require('fs'),path=require('path'),crypto=require('crypto'),{spawn}=require('child_process');

class Projects {
 constructor(root,hosts){
  this.root=root;this.hosts=hosts;this.file=path.join(root,'projects.json');this.pending=new Map();this.operations=new Map();
  this.items=fs.existsSync(this.file)?JSON.parse(fs.readFileSync(this.file,'utf8')):[];
  if(!Array.isArray(this.items))throw new Error('Invalid projects registry');
 }
 save(){const tmp=this.file+'.tmp';fs.writeFileSync(tmp,JSON.stringify(this.items,null,2)+'\n');fs.renameSync(tmp,this.file)}
 allowed(host){return host==='local'||this.hosts().includes(host)}
 list(){
  let changed=false;
  for(const host of ['local',...this.hosts()])if(!this.items.some(p=>p.id===host)){
   this.items.push({id:host,host,name:'默认',sessionName:host==='local'?'terminal':null,path:'~',mode:'default'});changed=true;
  }
  if(changed)this.save();return this.items.filter(p=>this.allowed(p.host));
 }
 get(id){return this.list().find(p=>p.id===id)}
 command(spec,script='project-session.py'){
  const code="import base64;exec(base64.b64decode('"+fs.readFileSync(path.join(this.root,script)).toString('base64')+"'))";
  const data=Buffer.from(JSON.stringify(spec)).toString('base64');
  return {code,data,shell:'python3 -c "'+code+'" '+data};
 }
 run(host,spec,script='project-session.py'){
  if(!this.allowed(host))return Promise.reject(new Error('服务器不存在'));
  const {code,data,shell}=this.command(spec,script);
  return new Promise((resolve,reject)=>{
   const p=host==='local'?spawn('wsl.exe',['-d','Ubuntu-22.04','--exec','python3','-c',code,data],{windowsHide:true}):spawn('ssh.exe',['-T','-o','BatchMode=yes','-o','ClearAllForwardings=yes','-o','ConnectTimeout=10',host,shell],{windowsHide:true});
   let out='',err='',done=false;const finish=(error,value)=>{if(done)return;done=true;clearTimeout(timer);error?reject(error):resolve(value)};
   const timer=setTimeout(()=>{p.kill();finish(new Error('服务器响应超时，请检查连接后重试'))},20000);
   p.stdin.end();p.stdout.on('data',d=>out+=d.toString());p.stderr.on('data',d=>err+=d.toString());p.on('error',e=>finish(e));
   p.on('close',code=>{if(code!==0)return finish(new Error(err.trim()||'无法访问服务器'));try{finish(null,JSON.parse(out))}catch{finish(new Error('服务器返回了无法识别的会话信息'))}});
  });
 }
 async workspace(id,action,data={}){
  if(!['prepare','split','layout'].includes(action))throw new Error('请求无效');
  const project=this.get(id);if(!project)throw new Error('项目不存在');
  const bound=await this.bind(project);
  return this.run(bound.host,{...data,sessionName:bound.sessionName,path:bound.path,pathOverride:bound.pathOverride,action},'workspace.py');
 }
 async bind(project){
  if(project.sessionName)return project;
  if(this.pending.has(project.id))return this.pending.get(project.id);
  const pending=this.run(project.host,{action:'prepare',mode:'default',preferred:'work',path:'~'}).then(result=>{Object.assign(project,result);this.save();return project}).finally(()=>this.pending.delete(project.id));
  this.pending.set(project.id,pending);return pending;
 }
 rpc(action,data={}){
  if(action!=='create')return this.perform(action,data);
  const key=data?.host,prior=this.operations.get(key)||Promise.resolve();
  const result=prior.catch(()=>{}).then(()=>this.perform(action,data));this.operations.set(key,result);
  result.finally(()=>{if(this.operations.get(key)===result)this.operations.delete(key)}).catch(()=>{});return result;
 }
 async perform(action,data={}){
  if(action==='list')return this.list();
  if(action==='sessions')return this.run(data.host,{action:'list'});
  if(action==='edit'){
   const p=this.get(data.id);if(!p)throw new Error('项目不存在');this.validateName(data.name);
   if(this.items.some(q=>q.id!==p.id&&q.host===p.host&&q.name===data.name.trim()))throw new Error('同一服务器已有这个项目名称');
   if(typeof data.path!=='string'||!data.path.trim()||data.path.length>4096||/[\x00\r\n]/.test(data.path))throw new Error('请输入有效的项目目录');
   const result=await this.run(p.host,{action:'validate-path',path:data.path.trim()});
   if(p.path!==result.path)p.pathOverride=true;
   p.name=data.name.trim();p.path=result.path;this.save();return p;
  }
  if(action==='rename'){
   const p=this.get(data.id);if(!p)throw new Error('项目不存在');this.validateName(data.name);
   if(this.items.some(q=>q.id!==p.id&&q.host===p.host&&q.name===data.name.trim()))throw new Error('同一服务器已有这个项目名称');
   p.name=data.name.trim();this.save();return p;
  }
  if(action!=='create'||!this.allowed(data.host))throw new Error('请求无效');
  this.validateName(data.name);
  if(!['create','attach'].includes(data.mode))throw new Error('请选择创建项目或接入已有会话');
  if(this.list().some(p=>p.host===data.host&&p.name===data.name.trim()))throw new Error('同一服务器已有这个项目名称');
  const id='project-'+crypto.randomUUID();
  if(data.mode==='attach'){
   const found=(await this.run(data.host,{action:'list'})).find(p=>p.name===data.sessionName);
   if(!found)throw new Error('所选会话已经不存在，请刷新后重试');
   const existing=this.items.find(p=>p.host===data.host&&p.sessionName===data.sessionName);
   if(existing)throw new Error('这个会话已关联项目「'+existing.name+'」，请直接打开该项目');
  }else if(typeof data.path!=='string'||data.path.length>4096||/[\x00\r\n]/.test(data.path))throw new Error('请输入有效的项目目录');
  // Pin the legacy default before adding another session, so it cannot drift
  // to the newly-created project on its next reconnect.
  await this.bind(this.get(data.host));
  if(data.mode==='attach'){
   const duplicate=this.items.find(p=>p.host===data.host&&p.sessionName===data.sessionName);
   if(duplicate)throw new Error('这个会话已关联项目「'+duplicate.name+'」，请直接打开该项目');
  }
  const spec={mode:data.mode,sessionName:data.mode==='attach'?data.sessionName:id,path:data.path||'~'};
  const result=await this.run(data.host,{...spec,action:'prepare'});
  const project={id,host:data.host,name:data.name.trim(),...spec,...result};
  this.items.push(project);this.save();return project;
 }
 validateName(name){if(typeof name!=='string'||!name.trim()||name.trim().length>60||/[\x00-\x1f]/.test(name))throw new Error('项目名称需要 1–60 个字符')}
}
module.exports=Projects;
