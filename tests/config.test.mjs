import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {loadConfig} from '../src/config.mjs';

test('active configuration pins Astra High and uses Modal media without loading DeepSeek settings',t=>{
 const dir=mkdtempSync(join(tmpdir(),'kavion-config-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const c=loadConfig({DATA_DIR:dir,DEEPSEEK_API_KEY:'do-not-use',EDITORIAL_ENV_FILE:'/private/legacy.env',MODAL_CONFIG_PATH:'/private/modal.toml',ASTRA_MODEL:'wrong-model',ASTRA_REASONING_EFFORT:'low'});
 assert.equal(c.astraModel,'gpt-6-astra');assert.equal(c.astraEffort,'high');assert.equal(c.mediaBackend,'modal');
 assert.equal(c.modalConfigPath,'/private/modal.toml');assert.equal(c.modalTranscriptionModel,'large-v3');assert.equal(c.remoteMediaApp,'kavion-video-studio-media');
 assert.equal(c.modalTranscriptionGpu,'A10');
 assert.equal(c.localWhisperModel,'medium');assert.equal(c.localWhisperComputeType,'int8');
 for(const key of ['deepseekKey','deepseekModel','deepseekUrl'])assert.equal(Object.hasOwn(c,key),false,key);
});
