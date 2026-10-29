import test from 'node:test';
import {execFileSync} from 'node:child_process';

test('included ASR deployment accepts only its private input contract and preserves segment text',()=>{
 execFileSync('python3',['-c',String.raw`
import importlib.util, sys, tempfile, types
from pathlib import Path
class Builder:
 def __getattr__(self,name):return lambda *a,**kw:self
class App:
 def __init__(self,*a):pass
 def function(self,**kw):
  assert kw['include_source'] is False
  assert kw['max_containers']==1 and kw['retries']==0
  return lambda fn:fn
resource=types.SimpleNamespace(from_name=lambda *a,**kw:Builder())
sys.modules['modal']=types.SimpleNamespace(App=App,NetworkFileSystem=resource,Volume=resource,Image=types.SimpleNamespace(from_registry=lambda *a,**kw:Builder()))
spec=importlib.util.spec_from_file_location('asr','scripts/whisperx-modal.py');m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
for args in [('../secret','source.mp4'),('uploads/video-studio-'+ 'a'*64 + '/source.mp4','other.mp4')]:
 try:m.transcribe_file(*args)
 except ValueError:pass
 else:raise AssertionError('Unsafe path/name accepted')
remote='uploads/video-studio-'+'a'*64+'/source.mp4'
for kwargs in [{'language':'en'},{'model_name':'medium'},{'enable_diarization':True}]:
 try:m.transcribe_file(remote,'source.mp4',**kwargs)
 except ValueError:pass
 else:raise AssertionError('Unsupported ASR settings accepted')
with tempfile.TemporaryDirectory() as directory:
 root=Path(directory);source=root/remote;source.parent.mkdir(parents=True);source.write_bytes(b'fixture')
 m.Path=lambda p:root if p=='/inputs' else Path(p)
 words=[{'word':'Hola','start':0.1,'end':0.6}]
 segments=[{'start':0,'end':1,'text':'Hola','words':words}]
 class Model:
  def transcribe(self,audio,**kw):
   assert kw==dict(batch_size=8,language='es')
   return dict(segments=segments)
 def load_model(name,device,**kw):
  assert (name,device)==('large-v3','cuda') and kw['vad_method']=='silero'
  return Model()
 sys.modules['torch']=types.SimpleNamespace(cuda=types.SimpleNamespace(empty_cache=lambda:None))
 sys.modules['whisperx']=types.SimpleNamespace(load_audio=lambda p:[0]*16000,load_model=load_model,load_align_model=lambda **kw:(None,None),align=lambda *a,**kw:dict(segments=segments))
 result=m.transcribe_file(remote,'source.mp4')
 assert result==dict(segments=segments,duration=1,language='es')
`],{cwd:process.cwd(),env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'},stdio:'pipe'});
});
