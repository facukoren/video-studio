// Astra chooses editorial content. This module grants only declarative,
// transcript-anchored capabilities to the trusted renderer.
export const EDIT_PLAN_VERSION = 3;
const number = {type:'number'};
const index = {type:'integer',minimum:0};
const text = maxLength => ({type:'string',maxLength});
const choice = values => ({type:'string',enum:values});
const object = properties => ({type:'object',additionalProperties:false,required:Object.keys(properties),properties});
const array = (items,maxItems,minItems=0) => ({type:'array',items,minItems,maxItems});
const range = {startWord:index,endWord:index};
const overlayProperties = {...range,kind:choice(['headline','keyword','comparison','counter']),text:text(64),secondaryText:text(40),valueFrom:number,valueTo:number,suffix:text(24),position:choice(['upper','center']),evidenceStartWord:index,evidenceEndWord:index};
export const VISUAL_STYLE = 'kavion-clavicular-v1';
const sceneProperties={...range,kind:choice(['distribution','comparison','metric','sequence']),kicker:text(32),title:text(48),accent:text(48),items:array(object({label:text(24),icon:choice(['profile','clip','clock','check','play']),emphasis:choice(['subdued','normal','prominent'])}),7),value:number,unit:text(24),evidenceStartWord:index,evidenceEndWord:index};
export const VISUAL_REVIEW_SCHEMA=object({ok:{type:'boolean'},issues:array({type:'string',minLength:1,maxLength:600},20),summary:{type:'string',minLength:1,maxLength:1200}});
export const REVIEW_SCHEMA = object({cuts:array(object({...range,reason:{type:'string',minLength:12,maxLength:300}}),24)});
export function creativeSchema(maxBrolls=2) {
  return object({
    creativeIntent:{type:'string',minLength:12,maxLength:600},
    visualStyle:choice([VISUAL_STYLE]),
    framing:object({focusX:{type:'number',minimum:.2,maximum:.8},focusY:{type:'number',minimum:.2,maximum:.7}}),
    scenes:array(object(sceneProperties),40),
    soundCues:array(object({word:index,kind:choice(['whoosh','click','impact']),gain:{type:'number',minimum:.05,maximum:.18}}),40),
    captionGroups:array(object({...range,emphasis:array(index,6),position:choice(['lower','center'])}),10000,1),
    zooms:array(object({...range,scale:{type:'number',minimum:1.02,maximum:1.15},position:choice(['center','upper'])}),80),
    overlays:array(object(overlayProperties),40),
    brolls:array(object({start:number,duration:number,prompt:{type:'string',minLength:12,maxLength:1800},quote:{type:'string',minLength:1,maxLength:300}}),maxBrolls,1),
  });
}

function exact(value, keys, label) {
  if(!value || typeof value!=='object' || Array.isArray(value) || Object.keys(value).some(k=>!keys.includes(k)) || keys.some(k=>!Object.hasOwn(value,k))) throw new Error(`${label}: campos no válidos.`);
}
function boundedText(value,min,max,label) {
  if(typeof value!=='string'||value.trim().length<min||value.length>max||/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value))throw new Error(`${label}: texto no válido.`);
}
function boundedArray(value,min,max,label) {
  if(!Array.isArray(value)||value.length<min||value.length>max)throw new Error(`${label}: cantidad fuera del límite.`);
}
function wordRange(value,words,label) {
  if(!Number.isInteger(value.startWord)||!Number.isInteger(value.endWord)||value.startWord<0||value.endWord<value.startWord||value.endWord>=words.length)throw new Error(`${label}: referencia de palabra no válida.`);
}
function validateWords(words,duration=Infinity) {
  boundedArray(words,1,10000,'Transcripción');
  let end=0;
  for(const word of words){
    boundedText(word?.text,1,2000,'Palabra');
    if(!Number.isFinite(word.start)||!Number.isFinite(word.end)||word.start<end-1e-8||word.end<=word.start||word.end>duration+1e-8)throw new Error('Tiempos de palabras no válidos.');
    end=word.end;
  }
}
export function validateReview(review,words) {
  validateWords(words);
  exact(review,['cuts'],'Revisión');boundedArray(review.cuts,0,24,'Cortes');
  let previousEnd=-1;
  const removed=new Set();
  const cuts=review.cuts.map(cut=>{
    exact(cut,['startWord','endWord','reason'],'Corte');wordRange(cut,words,'Corte');boundedText(cut.reason,12,300,'Motivo');
    if(cut.startWord<=previousEnd)throw new Error('Los cortes se superponen o están desordenados.');
    previousEnd=cut.endWord;
    for(let i=cut.startWord;i<=cut.endWord;i++)removed.add(i);
    return {...cut};
  });
  if(removed.size>=words.length||removed.size>Math.floor(words.length*.35))throw new Error('La revisión elimina demasiado contenido; requiere atención.');
  return {words:words.filter((_,i)=>!removed.has(i)),cuts};
}

export const normalizeAnchor = s=>s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu,'').replace(/[^\p{L}\p{N}\s]/gu,'').replace(/\s+/g,' ').trim();
export function validateBrollPlan(plan,words,duration,maxBrolls=2) {
  if(!plan||!Array.isArray(plan.brolls)||!plan.brolls.length||plan.brolls.length>maxBrolls)throw new Error('El plan debe incluir B-roll dentro del límite configurado.');
  const script=normalizeAnchor(words.map(w=>w.text).join(' '));
  const brolls=plan.brolls.map(c=>{
    if(!Number.isFinite(c.start)||!Number.isFinite(c.duration)||c.start<0||c.duration<=0||c.duration>3||c.start+c.duration>duration+1e-8)throw new Error('B-roll fuera de los tiempos del video.');
    boundedText(c.prompt,12,1800,'Prompt de B-roll');boundedText(c.quote,1,300,'Cita de B-roll');
    if(!normalizeAnchor(c.quote)||!script.includes(normalizeAnchor(c.quote)))throw new Error('El B-roll no tiene una cita válida del guion.');
    const nearby=normalizeAnchor(words.filter(w=>w.end>=c.start-2&&w.start<=c.start+c.duration+2).map(w=>w.text).join(' '));
    if(!nearby.includes(normalizeAnchor(c.quote)))throw new Error('La cita del guion no coincide con el momento elegido.');
    return {start:c.start,duration:c.duration,prompt:c.prompt,quote:c.quote};
  }).sort((a,b)=>a.start-b.start);
  for(let i=1;i<brolls.length;i++)if(brolls[i].start<brolls[i-1].start+brolls[i-1].duration)throw new Error('Hay B-rolls superpuestos.');
  return {brolls};
}
function noOverlap(items,words,label) {
  let end=-1;
  for(const item of [...items].sort((a,b)=>a.startWord-b.startWord)){
    if(words[item.startWord].start<end-1e-8)throw new Error(`${label}: elementos superpuestos.`);
    end=words[item.endWord].end;
  }
}
const namedNumbers={cero:0,un:1,una:1,uno:1,dos:2,tres:3,cuatro:4,cinco:5,seis:6,siete:7,ocho:8,nueve:9,diez:10,once:11,doce:12,trece:13,catorce:14,quince:15,veinte:20,treinta:30,sesenta:60,cien:100,mil:1000};
function evidenceNumbers(value,{articles=true}={}){
  const numbers=[...value.matchAll(/\d+(?:[.,]\d+)?/g)].map(m=>Number(m[0].replace(',','.')));
  for(const token of normalizeAnchor(value).split(' '))if(Object.hasOwn(namedNumbers,token)&&(articles||!['un','una'].includes(token)))numbers.push(namedNumbers[token]);
  return numbers;
}
export function validateCreativePlan(plan,words,duration,maxBrolls=2) {
  if(!Number.isFinite(duration)||duration<=0)throw new Error('Duración de composición no válida.');
  validateWords(words,duration);
  const reference=Object.hasOwn(plan||{},'visualStyle');
  exact(plan,['creativeIntent','captionGroups','zooms','overlays','brolls',...(reference?['visualStyle','framing','scenes','soundCues']:[])],'Plan creativo');
  if(reference&&plan.visualStyle!==VISUAL_STYLE)throw new Error('Estilo visual no válido.');
  boundedText(plan.creativeIntent,12,600,'Intención editorial');
  boundedArray(plan.captionGroups,1,words.length,'Subtítulos');
  let next=0;
  const captionGroups=plan.captionGroups.map(group=>{
    exact(group,['startWord','endWord','emphasis','position'],'Subtítulo');wordRange(group,words,'Subtítulo');
    if(group.startWord!==next||group.endWord-group.startWord>=(reference?5:6))throw new Error('Los subtítulos deben cubrir todas las palabras, una vez y en orden, en grupos de hasta seis.');
    const captionText=words.slice(group.startWord,group.endWord+1).map(w=>w.text).join(' ');
    if(captionText.length>90&&group.startWord!==group.endWord)throw new Error('El grupo de subtítulos es demasiado largo.');
    boundedArray(group.emphasis,0,6,'Énfasis');
    if(new Set(group.emphasis).size!==group.emphasis.length||group.emphasis.some(i=>!Number.isInteger(i)||i<group.startWord||i>group.endWord)||!['lower','center'].includes(group.position))throw new Error('Énfasis o posición de subtítulo no válidos.');
    next=group.endWord+1;return {...group,emphasis:[...group.emphasis]};
  });
  if(next!==words.length)throw new Error('Faltan palabras en la cobertura de subtítulos.');
  boundedArray(plan.zooms,0,80,'Zooms');
  const zooms=plan.zooms.map(zoom=>{
    exact(zoom,['startWord','endWord','scale','position'],'Zoom');wordRange(zoom,words,'Zoom');
    if(!Number.isFinite(zoom.scale)||zoom.scale<(reference?1.02:1)||zoom.scale>(reference?1.15:1.2)||!['center','upper'].includes(zoom.position))throw new Error('Escala o posición de zoom no válidas.');
    return {...zoom};
  });noOverlap(zooms,words,'Zooms');
  boundedArray(plan.overlays,0,40,'Gráficos');
  const overlays=plan.overlays.map(overlay=>{
    exact(overlay,Object.keys(overlayProperties),'Gráfico');wordRange(overlay,words,'Gráfico');
    wordRange({startWord:overlay.evidenceStartWord,endWord:overlay.evidenceEndWord},words,'Evidencia');
    if(!['headline','keyword','comparison','counter'].includes(overlay.kind)||!['upper','center'].includes(overlay.position))throw new Error('Tipo o posición de gráfico no válidos.');
    boundedText(overlay.text,1,64,'Titular');boundedText(overlay.secondaryText,0,40,'Comparación');boundedText(overlay.suffix,0,24,'Unidad');
    if(words[overlay.endWord].end-words[overlay.startWord].start>12||words[overlay.evidenceStartWord].start>words[overlay.endWord].end+2||words[overlay.evidenceEndWord].end<words[overlay.startWord].start-2)throw new Error('El gráfico no coincide con su evidencia temporal.');
    if(![overlay.valueFrom,overlay.valueTo].every(n=>Number.isFinite(n)&&Math.abs(n)<=1e9))throw new Error('Valor de contador no válido.');
    if(overlay.kind==='comparison'&&!overlay.secondaryText.trim())throw new Error('Falta la segunda parte de la comparación.');
    if(overlay.kind!=='comparison'&&overlay.secondaryText!=='')throw new Error('Solo una comparación admite texto secundario.');
    if(overlay.kind!=='counter'&&(overlay.valueFrom!==0||overlay.valueTo!==0||overlay.suffix!==''))throw new Error('Solo un contador admite valores y unidades.');
    const evidence=words.slice(overlay.evidenceStartWord,overlay.evidenceEndWord+1).map(w=>w.text).join(' ');
    const supported=evidenceNumbers(evidence);
    const claims=evidenceNumbers(`${overlay.text} ${overlay.secondaryText} ${overlay.suffix}`,{articles:false});
    if(overlay.kind==='counter'){claims.push(overlay.valueTo);if(overlay.valueFrom!==0)claims.push(overlay.valueFrom);}
    if(claims.some(n=>!supported.includes(n)))throw new Error('El gráfico contiene cifras sin evidencia en el guion.');
    return {...overlay};
  });noOverlap(overlays,words,'Gráficos');
  for(const overlay of overlays)if(overlay.position==='center'&&captionGroups.some(group=>group.position==='center'&&words[group.startWord].start<words[overlay.endWord].end&&words[group.endWord].end>words[overlay.startWord].start))throw new Error('Un gráfico centrado se superpone con la posición del subtítulo.');
  for(const broll of plan.brolls||[])exact(broll,['start','duration','prompt','quote'],'B-roll');
  const brollPlan=validateBrollPlan(plan,words,duration,maxBrolls);
  const visual=reference?validateReferenceFields(plan,words,brollPlan.brolls,overlays):{};
  return {creativeIntent:plan.creativeIntent,captionGroups,zooms,overlays,...brollPlan,...visual};
}

function validateReferenceFields(plan,words,brolls,overlays){
  exact(plan.framing,['focusX','focusY'],'Encuadre');
  const {focusX,focusY}=plan.framing;
  if(!Number.isFinite(focusX)||!Number.isFinite(focusY)||focusX<.2||focusX>.8||focusY<.2||focusY>.7)throw new Error('Encuadre fuera de los límites visuales.');
  boundedArray(plan.scenes,0,40,'Escenas');
  const scenes=plan.scenes.map(scene=>{
    exact(scene,Object.keys(sceneProperties),'Escena');wordRange(scene,words,'Escena');
    wordRange({startWord:scene.evidenceStartWord,endWord:scene.evidenceEndWord},words,'Evidencia de escena');
    if(!['distribution','comparison','metric','sequence'].includes(scene.kind))throw new Error('Tipo de escena no válido.');
    boundedText(scene.kicker,0,32,'Etiqueta');boundedText(scene.title,1,48,'Título');boundedText(scene.accent,0,48,'Énfasis');boundedText(scene.unit,0,24,'Unidad');
    const start=words[scene.startWord].start,end=words[scene.endWord].end;
    if(end-start<1-1e-8||end-start>12||words[scene.evidenceStartWord].start>end+2||words[scene.evidenceEndWord].end<start-2)throw new Error('La escena no coincide con su duración o evidencia temporal.');
    boundedArray(scene.items,scene.kind==='metric'?0:2,7,'Ítems de escena');
    const items=scene.items.map(item=>{
      // Historical v3 items omit emphasis; the renderer treats them as normal.
      // Preserve their serialized identity while accepting explicit new choices.
      const hasEmphasis=Object.hasOwn(item||{},'emphasis');
      exact(item,['label','icon',...(hasEmphasis?['emphasis']:[])],'Ítem');
      boundedText(item.label,1,24,'Etiqueta de ítem');
      if(!['profile','clip','clock','check','play'].includes(item.icon))throw new Error('Icono de escena no válido.');
      if(hasEmphasis&&!['subdued','normal','prominent'].includes(item.emphasis))throw new Error('Énfasis de ítem no válido.');
      return {...item};
    });
    if(!Number.isFinite(scene.value)||Math.abs(scene.value)>1e9||scene.kind!=='metric'&&(scene.value!==0||scene.unit!==''))throw new Error('Valor de escena no válido.');
    const evidence=words.slice(scene.evidenceStartWord,scene.evidenceEndWord+1).map(w=>w.text).join(' ');
    const claims=evidenceNumbers([scene.kicker,scene.title,scene.accent,scene.unit,...items.map(item=>item.label)].join(' '),{articles:false});
    if(scene.kind==='metric')claims.push(scene.value);
    if(claims.some(value=>!evidenceNumbers(evidence).includes(value)))throw new Error('La escena contiene cifras sin evidencia en el guion.');
    if(brolls.some(clip=>clip.start<end&&clip.start+clip.duration>start)||overlays.some(item=>words[item.startWord].start<end&&words[item.endWord].end>start))throw new Error('La escena se superpone con B-roll o gráficos.');
    return {...scene,items};
  });
  noOverlap(scenes,words,'Escenas');
  boundedArray(plan.soundCues,0,40,'Sonidos');
  const starts=new Set();
  const soundCues=plan.soundCues.map(cue=>{
    exact(cue,['word','kind','gain'],'Sonido');wordRange({startWord:cue.word,endWord:cue.word},words,'Sonido');
    if(!['whoosh','click','impact'].includes(cue.kind)||!Number.isFinite(cue.gain)||cue.gain<.05||cue.gain>.18)throw new Error('Sonido o ganancia fuera del límite.');
    const start=words[cue.word].start;if(starts.has(start))throw new Error('Los sonidos se superponen en el mismo instante.');starts.add(start);
    return {...cue};
  });
  return {visualStyle:VISUAL_STYLE,framing:{focusX,focusY},scenes,soundCues};
}
export function validateVisualReview(value){
  exact(value,['ok','issues','summary'],'Revisión visual');
  if(typeof value.ok!=='boolean')throw new Error('Revisión visual sin resultado válido.');
  boundedArray(value.issues,0,20,'Problemas de revisión visual');
  for(const issue of value.issues)boundedText(issue,1,600,'Problema de revisión visual');
  boundedText(value.summary,1,1200,'Resumen visual');
  if(value.ok!==!value.issues.length)throw new Error('La revisión visual es contradictoria.');
  return {ok:value.ok,issues:[...value.issues],summary:value.summary};
}
