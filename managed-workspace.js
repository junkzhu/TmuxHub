/* Each view has its own tmux window, PTY, xterm buffer and cell dimensions. */
(function(root){
 'use strict';
 const clone=value=>JSON.parse(JSON.stringify(value));
 function paneIds(tree){return tree.pane?[tree.pane]:tree.children.flatMap(paneIds)}
 // Track only verified overlapping rows while a full-screen application scrolls.
 // xterm cannot retain these rows: the application redraws its alternate buffer.
 class DragTranscript{
  constructor(rows,anchor){this.rows=rows;this.top=0;this.anchor=anchor;this.end=anchor;this.saved=new Map(rows.map((r,i)=>[i,r]));this.height=rows.length}
  merge(rows,direction){
   const old=this.rows,n=Math.min(old.length,rows.length);if(n!==old.length)return false;
   const keys=old.map(r=>r.cells.join('').trimEnd()),nextKeys=rows.map(r=>r.cells.join('').trimEnd());
   let bottom=n;while(bottom>0&&keys[bottom-1]===nextKeys[bottom-1])bottom--;
   if(!bottom)return false;
   let best=null;
   for(let step=1;step<Math.min(13,n);step++){
    const delta=direction*step;let matches=0,total=0,distinct=new Set();
    for(let y=0;y<bottom;y++){
     const other=y+delta;if(other<0||other>=bottom)continue;
     const a=keys[other],b=nextKeys[y];if(!a&&!b)continue;total++;
     if(a===b&&a.trim()){matches++;distinct.add(a)}
    }
    if(matches>=2&&distinct.size>=2&&matches/Math.max(1,total)>=.65&&(!best||matches>best.matches))best={delta,matches};
   }
   if(!best)return false;
   // A fixed composer/status footer is not part of the scrolling conversation.
   if(!this.scrolled){for(let y=bottom;y<this.height;y++)this.saved.delete(this.top+y);this.anchor.y=Math.min(this.anchor.y,bottom-1);this.scrolled=true}
   this.top+=best.delta;this.rows=rows;this.height=bottom;
   for(let y=0;y<bottom;y++)this.saved.set(this.top+y,rows[y]);
   return true;
  }
  select(x,y){this.end={x,y:this.top+Math.min(y,this.height-1)}}
  range(){const a=this.anchor,b=this.end;return a.y<b.y||a.y===b.y&&a.x<=b.x?[a,b]:[b,a]}
  text(){const [a,b]=this.range();let out='';for(let y=a.y;y<=b.y;y++){const row=this.saved.get(y);if(!row)continue;const text=row.cells.slice(y===a.y?a.x:0,y===b.y?b.x+1:undefined).join('').trimEnd();out+=(y>a.y&&!row.wrapped?'\n':'')+text}return out}
 }
 class ManagedWorkspace{
  constructor({id,mount,ipc,options,notify,onState}){
   Object.assign(this,{id,mount,ipc,options,notify,onState});this.views=new Map();this.selected=null;this.sequence=0;this.requests=new Map();this.epoch=0;
   this.empty=new Terminal({...options,disableStdin:true});
   this.navigation=document.createElement('div');this.navigation.className='workspace-windows';
   this.board=document.createElement('div');this.board.className='workspace-board';mount.append(this.navigation,this.board);
   ipc.on('workspace-result',(_,request,ok,value)=>{const pending=this.requests.get(request);if(!pending)return;clearTimeout(pending.timer);this.requests.delete(request);ok?pending.resolve(value):pending.reject(new Error(value))});
   ipc.on('workspace-changed',(_,project,state)=>{if(project===id&&(!this.state||state.revision>this.state.revision))this.apply(state)});
   ipc.on('started',(_,stream)=>{const v=this.forStream(stream);if(!v)return;clearTimeout(v.retry);v.connecting=false;v.attached=true;v.term.options.disableStdin=false;if(v.started)v.term.reset();v.started=true;this.fitView(v);ipc.send('resize',stream,v.term.cols,v.term.rows);this.onState('ready')});
   ipc.on('output',(_,stream,data,streamId)=>{const v=this.forStream(stream);if(!v)return;const bytes=Uint8Array.from(atob(data),c=>c.charCodeAt(0));
    // DEL is ignorable terminal padding, not printable UTF-8. Older tmux
    // emits it during redraw; xterm otherwise logs a parser error per byte.
    v.term.write(bytes.includes(127)?bytes.filter(b=>b!==127):bytes,()=>{if(streamId)ipc.send('output-ack',stream,streamId,bytes.length)});v.badge.textContent=v.term.options.fontSize+' px';});
   ipc.on('ended',(_,stream,details={})=>{const v=this.forStream(stream);if(!v)return;v.attached=false;v.connecting=false;v.term.options.disableStdin=true;if(details.retryable&&ipc.online){v.badge.textContent='重连中';v.retry=setTimeout(()=>this.connectView(v,true),2000)}else{v.badge.textContent='已断开';this.refreshExited()}});
   ipc.on('failure',(_,stream,message)=>{const v=this.forStream(stream);if(v){v.badge.textContent='连接失败';v.badge.title=message;this.notify(message)}});
   ipc.on('transport',(_,state)=>{if(state==='online')return;this.epoch++;this.cancelDrag();for(const v of this.views.values()){clearTimeout(v.retry);v.attached=false;v.connecting=false;v.term.options.disableStdin=true}for(const r of this.requests.values()){clearTimeout(r.timer);r.reject(new Error('连接正在恢复'))}this.requests.clear()});
   this.observer=new ResizeObserver(()=>this.scheduleFit());this.observer.observe(mount);
  }
  forStream(stream){return typeof stream==='string'&&stream.startsWith(this.id+'/')?this.views.get(stream.slice(this.id.length+1)):null}
  rpc(action,data={}){return new Promise((resolve,reject)=>{const request='workspace-'+this.id+'-'+(++this.sequence);const timer=setTimeout(()=>{this.requests.delete(request);reject(new Error('终端操作超时，请重新连接项目'))},60000);this.requests.set(request,{resolve,reject,timer});if(!this.ipc.send('workspace-rpc',request,action,{...data,project:this.id})){clearTimeout(timer);this.requests.delete(request);reject(new Error('连接正在恢复'))}})}
  async open(force=false){
   const epoch=++this.epoch;this.onState('connecting');
   try{const state=await this.rpc('prepare');if(epoch!==this.epoch)return;this.apply(state);for(const v of this.views.values())this.connectView(v,force);}
   catch(error){if(epoch===this.epoch){this.onState('error');this.notify(error.message)}}
  }
  apply(state){
   if(this.state?.server===state.server&&state.revision<this.state.revision)return;
   if(this.drag)this.cancelDrag();
   this.state=state;
   for(const [pane,v]of this.views)if(!state.panes[pane]){clearTimeout(v.retry);clearTimeout(v.zoomTimer);v.stopTextSelection?.();v.attached=false;v.term.dispose();v.el.remove();this.views.delete(pane)}
   if(!state.groups.length){this.selected=null;this.group=null;this.board.replaceChildren();this.navigation.replaceChildren();this.onState('ended');return}
   for(const [pane,info]of Object.entries(state.panes)){
    if(!this.views.has(pane))this.createView(pane,info);else{const v=this.views.get(pane);v.info=info;v.title.textContent=info.title+' · '+info.path}
   }
   const preferred=state.focusPane;
   if(preferred&&this.lastFocusPane!==preferred){this.lastFocusPane=preferred;this.selected=preferred;this.group=state.groups.find(g=>paneIds(g.tree).includes(preferred))?.id}
   if(!state.groups.some(g=>g.id===this.group))this.group=state.activeGroup||state.groups[0]?.id;
   if(!this.views.has(this.selected)||!paneIds(this.currentGroup().tree).includes(this.selected))this.selected=paneIds(this.currentGroup().tree)[0];
   this.render();
   for(const v of this.views.values())if(!v.attached&&!v.connecting)this.connectView(v);
  }
  currentGroup(){return this.state?.groups.find(g=>g.id===this.group)||this.state?.groups[0]}
  async refreshExited(){
   clearTimeout(this.exitTimer);
   this.exitTimer=setTimeout(async()=>{
    if(!this.ipc.online)return;
    try{this.apply(await this.rpc('prepare',{inspectOnly:true}))}catch(error){this.notify(error.message)}
   },120);
  }
  fontKey(pane){return `tmux-pane-font-v1:${this.id}:${this.state.server}:${pane}`}
  createView(pane,info){
   const el=document.createElement('div');el.className='pane-view managed-pane';el.dataset.pane=pane;
   const header=document.createElement('div');header.className='managed-pane-title';const title=document.createElement('span');title.textContent=info.title+' · '+info.path;title.title=info.path;
   const badge=document.createElement('span');badge.className='managed-pane-size';header.append(title,badge);
   const body=document.createElement('div');body.className='managed-pane-terminal';el.append(header,body);
   let size=this.options.fontSize;try{const saved=Number(localStorage.getItem(this.fontKey(pane)));if(saved>=10&&saved<=32)size=saved}catch{}
   const term=new Terminal({...this.options,fontSize:size,disableStdin:true});const fit=new FitAddon();term.loadAddon(fit);term.open(body);
   const v={el,title,badge,body,term,fit,info,pane:{id:pane},attached:false};this.views.set(pane,v);badge.textContent=size+' px';
   el.addEventListener('pointerdown',()=>{this.select(pane);term.focus()});
   term.textarea?.addEventListener('focus',()=>this.select(pane));
   this.installTextSelection(v);
   this.installWheelScroll(v);
   term.onData(data=>{if(v.attached&&this.ipc.online)this.ipc.send('input',this.id+'/'+pane,btoa(Array.from(new TextEncoder().encode(data),b=>String.fromCharCode(b)).join('')))});
   term.onResize(({cols,rows})=>{if(v.attached)this.ipc.send('resize',this.id+'/'+pane,cols,rows)});
   term.attachCustomKeyEventHandler(e=>{
    if(e.ctrlKey&&!e.shiftKey&&!e.altKey&&['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
     if(e.type==='keydown'){e.preventDefault();this.select(pane);this.action({ArrowLeft:2,ArrowRight:1,ArrowUp:4,ArrowDown:3}[e.key])}return false;
    }
    return true;
   });
   return v;
  }
  installWheelScroll(v){
   // Application mouse reporting bypasses xterm's smooth scrollback animation.
   // Pace reports through xterm itself so its negotiated mouse protocol and
   // coordinates remain correct. Never synthesize arrow keys into a prompt.
   v.term.options.smoothScrollDuration=120;
   let pending=0,frame=0,last=0,lastInput=0,point=null,forwarding=false;
   const reset=()=>{pending=0;last=0;if(frame)cancelAnimationFrame(frame);frame=0};
   const tick=now=>{
    frame=0;
    if(!v.attached||!this.ipc.online||!v.body.isConnected||document.hidden||v.term.modes.mouseTrackingMode==='none'){reset();return}
    if(Math.abs(pending)>=1-1e-6&&(!last||now-last>=32)){
     const direction=Math.sign(pending);pending-=direction;last=now;
     forwarding=true;
     try{v.term.element.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaMode:1,deltaY:direction,clientX:point.x,clientY:point.y}))}finally{forwarding=false}
    }
    if(Math.abs(pending)>=1-1e-6)frame=requestAnimationFrame(tick);
   };
   v.body.addEventListener('wheel',e=>{
    if(forwarding||v.forwardSelectionWheel||e.ctrlKey||e.metaKey||e.altKey||e.shiftKey||!e.deltaY||v.term.modes.mouseTrackingMode==='none')return;
    e.preventDefault();e.stopImmediatePropagation();
    if(!v.attached||!this.ipc.online){reset();return}
    const now=performance.now();
    // Reverse immediately, discard stale fractions, and cap queued work to
    // roughly 100 ms so network/application redraws cannot build a long tail.
    if(now-lastInput>180||Math.sign(pending)!==Math.sign(e.deltaY))pending=0;
    lastInput=now;point={x:e.clientX,y:e.clientY};
    const amount=e.deltaY*(e.deltaMode===1?1/3:e.deltaMode===2?4:1/60);
    pending=Math.max(-4,Math.min(4,pending+amount));
    if(!frame&&Math.abs(pending)>=1-1e-6)frame=requestAnimationFrame(tick);
   },{capture:true,passive:false});
   v.body.addEventListener('pointerleave',reset);
   v.body.addEventListener('pointerdown',reset,true);
   v.body.addEventListener('keydown',reset,true);
  }
  installTextSelection(v){
   // Keep text selection local even when tmux/Codex enables mouse reporting.
   // Alt+mouse remains available for interaction with terminal applications.
   let drag=null,scrollTimer=null,parseTimer=null,drainTimer=null;
   const originalSelection=v.term.getSelection?.bind(v.term),originalHas=v.term.hasSelection?.bind(v.term),originalClear=v.term.clearSelection.bind(v.term);
   v.term.getSelection=()=>v.selectionTranscript?.text()||originalSelection?.()||'';
   v.term.hasSelection=()=>!!v.selectionTranscript||!!originalHas?.();
   v.term.clearSelection=()=>{v.selectionTranscript=null;originalClear()};
   const snapshot=()=>Array.from({length:v.term.rows},(_,y)=>{const line=v.term.buffer.active.getLine(v.term.buffer.active.viewportY+y);return {wrapped:!!line?.isWrapped,cells:Array.from({length:v.term.cols},(_,x)=>{const c=line?.getCell(x);return c?.getWidth()===0?'':c?.getChars()||' '})}});
   const stopScroll=()=>{clearInterval(scrollTimer);scrollTimer=null};
   const stop=()=>{stopScroll();clearTimeout(parseTimer);parseTimer=null;clearTimeout(drainTimer);drainTimer=null;const id=drag?.pointer;drag=null;if(id!==undefined&&v.body.hasPointerCapture(id))v.body.releasePointerCapture(id)};
   const cell=e=>{const r=v.term.element.querySelector('.xterm-screen').getBoundingClientRect();return {x:Math.max(0,Math.min(v.term.cols-1,Math.floor((e.clientX-r.left)/r.width*v.term.cols))),y:v.term.buffer.active.viewportY+Math.max(0,Math.min(v.term.rows-1,Math.floor((e.clientY-r.top)/r.height*v.term.rows))),rect:r}};
   const update=e=>{if(!drag)return;const p=cell(e);if(Math.hypot(e.clientX-drag.x,e.clientY-drag.y)<3&&!drag.moved)return;drag.moved=true;
    if(drag.transcript){const t=drag.transcript;t.select(p.x,p.y-v.term.buffer.active.viewportY);v.selectionTranscript=t;const [a,b]=t.range(),cols=v.term.cols,start=Math.max(t.top*cols,a.y*cols+a.x),end=Math.min((t.top+t.height)*cols-1,b.y*cols+b.x);if(end>=start)v.term.select(start%cols,v.term.buffer.active.viewportY+Math.floor(start/cols)-t.top,end-start+1);return}
    const a=drag.cell.y*v.term.cols+drag.cell.x,b=p.y*v.term.cols+p.x,start=Math.min(a,b);v.term.select(start%v.term.cols,Math.floor(start/v.term.cols),Math.abs(b-a)+1)};
   const appScroll=direction=>{
    if(!drag||!v.attached||!this.ipc.online||v.term.modes?.mouseTrackingMode==='none')return;
    if(drag.pending){if(performance.now()-drag.pending.time<1200)return;drag.pending=null}
    if(!drag.transcript)drag.transcript=new DragTranscript(snapshot(),{x:drag.cell.x,y:drag.cell.y-v.term.buffer.active.viewportY});
    const r=cell(drag.point).rect;drag.pending={direction,time:performance.now()};
    v.forwardSelectionWheel=true;
    try{v.term.element.dispatchEvent(new WheelEvent('wheel',{bubbles:true,cancelable:true,deltaMode:1,deltaY:direction,clientX:Math.max(r.left+1,Math.min(r.right-1,drag.point.clientX)),clientY:r.top+Math.min(r.height/2,Math.max(1,drag.point.clientY-r.top))}))}finally{v.forwardSelectionWheel=false}
   };
   const drain=()=>{
    clearTimeout(drainTimer);drainTimer=null;if(!drag||drag.pending||Math.abs(drag.wheel||0)<1-1e-6)return;
    const direction=Math.sign(drag.wheel);drag.wheel-=direction;if(Math.abs(drag.wheel)<1e-6)drag.wheel=0;appScroll(direction);
   };
   v.term.onWriteParsed?.(()=>{
    // Throttle instead of debounce: continuous output must not postpone selection.
    if(!drag?.pending||parseTimer!==null)return;
    parseTimer=setTimeout(()=>{parseTimer=null;if(!drag?.pending)return;if(drag.transcript.merge(snapshot(),drag.pending.direction)){drag.pending=null;update(drag.point);if(drainTimer===null)drainTimer=setTimeout(drain,16)}},16);
   });
   const scroll=()=>{
    if(!drag?.moved)return;
    if(v.body.isConnected===false||v.term.options?.disableStdin||globalThis.document?.hidden){stop();return}
    const r=cell(drag.point).rect,edge=Math.min(28,r.height/4),y=drag.point.clientY;
    const distance=y<r.top+edge?y-r.top-edge:y>r.bottom-edge?y-r.bottom+edge:0;
    if(!distance){stopScroll();return}
    const buffer=v.term.buffer.active;
    // Local history and application-owned scrolling require different paths.
    const lines=Math.sign(distance)*Math.min(6,Math.max(1,Math.ceil(Math.abs(distance)/edge)));
    const target=Math.max(0,Math.min(buffer.baseY,buffer.viewportY+lines));
    if(!drag.transcript&&Number.isFinite(target)&&target!==buffer.viewportY){v.term.scrollToLine(target);update(drag.point)}else appScroll(Math.sign(distance));
   };
   v.body.addEventListener('pointerdown',e=>{
    if(e.button!==0||e.altKey||e.ctrlKey)return;
    const p=cell(e),r=p.rect;if(e.clientX<r.left||e.clientX>=r.right||e.clientY<r.top||e.clientY>=r.bottom)return;
    e.preventDefault();e.stopImmediatePropagation();this.select(v.pane.id);v.term.focus();v.term.clearSelection();
    stop();drag={pointer:e.pointerId,cell:p,x:e.clientX,y:e.clientY,point:e,moved:false};v.body.setPointerCapture(e.pointerId);
   },true);
   v.body.addEventListener('pointermove',e=>{if(drag&&drag.pointer===e.pointerId){e.preventDefault();e.stopImmediatePropagation();drag.point=e;update(e);if(drag.moved&&!scrollTimer)scrollTimer=setInterval(scroll,50)}},true);
   const finish=e=>{if(!drag||drag.pointer!==e.pointerId)return;e.preventDefault();e.stopImmediatePropagation();if(e.type==='pointerup')update(e);v.suppressSelectionMouseUntil=performance.now()+80;stop()};
   v.stopTextSelection=stop;
   v.body.addEventListener('wheel',e=>{
    if(v.forwardSelectionWheel||!drag||e.ctrlKey||!e.deltaY)return;e.preventDefault();e.stopImmediatePropagation();drag.moved=true;
    const b=v.term.buffer.active;
    if(!drag.transcript&&b.baseY>0){v.term.scrollToLine(Math.max(0,Math.min(b.baseY,b.viewportY+Math.sign(e.deltaY)*3)));update(drag.point);return}
    const now=performance.now();
    if(now-(drag.lastWheel||0)>180||Math.sign(drag.wheel)!==Math.sign(e.deltaY))drag.wheel=0;
    drag.lastWheel=now;drag.wheel=Math.max(-3,Math.min(3,drag.wheel+e.deltaY*(e.deltaMode===1?1/3:e.deltaMode===2?3:1/60)));
    drain();
   },{capture:true,passive:false});
   v.body.addEventListener('keydown',e=>{if(!['Control','Shift','Alt','Meta'].includes(e.key)&&!(e.ctrlKey&&e.key.toLowerCase()==='c'))v.selectionTranscript=null},true);
   for(const event of ['pointerup','pointercancel','lostpointercapture'])v.body.addEventListener(event,finish,true);
   for(const event of ['mousedown','mousemove','mouseup','click','dblclick'])v.body.addEventListener(event,e=>{if(drag||performance.now()<(v.suppressSelectionMouseUntil||0)){e.preventDefault();e.stopImmediatePropagation()}},true);
  }
  connectView(v,force=false){if(!this.ipc.online||v.connecting||v.attached&&!force)return;v.connecting=true;v.attached=false;v.term.options.disableStdin=true;v.badge.textContent='连接中';this.ipc.send('pane-connect',this.id,v.pane.id,{flowControl:true,reconnect:force})}
  select(pane){this.selected=pane;for(const [id,v]of this.views)v.el.classList.toggle('focused',id===pane)}
  inputTerm(){return this.views.get(this.selected)?.term||this.empty}
  render(){
   const focus=this.board.contains(document.activeElement);this.navigation.replaceChildren();this.navigation.hidden=this.state.groups.length<2;
   for(const group of this.state.groups){const b=document.createElement('button');b.textContent=group.name;b.className=group.id===this.group?'selected':'';b.onclick=()=>{this.group=group.id;this.selected=paneIds(group.tree)[0];this.render();this.inputTerm().focus()};this.navigation.append(b)}
   const build=tree=>{
    if(tree.pane)return this.views.get(tree.pane).el;
    const split=document.createElement('div');split.className='managed-split';split.dataset.axis=tree.axis;
    tree.children.forEach((child,i)=>{
     const box=document.createElement('div');box.className='managed-slot';box.style.flex=tree.weights[i]+' 1 0px';box.append(build(child));split.append(box);
     if(i<tree.children.length-1){const handle=document.createElement('div');handle.className='managed-separator';handle.setAttribute('role','separator');handle.setAttribute('aria-label','调整分屏大小');handle.setAttribute('aria-orientation',tree.axis==='x'?'vertical':'horizontal');handle.tabIndex=0;this.bindSeparator(handle,tree,i,split);split.append(handle)}
    });return split;
   };
   const group=this.currentGroup();if(group)this.board.replaceChildren(build(group.tree));this.select(this.selected);
   requestAnimationFrame(()=>{this.fitAll();if(focus)this.inputTerm().focus()});
  }
  fitView(v){if(!this.board.contains(v.el)||!v.body.clientWidth||!v.body.clientHeight)return;v.fit.fit()}
  fitAll(){if(this.drag||this.resizing)return;for(const v of this.views.values())this.fitView(v)}
  scheduleFit(){clearTimeout(this.fitTimer);this.fitTimer=setTimeout(()=>this.fitAll(),160)}
  pauseResize(){this.resizing=true;clearTimeout(this.fitTimer)}
  resumeResize(){this.resizing=false;this.fitAll()}
  zoom(target,delta){
   const el=target.closest('.pane-view');const v=el&&this.views.get(el.dataset.pane);if(!v)return false;
   const size=Math.max(10,Math.min(32,v.term.options.fontSize+delta));if(size===v.term.options.fontSize)return true;
   v.term.options.fontSize=size;v.badge.textContent=size+' px';try{localStorage.setItem(this.fontKey(v.pane.id),String(size))}catch{}
   clearTimeout(v.zoomTimer);v.zoomTimer=setTimeout(()=>this.fitView(v),100);
   return true;
  }
  async action(index){
   if(this.busy||!this.selected)return;this.busy=true;
   try{const state=await this.rpc('split',{pane:this.selected,direction:['window','right','left','down','up'][index]});this.apply(state);requestAnimationFrame(()=>this.inputTerm().focus())}
   catch(e){this.notify(e.message)}finally{this.busy=false}
  }
  bindSeparator(handle,tree,index,split){
   handle.addEventListener('pointerdown',e=>{
    if(e.button!==0||this.drag||this.busy)return;e.preventDefault();e.stopPropagation();
    const slots=Array.from(split.children).filter(el=>el.classList.contains('managed-slot'));
    const a=slots[index].getBoundingClientRect(),b=slots[index+1].getBoundingClientRect();
    const first=tree.axis==='x'?a.width:a.height,second=tree.axis==='x'?b.width:b.height;
    this.drag={handle,pointer:e.pointerId,tree,index,slots,start:tree.axis==='x'?e.clientX:e.clientY,first,second,weights:[...tree.weights]};handle.setPointerCapture(e.pointerId);handle.classList.add('dragging');
   });
   handle.addEventListener('pointermove',e=>{
    const d=this.drag;if(!d||d.handle!==handle||d.pointer!==e.pointerId)return;
    const delta=(tree.axis==='x'?e.clientX:e.clientY)-d.start,total=d.first+d.second,min=Math.min(tree.axis==='x'?90:65,total/3);
    d.next=Math.max(min,Math.min(total-min,d.first+delta));
    if(!this.dragFrame)this.dragFrame=requestAnimationFrame(()=>{this.dragFrame=0;this.paintDrag()});
   });
   handle.addEventListener('pointerup',()=>this.endDrag(true));
   handle.addEventListener('pointercancel',()=>this.endDrag(false));
   handle.addEventListener('lostpointercapture',()=>this.endDrag(false));
   handle.addEventListener('keydown',e=>{
    const keys=tree.axis==='x'?['ArrowLeft','ArrowRight']:['ArrowUp','ArrowDown'];if(!keys.includes(e.key)||this.busy)return;e.preventDefault();
    const sum=tree.weights[index]+tree.weights[index+1],delta=(e.key===keys[0]?-1:1)*sum*.03;tree.weights[index]=Math.max(sum*.05,Math.min(sum*.95,tree.weights[index]+delta));tree.weights[index+1]=sum-tree.weights[index];this.render();this.persistLayout();
   });
  }
  paintDrag(){
   const d=this.drag;if(!d||d.next===undefined)return;
   const total=d.first+d.second,sum=d.weights[d.index]+d.weights[d.index+1];
   d.tree.weights[d.index]=sum*d.next/total;d.tree.weights[d.index+1]=sum*(total-d.next)/total;
   d.slots[d.index].style.flex=d.tree.weights[d.index]+' 1 0px';d.slots[d.index+1].style.flex=d.tree.weights[d.index+1]+' 1 0px';
  }
  endDrag(commit){
   const d=this.drag;if(!d)return;this.paintDrag();this.drag=null;cancelAnimationFrame(this.dragFrame);this.dragFrame=0;
   d.handle.classList.remove('dragging');if(d.handle.hasPointerCapture(d.pointer))d.handle.releasePointerCapture(d.pointer);
   if(!commit){d.tree.weights=d.weights;d.slots.forEach((s,i)=>s.style.flex=d.weights[i]+' 1 0px')}this.fitAll();if(commit)this.persistLayout();
  }
  cancelDrag(){this.endDrag(false)}
  async persistLayout(){
   const group=this.currentGroup();if(!group||this.busy)return;this.busy=true;
   try{const state=await this.rpc('layout',{group:group.id,revision:this.state.revision,tree:clone(group.tree)});this.apply(state)}
   catch(e){this.notify(e.message);await this.open()}finally{this.busy=false}
  }
 }
 root.ManagedWorkspace=ManagedWorkspace;
 if(typeof module!=='undefined')module.exports={paneIds,ManagedWorkspace,DragTranscript};
})(typeof window!=='undefined'?window:globalThis);
