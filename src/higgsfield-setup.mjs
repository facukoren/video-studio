import {spawn} from 'node:child_process';
import {timingSafeEqual} from 'node:crypto';
import {run} from './process.mjs';

const fail=(message,status=400)=>Object.assign(new Error(message),{status,code:'higgsfield_connection'});
const same=(a,b)=>typeof a==='string'&&typeof b==='string'&&Buffer.byteLength(a)===Buffer.byteLength(b)&&timingSafeEqual(Buffer.from(a),Buffer.from(b));
const pause=ms=>new Promise(resolve=>{const timer=setTimeout(resolve,ms);timer.unref();});
function loopbackUrl(input){
 let url;try{url=new URL(input);}catch{throw fail('Pegá la dirección completa que quedó en el navegador después de autorizar Higgsfield.');}
 if(url.protocol!=='http:'||!['localhost','127.0.0.1'].includes(url.hostname)||url.port!=='8765'||url.pathname!=='/callback'||url.username||url.password||url.hash)throw fail('La dirección debe ser el retorno local de Higgsfield en el puerto 8765.');
 return url;
}
export function validateCallback(input,state){
 if(typeof input!=='string'||input.length>12000)throw fail('La dirección de retorno no es válida.');
 const url=loopbackUrl(input);
 if(url.searchParams.getAll('state').length!==1||!same(url.searchParams.get('state'),state))throw fail('Este retorno pertenece a otra conexión. Usá el enlace de autorización de esta ventana.');
 if(url.searchParams.getAll('code').length!==1||!url.searchParams.get('code')||url.searchParams.get('code').length>8192)throw fail('La dirección no contiene el código de autorización.');
 const target=new URL('http://127.0.0.1:8765/callback');target.search=new URLSearchParams({code:url.searchParams.get('code'),state}).toString();return target.href;
}
function authorizationUrl(text){
 for(const match of text.matchAll(/https:\/\/[^\s<>"']+/g)){
  try{
   const url=new URL(match[0]);
   if(!['clerk.higgsfield.ai','bridge.higgsfield.ai','kopir.higgsfield.ai'].includes(url.hostname)||url.port||url.username||url.password)continue;
   if(!url.searchParams.get('state')||url.searchParams.get('state').length<16||url.searchParams.get('code_challenge_method')!=='S256')continue;
   loopbackUrl(url.searchParams.get('redirect_uri'));return url;
  }catch{}
 }
 return null;
}
export async function ensureHiggsfieldAccount(config,{cli}={}){
 const invoke=cli|| (async args=>{
  const result=await run(config.higgsfieldPath||'higgsfield',[...args,'--json'],{timeout:3000});
  return args[1]==='set'?null:JSON.parse(result.stdout);
 });
 if(!config.higgsfieldWorkspace)throw fail('Falta configurar el espacio de Higgsfield del proyecto.',503);
 try{const current=await invoke(['workspace','status']);if(current.id===config.higgsfieldWorkspace)return current;}catch{}
 const workspaces=await invoke(['workspace','list']);
 if(!Array.isArray(workspaces)||!workspaces.some(w=>w.id===config.higgsfieldWorkspace))throw fail('Conectá la cuenta de Higgsfield que tiene tu plan y créditos.');
 // OAuth may replace credentials while keeping the previous account's workspace.
 // Select only the explicitly configured workspace after verifying membership.
 await invoke(['workspace','set',config.higgsfieldWorkspace]);
 const selected=await invoke(['workspace','status']);
 if(selected.id!==config.higgsfieldWorkspace)throw fail('No se pudo seleccionar el espacio correcto de Higgsfield.');
 return selected;
}
export class HiggsfieldSetup {
 constructor(config,{spawnImpl=spawn,fetchImpl=fetch,check}={}){
  this.config=config;this.spawn=spawnImpl;this.fetch=fetchImpl;
  this.check=check||(()=>ensureHiggsfieldAccount(config));
  this.attempt=null;this.starting=null;
 }
 status(owner){
  const a=this.attempt;if(!a)return {status:'idle'};
  if(a.owner!==owner)return {status:'idle',message:'Hay una conexión iniciada desde otra ventana.'};
  return {status:a.status,...(a.message?{message:a.message}:{}),...(a.status==='waiting'&&a.authUrl?{authUrl:a.authUrl,expiresAt:new Date(a.expiresAt).toISOString()}:{} )};
 }
 async start(owner){
  if(this.starting){await this.starting;return this.start(owner);}
  const a=this.attempt;
  if(a?.status==='waiting'){
   if(a.owner!==owner)throw fail('La conexión está abierta en otra ventana. Terminá ese intento o esperá a que venza.',409);
   return this.status(owner);
  }
  this.starting=this.begin(owner);try{return await this.starting;}finally{this.starting=null;}
 }
 async begin(owner){
  try{await this.check();this.attempt={owner,status:'connected',message:'Cuenta correcta de Higgsfield conectada.'};return this.status(owner);}catch{}
  let readyResolve;const ready=new Promise(resolve=>{readyResolve=resolve;});
  let doneResolve;const done=new Promise(resolve=>{doneResolve=resolve;});
  const a={owner,status:'waiting',expiresAt:Date.now()+10*60000,done,doneResolve,buffer:'',consumed:false};this.attempt=a;
  const finish=(status,message)=>{a.status=status;a.message=message;a.authUrl=undefined;a.state=undefined;clearTimeout(a.timer);readyResolve();doneResolve();};
  a.finish=finish;
  const child=this.spawn(this.config.higgsfieldPath||'higgsfield',['auth','login','--port','8765'],{detached:true,stdio:['ignore','pipe','pipe'],env:{...process.env,BROWSER:'/bin/true'}});a.child=child;
  a.stop=()=>{try{if(child.pid)process.kill(-child.pid,'SIGTERM');else child.kill('SIGTERM');}catch{child.kill('SIGTERM');}};
  const read=chunk=>{a.buffer=(a.buffer+chunk.toString()).slice(-32768);if(a.authUrl)return;const url=authorizationUrl(a.buffer);if(url){a.authUrl=url.href;a.state=url.searchParams.get('state');a.buffer='';readyResolve();}};
  child.stdout.on('data',read);child.stderr.on('data',read);
  child.on('error',()=>finish('error','No se pudo abrir la conexión de Higgsfield en el servidor.'));
  child.on('close',async code=>{
   if(a.status!=='waiting')return;
   if(code!==0){finish('error','La autorización no se completó. Volvé a iniciar la conexión.');return;}
   try{await this.check();finish('connected','Cuenta correcta de Higgsfield conectada.');}
   catch{finish('error','Se autorizó otra cuenta. Volvé a conectar usando la cuenta de Higgsfield que tenés vinculada en este chat.');}
  });
  a.timer=setTimeout(()=>{finish('error','El enlace venció. Iniciá una conexión nueva.');a.stop();},10*60000);a.timer.unref();
  await Promise.race([ready,pause(8000)]);
  if(a.status==='waiting'&&!a.authUrl){finish('error','Higgsfield no devolvió el enlace de acceso. Volvé a intentar.');a.stop();}
  return this.status(owner);
 }
 async complete(input,owner){
  const a=this.attempt;if(!a||a.owner!==owner)throw fail('Iniciá la conexión desde esta misma ventana.',403);
  if(a.status!=='waiting'||!a.state||a.consumed)throw fail('Esta autorización ya se recibió o venció. Consultá el estado de la conexión.',409);
  const target=validateCallback(input,a.state);a.consumed=true;a.message='Validando la autorización…';
  const forward=this.fetch(target,{redirect:'error',signal:AbortSignal.timeout(10000)}).then(response=>{
   if(!response.ok&&a.status==='waiting'){a.finish('error','Higgsfield rechazó la autorización. Iniciá una conexión nueva.');a.stop();}
  }).catch(()=>{if(a.status==='waiting'){a.finish('error','No se pudo completar el retorno de autorización. Iniciá una conexión nueva.');a.stop();}});
  // No callback URL/code is persisted, returned, or logged. The CLI owns PKCE and token storage.
  a.forward=forward;await Promise.race([a.done,pause(8000)]);return this.status(owner);
 }
 close(){const a=this.attempt;if(a?.status==='waiting'){a.finish('error','La conexión se cerró.');a.stop();}}
}
export function registerHiggsfieldSetup(app,{config,setup=new HiggsfieldSetup(config)}){
 app.get('/api/setup/higgsfield',(req,res)=>res.json(setup.status(req.session)));
 app.post('/api/setup/higgsfield/start',async(req,res)=>res.json(await setup.start(req.session)));
 app.post('/api/setup/higgsfield/complete',async(req,res)=>res.json(await setup.complete(req.body?.callbackUrl,req.session)));
 return setup;
}
