import {run} from '../process.mjs';
export class HiggsfieldClient {
 constructor(config,{cli}={}){this.config=config;this.cli=cli|| (async args=>JSON.parse((await run(config.higgsfieldPath||'higgsfield',[...args,'--json'],{timeout:120000})).stdout));}
 async check({requireCredits=true}={}){
  const w=await this.cli(['workspace','status']);
  if(!this.config.higgsfieldWorkspace||w.id!==this.config.higgsfieldWorkspace)throw new Error('Conectá la cuenta correcta de Higgsfield en este servidor.');
  if(requireCredits&&!(w.credits>0))throw new Error('La cuenta de Higgsfield no tiene créditos disponibles.');
  return w;
 }
 args(clip){return [this.config.higgsfieldModel||'kling3_0','--prompt',clip.prompt,'--duration','3','--sound','off','--mode','std','--aspect-ratio',clip.aspectRatio||'9:16'];}
 async cost(clip){const result=await this.cli(['generate','cost',...this.args(clip)]);if(!Number.isFinite(result.credits)||result.credits<0)throw new Error('Higgsfield no devolvió un costo verificable.');return result.credits;}
 async generate(clip,{budget,state={},checkpoint}){
  if(state.pending&&!state.jobId)throw Object.assign(new Error('El resultado de una generación anterior es incierto. Revisá Higgsfield antes de reintentar.'),{needsAttention:true});
  if(!state.jobId){
   const account=await this.check(),cost=await this.cost(clip);
   if(!Number.isFinite(budget)||cost>budget)throw Object.assign(new Error('El costo de B-roll supera el presupuesto configurado.'),{needsAttention:true});
   if(cost>account.credits)throw new Error('Saldo insuficiente en Higgsfield.');
   state={...state,pending:true,estimatedCredits:cost,submittedAt:new Date().toISOString()};await checkpoint(state);
   let created;try{created=await this.cli(['generate','create',...this.args(clip)]);}catch{throw Object.assign(new Error('Envío a Higgsfield de resultado incierto. Revisá la generación en la cuenta antes de reintentar.'),{needsAttention:true});}
   // The CLI returns ["job-uuid"] without --wait, rather than a job object.
   const single=Array.isArray(created)&&created.length===1?created[0]:null;
   const id=created?.id||created?.job_id||created?.job?.id||(typeof single==='string'?single:single?.id);
   if(typeof id!=='string'||!/^[A-Za-z0-9_-]{1,200}$/.test(id)){
    await checkpoint({...state,submissionResponse:created});
    throw Object.assign(new Error('Higgsfield recibió el envío pero no devolvió un ID verificable; resultado incierto.'),{needsAttention:true});
   }
   state={...state,jobId:id,pending:false};await checkpoint(state);
  }
  const deadline=Date.now()+(this.config.providerTimeoutMs||1200000);
  while(Date.now()<deadline){
   const job=await this.cli(['generate','get',state.jobId]);
   if(job.status==='completed'){
    const url=job.result_url||job.results?.[0]?.url;
    if(!url)throw new Error('Higgsfield terminó sin un video descargable.');
    const result={...state,url,status:'completed'};await checkpoint(result);return result;
   }
   if(['failed','cancelled','canceled'].includes(job.status))throw Object.assign(new Error('La generación de Higgsfield falló. Se conserva el ID para revisión.'),{needsAttention:true});
   await new Promise(r=>setTimeout(r,5000));
  }
  throw new Error('Higgsfield sigue procesando. El reintento consultará la misma generación.');
 }
}
