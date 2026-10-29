import test from 'node:test';
import {runMediaCommand} from '../src/media.mjs';
const env={...process.env,PYTHONDONTWRITEBYTECODE:'1',PYTHONPATH:['scripts',process.env.PYTHONPATH].filter(Boolean).join(':')};
const run=code=>runMediaCommand('python3',['-c',code],{env});

test('acoustic alignment expands numeric spelling but restores every original display token',async()=>{
 await run(`from alignment_words import prepare_alignment,restore_alignment
raw={'segments':[{'start':0,'end':4,'words':[{'word':'100'},{'word':'videos'},{'word':'$1.000'},{'word':'30%'},{'word':'1,5'}]}]}
p=prepare_alignment(raw,4)
assert p['segments']==[{'start':0,'end':4,'text':'cien videos mil treinta por ciento uno coma cinco'}],p
aligned={'word_segments':[{'word':w,'start':a,'end':b} for w,a,b in [('cien',0,.2),('videos',.3,.5),('mil',.6,.8),('treinta',.9,1.1),('por',1.2,1.4),('ciento',1.5,1.7),('uno',1.8,2),('coma',2.1,2.3),('cinco',2.4,2.6)]]}
assert restore_alignment(p,aligned,4)==[{'text':'100','start':0,'end':.2},{'text':'videos','start':.3,'end':.5},{'text':'$1.000','start':.6,'end':.8},{'text':'30%','start':.9,'end':1.7},{'text':'1,5','start':1.8,'end':2.6}]
`);
});

test('edge words and consecutive missing timestamps use audio windows instead of gap estimates',async()=>{
 await run(`from alignment_words import prepare_alignment,restore_alignment
p=prepare_alignment({'segments':[{'start':.4,'end':1,'words':[{'word':'100'},{'word':'videos','start':.4,'end':1}]},{'start':2,'end':3,'words':[{'word':'por'},{'word':'día'}]}]},4)
assert p['segments']==[{'start':0,'end':1.5,'text':'cien videos'},{'start':1.5,'end':4,'text':'por día'}],p
aligned={'word_segments':[{'word':'cien','start':.1,'end':.3},{'word':'videos','start':.4,'end':1},{'word':'por','start':2,'end':2.2},{'word':'día','start':2.4,'end':3}]}
assert restore_alignment(p,aligned,4)==[{'text':'100','start':.1,'end':.3},{'text':'videos','start':.4,'end':1},{'text':'por','start':2,'end':2.2},{'text':'día','start':2.4,'end':3}]
`);
});

test('unaligned segment text and flat provider words retain their literal content',async()=>{
 await run(`from alignment_words import prepare_alignment,restore_alignment
for payload in [{'segments':[{'start':0,'end':2,'text':'  Subo 100 videos.  '}]},{'words':[{'text':'Subo'},{'text':'100'},{'text':'videos.'}]}]:
 p=prepare_alignment(payload,2)
 assert p['segments'][0]['text']=='subo cien videos'
 aligned={'word_segments':[{'word':'subo','start':.1,'end':.3},{'word':'cien','start':.4,'end':.8},{'word':'videos','start':.9,'end':1.3}]}
 assert [w['text'] for w in restore_alignment(p,aligned,2)]==['Subo','100','videos.']
`);
});

test('recovery rejects changed words, missing acoustic timing, overlap and out-of-source results',async()=>{
 await run(`from alignment_words import prepare_alignment,restore_alignment
p=prepare_alignment({'words':[{'text':'100'},{'text':'videos'}]},2)
for words in [[{'word':'doscientos','start':.1,'end':.3},{'word':'videos','start':.4,'end':.6}],[{'word':'cien'},{'word':'videos','start':.4,'end':.6}],[{'word':'cien','start':.1,'end':.5},{'word':'videos','start':.4,'end':.6}],[{'word':'cien','start':.1,'end':.3},{'word':'videos','start':.4,'end':2.2}],[{'word':'cien','start':.1,'end':.3}]]:
 try:restore_alignment(p,{'word_segments':words},2)
 except ValueError:pass
 else:raise AssertionError(words)
for payload in [{'segments':[{'start':2,'end':1,'text':'hola'}]},{'words':[{'text':''}]},{'words':[{'text':'😀'}]},{'segments':[]},{'words':[{'text':123}]}]:
 try:prepare_alignment(payload,2)
 except ValueError:pass
 else:raise AssertionError(payload)
`);
});

test('Spanish decimal commas keep leading fractional zeroes and negative signs',async()=>{
 await run(`from alignment_words import prepare_alignment
for text,want in [('1,05','uno coma cero cinco'),('-0,5','menos cero coma cinco'),('1,500','uno coma cinco'),('$1.000,05','mil coma cero cinco')]:
 p=prepare_alignment({'words':[{'text':text}]},2)
 assert p['segments'][0]['text']==want,(text,p)
`);
});


test('provider numeric scalar times become native JSON numbers before restoration',async()=>{
 await run(`import json
from alignment_words import native_alignment,prepare_alignment,restore_alignment
class ProviderFloat(float):pass
p=prepare_alignment({'words':[{'text':'100'},{'text':'videos'}]},2)
aligned=native_alignment({'word_segments':[{'word':'cien','start':ProviderFloat(.1),'end':ProviderFloat(.3)},{'word':'videos','start':ProviderFloat(.4),'end':ProviderFloat(.6)}]})
assert type(aligned['word_segments'][0]['start']) is float
assert restore_alignment(p,aligned,2)==[{'text':'100','start':.1,'end':.3},{'text':'videos','start':.4,'end':.6}]
assert json.loads(json.dumps(aligned))==aligned
for bad in [True,'0.1',float('nan'),float('inf'),None]:
 a=native_alignment({'word_segments':[{'word':'cien','start':bad,'end':.3},{'word':'videos','start':.4,'end':.6}]})
 try:restore_alignment(p,a,2)
 except ValueError:pass
 else:raise AssertionError(bad)
`);
});


test('complete segment text takes precedence over partial global and segment word lists',async()=>{
 await run(`from alignment_words import prepare_alignment
for words in [[],[{'word':'videos'}]]:
 p=prepare_alignment({'word_segments':[{'word':'100','start':.1,'end':.4}], 'segments':[{'start':0,'end':.4,'words':[{'word':'100'}]},{'start':.5,'end':1.5,'text':'videos día','words':words}]},2)
 assert [g['text'] for g in p['groups']]==['100','videos','día'],p
`);
});

test('acoustic evidence rejects zero-score or mostly unsupported alignment while allowing contextual filler',async()=>{
 await run(`from alignment_words import native_alignment,require_acoustic_evidence
for scores in [[0],[.05,.03,.1],[.8,0,0,0]]:
 a=native_alignment({'word_segments':[{'word':'hola','start':i*.2,'end':i*.2+.1,'score':s} for i,s in enumerate(scores)]})
 try:require_acoustic_evidence(a)
 except ValueError:pass
 else:raise AssertionError(scores)
for scores in [[.8],[.8,.9,0,.85,.7]]:
 a=native_alignment({'word_segments':[{'word':'hola','start':i*.2,'end':i*.2+.1,'score':s} for i,s in enumerate(scores)]})
 evidence=require_acoustic_evidence(a)
 assert evidence['wordCount']==len(scores)
 assert evidence['meanScore']>=.35
`);
});
