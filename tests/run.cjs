const {spawnSync}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs');
for(const file of fs.readdirSync(__dirname).filter(name=>/^test-.*\.cjs$/.test(name)).sort()){
 const result=spawnSync(process.execPath,[path.join(__dirname,file)],{cwd:path.join(__dirname,'..'),stdio:'inherit'});
 if(result.error)throw result.error;
 if(result.status!==0)process.exit(result.status||1);
}
