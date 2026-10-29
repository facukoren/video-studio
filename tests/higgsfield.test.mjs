import test from 'node:test';
import assert from 'node:assert/strict';
import {HiggsfieldClient} from '../src/providers/higgsfield.mjs';

test('does not submit generation when workspace differs',async()=>{
 const calls=[];const cli=async args=>{calls.push(args);return {id:'wrong',credits:100};};
 const h=new HiggsfieldClient({higgsfieldWorkspace:'expected'}, {cli});
 await assert.rejects(h.generate({prompt:'computer',duration:3}, {budget:30,state:{},checkpoint:()=>{}}),/cuenta/i);
 assert.equal(calls.some(x=>x.includes('create')),false);
});
test('unknown prior paid submission must not be repeated',async()=>{
 let calls=0;const h=new HiggsfieldClient({}, {cli:async()=>{calls++;return {};}});
 await assert.rejects(h.generate({prompt:'computer',duration:3},{budget:30,state:{pending:true},checkpoint:()=>{}}),/incierto/i);
 assert.equal(calls,0);
});
test('cost above budget prevents submission',async()=>{
 const calls=[];const cli=async args=>{calls.push(args);if(args[0]==='workspace') return {id:'ok',credits:100}; if(args[1]==='cost')return {credits:40};return {};};
 const h=new HiggsfieldClient({higgsfieldWorkspace:'ok'}, {cli});
 await assert.rejects(h.generate({prompt:'computer',duration:3},{budget:20,state:{},checkpoint:()=>{}}),/presupuesto/i);
 assert.equal(calls.some(x=>x.includes('create')),false);
});

test('previously paid jobs can be recovered with zero remaining balance',async()=>{
 const h=new HiggsfieldClient({higgsfieldWorkspace:'ok'},{cli:async()=>({id:'ok',credits:0})});
 assert.equal((await h.check({requireCredits:false})).credits,0);
 await assert.rejects(h.check(),/créditos/i);
});

test('CLI create returns an array of job ID strings and checkpoints before polling',async()=>{
 const calls=[],states=[];
 const id='72c360fd-af95-4812-a205-b63279692260';
 const h=new HiggsfieldClient({higgsfieldWorkspace:'ok'},{cli:async args=>{
  calls.push(args);
  if(args[0]==='workspace')return {id:'ok',credits:100};
  if(args[1]==='cost')return {credits:4.5};
  if(args[1]==='create')return [id];
  assert.equal(args[1],'get');assert.equal(args[2],id);
  assert.equal(states.at(-1).jobId,id);assert.equal(states.at(-1).pending,false);
  return {id,status:'completed',result_url:'https://cdn.higgsfield.ai/example.mp4'};
 }});
 const result=await h.generate({prompt:'A streamer setup',duration:3},{budget:4.5,checkpoint:s=>states.push({...s})});
 assert.equal(result.jobId,id);assert.equal(calls.filter(x=>x[1]==='create').length,1);
});
