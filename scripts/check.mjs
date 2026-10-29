import {spawnSync} from 'node:child_process';import {readdir} from 'node:fs/promises';
const scan=async dir=>{for(const item of await readdir(dir,{withFileTypes:true})){const file=`${dir}/${item.name}`;if(item.isDirectory())await scan(file);else if(/\.(mjs|js)$/.test(file)){const r=spawnSync(process.execPath,['--check',file],{stdio:'inherit'});if(r.status)process.exit(r.status);}}};
for(const dir of ['src','public','scripts'])await scan(dir);console.log('Sintaxis JavaScript verificada.');
