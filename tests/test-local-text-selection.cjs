const assert=require('assert'),{ManagedWorkspace}=require('../managed-workspace.js');const events={};let selected=[],focus=0,clear=0,captured=false;
const v={pane:{id:'%1'},body:{addEventListener:(k,f)=>events[k]=f,setPointerCapture(){captured=true},hasPointerCapture:()=>captured,releasePointerCapture(){captured=false}},term:{cols:10,rows:5,buffer:{active:{viewportY:20}},element:{querySelector:()=>({getBoundingClientRect:()=>({left:0,top:0,right:100,bottom:100,width:100,height:100})})},focus(){focus++},clearSelection(){clear++},select(...args){selected.push(args)}}};
ManagedWorkspace.prototype.installTextSelection.call({select(){}},v);
const ev=(x,y,extra={})=>({pointerId:1,button:0,clientX:x,clientY:y,preventDefault(){},stopImmediatePropagation(){},...extra});
events.pointerdown(ev(15,10));events.pointermove(ev(45,30));events.pointerup(ev(45,30,{type:'pointerup'}));assert.deepEqual(selected.at(-1),[1,20,14]);assert.equal(focus,1);assert.equal(clear,1);assert(!captured);
selected=[];events.pointerdown(ev(45,30));events.pointermove(ev(15,10));events.pointerup(ev(15,10,{type:'pointerup'}));assert.deepEqual(selected.at(-1),[1,20,14]);
events.pointerdown(ev(15,10,{altKey:true}));assert(!captured);assert.equal(focus,2);
console.log('PASS: plain pointer drag selects local buffer across rows in both directions; scrollback offset preserved; Alt mouse bypass; capture released');
const realSet=global.setInterval,realClear=global.clearInterval;let tick=null;
global.setInterval=fn=>{tick=fn;return 1};global.clearInterval=()=>{tick=null};
try{
 v.term.buffer.active.baseY=100;
 v.term.scrollToLine=y=>{v.term.buffer.active.viewportY=y};
 events.pointerdown(ev(15,10));events.pointermove(ev(45,120));
 tick();tick();assert(v.term.buffer.active.viewportY>20);assert(selected.at(-1)[2]>54);
 events.pointerup(ev(45,120,{type:'pointerup'}));assert.equal(tick,null);assert(!captured);
 v.term.buffer.active.viewportY=20;
 events.pointerdown(ev(45,70));events.pointermove(ev(15,-20));tick();
 assert(v.term.buffer.active.viewportY<20);assert(selected.at(-1)[1]<20);
 events.pointermove(ev(15,50));tick();assert.equal(tick,null);
 events.pointermove(ev(15,-20));v.stopTextSelection();assert.equal(tick,null);assert(!captured);
 v.term.buffer.active.viewportY=100;
 events.pointerdown(ev(15,10));events.pointermove(ev(45,120));tick();assert.equal(v.term.buffer.active.viewportY,100);
 events.pointercancel(ev(45,120,{type:'pointercancel'}));assert.equal(tick,null);
 console.log('PASS: edge scrolling extends selection in both directions; center, release, cancellation and disposal stop scrolling; buffer limit respected');
}finally{global.setInterval=realSet;global.clearInterval=realClear}
