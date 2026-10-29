import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {existsSync,mkdirSync,realpathSync} from 'node:fs';
import {homedir} from 'node:os';

export function loadConfig(env=process.env) {
 const rootDir=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
 const dataDir=path.resolve(env.DATA_DIR||path.join(rootDir,'runtime/data'));
 const publicDir=path.join(rootDir,'public');
 const within=(base,target)=>{const rel=path.relative(base,target);return rel===''||(!rel.startsWith('..')&&!path.isAbsolute(rel));};
 if(within(publicDir,dataDir))throw new Error('DATA_DIR debe quedar fuera de public.');
 const host=env.HOST||'127.0.0.1',accessToken=env.APP_ACCESS_TOKEN||'';
 if((!['127.0.0.1','::1','localhost'].includes(host)||accessToken)&&accessToken.length<32)throw new Error('APP_ACCESS_TOKEN debe tener al menos 32 caracteres para acceso remoto o autenticado.');
 const baseUrl=env.BASE_URL||`http://127.0.0.1:${env.PORT||4142}`;
 const origin=new URL(baseUrl);
 if(!['http:','https:'].includes(origin.protocol)||origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('BASE_URL debe ser un origen HTTP(S) sin credenciales ni ruta.');
 mkdirSync(dataDir,{recursive:true,mode:0o700});
 if(within(realpathSync(publicDir),realpathSync(dataDir)))throw new Error('DATA_DIR debe quedar fuera de public.');
 const destinationFolderId=env.DRIVE_DESTINATION_FOLDER_ID||'';
 if(destinationFolderId&&!/^[A-Za-z0-9_-]{10,200}$/.test(destinationFolderId))throw new Error('DRIVE_DESTINATION_FOLDER_ID no es válido.');
 const localTool=name=>{const p=path.join(rootDir,'runtime/tools/extracted/usr/bin',name);return existsSync(p)?p:name;};
 const localPython=path.join(rootDir,'runtime/venv-media',process.platform==='win32'?'Scripts/python.exe':'bin/python');
 return {
  rootDir,dataDir,publicDir,port:Number(env.PORT||4142),host,destinationFolderId,
  referenceVideoPath:path.resolve(env.REFERENCE_VIDEO_PATH||path.join(dataDir,'style-reference/reference.mp4')),
  baseUrl,accessToken,
  googleClientId:env.GOOGLE_CLIENT_ID||'',googleClientSecret:env.GOOGLE_CLIENT_SECRET||'',
  googleClientFile:path.resolve(env.GOOGLE_CLIENT_FILE||path.join(dataDir,'google-client.json')),
  googleRedirectUri:env.GOOGLE_REDIRECT_URI||`${baseUrl}/api/auth/google/callback`,
  googleTokenPath:path.join(dataDir,'google-tokens.json'),maxInputBytes:2*1024**3,
  ffmpegPath:env.FFMPEG_PATH||localTool('ffmpeg'),ffprobePath:env.FFPROBE_PATH||localTool('ffprobe'),
  hyperframesPath:path.join(rootDir,'node_modules/.bin/hyperframes'),maxSilence:0.3,renderTimeoutMs:30*60*1000,
  higgsfieldPath:env.HIGGSFIELD_PATH||'higgsfield',higgsfieldModel:env.HIGGSFIELD_MODEL||'kling3_0',
  higgsfieldWorkspace:env.HIGGSFIELD_WORKSPACE_ID||'',
  astraPath:env.ASTRA_PATH||'codex',astraHome:env.ASTRA_HOME||path.join(homedir(),'.codex'),
  astraModel:'gpt-6-astra',astraEffort:'high',astraTimeoutMs:180000,
  pythonPath:env.PYTHON_PATH||'python3',localPythonPath:env.LOCAL_PYTHON_PATH||(existsSync(localPython)?localPython:env.PYTHON_PATH||'python3'),
  pythonLibs:env.PYTHON_LIBS||path.join(rootDir,'runtime/python-libs'),modalConfigPath:env.MODAL_CONFIG_PATH||path.join(homedir(),'.modal.toml'),
  remoteMediaApp:env.MODAL_MEDIA_APP||'kavion-video-studio-media',remoteMediaVolume:env.MODAL_MEDIA_VOLUME||'kavion-video-studio-media',
  remoteMediaEnvironment:env.MODAL_MEDIA_ENVIRONMENT||'',remoteMediaTimeoutMs:32*60*1000,
  modalTranscriptionApp:'kavion-whisperx-real',modalTranscriptionFunction:'transcribe_file',modalTranscriptionFilesystem:'kavion-whisperx-inputs',
  modalTranscriptionEnvironment:env.MODAL_MEDIA_ENVIRONMENT||'',modalTranscriptionModel:'large-v3',modalTranscriptionGpu:'A10',modalTranscriptionTimeoutMs:20*60*1000,
  modalAlignmentRecovery:{app:'kavion-word-alignment',function:'align_words_v1',contract:'kavion-word-alignment-v1'},
  localWhisperModelPath:env.LOCAL_WHISPER_MODEL_PATH||path.join(rootDir,'runtime/models/whisper-medium'),
  localWhisperModel:env.LOCAL_WHISPER_MODEL||'medium',localWhisperDevice:env.LOCAL_WHISPER_DEVICE||'cpu',
  localWhisperComputeType:env.LOCAL_WHISPER_COMPUTE_TYPE||'int8',localWhisperThreads:2,
  localTranscriptionMinMemoryMb:Number(env.LOCAL_TRANSCRIPTION_MIN_MEMORY_MB||3072),localTranscriptionTimeoutMs:7200000,mediaThreads:2,
  browserExecutablePath:env.PUPPETEER_EXECUTABLE_PATH||undefined,
  mediaBackend:'modal',
  providerTimeoutMs:20*60*1000,maxVideoDuration:600,
 };
}
