import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,readFile,readdir,stat,symlink,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {AstraClient} from '../src/providers/astra.mjs';

const schema={type:'object',properties:{status:{type:'string',enum:['ok']}},required:['status'],additionalProperties:false};
async function fixture(t,mode='ok'){
 const dir=await mkdtemp(path.join(os.tmpdir(),'astra-test-'));t.after(()=>rm(dir,{recursive:true,force:true}));
 const binary=path.join(dir,'codex');
 await writeFile(binary,`#!${process.execPath}
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
const args=process.argv.slice(2),home=path.dirname(process.argv[1]);
const mode=fs.readFileSync(path.join(home,'mode'),'utf8');
if(args[0]==='login'){process.stderr.write(mode==='logout'?'Not logged in':'Logged in using ChatGPT');process.exit(mode==='logout'?1:0);}
if(args[0]==='debug'){console.log(JSON.stringify({models:mode==='missing-model'?[]:[{slug:'gpt-6-astra',supported_reasoning_levels:[{effort:'high'}]}]}));process.exit(0);}
if(args.includes('--help')){console.log('--ephemeral --ignore-user-config --ignore-rules --output-schema --output-last-message --json');process.exit(0);}
if(args.includes('--version')){console.log('codex-cli 0.162.1');process.exit(0);}
let input='';for await(const chunk of process.stdin)input+=chunk;
fs.appendFileSync(path.join(home,'calls'),JSON.stringify({args,env:process.env,input})+'\\n');
const output=args[args.indexOf('--output-last-message')+1];
if(mode==='timeout'){const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});fs.writeFileSync(path.join(home,'child'),String(child.pid));setInterval(()=>{},1000);}
else if(mode==='overflow'){process.stdout.write('x'.repeat(6000000));setInterval(()=>{},1000);}
else {
 if(mode==='symlink'){fs.unlinkSync(output);fs.symlinkSync(path.join(home,'outside'),output);}
 else if(mode!=='missing')fs.writeFileSync(output,mode==='malformed'?'{':mode==='wrong-schema'?'{}':'{"status":"ok"}');
 if(mode==='warning')console.log(JSON.stringify({type:'item.completed',item:{type:'error',message:'temporary warning'}}));
 if(mode==='failed')console.log(JSON.stringify({type:'turn.failed',error:{message:'failure'}}));
 else if(mode!=='incomplete')console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:10,output_tokens:5}}));
 process.exit(mode==='exit'?2:0);
}
`,{mode:0o700});
 await writeFile(path.join(dir,'mode'),mode);
 await writeFile(path.join(dir,'outside'),'{"status":"ok"}');
 const client=new AstraClient({astraPath:binary,astraHome:path.join(dir,'auth'),astraTimeoutMs:5000});
 const run=(extra={})=>client.run({prompt:'Editorial input $(touch NO) `echo unsafe`',schema,dir,name:'../edit/pass',...extra});
 return {dir,client,run,setMode:mode=>writeFile(path.join(dir,'mode'),mode),calls:async()=>{try{return(await readFile(path.join(dir,'calls'),'utf8')).trim().split('\n').map(JSON.parse);}catch{return[];}}};
}

test('invocation fixes Astra High, passes prompt via stdin and excludes service/session secrets',async t=>{
 const f=await fixture(t);process.env.DRIVE_SECRET='do-not-forward';process.env.CODEX_THREAD_ID='do-not-forward';
 t.after(()=>{delete process.env.DRIVE_SECRET;delete process.env.CODEX_THREAD_ID;});
 const result=await f.run();assert.deepEqual(result.value,{status:'ok'});
 assert.equal(result.metadata.model,'gpt-6-astra');assert.equal(result.metadata.effort,'high');
 const [call]=await f.calls();assert.equal(call.args[call.args.indexOf('--model')+1],'gpt-6-astra');
 assert.ok(call.args.includes('model_reasoning_effort="high"'));assert.ok(call.args.includes('--ignore-user-config'));
 assert.equal(call.args[call.args.indexOf('--sandbox')+1],'read-only');
 assert.equal(call.env.DRIVE_SECRET,undefined);assert.equal(call.env.CODEX_THREAD_ID,undefined);assert.equal(call.env.CODEX_HOME,path.join(f.dir,'auth'));
 assert.ok(call.input.includes('$(touch NO)'));assert.equal(call.args.includes(call.input),false);
 for(const flag of ['shell_tool','apps','plugins','multi_agent','hooks','browser_use','computer_use','image_generation'])assert.ok(call.args.includes(flag));
 const entries=await readdir(path.join(f.dir,'.astra'),{withFileTypes:true});
 for(const entry of entries){const p=path.join(f.dir,'.astra',entry.name);assert.equal((await stat(p)).mode&0o777,entry.isDirectory()?0o700:0o600);if(entry.isDirectory())for(const child of await readdir(p))assert.equal((await stat(path.join(p,child))).mode&0o777,0o600);}
});

test('cache binds prompt, schema and image contents and validates saved output',async t=>{
 const f=await fixture(t),image=path.join(f.dir,'image.png');await writeFile(image,'first');
 const first=await f.run({images:[image]});assert.equal(first.metadata.cached,false);
 const cached=await f.run({images:[image]});assert.equal(cached.metadata.cached,true);assert.equal((await f.calls()).length,1);
 await f.run({prompt:'Changed',images:[image]});assert.equal((await f.calls()).length,2);
 await writeFile(image,'second');await f.run({images:[image]});assert.equal((await f.calls()).length,3);
 const changedSchema={...schema,properties:{status:{const:'ok',type:'string'}}};await f.run({schema:changedSchema,images:[image]});assert.equal((await f.calls()).length,4);
 const cache=path.join(f.dir,'.astra',(await readdir(path.join(f.dir,'.astra'))).find(x=>x.endsWith('.json')&&x.includes(first.metadata.fingerprint)));
 await writeFile(cache,'{"value":{},"metadata":{}}');await writeFile(image,'first');
 const repaired=await f.run({images:[image]});assert.equal(repaired.metadata.cached,false);assert.equal((await f.calls()).length,5);
});

for(const mode of ['malformed','wrong-schema','failed','incomplete','missing','exit','symlink'])test(`rejects ${mode} result and never caches failure`,async t=>{
 const f=await fixture(t,mode);await assert.rejects(f.run());
 await f.setMode('ok');const result=await f.run();assert.equal(result.metadata.cached,false);assert.deepEqual(result.value,{status:'ok'});assert.equal((await f.calls()).length,2);
 assert.equal(await readFile(path.join(f.dir,'outside'),'utf8'),'{"status":"ok"}');
});

test('completed turn with a nonfatal event warning is usable and records warning',async t=>{
 const f=await fixture(t,'warning');const result=await f.run();assert.deepEqual(result.value,{status:'ok'});assert.equal(result.metadata.warningCount,1);assert.equal(result.metadata.usage.input_tokens,10);
});

test('timeout terminates the spawned process group',async t=>{
 const f=await fixture(t,'timeout');f.client.timeout=300;
 await assert.rejects(f.run(),/tiempo|timeout/i);
 const pid=Number(await readFile(path.join(f.dir,'child'),'utf8'));
 // A killed orphan may briefly remain a zombie until the container reaps it.
 let alive=true;try{const s=await readFile(`/proc/${pid}/stat`,'utf8');alive=!s.includes(') Z ');}catch{alive=false;}assert.equal(alive,false);
});

test('output cap stops excessive CLI output',async t=>{
 const f=await fixture(t,'overflow');await assert.rejects(f.run(),/salida|output/i);
});

test('symlinked storage is rejected without touching its destination',async t=>{
 const f=await fixture(t);const outside=await mkdtemp(path.join(os.tmpdir(),'astra-outside-'));t.after(()=>rm(outside,{recursive:true,force:true}));
 await symlink(outside,path.join(f.dir,'.astra'));await assert.rejects(f.run(),/enlace|symlink|directorio/i);assert.deepEqual(await readdir(outside),[]);
});

test('read-only readiness requires supported CLI, login, exact model and high',async t=>{
 const f=await fixture(t);assert.equal((await f.client.check()).ready,true);assert.equal((await f.calls()).length,0);
 await f.setMode('logout');assert.equal((await f.client.check()).ready,false);
 await f.setMode('missing-model');assert.equal((await f.client.check()).ready,false);
 const absent=new AstraClient({astraPath:path.join(f.dir,'absent')});assert.equal((await absent.check()).ready,false);
});

test('unknown schema constraints fail before starting an inference',async t=>{
 const f=await fixture(t);await assert.rejects(f.run({schema:{type:'string',format:'email'}}),/Schema/);assert.equal((await f.calls()).length,0);
});

test('cache symlinks cannot serve results from outside the private job storage',async t=>{
 const f=await fixture(t);await f.run();
 const cache=path.join(f.dir,'.astra',(await readdir(path.join(f.dir,'.astra'))).find(x=>x.endsWith('.json')));
 await rm(cache);await symlink(path.join(f.dir,'outside'),cache);
 await assert.rejects(f.run(),/enlace|symlink/);assert.equal((await f.calls()).length,1);
});

test('nested schemas enforce nullable values, item bounds and additional properties',async t=>{
 const f=await fixture(t);
 const structured={type:'object',properties:{items:{type:'array',minItems:1,items:{$ref:'#/$defs/item'}}},required:['items'],additionalProperties:false,$defs:{item:{type:'object',properties:{word:{type:['string','null']},index:{type:'integer',minimum:0,maximum:3}},required:['word','index'],additionalProperties:false}}};
 let value={items:[{word:null,index:2}]};
 const client=new AstraClient({}, {runner:async(_command,args)=>{await writeFile(args[args.indexOf('--output-last-message')+1],JSON.stringify(value));return {code:0,stdout:'{"type":"turn.completed"}\n',stderr:''};}});
 assert.deepEqual((await client.run({prompt:'Nested schema test',schema:structured,dir:f.dir})).value,value);
 for(const bad of [{items:[]},{items:[{word:'a',index:4}]},{items:[{word:'a',index:1,code:'run'}]},{items:[{word:42,index:1}]}]){value=bad;await assert.rejects(client.run({prompt:JSON.stringify(bad),schema:structured,dir:f.dir}),/Schema/);}
});
