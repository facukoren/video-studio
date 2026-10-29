import {chromium} from 'playwright';
import express from 'express';
import {mkdtemp,mkdir,rm} from 'node:fs/promises';
import os from 'node:os';import path from 'node:path';import assert from 'node:assert/strict';
import {Store} from '../src/store.mjs';import {createApp} from '../src/app.mjs';import {loadConfig} from '../src/config.mjs';import {runMediaCommand} from '../src/media.mjs';
const config=loadConfig(),dataDir=await mkdtemp(path.join(os.tmpdir(),'kavion-upload-browser-'));
const store=new Store(path.join(dataDir,'test.sqlite')),testConfig={...config,dataDir,baseUrl:'http://127.0.0.1',googleClientFile:path.join(dataDir,'client.json'),googleTokenPath:path.join(dataDir,'tokens.json')};
const app=createApp({store,config:testConfig,integrationStatus:async()=>[]});
let loseUploadResponse=false;
const gateway=express();gateway.use((req,res,next)=>{if(req.method==='POST'&&req.path==='/api/jobs/upload'&&loseUploadResponse){res.end=()=>{loseUploadResponse=false;res.setHeader('Content-Length','100000');res.flushHeaders();res.write('{');setTimeout(()=>res.destroy(),300);return res;};}next();});gateway.use(app);
const server=gateway.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const origin=`http://127.0.0.1:${server.address().port}`;testConfig.baseUrl=origin;
const browser=await chromium.launch({headless:true,executablePath:config.browserExecutablePath,args:['--no-sandbox','--disable-dev-shm-usage','--renderer-process-limit=1']});
await mkdir('runtime/upload-screenshots',{recursive:true});const errors=[];
try{
 const file=path.join(dataDir,'Prueba de cámara.MOV');
 await runMediaCommand(config.ffmpegPath,['-v','error','-y','-f','lavfi','-i','color=c=blue:s=128x192:d=1','-f','lavfi','-i','sine=frequency=440:duration=1','-c:v','mpeg4','-c:a','aac','-shortest',file]);
 const page=await browser.newPage({viewport:{width:1440,height:1000},colorScheme:'dark'});page.on('pageerror',e=>errors.push(e.message));
 await page.goto(origin);await page.locator('#history-empty').waitFor();
 assert.equal(await page.locator('#source-mode-upload').count(),1);
 await page.locator('#source-mode-upload').click();
 await page.locator('#source-file').setInputFiles({name:'wrong.txt',mimeType:'text/plain',buffer:Buffer.from('invalid')});await page.locator('#submit-video').click();await page.locator('#source-error').waitFor({state:'visible'});assert.equal(store.listJobs().length,0);
 await page.locator('#source-file').setInputFiles(file);
 await page.screenshot({path:'runtime/upload-screenshots/selected-desktop.png',fullPage:true});
 loseUploadResponse=true;
 await page.locator('#submit-video').click();await page.locator('#upload-progress').waitFor({state:'visible'});
 assert.equal(await page.locator('#source-mode-drive').isDisabled(),true);
 await page.waitForFunction(()=>!document.querySelector('#source-error').hidden&&!document.querySelector('#submit-video').disabled);
 assert.equal(loseUploadResponse,false);assert.equal(store.listJobs().length,1);assert.equal(await page.locator('#source-file').evaluate(e=>e.files.length),1);
 await page.reload();await page.locator('#source-file').waitFor({state:'visible'});await page.locator('#source-file').setInputFiles(file);
 await page.locator('#submit-video').click();await page.locator('#submission-message').waitFor({state:'visible'});
 assert.equal(store.listJobs().length,1);assert.equal(await page.locator('#source-file').evaluate(e=>e.files.length),0);
 const job=store.listJobs()[0];assert.equal(job.sourceName,'Prueba de cámara.MOV');
 await page.locator('#job-list .job-button').first().click();assert.equal(await page.locator('#detail-source').isVisible(),false);await page.keyboard.press('Escape');
 for(const [theme,width,height]of [['dark',390,844],['light',390,844],['light',1440,1000]]){
  await page.emulateMedia({colorScheme:theme});await page.setViewportSize({width,height});
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  await page.screenshot({path:`runtime/upload-screenshots/${theme}-${width}.png`,fullPage:true});
 }
 await page.locator('#source-mode-drive').click();await page.locator('#source-url').fill('https://drive.google.com/file/d/abcdefghijk123/view');await page.locator('#submit-video').click();
 await page.waitForFunction(()=>document.querySelector('#job-count').textContent==='2');assert.equal(store.listJobs().length,2);
 assert.deepEqual(errors,[]);console.log('Upload browser QA passed: real MOV, progress, lost response and reload retry create one job, filename, source link hidden, Drive flow, mobile/desktop dark/light, no JS errors.');
}finally{await browser.close();server.closeAllConnections();await new Promise(r=>server.close(r));store.close();await rm(dataDir,{recursive:true,force:true});}
