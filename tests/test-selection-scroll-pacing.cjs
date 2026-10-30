const assert=require('node:assert/strict');
const {ManagedWorkspace,DragTranscript}=require('../managed-workspace.js');
let now=0,seq=0,parsed,offset=0,captured=false;
const timers=new Map(),events={},reports=[];
global.performance={now:()=>now};
global.setTimeout=(fn,ms)=>{timers.set(++seq,{fn,at:now+ms});return seq};
global.clearTimeout=id=>timers.delete(id);
global.WheelEvent=class {constructor(type,opts){Object.assign(this,{type},opts)}};
const advance=ms=>{const end=now+ms;while(true){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at)[0];if(!next)break;now=next[1].at;timers.delete(next[0]);next[1].fn()}now=end};
const rows=()=>Array.from({length:12},(_,i)=>i<10?`row ${String(offset+i).padStart(3,'0')} unique`:'fixed footer '+i);
const term={cols:24,rows:12,options:{},modes:{mouseTrackingMode:'drag'},
 buffer:{active:{viewportY:0,baseY:0,getLine:y=>({isWrapped:false,getCell:x=>({getWidth:()=>1,getChars:()=>rows()[y]?.[x]||''})})}},
 element:{querySelector:()=>({getBoundingClientRect:()=>({left:0,top:0,right:240,bottom:240,width:240,height:240})}),dispatchEvent:e=>reports.push({direction:e.deltaY,time:now})},
 getSelection:()=>'',hasSelection:()=>false,clearSelection(){},select(){},focus(){},onWriteParsed:fn=>parsed=fn};
const v={attached:true,pane:{id:'%1'},term,body:{isConnected:true,addEventListener:(name,fn)=>events[name]=fn,setPointerCapture(){captured=true},hasPointerCapture:()=>captured,releasePointerCapture(){captured=false}}};
ManagedWorkspace.prototype.installTextSelection.call({ipc:{online:true},select(){}},v);
const event=(extra={})=>({pointerId:1,button:0,clientX:10,clientY:100,preventDefault(){},stopImmediatePropagation(){},...extra});
events.pointerdown(event());
const wheel=deltaY=>events.wheel(event({deltaY,deltaMode:0}));
wheel(10);wheel(10);wheel(10);wheel(10);wheel(10);wheel(10);
assert.equal(reports.length,1,'fractional trackpad movement accumulates');
for(let i=0;i<40;i++)wheel(120);
assert.equal(reports.length,1,'only one request awaits a verified screen');
offset=1;parsed();advance(8);parsed();advance(8);
assert(term.hasSelection(),'continuous output does not postpone merge');
advance(16);assert.equal(reports.length,2,'buffered wheel resumes after verified redraw');
wheel(-120);offset=2;parsed();advance(16);advance(16);
assert.equal(reports.at(-1).direction,-1,'reversal discards old queued direction');
offset=1;parsed();advance(16);
events.pointerup(event({type:'pointerup'}));const count=reports.length;advance(2000);
assert.equal(reports.length,count,'release cancels queued scroll');assert(!captured);
assert(term.getSelection().includes('005 unique'),'selection remains copyable after release');
const screen=start=>Array.from({length:12},(_,i)=>({cells:[...(i<10?`row ${start+i} unique`:'footer')],wrapped:false}));
const t=new DragTranscript(screen(0),{x:0,y:5});
assert(t.merge(screen(1),1));t.select(20,9);assert(t.text().includes('row 10 unique'));assert(!t.text().includes('footer'));
assert(!t.merge(screen(90),1),'unrelated redraw must not merge guessed text');
assert(t.merge(screen(0),-1));t.select(0,0);assert(t.text().includes('row 0 unique'));
console.log('PASS: fractional input, bounded queue, non-starving redraw, reversal, release, cross-screen text and ambiguous redraw rejection');
