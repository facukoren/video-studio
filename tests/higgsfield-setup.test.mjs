import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {HiggsfieldSetup,validateCallback,ensureHiggsfieldAccount} from '../src/higgsfield-setup.mjs';

const state='correct-state-with-at-least-24-characters';
const authUrl=`https://clerk.higgsfield.ai/oauth/authorize?state=${state}&redirect_uri=${encodeURIComponent('http://localhost:8765/callback')}&code_challenge=challenge&code_challenge_method=S256`;
test('a successful login recovers a stale workspace selection without asking for login again',async()=>{
 let selected=false;const calls=[];
 const cli=async args=>{calls.push(args);if(args[1]==='status'){if(!selected)throw new Error('workspace_membership_required');return {id:'expected',credits:50};}if(args[1]==='list')return [{id:'expected',is_selected:false}];if(args[1]==='set'){assert.equal(args[2],'expected');selected=true;return;}};
 assert.equal((await ensureHiggsfieldAccount({higgsfieldWorkspace:'expected'},{cli})).id,'expected');assert.equal(calls.filter(c=>c[1]==='set').length,1);
 const wrong=async args=>args[1]==='list'?[{id:'other'}]:{id:'other'};
 await assert.rejects(ensureHiggsfieldAccount({higgsfieldWorkspace:'expected'},{cli:wrong}),/cuenta/);
});
test('callback relay confines destination and requires the original OAuth state',()=>{
 for(const callback of [`https://evil.example/callback?code=x&state=${state}`,`http://localhost:9999/callback?code=x&state=${state}`,`http://localhost:8765/other?code=x&state=${state}`,`http://localhost:8765/callback?code=x&state=wrong`,`http://user@localhost:8765/callback?code=x&state=${state}`,`http://localhost:8765/callback?code=x&code=y&state=${state}`])assert.throws(()=>validateCallback(callback,state));
 assert.equal(validateCallback(`http://localhost:8765/callback?code=secret-code&state=${state}`,state),'http://127.0.0.1:8765/callback?code=secret-code&state='+state);
});
test('login is session-bound, forwards one callback and confirms the expected workspace',async t=>{
 const child=new EventEmitter();child.stdout=new PassThrough();child.stderr=new PassThrough();child.kill=()=>child.emit('close',1);
 let connected=false,forwards=0,spawns=0;
 const setup=new HiggsfieldSetup({}, {spawnImpl:()=>{spawns++;setImmediate(()=>child.stdout.write('Visit: '+authUrl+'\n'));return child;},check:async()=>{if(!connected)throw new Error('wrong account');return {id:'expected'};},fetchImpl:async url=>{forwards++;assert.ok(url.startsWith('http://127.0.0.1:8765/callback?'));connected=true;setImmediate(()=>child.emit('close',0));return {ok:true};}});
 t.after(()=>setup.close());const owner={};const start=await setup.start(owner);assert.equal(start.status,'waiting');assert.equal(start.authUrl,authUrl);
 assert.equal((await setup.start(owner)).authUrl,authUrl);assert.equal(spawns,1);
 await assert.rejects(setup.start({}),e=>e.status===409);
 assert.equal(setup.status({}).authUrl,undefined);
 await assert.rejects(setup.complete(`http://localhost:8765/callback?code=secret&state=${state}`,{}),e=>e.status===403);
 await assert.rejects(setup.complete('http://localhost:8765/callback?code=secret&state=wrong',owner));assert.equal(forwards,0);
 const final=await setup.complete(`http://localhost:8765/callback?code=secret&state=${state}`,owner);assert.equal(final.status,'connected');assert.equal(forwards,1);
 assert.ok(!JSON.stringify(final).includes('secret'));assert.ok(!JSON.stringify(final).includes(state));
 await assert.rejects(setup.complete(`http://localhost:8765/callback?code=secret&state=${state}`,owner));assert.equal(forwards,1);
});
