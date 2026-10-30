(function(){
 const icons={
  chevron:'<path d="m6.5 4 4 4-4 4"/>',
  plus:'<path d="M8 3.5v9M3.5 8h9"/>',
  refresh:'<path d="M12.5 6A4.8 4.8 0 1 0 12 11M12.5 2.5V6H9"/>',
  more:'<circle cx="3.5" cy="8" r=".65"/><circle cx="8" cy="8" r=".65"/><circle cx="12.5" cy="8" r=".65"/>',
  desktop:'<rect x="1.75" y="2.5" width="12.5" height="8.5" rx="1.6"/><path d="M8 11v2.5M5 13.5h6"/>',
  server:'<rect x="2" y="2" width="12" height="5" rx="1.5"/><rect x="2" y="9" width="12" height="5" rx="1.5"/><path d="M4.5 4.5h.01M4.5 11.5h.01M10 4.5h1.5M10 11.5h1.5"/>'
 };
 const icon=name=>'<svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">'+icons[name]+'</svg>';
 class TmuxProjects {
  constructor({ipc,row,onOpen,onReconnect,onRender}){
   Object.assign(this,{ipc,row,onOpen,onReconnect,onRender});this.items=new Map();this.requests=new Map();this.sequence=0;this.expanded={};
   try{this.expanded=JSON.parse(localStorage.getItem('tmux-project-tree-v1')||'{}')}catch{}
   ipc.on('project-result',(_,id,ok,value)=>{const request=this.requests.get(id);if(!request)return;clearTimeout(request.timer);this.requests.delete(id);ok?request.resolve(value):request.reject(new Error(value))});
   ipc.on('projects-changed',(_,items)=>this.accept(items));
   ipc.on('transport',(_,state)=>{if(state==='online')return;for(const r of this.requests.values()){clearTimeout(r.timer);r.reject(new Error('连接中断，请恢复连接后重试'))}this.requests.clear()});
   this.makeDialog();
  }
  get(id){return this.items.get(id)}
  title(id){const p=this.get(id);return p?`${p.name} · ${p.host==='local'?'本机':p.host}`:id}
  request(action,data={}){return new Promise((resolve,reject)=>{const id='project-rpc-'+Date.now()+'-'+(++this.sequence);const timer=setTimeout(()=>{this.requests.delete(id);reject(new Error('操作超时，请重试'))},25000);this.requests.set(id,{resolve,reject,timer});if(!this.ipc.send('project-rpc',id,action,data)){clearTimeout(timer);this.requests.delete(id);reject(new Error('正在恢复连接，请稍后重试'))}})}
  async refresh(){this.accept(await this.request('list'))}
  accept(items){this.items=new Map(items.map(p=>[p.id,p]));this.render()}
  render(){
   const locals=document.getElementById('locals'),servers=document.getElementById('servers');locals.replaceChildren();servers.replaceChildren();
   const hosts=[...new Set([...this.items.values()].map(p=>p.host))].filter(h=>!h.toLowerCase().endsWith('-gateway'));
   for(const host of hosts){
    const section=document.createElement('section');section.className='project-server';section.dataset.server=host;
    const heading=document.createElement('div');heading.className='server-heading';
    const toggle=document.createElement('button');toggle.className='server-tree-toggle';toggle.setAttribute('aria-label','展开/收起 '+(host==='local'?'本机':host));
    const arrow=document.createElement('span');arrow.className='tree-chevron';arrow.innerHTML=icon('chevron');
    const hostIcon=document.createElement('span');hostIcon.className='server-kind-icon';hostIcon.innerHTML=icon(host==='local'?'desktop':'server');
    const label=document.createElement('span');label.className='server-heading-label';label.textContent=host==='local'?'Ubuntu / tmux':host;toggle.append(arrow,hostIcon,label);
    const add=document.createElement('button');add.className='tree-action';add.innerHTML=icon('plus');add.title='在 '+(host==='local'?'本机':host)+' 添加项目';add.setAttribute('aria-label',add.title);add.onclick=()=>this.openDialog(host);
    const reload=document.createElement('button');reload.className='tree-action';reload.innerHTML=icon('refresh');reload.title='重新连接 '+host+' 的已打开项目';reload.setAttribute('aria-label',reload.title);reload.onclick=()=>this.onReconnect(host);
    heading.append(toggle,add,reload);const children=document.createElement('div');children.className='project-children';
    const expand=()=>{const visible=this.expanded[host]!==false;children.hidden=!visible;toggle.setAttribute('aria-expanded',String(visible))};
    toggle.onclick=()=>{this.expanded[host]=this.expanded[host]===false;expand();try{localStorage.setItem('tmux-project-tree-v1',JSON.stringify(this.expanded))}catch{}};expand();
    for(const project of this.items.values())if(project.host===host){
     const row=this.row(project.id,project.name);row.classList.add('project-row');row.querySelector('.server-refresh')?.remove();row.title=project.path||'';
     const rename=document.createElement('button');rename.className='project-rename';rename.innerHTML=icon('more');rename.title='编辑项目 '+project.name;rename.setAttribute('aria-label',rename.title);rename.onclick=()=>this.openDialog(host,project);row.addEventListener('contextmenu',e=>{e.preventDefault();e.stopPropagation();this.openDialog(host,project)});row.append(rename);children.append(row);
    }
    section.append(heading,children);(host==='local'?locals:servers).append(section);
   }
   this.onRender();
  }
  makeDialog(){
   const dialog=document.createElement('dialog');dialog.className='project-dialog';dialog.setAttribute('aria-labelledby','project-dialog-title');
   dialog.innerHTML='<form><h2 id="project-dialog-title">添加项目</h2><p class="project-server-label"></p><label>项目名称<input name="name" maxlength="60" autocomplete="off" placeholder="例如 MeshCompare" required></label><label class="project-mode-label">打开方式<select name="mode"><option value="create">新建项目会话</option><option value="attach">接入已有会话</option></select></label><label class="project-path-label">项目目录<input name="path" value="~" autocomplete="off" placeholder="服务器上的完整目录，如 /home/user/project"></label><div class="project-existing" hidden><label>已有会话<select name="session"></select></label><button type="button" class="project-reload-sessions">刷新会话</button></div><p class="project-dialog-error" role="alert"></p><div class="project-dialog-actions"><button type="button" class="project-cancel">取消</button><button type="submit" class="project-submit">创建并打开</button></div></form>';
   document.body.append(dialog);this.dialog=dialog;this.form=dialog.querySelector('form');this.error=dialog.querySelector('.project-dialog-error');
   this.pathHint=document.createElement('p');this.pathHint.className='project-path-hint';this.pathHint.textContent='新路径用于新建终端和恢复已结束的会话。正在运行的终端保留当前目录，可在保存后新建分屏使用新路径。';this.pathHint.hidden=true;this.error.before(this.pathHint);
   this.form.elements.mode.onchange=()=>this.setMode();dialog.querySelector('.project-reload-sessions').onclick=()=>this.loadSessions();
   dialog.querySelector('.project-cancel').onclick=()=>{if(!this.busy)dialog.close()};dialog.addEventListener('cancel',e=>{if(this.busy)e.preventDefault()});
   this.form.onsubmit=e=>{e.preventDefault();this.submit()};
  }
  openDialog(host,project=null){
   this.host=host;this.editing=project;this.busy=false;this.dialogToken=(this.dialogToken||0)+1;this.error.textContent='';this.form.reset();this.form.elements.name.value=project?.name||'';
   this.pathHint.hidden=!project;
   this.dialog.querySelector('h2').textContent=project?'编辑项目':'添加项目';this.dialog.querySelector('.project-server-label').textContent=host==='local'?'本机':host;
   this.dialog.querySelector('.project-mode-label').hidden=!!project;this.form.elements.path.value=project?.path||'~';this.setMode();this.dialog.showModal();this.form.elements.name.focus();
  }
  setMode(){
   const attach=this.form.elements.mode.value==='attach';this.dialog.querySelector('.project-path-label').hidden=!this.editing&&attach;this.dialog.querySelector('.project-existing').hidden=!!this.editing||!attach;
   this.dialog.querySelector('.project-submit').textContent=this.editing?'保存修改':attach?'接入并打开':'创建并打开';
   if(attach&&!this.editing)this.loadSessions();
  }
  async loadSessions(){
   const token=this.dialogToken,host=this.host,select=this.form.elements.session;select.replaceChildren(new Option('正在读取会话…',''));select.disabled=true;this.error.textContent='';
   try{
    const items=await this.request('sessions',{host});if(token!==this.dialogToken)return;select.replaceChildren();
    for(const item of items){const existing=[...this.items.values()].find(p=>p.host===host&&p.sessionName===item.name);const option=new Option(`${item.name} · ${item.windows} 个窗口${existing?' · 已关联 '+existing.name:''}`,item.name);option.disabled=!!existing;select.append(option)}
    const first=Array.from(select.options).find(o=>!o.disabled);if(first)select.value=first.value;else{select.replaceChildren(new Option(items.length?'所有会话均已关联项目':'没有可接入的会话',''))}
   }catch(error){if(token===this.dialogToken){select.replaceChildren(new Option('读取失败，请刷新重试',''));this.error.textContent=error.message}}
   finally{if(token===this.dialogToken)select.disabled=false}
  }
  async submit(){
   if(this.busy)return;const f=this.form.elements,name=f.name.value.trim();if(!name){this.error.textContent='请输入项目名称';return}
   const data=this.editing?{id:this.editing.id,name,path:f.path.value.trim()}:{host:this.host,name,mode:f.mode.value,path:f.path.value.trim(),sessionName:f.session.value};
   if(!this.editing&&data.mode==='attach'&&!data.sessionName){this.error.textContent='请选择一个可接入的会话';return}
   this.busy=true;this.error.textContent='';const buttons=this.dialog.querySelectorAll('button');buttons.forEach(b=>b.disabled=true);
   const submit=this.dialog.querySelector('.project-submit'),oldText=submit.textContent;submit.textContent=this.editing?'正在保存…':'正在连接…';
   try{const project=await this.request(this.editing?'edit':'create',data);this.items.set(project.id,project);this.expanded[project.host]=true;this.render();this.dialog.close();if(!this.editing)this.onOpen(project.id)}catch(error){this.error.textContent=error.message}
   finally{this.busy=false;buttons.forEach(b=>b.disabled=false);submit.textContent=oldText}
  }
 }
 window.TmuxProjects=TmuxProjects;
})();
