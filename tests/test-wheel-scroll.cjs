const assert=require('node:assert/strict');
const {ManagedWorkspace}=require('../managed-workspace.js');
let now=1000,id=0;const frames=new Map(),handlers={},sent=[];
global.performance={now:()=>now};global.document={hidden:false};
global.requestAnimationFrame=f=>{frames.set(++id,f);return id};
global.cancelAnimationFrame=id=>frames.delete(id);
global.WheelEvent=class{constructor(type,options){Object.assign(this,{type},options)}};
const v={attached:true,body:{isConnected:true,addEventListener:(name,f)=>handlers[name]=f},term:{options:{},modes:{mouseTrackingMode:'drag'},element:{dispatchEvent:e=>sent.push({...e,time:now})}}};
const owner={ipc:{online:true}};
ManagedWorkspace.prototype.installWheelScroll.call(owner,v);
function wheel(deltaY,extra={}){let prevented=false;handlers.wheel({deltaY,deltaMode:0,clientX:80,clientY:120,preventDefault(){prevented=true},stopImmediatePropagation(){},...extra});return prevented}
function advance(ms){now+=ms;const batch=[...frames.values()];frames.clear();batch.forEach(f=>f(now))}
assert(wheel(240));advance(1);assert.equal(sent.length,1);advance(16);assert.equal(sent.length,1);advance(16);assert.equal(sent.length,2);
wheel(-60);advance(32);assert.equal(sent.at(-1).deltaY,-1);assert.equal(frames.size,0);
for(let i=0;i<100;i++)wheel(120);for(let i=0;i<8;i++)advance(32);assert.equal(sent.length,7,'burst capped to four reports');
const before=sent.length;wheel(120);handlers.pointerleave();advance(40);assert.equal(sent.length,before);
wheel(120);owner.ipc.online=false;advance(40);assert.equal(sent.length,before);owner.ipc.online=true;
for(const key of ['ctrlKey','altKey','metaKey','shiftKey'])assert.equal(wheel(120,{[key]:true}),false);
v.term.modes.mouseTrackingMode='none';assert.equal(wheel(120),false);v.term.modes.mouseTrackingMode='drag';
advance(200);for(let i=0;i<6;i++)wheel(10);advance(1);assert.equal(sent.length,before+1,'small trackpad deltas accumulate');
assert.equal(sent.at(-1).deltaMode,1);assert.equal(sent.at(-1).clientX,80);assert.equal(v.term.options.smoothScrollDuration,120);
console.log('PASS: paced mouse wheel, bounded burst, immediate direction reversal, fractional accumulation, pane leave/disconnect cancellation, modifier and normal-scrollback bypass');
