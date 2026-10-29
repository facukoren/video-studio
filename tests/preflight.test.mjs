import test from 'node:test';
import assert from 'node:assert/strict';
import {jobPreflight} from '../src/preflight.mjs';
const status=integrations=>({integrations});
test('completed checkpoints do not require unused editorial, transcription or Higgsfield connections',()=>{
 const artifacts={transcript:[{}],review:{},cut:{},plan:{},brolls:[{}]};
 assert.deepEqual(jobPreflight(status(['editorial','transcription','higgsfield'].map(id=>({id,state:'missing',detail:id}))),artifacts),[]);
});
test('transient resource waits retain the job in the queue',()=>{
 assert.throws(()=>jobPreflight(status([{id:'transcription',state:'waiting',detail:'Esperando memoria'}]),{}),error=>error.code==='LOCAL_RESOURCES_WAIT'&&/memoria/.test(error.message));
});
test('missing required setup is actionable before any processing',()=>{
 assert.deepEqual(jobPreflight(status([{id:'editorial',state:'missing',detail:'Iniciá sesión en Codex'},{id:'resources',state:'waiting',detail:'Memoria baja'}]),{}),['Iniciá sesión en Codex']);
});
test('paid generations may be recovered without a positive remaining balance',()=>{
 const artifacts={plan:{brolls:[{},{}]},generations:{0:{jobId:'one'},1:{jobId:'two'}}};
 assert.deepEqual(jobPreflight(status([{id:'higgsfield',state:'error',detail:'Sin créditos'}]),artifacts),[]);
});
