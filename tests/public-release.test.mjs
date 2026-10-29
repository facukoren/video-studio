import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.mjs';
import {Store} from '../src/store.mjs';
import {createApp} from '../src/app.mjs';
import {DriveClient} from '../src/providers/drive.mjs';

const folderId='example-output-folder-12345';
const temporary=t=>{const dir=mkdtempSync(join(tmpdir(),'public-release-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;};
test('fresh installations have no inherited account or destination',t=>{
 const c=loadConfig({DATA_DIR:temporary(t)});
 assert.equal(c.higgsfieldWorkspace,'');assert.equal(c.destinationFolderId,'');
 const store=new Store(':memory:');t.after(()=>store.close());assert.equal(store.getSettings().destinationFolderId,'');
});
test('configured destination is used for settings, jobs and Drive readiness',async t=>{
 const dir=temporary(t);const config=loadConfig({DATA_DIR:dir,DRIVE_DESTINATION_FOLDER_ID:folderId,HIGGSFIELD_WORKSPACE_ID:'example-workspace'});
 assert.equal(config.destinationFolderId,folderId);
 const store=new Store(':memory:',{destinationFolderId:config.destinationFolderId});t.after(()=>store.close());
 assert.equal(store.getSettings().destinationFolderId,folderId);
 assert.equal(store.createJob({sourceUrl:'https://drive.google.com/file/d/example-input-123/view',idempotencyKey:'test'}).destinationFolderId,folderId);
 assert.throws(()=>store.updateSettings({destinationFolderId:'different-folder-123'}));
 const client=new DriveClient({...config,googleClientId:'fixture.apps.googleusercontent.com',googleClientSecret:'not-a-real-secret'});
 client.checked=async url=>{assert.equal(new URL(url).pathname,`/drive/v3/files/${folderId}`);return {id:folderId,name:'Output',mimeType:'application/vnd.google-apps.folder',capabilities:{canAddChildren:true}};};
 assert.equal((await client.check()).state,'ready');
});
test('unsafe public binding and private data below public are rejected',t=>{
 const dir=temporary(t);
 assert.throws(()=>loadConfig({DATA_DIR:dir,HOST:'0.0.0.0'}),/APP_ACCESS_TOKEN/);
 assert.throws(()=>loadConfig({DATA_DIR:dir,HOST:'0.0.0.0',APP_ACCESS_TOKEN:'short'}),/APP_ACCESS_TOKEN/);
 assert.throws(()=>loadConfig({DATA_DIR:join(process.cwd(),'public','private-test')}),/public/);
});
test('explicit access token cannot be bypassed by loopback or forwarded headers',async t=>{
 const dir=temporary(t),token='test-only-access-token-with-at-least-32-chars';const store=new Store(':memory:');t.after(()=>store.close());
 const config={dataDir:dir,publicDir:dir,baseUrl:'http://127.0.0.1',accessToken:token};
 const app=createApp({store,config});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));t.after(()=>new Promise(r=>server.close(r)));
 config.baseUrl=`http://127.0.0.1:${server.address().port}`;
 for(const headers of [{},{authorization:'Bearer wrong'},{'x-forwarded-for':'127.0.0.1','x-forwarded-host':'localhost'}])assert.equal((await fetch(config.baseUrl+'/api/status',{headers})).status,401);
 const response=await fetch(config.baseUrl+'/api/status',{headers:{authorization:'Bearer '+token}});assert.equal(response.status,200);
 const cookie=response.headers.get('set-cookie').split(';')[0];
 assert.equal((await fetch(config.baseUrl+'/api/settings',{headers:{cookie}})).status,200);
});
test('first startup before configuring Drive can be reopened with its own destination',t=>{
 const db=join(temporary(t),'studio.sqlite');
 const first=new Store(db);first.updateSettings({maxCreditsPerVideo:7});
 const pending=first.createJob({sourceUrl:'https://drive.google.com/file/d/example-input-123/view',idempotencyKey:'pending-before-setup'});first.close();
 const configured=new Store(db,{destinationFolderId:folderId});
 assert.equal(configured.getSettings().destinationFolderId,folderId);
 assert.equal(configured.getSettings().maxCreditsPerVideo,7);
 assert.equal(configured.getJob(pending.id).destinationFolderId,'');
 assert.equal(configured.createJob({sourceUrl:'https://drive.google.com/file/d/example-input-456/view',idempotencyKey:'after-setup'}).destinationFolderId,folderId);configured.close();
 assert.throws(()=>new Store(db,{destinationFolderId:'different-folder-12345'}),/DATA_DIR/);
 assert.throws(()=>new Store(db),/DATA_DIR/);
});
