import {spawn} from 'node:child_process';
export function run(command,args,{timeout=120000,cwd,env=process.env,maxOutput=2*1024**2}={}) {
 return new Promise((resolve,reject)=>{
  const child=spawn(command,args,{cwd,env,stdio:['ignore','pipe','pipe']});let stdout='',stderr='',timedOut=false;
  const timer=setTimeout(()=>{timedOut=true;child.kill('SIGTERM');setTimeout(()=>child.kill('SIGKILL'),3000).unref();},timeout);
  child.stdout.on('data',b=>{stdout+=b;if(stdout.length>maxOutput)child.kill('SIGKILL');});
  child.stderr.on('data',b=>{stderr=(stderr+b).slice(-maxOutput);});
  child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);if(code!==0||timedOut){const e=new Error(timedOut?'El proceso excedió el tiempo de espera.':`Falló ${command.split('/').at(-1)} (código ${code}).`);e.detail=stderr;e.code=timedOut?'TIMEOUT':'PROCESS_FAILED';reject(e);}else resolve({stdout,stderr});});
 });
}
