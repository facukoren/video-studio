// Check only dependencies still needed by this durable job. Provider-specific
// checks also run immediately before generation/upload, where they are binding.
export function jobPreflight(status, artifacts={}) {
 const paid=artifacts.plan?.brolls?.length&&artifacts.plan.brolls.every((_,i)=>artifacts.generations?.[i]?.jobId);
 const needed=entry=>!((entry.id==='transcription'&&artifacts.transcript)
  ||(entry.id==='editorial'&&artifacts.review&&artifacts.plan)
  ||(entry.id==='higgsfield'&&(artifacts.brolls||paid)));
 const unavailable=status.integrations.filter(entry=>entry.state!=='ready'&&needed(entry));
 const missing=unavailable.filter(entry=>entry.state!=='waiting');
 if(missing.length)return missing.map(entry=>entry.detail);
 if(unavailable.length)throw Object.assign(new Error(unavailable.map(entry=>entry.detail).join(' ')),{code:'LOCAL_RESOURCES_WAIT'});
 return [];
}
