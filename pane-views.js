/* Independent views of the existing tmux grid. No pane is moved, respawned,
 * resized, or piped. The original terminal remains the authoritative emulator. */
(function(root){
 'use strict';
 function color(cell,fg){
  const prefix=fg?38:48, value=fg?cell.getFgColor():cell.getBgColor();
  if(fg?cell.isFgRGB():cell.isBgRGB())return `${prefix};2;${value>>16&255};${value>>8&255};${value&255}`;
  if(fg?cell.isFgPalette():cell.isBgPalette())return `${prefix};5;${value}`;
  return fg?'39':'49';
 }
 function style(cell){
  const codes=['0',color(cell,true),color(cell,false)];
  for(const [method,code]of [['isBold',1],['isDim',2],['isItalic',3],['isUnderline',4],['isInverse',7],['isInvisible',8],['isStrikethrough',9],['isOverline',53]])if(cell[method]?.())codes.push(code);
  return '\x1b['+codes.join(';')+'m';
 }
 function rowText(line,left,width){
  let result='',last='';
  for(let x=left;x<left+width;x++){
   const cell=line?.getCell(x);if(!cell){result+=' ';continue}
   if(cell.getWidth()===0)continue;
   const next=style(cell);if(next!==last){result+=next;last=next}
   // Never copy half a wide glyph from a temporarily changing layout.
   result+=(cell.getWidth()===2&&x===left+width-1)?' ':(cell.getChars()||' ').replace(/[\x00-\x1f\x7f]/g,' ');
  }
  return result+'\x1b[0m';
 }
 function translateMouse(data,pane){
  return data.replace(/\x1b\[<(\d+);(\d+);(\d+)([Mm])/g,(_,b,x,y,end)=>`\x1b[<${b};${Number(x)+pane.x};${Number(y)+pane.y}${end}`);
 }
 function validLayout(layout,cols,rows){
  return !!layout&&layout.supported&&String(layout.server).match(/^\d+$/)&&Array.isArray(layout.panes)&&layout.panes.length>0&&layout.panes.length<=100&&
   layout.cols===cols&&layout.rows===rows&&layout.panes.every(p=>/^%\d+$/.test(p.id)&&[p.x,p.y,p.width,p.height].every(Number.isInteger)&&p.x>=0&&p.y>0&&p.width>=2&&p.height>=1&&p.x+p.width<=cols&&p.y+p.height<=rows);
 }
 // Coordinates are tmux screen cells, independent of each pane's font size.
 function borders(panes){
  const result=[];
  for(const a of panes)for(const b of panes){
   const top=Math.max(a.y,b.y),bottom=Math.min(a.y+a.height,b.y+b.height);
   if(a.x+a.width+1===b.x&&bottom>top)result.push({axis:'x',at:a.x+a.width,start:top,end:bottom,min:2-a.width,max:b.width-2});
   const left=Math.max(a.x,b.x),right=Math.min(a.x+a.width,b.x+b.width),gap=b.y-a.y-a.height;
   if(gap>=1&&gap<=2&&right>left)result.push({axis:'y',at:a.y+a.height,start:left,end:right,min:2-a.height,max:b.height-2});
  }
  return result;
 }
 function dragSequence(x,y,toX,toY){
  // The first motion establishes tmux's resize drag at the original border.
  return `\x1b[<0;${x};${y}M\x1b[<32;${x};${y}M\x1b[<32;${toX};${toY}M\x1b[<0;${toX};${toY}m`;
 }
 class PaneViews{
  constructor({id,source,mount,send,notify,defaultSize}){
   Object.assign(this,{id,source,mount,send,notify,defaultSize});this.views=new Map();this.layout=null;this.selected=null;this.cursorVisible=true;
   this.layer=document.createElement('div');this.layer.className='pane-view-layer';mount.append(this.layer);
   this.subscriptions=[source.onWriteParsed(()=>this.schedule()),source.onResize(()=>this.schedule()),source.parser.registerCsiHandler({prefix:'?',final:'h'},params=>{if(params.includes(25))this.cursorVisible=true;return false}),source.parser.registerCsiHandler({prefix:'?',final:'l'},params=>{if(params.includes(25))this.cursorVisible=false;return false})];
   this.observer=new ResizeObserver(()=>this.schedule());this.observer.observe(mount);
   this.installBorderDrag();
   mount.addEventListener('pointerdown',e=>{if(!e.target.closest('.pane-view'))this.selected=null},true);
  }
  inputTerm(){return this.selected&&this.layer.style.display!=='none'?this.views.get(this.selected)?.term||this.source:this.source}
  reset(){this.finishBorderDrag(false);this.layout=null;this.selected=null;this.layer.style.display='none';this.clear()}
  clear(){for(const v of this.views.values()){v.term.dispose();v.el.remove()}this.views.clear()}
  update(layout){
   if(this.borderDrag&&JSON.stringify(layout)!==JSON.stringify(this.layout))this.finishBorderDrag(false);
   const previous=this.layout?.panes.find(p=>p.active)?.id,next=layout?.panes.find(p=>p.active)?.id;
   if(this.selected&&previous!==next&&next){
    const focused=this.views.get(this.selected)?.el.contains(document.activeElement);this.selected=next;
    if(focused)this.pendingFocus=next;
   }
   this.layout=layout;this.schedule();
  }
  installBorderDrag(){
   const mount=this.mount;
   const guide=document.createElement('div');guide.className='pane-resize-guide';guide.hidden=true;mount.append(guide);this.resizeGuide=guide;
   mount.addEventListener('pointerdown',e=>{
    if(e.button!==0||!this.layout?.supported||this.layout.cols!==this.source.cols||this.layout.rows!==this.source.rows)return;
    const screen=this.source.element?.querySelector('.xterm-screen');if(!screen)return;
    const rect=screen.getBoundingClientRect(),base=mount.getBoundingClientRect(),cw=rect.width/this.source.cols,ch=rect.height/this.source.rows;
    if(!cw||!ch)return;
    const x=(e.clientX-rect.left)/cw,y=(e.clientY-rect.top)/ch;
    const border=borders(this.layout.panes).find(b=>b.min<=b.max&&(b.axis==='x'?Math.abs(x-b.at-.5)*cw<=4&&y>=b.start&&y<b.end:Math.abs(y-b.at-.5)*ch<=4&&x>=b.start&&x<b.end));
    if(!border)return;
    e.preventDefault();e.stopImmediatePropagation();
    this.borderDrag={border,id:e.pointerId,rect,base,cw,ch,x:border.axis==='x'?border.at:Math.floor(x),y:border.axis==='y'?border.at:Math.floor(y),delta:0};
    mount.setPointerCapture(e.pointerId);this.pauseResize();guide.hidden=false;
    guide.dataset.axis=border.axis;this.paintBorderDrag();
   },true);
   mount.addEventListener('pointermove',e=>{
    const d=this.borderDrag;if(!d||e.pointerId!==d.id)return;
    e.preventDefault();e.stopImmediatePropagation();
    const pos=d.border.axis==='x'?(e.clientX-d.rect.left)/d.cw:(e.clientY-d.rect.top)/d.ch;
    d.delta=Math.max(d.border.min,Math.min(d.border.max,Math.round(pos-d.border.at-.5)));
    if(!this.dragFrame)this.dragFrame=requestAnimationFrame(()=>{this.dragFrame=0;this.paintBorderDrag()});
   },true);
   mount.addEventListener('pointerup',e=>{if(this.borderDrag&&e.pointerId===this.borderDrag.id){e.preventDefault();e.stopImmediatePropagation();this.finishBorderDrag(true)}},true);
   for(const type of ['pointercancel','lostpointercapture'])mount.addEventListener(type,()=>this.finishBorderDrag(false));
   window.addEventListener('blur',()=>this.finishBorderDrag(false));
   // Stop xterm's compatibility mouse handlers from starting a second drag.
   for(const type of ['mousedown','mousemove','mouseup','click'])mount.addEventListener(type,e=>{if(this.borderDrag||performance.now()<(this.suppressMouseUntil||0)){e.preventDefault();e.stopImmediatePropagation()}},true);
  }
  paintBorderDrag(){
   const d=this.borderDrag;if(!d)return;const b=d.border,s=this.resizeGuide.style;
   if(b.axis==='x'){s.left=(d.rect.left-d.base.left+(b.at+.5+d.delta)*d.cw)+'px';s.top=(d.rect.top-d.base.top+b.start*d.ch)+'px';s.width='2px';s.height=((b.end-b.start)*d.ch)+'px'}
   else{s.left=(d.rect.left-d.base.left+b.start*d.cw)+'px';s.top=(d.rect.top-d.base.top+(b.at+.5+d.delta)*d.ch)+'px';s.width=((b.end-b.start)*d.cw)+'px';s.height='2px'}
  }
  finishBorderDrag(commit){
   const d=this.borderDrag;if(!d)return;this.borderDrag=null;
   cancelAnimationFrame(this.dragFrame);this.dragFrame=0;this.resizeGuide.hidden=true;
   this.suppressMouseUntil=performance.now()+80;
   if(this.mount.hasPointerCapture(d.id))this.mount.releasePointerCapture(d.id);
   if(commit&&d.delta){const x=d.x+1,y=d.y+1;this.send(dragSequence(x,y,x+(d.border.axis==='x'?d.delta:0),y+(d.border.axis==='y'?d.delta:0)))}
   this.resumeResize();
  }
  pauseResize(){this.resizing=true;if(this.frame){cancelAnimationFrame(this.frame);this.frame=0}}
  resumeResize(){this.resizing=false;this.schedule()}
  schedule(){if(this.frame||this.resizing)return;this.frame=requestAnimationFrame(()=>{this.frame=0;this.render()})}
  key(pane){return `tmux-pane-font-v1:${this.id}:${this.layout.server}:${pane.id}`}
  size(pane){try{const n=Number(localStorage.getItem(this.key(pane)));if(Number.isFinite(n)&&n>=10&&n<=32)return n}catch{}return this.defaultSize}
  activate(v){
   if(this.selected!==v.pane.id){
    this.selected=v.pane.id;
    // Select via tmux's title border, never by injecting a click into Codex.
    const x=v.pane.x+1,y=v.pane.y;
    this.send(`\x1b[<0;${x};${y}M\x1b[<0;${x};${y}m`);
   }
  }
  zoom(target,delta){
   const el=target.closest('.pane-view');if(!el||!this.layer.contains(el))return false;
   const v=this.views.get(el.dataset.pane);if(!v)return false;
   const next=Math.max(10,Math.min(32,v.term.options.fontSize+delta));if(next===v.term.options.fontSize)return true;
   const old=v.term.options.fontSize,cx=(v.viewport.scrollLeft+v.viewport.clientWidth/2)/old,cy=(v.viewport.scrollTop+v.viewport.clientHeight/2)/old;
   v.term.options.fontSize=next;try{localStorage.setItem(this.key(v.pane),String(next))}catch{}
   this.place(v);v.viewport.scrollLeft=cx*next-v.viewport.clientWidth/2;v.viewport.scrollTop=cy*next-v.viewport.clientHeight/2;
   v.label.textContent=`${next} px`;this.notify(`分屏 ${v.pane.index} · ${next} px`);this.schedule();return true;
  }
  create(pane){
   const el=document.createElement('div');el.className='pane-view';el.dataset.pane=pane.id;
   const viewport=document.createElement('div');viewport.className='pane-view-scroll';const grid=document.createElement('div');grid.className='pane-view-grid';viewport.append(grid);
   const label=document.createElement('div');label.className='pane-font-label';label.title='Ctrl＋滚轮调整此分屏字号';
   el.append(viewport,label);this.layer.append(el);
   const term=new Terminal({...this.source.options,cols:pane.width,rows:pane.height,fontSize:this.size(pane),scrollback:0,disableStdin:false,allowProposedApi:false});term.open(grid);
   const v={el,viewport,grid,label,term,pane,lines:[],writing:false};this.views.set(pane.id,v);label.textContent=term.options.fontSize+' px';
   term.onData(data=>{this.activate(v);if(!data.startsWith('\x1b[<')){v.followCursor=true;this.revealCursor(v)}this.send(translateMouse(data,v.pane))});
   el.addEventListener('pointerdown',e=>{e.stopPropagation();this.activate(v);term.focus()});
   // Wheel scrolls the enlarged viewport when it overflows. Shift-wheel moves
   // horizontally; at the default size tmux keeps its usual history scrolling.
   el.addEventListener('wheel',e=>{if(e.ctrlKey)return;const axis=e.shiftKey?'scrollLeft':'scrollTop',extent=e.shiftKey?'scrollWidth':'scrollHeight',client=e.shiftKey?'clientWidth':'clientHeight';if(viewport[extent]>viewport[client]+2){e.preventDefault();e.stopImmediatePropagation();viewport[axis]+=e.deltaY*(e.deltaMode===1?16:1)}},{capture:true,passive:false});
   return v;
  }
  revealCursor(v){
   const b=this.source.buffer.active,p=v.pane,x=b.cursorX-p.x,y=b.cursorY-p.y;
   if(x<0||y<0||x>=p.width||y>=p.height)return;
   const screen=v.term.element?.querySelector('.xterm-screen');if(!screen)return;
   const cw=screen.offsetWidth/p.width,ch=screen.offsetHeight/p.height,port=v.viewport;
   if(x*cw<port.scrollLeft)port.scrollLeft=x*cw;
   else if((x+1)*cw>port.scrollLeft+port.clientWidth)port.scrollLeft=(x+1)*cw-port.clientWidth;
   if(y*ch<port.scrollTop)port.scrollTop=y*ch;
   else if((y+1)*ch>port.scrollTop+port.clientHeight)port.scrollTop=(y+1)*ch-port.clientHeight;
  }
  place(v){
   const screen=this.source.element?.querySelector('.xterm-screen');if(!screen)return;
   const rect=screen.getBoundingClientRect(),base=this.mount.getBoundingClientRect();if(!rect.width||!rect.height)return;
   const cw=rect.width/this.source.cols,ch=rect.height/this.source.rows,p=v.pane,ratio=v.term.options.fontSize/this.source.options.fontSize;
   v.viewport.style.overflow=ratio>1?'auto':'hidden';
   Object.assign(v.el.style,{left:(rect.left-base.left+p.x*cw)+'px',top:(rect.top-base.top+p.y*ch)+'px',width:(p.width*cw)+'px',height:(p.height*ch)+'px'});
   v.grid.style.width=Math.ceil(p.width*cw*ratio)+'px';v.grid.style.height=Math.ceil(p.height*ch*ratio)+'px';
  }
  render(){
   if(this.resizing)return;
   if(!this.mount.getBoundingClientRect().width)return;
   if(!validLayout(this.layout,this.source.cols,this.source.rows)){this.layer.style.display='none';return}
   this.layer.style.display='';const ids=new Set(this.layout.panes.map(p=>p.id));
   for(const [id,v]of this.views)if(!ids.has(id)){v.term.dispose();v.el.remove();this.views.delete(id);if(this.selected===id)this.selected=null}
   const buffer=this.source.buffer.active;
   for(const pane of this.layout.panes){
    const v=this.views.get(pane.id)||this.create(pane);v.pane=pane;this.place(v);
    if(v.term.cols!==pane.width||v.term.rows!==pane.height){v.term.resize(pane.width,pane.height);v.lines=[]}
    if(v.writing){v.dirty=true;continue}
    let data='';const lines=[];
    for(let y=0;y<pane.height;y++){const text=rowText(buffer.getLine(buffer.baseY+pane.y+y),pane.x,pane.width);lines.push(text);if(v.lines[y]!==text)data+=`\x1b[${y+1};1H`+text}
    const cursorX=buffer.cursorX-pane.x,cursorY=buffer.cursorY-pane.y;
    const cursor=this.cursorVisible&&cursorX>=0&&cursorX<pane.width&&cursorY>=0&&cursorY<pane.height;
    const modes=this.source.modes;
    const tail=`\x1b[?1${modes.applicationCursorKeysMode?'h':'l'}\x1b[?2004${modes.bracketedPasteMode?'h':'l'}\x1b[?1006h\x1b[?1003${modes.mouseTrackingMode!=='none'?'h':'l'}`+(cursor?`\x1b[${cursorY+1};${cursorX+1}H\x1b[?25h`:'\x1b[?25l');
    if(!data&&tail===v.tail)continue;
    v.lines=lines;v.tail=tail;v.writing=true;v.rendering=true;
    v.term.write('\x1b[?25l\x1b[?7l'+data+tail,()=>{v.writing=false;v.rendering=false;if(v.followCursor){this.revealCursor(v);v.followCursor=false}if(v.dirty){v.dirty=false;this.schedule()}});
   }
   if(this.pendingFocus&&this.views.has(this.pendingFocus)){this.views.get(this.pendingFocus).term.focus();this.pendingFocus=null}
  }
 }
 root.PaneViews=PaneViews;
 if(typeof module!=='undefined')module.exports={rowText,translateMouse,validLayout,borders,dragSequence};
})(typeof window!=='undefined'?window:globalThis);
