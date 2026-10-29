import {spawn} from 'node:child_process';
import {constants} from 'node:fs';
import {open,mkdir,mkdtemp,lstat,realpath,rename,chmod} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

export const ASTRA_MODEL='gpt-6-astra';
export const ASTRA_EFFORT='high';
const MAX_OUTPUT=4*1024*1024,MAX_IMAGE=32*1024*1024;
const DISABLED=['apps','plugins','multi_agent','hooks','shell_tool','unified_exec','browser_use','computer_use','image_generation'];
const hash=value=>createHash('sha256').update(value).digest('hex');
const canonical=value=>JSON.stringify(value,(_,v)=>v&&typeof v==='object'&&!Array.isArray(v)?Object.fromEntries(Object.entries(v).sort(([a],[b])=>a.localeCompare(b))):v);

function environment(home){
 const env={};
 for(const key of ['PATH','HOME','LANG','LC_ALL','LC_CTYPE','TMPDIR','TEMP','TMP','SYSTEMROOT','SystemRoot','WINDIR','COMSPEC','PATHEXT'])if(process.env[key])env[key]=process.env[key];
 env.CODEX_HOME=home;return env;
}

// The process group is killed even when a child keeps inherited pipes open.
function execute(command,args,{cwd,env,input='',timeout,maxOutputBytes=MAX_OUTPUT}){
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env,stdio:['pipe','pipe','pipe'],shell:false,detached:process.platform!=='win32',windowsHide:true});
  let stdout='',stderr='',bytes=0,failure,settled=false;
  const kill=()=>{try{if(process.platform==='win32')spawn('taskkill',['/pid',String(child.pid),'/T','/F'],{stdio:'ignore',windowsHide:true});else process.kill(-child.pid,'SIGKILL');}catch{child.kill('SIGKILL');}};
  const timer=setTimeout(()=>{failure=new Error('Astra superó el límite de tiempo (timeout).');kill();},timeout);
  const finish=(error,value)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(value);};
  const collect=(stream,chunk)=>{bytes+=chunk.length;if(bytes>maxOutputBytes){failure=new Error('Astra superó el límite de salida (output).');kill();return;}if(stream==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();};
  child.stdout.on('data',chunk=>collect('stdout',chunk));child.stderr.on('data',chunk=>collect('stderr',chunk));
  child.once('error',()=>finish(new Error('No se pudo iniciar Codex para Astra.')));
  child.once('close',(code,signal)=>finish(failure,{code,signal,stdout,stderr}));
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}

async function privateWrite(file,data){
 const handle=await open(file,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
 try{await handle.writeFile(data);}finally{await handle.close();}
}
async function safeRead(file,limit=MAX_OUTPUT){
 const handle=await open(file,constants.O_RDONLY|constants.O_NOFOLLOW);
 try{const info=await handle.stat();if(!info.isFile()||info.size>limit)throw new Error('Archivo de Astra inválido o demasiado grande.');return await handle.readFile();}finally{await handle.close();}
}
async function privateDirectory(dir){
 await mkdir(dir,{recursive:true,mode:0o700});const info=await lstat(dir);
 if(info.isSymbolicLink()||!info.isDirectory())throw new Error('El directorio de Astra no puede ser un enlace simbólico.');
 await chmod(dir,0o700);return realpath(dir);
}

// Restrict validation to supported JSON Schema vocabulary; unknown constraints
// fail closed so the CLI schema cannot silently exceed our local validator.
const SCHEMA_KEYS=new Set(['$schema','$id','$defs','definitions','$ref','title','description','default','examples','type','enum','const','properties','required','additionalProperties','items','minItems','maxItems','uniqueItems','minLength','maxLength','pattern','minimum','maximum','exclusiveMinimum','exclusiveMaximum','multipleOf','anyOf','oneOf','allOf','not']);
function schemaCheck(schema,root=schema,seen=new Set()){
 if(typeof schema==='boolean')return;
 if(!schema||typeof schema!=='object'||Array.isArray(schema))throw new Error('JSON Schema de Astra inválido.');
 if(seen.has(schema))return;seen.add(schema);
 for(const key of Object.keys(schema))if(!SCHEMA_KEYS.has(key))throw new Error(`JSON Schema de Astra no soporta ${key}.`);
 if(schema.$ref)resolveRef(schema.$ref,root);
 for(const group of [schema.properties,schema.$defs,schema.definitions])for(const value of Object.values(group||{}))schemaCheck(value,root,seen);
 for(const key of ['items','additionalProperties','not'])if(schema[key]!==undefined)schemaCheck(schema[key],root,seen);
 for(const key of ['anyOf','oneOf','allOf'])for(const child of schema[key]||[])schemaCheck(child,root,seen);
}
function resolveRef(ref,root){
 if(typeof ref!=='string'||!ref.startsWith('#/'))throw new Error('Astra solo admite referencias JSON Schema locales.');
 let result=root;for(const part of ref.slice(2).split('/'))result=result?.[part.replace(/~1/g,'/').replace(/~0/g,'~')];
 if(result===undefined)throw new Error('Referencia JSON Schema inexistente.');return result;
}
function valid(value,schema,root=schema,depth=0){
 if(depth>100)return false;if(typeof schema==='boolean')return schema;
 if(schema.$ref&&!valid(value,resolveRef(schema.$ref,root),root,depth+1))return false;
 const matches=child=>valid(value,child,root,depth+1);
 if(schema.anyOf&&!schema.anyOf.some(matches)||schema.oneOf&&schema.oneOf.filter(matches).length!==1||schema.allOf&&!schema.allOf.every(matches)||schema.not&&matches(schema.not))return false;
 if(schema.const!==undefined&&canonical(value)!==canonical(schema.const)||schema.enum&&!schema.enum.some(x=>canonical(x)===canonical(value)))return false;
 const type=Array.isArray(value)?'array':value===null?'null':typeof value;
 if(schema.type&&![].concat(schema.type).some(x=>x===type||x==='integer'&&Number.isInteger(value)))return false;
 if(type==='object'){
  if(schema.required?.some(key=>!Object.hasOwn(value,key)))return false;
  for(const [key,item]of Object.entries(value)){const sub=Object.hasOwn(schema.properties||{},key)?schema.properties[key]:schema.additionalProperties;if(sub!==undefined&&!valid(item,sub,root,depth+1))return false;}
 }
 if(type==='array'){
  if(value.length<(schema.minItems??0)||value.length>(schema.maxItems??Infinity)||schema.uniqueItems&&new Set(value.map(canonical)).size!==value.length)return false;
  if(schema.items!==undefined&&!value.every(item=>valid(item,schema.items,root,depth+1)))return false;
 }
 if(type==='string'&&(Array.from(value).length<(schema.minLength??0)||Array.from(value).length>(schema.maxLength??Infinity)||schema.pattern&&!new RegExp(schema.pattern,'u').test(value)))return false;
 if(type==='number'&&(!Number.isFinite(value)||value<(schema.minimum??-Infinity)||value>(schema.maximum??Infinity)||schema.exclusiveMinimum!==undefined&&value<=schema.exclusiveMinimum||schema.exclusiveMaximum!==undefined&&value>=schema.exclusiveMaximum||schema.multipleOf!==undefined&&Math.abs(value/schema.multipleOf-Math.round(value/schema.multipleOf))>1e-9))return false;
 return true;
}

export class AstraClient{
 constructor(config={}, {runner=execute}={}){
  this.binary=config.astraPath||'codex';this.home=path.resolve(config.astraHome||path.join(os.homedir(),'.codex'));
  this.timeout=Number.isFinite(config.astraTimeoutMs)&&config.astraTimeoutMs>0?config.astraTimeoutMs:180000;this.runner=runner;
 }
 async check(){
  const base={model:ASTRA_MODEL,effort:ASTRA_EFFORT};
  try{
   const options={env:environment(this.home),timeout:Math.min(this.timeout,15000),maxOutputBytes:MAX_OUTPUT};
   const version=await this.runner(this.binary,['--version'],options);
   const help=await this.runner(this.binary,['exec','--help'],options);
   if(version.code!==0||help.code!==0||!['--ephemeral','--ignore-user-config','--ignore-rules','--output-schema','--output-last-message','--json'].every(x=>help.stdout.includes(x)))return {...base,ready:false,reason:'La versión de Codex no ofrece el modo estructurado requerido.'};
   const login=await this.runner(this.binary,['login','status'],options);
   if(login.code!==0||!`${login.stdout}\n${login.stderr}`.includes('Logged in using ChatGPT'))return {...base,ready:false,reason:'Falta iniciar sesión en Codex con ChatGPT en este host.'};
   const catalog=await this.runner(this.binary,['debug','models'],options);
   const data=JSON.parse(catalog.stdout),models=Array.isArray(data)?data:data.models;
   const model=models?.find(x=>x.slug===ASTRA_MODEL);
   if(catalog.code!==0||!model?.supported_reasoning_levels?.some(x=>x.effort===ASTRA_EFFORT))return {...base,ready:false,reason:'La sesión de Codex no anuncia gpt-6-astra con razonamiento high.'};
   return {...base,ready:true,version:version.stdout.trim(),authenticated:true,reason:'Sesión y catálogo disponibles; la inferencia depende de la disponibilidad y cuota de Codex.'};
  }catch{return {...base,ready:false,reason:'No se pudo comprobar Codex, su sesión o el catálogo de Astra High en este host.'};}
 }
 async run({prompt,schema,dir,name='editorial',images=[]}){
  if(typeof prompt!=='string'||!prompt.trim()||Buffer.byteLength(prompt)>MAX_OUTPUT)throw new Error('La entrada de Astra está vacía o supera el límite.');
  if(typeof dir!=='string'||!dir||!Array.isArray(images)||images.length>8)throw new Error('Directorio o imágenes de Astra inválidos.');
  schemaCheck(schema);const schemaText=canonical(schema);if(Buffer.byteLength(schemaText)>MAX_OUTPUT)throw new Error('JSON Schema demasiado grande.');
  const imageData=[];for(const file of images)imageData.push(await safeRead(file,MAX_IMAGE));
  const fingerprint=hash(canonical({version:1,model:ASTRA_MODEL,effort:ASTRA_EFFORT,prompt,schema,images:imageData.map(hash)}));
  const base=await privateDirectory(path.join(path.resolve(dir),'.astra'));
  const safeName=String(name).replace(/[^a-zA-Z0-9_-]+/g,'-').slice(0,64)||'editorial';
  const cache=path.join(base,`${safeName}-${fingerprint}.json`);
  try{
   const saved=JSON.parse((await safeRead(cache)).toString('utf8'));
   if(saved.metadata?.fingerprint===fingerprint&&saved.metadata.model===ASTRA_MODEL&&saved.metadata.effort===ASTRA_EFFORT&&saved.metadata.completed===true&&saved.metadata.valueHash===hash(canonical(saved.value))&&valid(saved.value,schema))return {value:saved.value,metadata:{...saved.metadata,cached:true}};
  }catch(error){if(error.code==='ELOOP')throw new Error('La caché de Astra no puede ser un enlace simbólico.');}
  const work=await mkdtemp(path.join(base,`${safeName}-`));await chmod(work,0o700);
  const schemaFile=path.join(work,'schema.json'),resultFile=path.join(work,'result.json');
  await privateWrite(schemaFile,schemaText);await privateWrite(path.join(work,'prompt.txt'),prompt);await privateWrite(resultFile,'');
  const args=['exec','--ephemeral','--ignore-user-config','--ignore-rules','--skip-git-repo-check','--model',ASTRA_MODEL,'-c',`model_reasoning_effort="${ASTRA_EFFORT}"`,'-c','approval_policy="never"','-c','web_search="disabled"','--sandbox','read-only',...DISABLED.flatMap(name=>['--disable',name]),'--enable','skip_host_skill_discovery','--cd',work,'--output-schema',schemaFile,'--output-last-message',resultFile,'--json'];
  for(let i=0;i<images.length;i++){const extension=['.png','.jpg','.jpeg','.webp','.gif'].includes(path.extname(images[i]).toLowerCase())?path.extname(images[i]).toLowerCase():'.png';const file=path.join(work,`image-${i}${extension}`);await privateWrite(file,imageData[i]);args.push('--image',file);}
  args.push('-');const started=Date.now();
  const result=await this.runner(this.binary,args,{cwd:work,env:environment(this.home),input:prompt,timeout:this.timeout,maxOutputBytes:MAX_OUTPUT});
  await privateWrite(path.join(work,'diagnostics.json'),JSON.stringify({code:result.code,stdout:result.stdout,stderr:result.stderr}));
  if(result.code!==0)throw new Error('Astra High falló. Revisá la sesión, disponibilidad o cuota de Codex; no se usó otro modelo.');
  let completed=false,failed=false,warningCount=0,usage;
  for(const line of (result.stdout||'').split('\n').filter(Boolean)){
   let event;try{event=JSON.parse(line);}catch{throw new Error('Codex devolvió eventos JSON inválidos.');}
   if(event.type==='turn.completed'){completed=true;usage=event.usage;}
   if(event.type==='turn.failed'||event.type==='error')failed=true;
   if(event.type==='item.completed'&&event.item?.type==='error')warningCount++;
  }
  if(!completed||failed)throw new Error('Astra no completó la respuesta; no se guardó una decisión reutilizable.');
  let value;try{value=JSON.parse((await safeRead(resultFile)).toString('utf8'));}catch{throw new Error('Astra no devolvió un archivo JSON válido y seguro.');}
  if(!valid(value,schema))throw new Error('La respuesta de Astra no cumple el JSON Schema.');
  await chmod(resultFile,0o600);
  const metadata={model:ASTRA_MODEL,effort:ASTRA_EFFORT,fingerprint,valueHash:hash(canonical(value)),completed:true,cached:false,warningCount,usage,durationMs:Date.now()-started,createdAt:new Date().toISOString()};
  const record=JSON.stringify({value,metadata});await privateWrite(path.join(work,'metadata.json'),JSON.stringify(metadata));
  const temporary=path.join(work,'cache.json');await privateWrite(temporary,record);await rename(temporary,cache);
  return {value,metadata};
 }
}
