import test from 'node:test';import assert from 'node:assert/strict';
import {makeStatus,mediaMemoryFloor} from '../src/status.mjs';
test('cold status remains available while a provider is slow',async()=>{
 const status=makeStatus({config:{},store:{workerStatus:()=>({online:true}),getSettings:()=>({destinationFolderId:'folder',maxCreditsPerVideo:10})},drive:{check:()=>new Promise(()=>{})},higgs:{check:async()=>({credits:50})},runImpl:async()=>({}),memory:()=>1024,astra:{check:async()=>({ready:false})},transcriber:{check:async()=>({state:'missing'})}});
 const result=await Promise.race([status(),new Promise((_,reject)=>setTimeout(()=>reject(new Error('status blocked')),200))]);
 assert.equal(result.ready,false);assert.equal(result.integrations.find(i=>i.id==='drive').detail,'Comprobando conexión…');
});
test('readiness requires Astra High and local transcription, without remote provider calls',async()=>{
 let astraChecks=0,localChecks=0;
 const config={hyperframesPath:'/etc/hosts'};
 const status=makeStatus({config,store:{workerStatus:()=>({online:true}),getSettings:()=>({destinationFolderId:'folder',maxCreditsPerVideo:15})},drive:{check:async()=>({state:'ready'})},higgs:{check:async()=>({credits:50})},runImpl:async()=>({}),memory:()=>4096,astra:{check:async()=>{astraChecks++;return {ready:true};}},transcriber:{check:async()=>{localChecks++;return {state:'ready',detail:'Whisper medium local'};}}});
 const result=await status({fresh:true});assert.equal(result.ready,true);assert.equal(astraChecks,1);assert.equal(localChecks,1);assert.equal(mediaMemoryFloor(config),768);
 assert.match(result.integrations.find(x=>x.id==='editorial').name,/Astra High/);
 assert.match(result.integrations.find(x=>x.id==='render').detail,/local/i);
});
test('an unavailable local model is reported without using Modal or another transcriber',async()=>{
 const status=makeStatus({config:{hyperframesPath:'/etc/hosts'},store:{workerStatus:()=>({online:true}),getSettings:()=>({destinationFolderId:'example-output-folder-12345',maxCreditsPerVideo:15})},drive:{check:async()=>({state:'ready'})},higgs:{check:async()=>({credits:50})},runImpl:async()=>({}),memory:()=>4096,astra:{check:async()=>({ready:true})},transcriber:{check:async()=>({state:'missing',detail:'Falta instalar Whisper medium local.'})}});
 const result=await status({fresh:true});assert.equal(result.ready,false);assert.equal(result.integrations.find(x=>x.id==='transcription').state,'missing');assert.equal(result.integrations.find(x=>x.id==='transcription').detail,'Falta preparar la transcripción local en el equipo de edición.');
});


test('production readiness uses Modal media and Astra without a local ASR or browser requirement',async()=>{
 let remoteChecks=0;
 const config={mediaBackend:'modal'};
 const status=makeStatus({config,store:{workerStatus:()=>({online:true}),getSettings:()=>({destinationFolderId:'example-output-folder-12345',maxCreditsPerVideo:15})},drive:{check:async()=>({state:'ready'})},higgs:{check:async()=>({credits:50})},runImpl:async()=>{throw new Error('Local renderer must not be checked');},memory:()=>512,astra:{check:async()=>({ready:true})},transcriber:{check:async()=>({state:'ready',detail:'WhisperX en Modal disponible'})},remoteMedia:{check:async()=>{remoteChecks++;return {state:'ready',detail:'HyperFrames en Modal disponible'};}}});
 const result=await status({fresh:true});assert.equal(result.ready,true);assert.equal(remoteChecks,1);assert.equal(mediaMemoryFloor(config),256);
 assert.match(result.integrations.find(x=>x.id==='render').name,/Modal/);assert.match(result.integrations.find(x=>x.id==='transcription').name,/Modal/);
});
