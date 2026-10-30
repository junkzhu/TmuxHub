const fs=require('fs'),vm=require('vm'),assert=require('assert');const html=fs.readFileSync('index.html','utf8');new Function(html.split('<script>').pop().split('</script>')[0]);
let selected=false,copied=0,pasted=0,blocked=0;const s={};const ctx={sessions:new Map([['hpc',s]]),active:'hpc',inputTerminal:()=>({hasSelection:()=>selected}),copyTerminal:()=>copied++,pasteTerminal:()=>pasted++};vm.createContext(ctx);const start=html.indexOf('function terminalClipboardShortcut('),end=html.indexOf("document.addEventListener('keydown',terminalClipboardShortcut",start);vm.runInContext(html.slice(start,end),ctx);
function press(key,opts={}){ctx.terminalClipboardShortcut({key,code:'Key'+key.toUpperCase(),ctrlKey:true,target:{closest:()=>true},preventDefault(){blocked++},stopImmediatePropagation(){},...opts})}
press('c');assert.equal(blocked,0);assert.equal(copied,0);
selected=true;press('c');assert.equal(copied,1);assert.equal(blocked,1);
press('v');assert.equal(pasted,1);assert.equal(blocked,2);
selected=false;press('c',{shiftKey:true});press('v',{shiftKey:true});assert.equal(copied,2);assert.equal(pasted,2);
press('v',{target:{closest:()=>null}});press('c',{target:{closest:()=>null}});assert.equal(blocked,4);
press('v',{repeat:true});assert.equal(pasted,2);assert.equal(blocked,5);
press('v',{altKey:true});press('v',{isComposing:true});assert.equal(blocked,5);
console.log('PASS: selected Ctrl+C copies; unselected Ctrl+C passes through; Ctrl+V and Ctrl+Shift+C/V intercepted once; project forms, IME and Alt shortcuts unaffected');
