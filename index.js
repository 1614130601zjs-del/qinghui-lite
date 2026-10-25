import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '/script.js';
import { parseImageMarkers, makeTriggerId, TriggerRegistry } from './trigger-core.js';

const EXT = 'qinghui_lite';
const defaults = { vibes:[], activeVibeIndex:-1, activePresetIndex:-1, bindings:[], provider:'openai', endpoint:'https://api.openai.com/v1', apiKey:'', model:'gpt-image-1', size:'1024x1024', quality:'medium', naiModel:'nai-diffusion-4-5-full', naiSteps:28, naiScale:5, naiWidth:832, naiHeight:1216, naiSampler:'k_euler_ancestral', naiScheduler:'karras', naiNormalizeVibeStrengths:true, prompt:'', negative:'', records:[], presets:[], characters:[], prompts:[] };
const $ = (s, root=document) => root.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let busy=false;
function cfg(){
 extension_settings[EXT] ??= JSON.parse(JSON.stringify(defaults));
 const s=extension_settings[EXT];
 if(typeof s.naiNormalizeVibeStrengths!=='boolean')s.naiNormalizeVibeStrengths=true;
 for(const key of ['records','presets','characters','prompts','vibes','bindings'])if(!Array.isArray(s[key]))s[key]=[];
 let migrated=false;
 for(const vibe of s.vibes){
  if(!vibe||vibe._vibeMigrationVersion===1)continue;
  if(Array.isArray(vibe.entries)){
   for(const entry of vibe.entries){
    if(!entry||typeof entry.image==='string'&&entry.image.length>160||!entry.raw)continue;
    const extracted=extractUsableVibe(entry.raw);
    if(!extracted)continue;
    entry.image=extracted.image;
    if(entry.strength==null)entry.strength=extracted.strength;
    if(entry.informationExtracted==null)entry.informationExtracted=extracted.informationExtracted;
    migrated=true;
   }
   vibe.hasPayload=vibe.entries.some(entry=>typeof entry?.image==='string'&&entry.image.length>160);
  }
  vibe._vibeMigrationVersion=1;
 }
 if(migrated)saveSettingsDebounced();
 return s;
}
const triggerRegistry = new TriggerRegistry();
const autoTasks = new Set(); // 临时兼容旧入口状态；任务准入与状态以 triggerRegistry 为准。
function markers(text){return parseImageMarkers(text).map(({index,prompt,marker})=>({index,prompt,raw:marker}));}
function hideMarkersInTextNode(root){if(!root)return;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())if(walker.currentNode.nodeValue?.includes('image###'))nodes.push(walker.currentNode);for(const node of nodes){node.nodeValue=node.nodeValue.replace(/image###[\s\S]*?###/g,'');}}
async function requestImage(prompt, negativeOverride, vibeItem=null){
 const c=cfg();
 let raw='',data=null,res;
 if(c.provider==='novelai'){
  const naiModel=c.naiModel||'nai-diffusion-4-5-full';
  const payload={prompt,model:naiModel,sampler:c.naiSampler||'k_euler_ancestral',noise_schedule:c.naiScheduler||'karras',steps:Number(c.naiSteps)||28,scale:Number(c.naiScale)||5,width:Number(c.naiWidth)||832,height:Number(c.naiHeight)||1216,negative_prompt:negativeOverride??c.negative??'',decrisper:false,variety_boost:false,sm:false,sm_dyn:false,seed:-1};
  if(vibeItem){
   if(!/^nai-diffusion-4(?:-|$)/i.test(naiModel))throw new Error('当前所选 NovelAI 模型不支持导入的 V4 Vibe 编码。请切换到 NovelAI Diffusion V4 / V4.5 模型；编码不能当作普通参考图片跨模型使用。');
   const vibes=Array.isArray(vibeItem.entries)
    ?vibeItem.entries.map(item=>{const extracted=extractUsableVibe(item.raw||item);const image=typeof item.image==='string'&&item.image.trim()?String(item.image).trim().replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,''):extracted?.image||'';return image?{image,strength:Number(item.strength??extracted?.strength??0.6),informationExtracted:Number(item.informationExtracted??extracted?.informationExtracted??1)}:null;}).filter(Boolean)
    :(()=>{const one=extractUsableVibe(vibeItem.raw||vibeItem);return one?[one]:[];})();
   if(!vibes.length)throw new Error('这个 Vibe 组没有可用的预编码资源。请重新导入官网 .naiv4vibe / bundle，或检查智绘姬导出 JSON 是否包含 vibeData 编码；普通预览图不能替代编码。');
   if(vibes.length>16)throw new Error('NovelAI 单次最多使用 16 条 Vibe 参考，请先删除多余条目。');
   if(vibes.some(v=>!Number.isFinite(v.strength)||v.strength<0||v.strength>1||!Number.isFinite(v.informationExtracted)||v.informationExtracted<0||v.informationExtracted>1))throw new Error('Vibe 强度与 Information Extracted 必须在 0 到 1 之间。');
   payload.reference_image_multiple=vibes.map(v=>v.image);
   payload.reference_strength_multiple=vibes.map(v=>v.strength);
   payload.reference_information_extracted_multiple=vibes.map(v=>v.informationExtracted);
   if(/^nai-diffusion-4(?:-|$)/i.test(naiModel))payload.normalize_reference_strength_multiple=c.naiNormalizeVibeStrengths!==false;
  }
  if(naiModel.includes('nai-diffusion-5'))payload.use_new_shared_trial=true;
  res=await fetch('/api/novelai/generate-image',{method:'POST',headers:getRequestHeaders(window.token),body:JSON.stringify(payload)});
  raw=await res.text();
  if(!res.ok)throw new Error('NovelAI 请求失败（HTTP '+res.status+'）：'+raw.slice(0,240));
  try{data=JSON.parse(raw);}catch{}
  let value=data?.images?.[0]??data?.image??raw.trim();
  if(typeof value!=='string'||!value)throw new Error('NovelAI 响应中没有可识别的图片');
  return /^(data:|https?:)/.test(value)?value:'data:image/png;base64,'+value.replace(/^data:image\/[^;]+;base64,/,'');
 }
 if(!c.endpoint||!c.apiKey)throw new Error('请先在轻绘设置中填写 OpenAI 兼容 API 地址和 Key');
 const model=String(c.model||'').toLowerCase();
 const negative=String(negativeOverride??c.negative??'').trim();
 const body={model:c.model,prompt,n:1,size:c.size};
 if(model.includes('gpt-image')){
  body.quality=c.quality;
  if(negative)body.prompt=prompt+'\n\nAvoid these visual elements: '+negative;
 }else if(negative){
  body.negative_prompt=negative;
 }
 res=await fetch(c.endpoint.replace(/\/$/, '')+'/images/generations',{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+c.apiKey},body:JSON.stringify(body)});
 raw=await res.text();
 try{data=JSON.parse(raw);}catch{throw new Error('接口返回非 JSON（HTTP '+res.status+'）');}
 if(!res.ok)throw new Error(data?.error?.message||'HTTP '+res.status);
 const item=data?.data?.[0];let url=item?.b64_json?'data:image/png;base64,'+item.b64_json:item?.url;
 const candidates=[data?.images?.[0],data?.output?.[0]];
 for(const v of candidates){
  if(url||v==null)continue;
  if(typeof v==='string')url=/^(data:|https?:)/.test(v)?v:'data:image/png;base64,'+v;
  else if(typeof v==='object')url=v.url||(v.b64_json?'data:image/png;base64,'+v.b64_json:null)||(v.image?'data:image/png;base64,'+v.image:null);
 }
 if(typeof url!=='string'||!url)throw new Error('响应中没有可识别的图片');
 return url;
}

/**
 * 统一所有入口的有效提示词：手动生图、聊天标记、状态栏和重绘都应使用同一组已启用预设。
 * 手动生图会自行组装参数；其他入口走此包装函数，避免自动触发漏掉画师串/Vibe。
 */
function resolveActiveGeneration(prompt, negativeOverride){
 const s=cfg();
 const presetIndex=Number(s.activePresetIndex??-1);
 const preset=presetIndex>=0?s.presets[presetIndex]:null;
 const vibeIndex=Number(s.activeVibeIndex??-1);
 const vibe=vibeIndex>=0?s.vibes[vibeIndex]:null;
 const finalPrompt=[String(prompt??'').trim(),preset?.positive].filter(Boolean).join(', ');
 const baseNegative=String(negativeOverride??s.negative??'').trim();
 const finalNegative=negativeOverride==null
  ?[baseNegative,preset?.negative].filter(Boolean).join(', ')
  :baseNegative;
 return {prompt:finalPrompt,negative:finalNegative,vibe};
}
async function requestWithActiveSettings(prompt, negativeOverride){
 const resolved=resolveActiveGeneration(prompt,negativeOverride);
 return requestImage(resolved.prompt,resolved.negative,resolved.vibe);
}

function extractUsableVibe(raw){
 const encodedKeys=/^(?:referenceImage|reference_image|referenceImageData|reference_image_data|base64|imageBase64|image_base64|encoded|encodedVibe|encoded_vibe|vibeEncoding|vibe_encoding|vibeData|vibe_data|payload)$/i;
 const seen=new WeakSet();let found='';
 const clean=value=>String(value||'').trim().replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/');
 const walk=(value,key='',canonical=false)=>{
  if(found||value==null)return;
  if(typeof value==='string'){
   const v=clean(value);
   if((canonical||encodedKeys.test(key))&&/^[A-Za-z0-9+/]+={0,2}$/.test(v)&&v.length>160){found=v;return;}
   return;
  }
  if(typeof value!=='object'||seen.has(value))return;
  seen.add(value);
  if(Array.isArray(value)){for(const item of value)walk(item,key,canonical);return;}
  const isCanonical=value.identifier==='novelai-vibe-transfer'&&value.type==='image';
  if(isCanonical&&typeof value.image==='string')walk(value.image,'image',true);
  for(const [k,v] of Object.entries(value)){
   if(isCanonical&&k==='image')continue;
   walk(v,k,false);
  }
 };
 walk(raw);
 if(!found)return null;
 const serialized=safeMigrationStringify(raw)||'';
 const readNumber=(re,fallback)=>{const m=serialized.match(re);return m?Number(m[1]):fallback;};
 const strength=readNumber(/"(?:reference_strength|referenceStrength|strength)"\s*:\s*([0-9.]+)/i,0.6);
 const informationExtracted=readNumber(/"(?:reference_information_extracted|referenceInformationExtracted|information_extracted|informationExtracted|info_extracted)"\s*:\s*([0-9.]+)/i,1);
 const norm=serialized.match(/"normalize_reference_strength"\s*:\s*(true|false)/i);
 return {image:found,strength,informationExtracted,normalize:norm?norm[1]==='true':undefined};
}
function renderActivePresets(){const select=$('#ql-active-preset');if(!select)return;const s=cfg(),prior=String(s.activePresetIndex??-1);select.innerHTML='<option value="-1">不使用画师串预设</option>'+s.presets.map((p,i)=>'<option value="'+i+'">'+esc(p.name||('画师串 '+(i+1)))+'</option>').join('');select.value=s.presets[Number(prior)]?prior:'-1';select.onchange=()=>{s.activePresetIndex=Number(select.value);save();};}
function currentCharacter(){const ctx=getContext()||{},id=ctx.characterId,ch=Number.isInteger(id)&&id>=0?ctx.characters?.[id]:null;return {id:id==null?'':String(id),name:ch?.name||ch?.avatar||''};}
function renderBindings(){const s=cfg(),select=$('#ql-bind-character'),preset=$('#ql-bind-preset'),vibe=$('#ql-bind-vibe'),list=$('#ql-bindings-list');if(!select||!preset||!vibe)return;const ctx=getContext()||{},chars=Array.isArray(ctx.characters)?ctx.characters:[],current=currentCharacter();const options=chars.map((ch,i)=>({id:String(i),name:ch?.name||ch?.avatar||('角色 '+(i+1))}));if(current.id&&!options.some(x=>x.id===current.id))options.unshift({id:current.id,name:current.name||('当前角色 '+current.id)});const oldValue=select.value;select.innerHTML='<option value="">选择角色卡</option>'+options.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');if(options.some(x=>x.id===oldValue))select.value=oldValue;else if(options.some(x=>x.id===current.id))select.value=current.id;preset.innerHTML='<option value="-1">不绑定画师串</option>'+s.presets.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('画师串 '+(i+1)))+'</option>').join('');vibe.innerHTML='<option value="-1">不绑定 Vibe</option>'+s.vibes.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('Vibe '+(i+1)))+'</option>').join('');const selectedName=options.find(o=>o.id===select.value)?.name;const binding=s.bindings.find(x=>x.characterName===selectedName)||s.bindings.find(x=>x.characterKey===select.value);if(binding){preset.value=String(binding.presetIndex??-1);vibe.value=String(binding.vibeIndex??-1);}if(list)list.innerHTML=s.bindings.map((b,i)=>'<div class="ql-record"><strong>'+esc(b.characterName||('角色 '+b.characterKey))+'</strong><p>画师串：'+esc(s.presets[b.presetIndex]?.name||'未绑定')+' · Vibe：'+esc(s.vibes[b.vibeIndex]?.name||'未绑定')+'</p><button class="menu_button" data-binding-delete="'+i+'">删除绑定</button></div>').join('')||'<p class="ql-muted">暂无角色绑定</p>';list?.querySelectorAll('[data-binding-delete]').forEach(btn=>btn.onclick=()=>{s.bindings.splice(+btn.dataset.bindingDelete,1);save();renderBindings();});}
function applyCurrentBinding(){const current=currentCharacter();if(!current.id)return;const s=cfg(),ch=(getContext()?.characters||[])[Number(current.id)],name=current.name||ch?.name||ch?.avatar||'';const binding=s.bindings.find(x=>x.characterName===name)||s.bindings.find(x=>x.characterKey===current.id);if(!binding)return;s.activePresetIndex=Number.isInteger(binding.presetIndex)?binding.presetIndex:-1;s.activeVibeIndex=Number.isInteger(binding.vibeIndex)?binding.vibeIndex:-1;renderActivePresets();renderActiveVibes();status('已自动应用角色绑定：'+(name||current.id));}
function renderTagChips(){const host=$('#ql-tag-chips'),prompt=$('#ql-prompt');if(!host||!prompt)return;const tags=prompt.value.split(',').map(x=>x.trim()).filter(Boolean);host.innerHTML=tags.map((tag,i)=>'<button type="button" class="ql-tag-chip" data-tag-index="'+i+'">'+esc(tag)+' ×</button>').join('');host.querySelectorAll('[data-tag-index]').forEach(btn=>btn.onclick=()=>{const next=prompt.value.split(',').map(x=>x.trim()).filter(Boolean);next.splice(Number(btn.dataset.tagIndex),1);prompt.value=next.join(', ');read();renderTagChips();});}
let pendingVibeImage=null;
function renderActiveVibes(){
 const select=$('#ql-active-vibe');if(!select)return;
 const prior=String(cfg().activeVibeIndex??-1);
 select.innerHTML='<option value="-1">不使用 Vibe</option>'+cfg().vibes.map((v,i)=>'<option value="'+i+'">'+esc(v.name||('Vibe '+(i+1)))+(v.hasPayload?' · 已识别编码':' · 尚无可用编码')+'</option>').join('');
 select.value=cfg().vibes[Number(prior)]?prior:'-1';
 select.onchange=()=>{cfg().activeVibeIndex=Number(select.value);save();};
}
function saveCleanImage(src,filename){
 if(!src)return;
 const a=document.createElement('a');a.href=src;a.download=filename||'qinghui-image.png';a.rel='noopener';a.style.display='none';document.body.append(a);a.click();a.remove();
}
function addMessageImage(host,url,prompt,taskKey,recordMeta={}) {
 if(!host)return;
 let card=[...host.querySelectorAll('.ql-chat-image')].find(el=>el.dataset.qlTask===taskKey);
 if(!card){
  card=document.createElement('figure');card.className='ql-chat-image';card.dataset.qlTask=taskKey;
  const img=document.createElement('img');img.loading='lazy';img.alt='轻绘生成图片';
  const caption=document.createElement('figcaption');caption.className='ql-chat-image-prompt';caption.textContent=prompt;
  const controls=document.createElement('div');controls.className='ql-chat-image-controls';
  const prev=document.createElement('button');prev.type='button';prev.className='menu_button';prev.textContent='‹ 上一张';
  const count=document.createElement('span');count.className='ql-chat-image-count';count.textContent='1 / 1';
  const next=document.createElement('button');next.type='button';next.className='menu_button';next.textContent='下一张 ›';
  const reroll=document.createElement('button');reroll.type='button';reroll.className='menu_button';reroll.textContent='再画一张';
  controls.append(prev,count,next,reroll);card.append(img,caption,controls);host.append(card);
  card._qlCandidates=[];card._qlIndex=0;
  const render=()=>{const list=card._qlCandidates;const i=card._qlIndex;img.src=list[i].url;count.textContent=(i+1)+' / '+list.length;prev.disabled=i<=0;next.disabled=i>=list.length-1;};
  const step=delta=>{const nextIndex=card._qlIndex+delta;if(nextIndex>=0&&nextIndex<card._qlCandidates.length){card._qlIndex=nextIndex;render();}};
  prev.addEventListener('click',()=>step(-1));
  next.addEventListener('click',()=>step(1));
  let touchX=0,touchY=0;
  img.addEventListener('touchstart',e=>{const t=e.changedTouches[0];touchX=t.clientX;touchY=t.clientY;},{passive:true});
  img.addEventListener('touchend',e=>{const t=e.changedTouches[0],dx=t.clientX-touchX,dy=t.clientY-touchY;if(Math.abs(dx)>42&&Math.abs(dx)>Math.abs(dy)*1.25)step(dx<0?1:-1);},{passive:true});
  img.addEventListener('contextmenu',e=>{e.preventDefault();saveCleanImage(img.src,'qinghui-'+Date.now()+'.png');});
  reroll.addEventListener('click',async()=>{if(card.dataset.qlBusy==='1')return;const candidate=triggerRegistry.beginCandidate(taskKey,{prompt,source:'chat-reroll',...recordMeta});if(!candidate.accepted)return;triggerRegistry.markRunning(taskKey);card.dataset.qlBusy='1';reroll.disabled=true;const old=reroll.textContent;reroll.textContent='生成中…';try{const fresh=await requestWithActiveSettings(prompt);card._qlCandidates.push({url:fresh,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;render();storeChatRecord(fresh,prompt,taskKey,recordMeta);triggerRegistry.markSucceeded(taskKey,taskKey+':candidate:'+Date.now());}catch(e){triggerRegistry.markFailed(taskKey,e?.message||String(e));const note=document.createElement('p');note.className='ql-chat-image-status';note.textContent='轻绘生成失败：'+(e?.message||String(e));card.append(note);}finally{card.dataset.qlBusy='0';reroll.disabled=false;reroll.textContent=old;}});
  card._qlRender=render;
 }
 if(!card._qlCandidates.some(item=>item.url===url)){card._qlCandidates.push({url,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;}
 card._qlRender?.();
}
function snapshotConfig(prompt, negativeOverride){
 const c=cfg();
 return {
  provider:c.provider, endpoint:c.provider==='openai'?c.endpoint:'', model:c.provider==='novelai'?c.naiModel:c.model,
  size:c.provider==='novelai'?(c.naiWidth+'x'+c.naiHeight):c.size,
  quality:c.provider==='openai'?c.quality:null,
  negative:negativeOverride??c.negative??'',
  nai:c.provider==='novelai'?{steps:c.naiSteps,scale:c.naiScale,width:c.naiWidth,height:c.naiHeight,sampler:c.naiSampler,scheduler:c.naiScheduler}:null
 };
}
function storeChatRecord(url,prompt,taskKey,meta={}){
 const c=cfg();
 c.records.unshift({
  id:taskKey+':'+Date.now(),at:Date.now(),prompt,negative:c.negative||'',
  provider:c.provider,model:c.provider==='novelai'?c.naiModel:c.model,
  size:c.provider==='novelai'?(c.naiWidth+'x'+c.naiHeight):c.size,
  quality:c.provider==='openai'?c.quality:null,dataUrl:url,
  config:snapshotConfig(prompt),source:meta.source||'chat',
  messageIndex:meta.messageIndex,taskKey,character:meta.character||null,chatId:getContext()?.chatId||null
 });
 c.records=c.records.slice(0,10);save();history();
}
async function processLatestAssistantMessage(){
 const context=getContext();const chat=context?.chat;if(!Array.isArray(chat)||!chat.length)return;
 let messageIndex=-1;for(let i=chat.length-1;i>=0;i--){if(!chat[i]?.is_user&&!chat[i]?.is_system&&typeof chat[i]?.mes==='string'){messageIndex=i;break;}}
 if(messageIndex<0)return;
 const message=chat[messageIndex];const found=markers(message.mes);if(!found.length)return;
 const host=document.querySelector('.mes[mesid="'+messageIndex+'"] .mes_text');if(host)hideMarkersInTextNode(host);
 for(let markerOrdinal=0;markerOrdinal<found.length;markerOrdinal++){
  const marker=found[markerOrdinal];
  // 不把 marker.index 放进任务 ID：流式输出时，前文增长会改变标记的字符偏移，
  // 进而让同一张图被重复请求。按消息、swipe 和标记出现顺序去重。
  let taskKey;
  try {
   taskKey=makeTriggerId({
    chatId:context.chatId||'chat',
    messageId:String(messageIndex)+':'+String(message.swipe_id??0),
    markerIndex:markerOrdinal
   });
  } catch (error) {
   console.warn('[轻绘 Lite] 无法为消息创建稳定任务 ID',error);
   continue;
  }
  if(!host)continue;
  // 任务注册表统一负责自动触发去重与状态迁移；同一流式消息重复扫描不会重复请求。
  const accepted=triggerRegistry.begin(taskKey,{prompt:marker.prompt,source:'chat',messageIndex,markerOrdinal});
  if(!accepted.accepted)continue;
  autoTasks.add(taskKey);
  triggerRegistry.markRunning(taskKey);
  const pending=document.createElement('p');pending.className='ql-chat-image-status';pending.textContent='轻绘：正在生成图片…';host.append(pending);
  try{
   const url=await requestWithActiveSettings(marker.prompt);
   pending.remove();
   addMessageImage(host,url,marker.prompt,taskKey,{messageIndex});
   storeChatRecord(url,marker.prompt,taskKey,{messageIndex});
   triggerRegistry.markSucceeded(taskKey,taskKey+':candidate:'+Date.now());
  }
  catch(error){
   triggerRegistry.markFailed(taskKey,error?.message||String(error));
   pending.replaceChildren();
   const message=document.createElement('span');
   message.textContent='轻绘生成失败：'+(error?.message||String(error))+' ';
   const retry=document.createElement('button');
   retry.type='button';retry.className='menu_button';retry.textContent='点击重试';
   retry.addEventListener('click',()=>{
    pending.remove();
    // failed 状态允许再次 begin；成功任务仍由 registry 拒绝重复执行。
    processLatestAssistantMessage().catch(e=>console.warn('[轻绘 Lite] 手动重试失败',e));
   },{once:true});
   pending.append(message,retry);
  }
 }
}

let statusbarObserver=null;
const statusbarObservedDocs=new WeakSet();
function parseStatusbarMarker(text){const match=String(text||'').match(/image###([\s\S]*?)###/);return match?.[1]?.trim()||'';}
function statusbarPromptForTarget(target){
 const direct=[
  target?.textContent,
  target?.getAttribute?.('data-tag'),
  ...Array.from(target?.querySelectorAll?.('[data-tag]')||[],el=>el.getAttribute('data-tag'))
 ];
 for(const value of direct){const prompt=parseStatusbarMarker(value);if(prompt)return prompt;}
 let ancestor=target?.parentElement;
 while(ancestor&&!ancestor.matches?.('.mes')){
  const prompt=parseStatusbarMarker(ancestor.getAttribute?.('data-tag'));
  if(prompt)return prompt;
  ancestor=ancestor.parentElement;
 }
 return '';
}
function statusbarTaskKey(target,prompt,doc){
 const message=target.closest('.mes[mesid]')||target.closest('.mes');
 const messageId=message?.getAttribute('mesid')||message?.dataset?.mesid||'no-message-id';
 const scope=message||doc;
 const targets=Array.from(scope.querySelectorAll('[class~="scanning"], [data-qlPrompt]')).filter(el=>statusbarPromptForTarget(el)||el.dataset.qlPrompt);
 const ordinal=Math.max(0,targets.indexOf(target));
 let hash=2166136261;
 for(let i=0;i<prompt.length;i++){hash^=prompt.charCodeAt(i);hash=Math.imul(hash,16777619);}
 return 'statusbar:'+String(getContext()?.chatId||'chat')+':'+messageId+':'+ordinal+':'+(hash>>>0).toString(36);
}
function renderStatusbarCard(frame,prompt,url,taskKey){
 let card=frame.querySelector('.ql-statusbar-card');
 if(!card||card.dataset.qlTask!==taskKey){
  frame.querySelectorAll('.ql-statusbar-card,.ql-statusbar-error,.ql-statusbar-loading').forEach(el=>el.remove());
  if(getComputedStyle(frame).position==='static')frame.style.position='relative';
  card=document.createElement('div');card.className='ql-statusbar-card';card.dataset.qlTask=taskKey;
  card.style.cssText='position:absolute;inset:0;width:100%;height:100%;overflow:hidden;background:#000;z-index:6;';
  const img=document.createElement('img');img.alt='轻绘状态栏画面';img.loading='eager';img.style.cssText='display:block;width:100%;height:100%;object-fit:contain;';
  const controls=document.createElement('div');controls.className='ql-statusbar-controls';controls.style.cssText='position:absolute;left:0;right:0;bottom:4px;z-index:8;display:flex;align-items:center;justify-content:center;gap:4px;opacity:.92;';
  const prev=document.createElement('button');prev.type='button';prev.className='menu_button';prev.textContent='‹';
  const count=document.createElement('span');count.className='ql-statusbar-count';count.textContent='1 / 1';count.style.cssText='color:#fff;font-size:11px;text-shadow:0 1px 3px #000;padding:0 4px;';
  const next=document.createElement('button');next.type='button';next.className='menu_button';next.textContent='›';
  const reroll=document.createElement('button');reroll.type='button';reroll.className='menu_button';reroll.textContent='再画一张';
  controls.append(prev,count,next,reroll);card.append(img,controls);frame.append(card);
  card._qlCandidates=[];card._qlIndex=0;card._qlPrompt=prompt;
  const render=()=>{const list=card._qlCandidates;if(!list.length)return;img.src=list[card._qlIndex].url;count.textContent=(card._qlIndex+1)+' / '+list.length;prev.disabled=card._qlIndex<=0;next.disabled=card._qlIndex>=list.length-1;};
  card._qlAddCandidate=url=>{card._qlCandidates.push({url,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;render();};
  const step=delta=>{const nextIndex=card._qlIndex+delta;if(nextIndex>=0&&nextIndex<card._qlCandidates.length){card._qlIndex=nextIndex;render();}};
  prev.onclick=()=>step(-1);next.onclick=()=>step(1);
  let touchX=0,touchY=0;
  img.addEventListener('touchstart',e=>{const t=e.changedTouches[0];touchX=t.clientX;touchY=t.clientY;},{passive:true});
  img.addEventListener('touchend',e=>{const t=e.changedTouches[0],dx=t.clientX-touchX,dy=t.clientY-touchY;if(Math.abs(dx)>42&&Math.abs(dx)>Math.abs(dy)*1.25)step(dx<0?1:-1);},{passive:true});
  img.addEventListener('contextmenu',e=>{e.preventDefault();saveCleanImage(img.src,'qinghui-'+Date.now()+'.png');});
  reroll.onclick=async()=>{if(card.dataset.busy==='1')return;const candidate=triggerRegistry.beginCandidate(taskKey,{prompt:card._qlPrompt,source:'statusbar-reroll'});if(!candidate.accepted)return;triggerRegistry.markRunning(taskKey);card.dataset.busy='1';reroll.disabled=true;const old=reroll.textContent;reroll.textContent='生成中';try{const fresh=await requestWithActiveSettings(card._qlPrompt);card._qlCandidates.push({url:fresh,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;render();storeChatRecord(fresh,card._qlPrompt,taskKey,{source:'statusbar'});triggerRegistry.markSucceeded(taskKey,taskKey+':candidate:'+Date.now());}catch(e){triggerRegistry.markFailed(taskKey,e?.message||String(e));statusbarError(frame,card._qlPrompt,taskKey,e);}finally{card.dataset.busy='0';reroll.disabled=false;reroll.textContent=old;}};
  card._qlRender=render;
 }
 if(!card._qlCandidates.some(item=>item.url===url)){card._qlCandidates.push({url,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;}
 card._qlRender?.();
 frame.classList.remove('scanning');frame.dataset.qlDone='1';
}
function statusbarError(frame,prompt,taskKey,error){
 const existingCard=frame.querySelector('.ql-statusbar-card');
 const note=document.createElement('div');note.className='ql-statusbar-error';
 note.style.cssText='position:absolute;inset:0;z-index:9;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;padding:12px;background:rgba(0,0,0,.78);color:#fff;text-align:center;font-size:13px;';
 const text=document.createElement('span');text.textContent='轻绘生成失败：'+(error?.message||String(error));
 const retry=document.createElement('button');retry.type='button';retry.className='menu_button';retry.textContent='点击重试';
 retry.onclick=async()=>{
  const accepted=triggerRegistry.begin(taskKey,{prompt,source:'statusbar-retry'});
  if(!accepted.accepted)return;
  triggerRegistry.markRunning(taskKey);retry.disabled=true;retry.textContent='生成中…';
  try{
   const url=await requestWithActiveSettings(prompt);
   note.remove();
   const card=frame.querySelector('.ql-statusbar-card');
   if(card&&typeof card._qlAddCandidate==='function')card._qlAddCandidate(url);
   else renderStatusbarCard(frame,prompt,url,taskKey);
   storeChatRecord(url,prompt,taskKey,{source:'statusbar'});
   triggerRegistry.markSucceeded(taskKey,taskKey+':candidate:'+Date.now());
  }catch(e){
   triggerRegistry.markFailed(taskKey,e?.message||String(e));
   text.textContent='轻绘生成失败：'+(e?.message||String(e));
   retry.disabled=false;retry.textContent='点击重试';
  }
 };
 note.append(text,retry);frame.append(note);
}
async function processStatusbarFrames(){
 const docs=[document];
 document.querySelectorAll('iframe').forEach(iframe=>{try{if(iframe.contentDocument)docs.push(iframe.contentDocument);}catch{}});
 const frames=docs.flatMap(doc=>Array.from(doc.querySelectorAll('[class~="scanning"]')).filter(frame=>{
  const prompt=statusbarPromptForTarget(frame);
  if(!prompt)return false;
  return !Array.from(frame.querySelectorAll('[class~="scanning"]')).some(child=>statusbarPromptForTarget(child)===prompt);
 }));
 for(const frame of frames){
  const prompt=statusbarPromptForTarget(frame);
  if(!prompt)continue;
  if(frame.dataset.qlPrompt!==prompt){
   frame.dataset.qlPrompt=prompt;
   frame.dataset.qlDone='';
   frame.querySelectorAll('.ql-statusbar-card,.ql-statusbar-error,.ql-statusbar-loading').forEach(el=>el.remove());
  }
  if(frame.dataset.qlBusy==='1'||frame.dataset.qlDone==='1')continue;
  frame.dataset.qlBusy='1';
  const taskKey=statusbarTaskKey(frame,prompt,frame.ownerDocument||document);
  const accepted=triggerRegistry.begin(taskKey,{prompt,source:'statusbar'});
  if(!accepted.accepted){frame.dataset.qlBusy='0';continue;}
  triggerRegistry.markRunning(taskKey);
  const loading=(frame.ownerDocument||document).createElement('div');
  loading.className='ql-statusbar-loading';
  loading.textContent='轻绘：正在生成画面…';
  loading.style.cssText='position:absolute;inset:0;z-index:7;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.72);color:#fff;font-size:13px;';
  if(getComputedStyle(frame).position==='static')frame.style.position='relative';
  frame.append(loading);
  try{
   const url=await requestWithActiveSettings(prompt);
   loading.remove();
   renderStatusbarCard(frame,prompt,url,taskKey);
   storeChatRecord(url,prompt,taskKey,{source:'statusbar'});
   triggerRegistry.markSucceeded(taskKey,taskKey+':candidate:'+Date.now());
  }catch(e){
   triggerRegistry.markFailed(taskKey,e?.message||String(e));
   loading.remove();
   statusbarError(frame,prompt,taskKey,e);
  }finally{frame.dataset.qlBusy='0';}
 }
}
function observeStatusbarFrames(){
 const attach=doc=>{
  if(!doc||statusbarObservedDocs.has(doc))return;
  const target=doc.body||doc.documentElement;if(!target)return;
  statusbarObservedDocs.add(doc);
  const observer=new MutationObserver(()=>{attachFrames();processStatusbarFrames().catch(e=>console.warn('[轻绘 Lite] 状态栏触发失败',e));});
  observer.observe(target,{childList:true,subtree:true,characterData:true,attributes:true,attributeFilter:['class']});
  if(doc===document)statusbarObserver=observer;
 };
 const attachFrames=()=>{
  attach(document);
  document.querySelectorAll('iframe').forEach(frame=>{try{attach(frame.contentDocument);}catch{}});
 };
 attachFrames();
 processStatusbarFrames().catch(e=>console.warn('[轻绘 Lite] 状态栏触发失败',e));
}

const themePalettes={mist:{accent:'#7f98ad',panel:'rgba(224,232,238,.96)',card:'rgba(239,243,246,.92)',text:'#344653',muted:'#657784',border:'rgba(100,125,145,.28)',field:'rgba(250,252,253,.92)'},sage:{accent:'#849b8c',panel:'rgba(225,234,226,.97)',card:'rgba(240,245,239,.94)',text:'#3c5044',muted:'#687a6d',border:'rgba(103,133,111,.28)',field:'rgba(250,252,248,.94)'},lavender:{accent:'#9a91b0',panel:'rgba(233,229,240,.97)',card:'rgba(246,243,249,.94)',text:'#4c465b',muted:'#777083',border:'rgba(140,127,164,.28)',field:'rgba(253,251,255,.94)'},oat:{accent:'#b09c82',panel:'rgba(239,232,220,.97)',card:'rgba(250,246,238,.94)',text:'#554b3e',muted:'#817565',border:'rgba(158,137,109,.28)',field:'rgba(255,252,246,.94)'},ink:{accent:'#8296aa',panel:'rgba(39,49,61,.98)',card:'rgba(49,61,74,.96)',text:'#e2e8ee',muted:'#aebbc7',border:'rgba(145,164,181,.25)',field:'rgba(31,41,52,.96)'}};
function applyTheme(preset,customCss){const panel=$('#qinghui-lite-panel');if(!panel)return;panel.querySelectorAll('#ql-custom-theme-style').forEach(x=>x.remove());if(preset==='auto'){panel.style.removeProperty('--ql-accent');panel.style.removeProperty('--ql-panel');panel.style.removeProperty('--ql-card');panel.style.removeProperty('--ql-text');panel.style.removeProperty('--ql-muted');panel.style.removeProperty('--ql-border');panel.style.removeProperty('--ql-field');panel.style.removeProperty('color');panel.style.removeProperty('background');return;}if(preset!=='custom'&&themePalettes[preset]){const p=themePalettes[preset];panel.style.setProperty('--ql-accent',p.accent);panel.style.setProperty('--ql-panel',p.panel);panel.style.setProperty('--ql-card',p.card);panel.style.setProperty('--ql-text',p.text);panel.style.setProperty('--ql-muted',p.muted);panel.style.setProperty('--ql-border',p.border);panel.style.setProperty('--ql-field',p.field);panel.style.color='var(--ql-text)';panel.style.background='var(--ql-panel)';return;}if(preset==='custom'){for(const key of ['--ql-accent','--ql-panel','--ql-card','--ql-text','--ql-muted','--ql-border','--ql-field'])panel.style.removeProperty(key);panel.style.removeProperty('color');panel.style.removeProperty('background');const style=document.createElement('style');style.id='ql-custom-theme-style';style.textContent='#qinghui-lite-panel{'+String(customCss||'')+'}';panel.append(style);}}
function save(){ saveSettingsDebounced(); }
function html(){return `<div id="ql-overlay" hidden><section id="qinghui-lite-panel">
<header class="ql-header"><div class="ql-brand"><strong>轻绘 Lite</strong><span>独立生图工作区</span></div><button id="ql-close" class="menu_button" type="button">关闭</button></header>
<nav class="ql-tabs" aria-label="轻绘功能导航" role="tablist">
<button type="button" class="ql-tab active" data-page="generate" role="tab" aria-selected="true">生图</button>
<button type="button" class="ql-tab" data-page="library" role="tab" aria-selected="false">预设</button>
<button type="button" class="ql-tab" data-page="history" role="tab" aria-selected="false">历史</button>
<button type="button" class="ql-tab" data-page="settings" role="tab" aria-selected="false">设置</button>
<button type="button" class="ql-tab" data-page="migration" role="tab" aria-selected="false">迁移</button>
</nav>
<div class="ql-page active" data-page-panel="generate" role="tabpanel">
<div class="ql-card"><h3>图片放置区</h3><p class="ql-muted">生成结果会显示在这里；长按图片可保存。</p><div id="ql-result" class="ql-image-stage"><div class="ql-image-placeholder">等待生成图片</div></div></div>
<div class="ql-card"><h3>提示词 Tag 调整</h3><div class="ql-row"><input id="ql-tag-input" placeholder="输入一个 Tag，例如 1girl"><button id="ql-tag-add" class="menu_button" type="button">添加 Tag</button></div><div id="ql-tag-chips" class="ql-tag-chips"></div><label for="ql-prompt">正向提示词</label><textarea id="ql-prompt" placeholder="输入完整提示词"></textarea><label for="ql-negative">负向提示词</label><textarea id="ql-negative" placeholder="可选"></textarea></div>
<div class="ql-card"><h3>画师串与 Vibe</h3><label for="ql-active-preset">画师串组合</label><select id="ql-active-preset"><option value="-1">不使用画师串预设</option></select><div class="ql-row"><button id="ql-apply-preset" class="menu_button" type="button">应用画师串</button><button id="ql-open-preset" class="menu_button" type="button">编辑 / 管理预设</button></div><label for="ql-active-vibe">Vibe 参考（仅 NovelAI）</label><select id="ql-active-vibe"><option value="-1">不使用 Vibe</option></select><p class="ql-muted">仅包含完整参考图编码的 Vibe 可用于生成。</p></div>
<div class="ql-card"><h3>模型参数</h3><label for="ql-fast-provider">生图后端</label><select id="ql-fast-provider"><option value="openai">GPT / OpenAI 兼容接口</option><option value="novelai">NovelAI（酒馆连接）</option></select><div id="ql-fast-openai"><label for="ql-fast-model">模型</label><input id="ql-fast-model" placeholder="gpt-image-1"><div class="ql-row"><div><label>尺寸</label><select id="ql-fast-size"><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option></select></div><div><label>质量</label><select id="ql-fast-quality"><option>low</option><option>medium</option><option>high</option></select></div></div></div><div id="ql-fast-nai" hidden><label>NovelAI 模型</label><select id="ql-fast-nai-model"><option>nai-diffusion-4-5-full</option><option>nai-diffusion-4-5-curated</option><option>nai-diffusion-4-full</option><option>nai-diffusion-4-curated</option><option>nai-diffusion-3</option></select><div class="ql-row"><div><label>步数</label><input id="ql-fast-nai-steps" type="number" min="1" max="50"></div><div><label>CFG Scale</label><input id="ql-fast-nai-scale" type="number" min="1" max="20" step="0.5"></div></div><div class="ql-row"><div><label>宽度</label><select id="ql-fast-nai-width"><option>512</option><option>640</option><option>768</option><option>832</option><option>1024</option></select></div><div><label>高度</label><select id="ql-fast-nai-height"><option>512</option><option>640</option><option>768</option><option>832</option><option>1024</option><option>1216</option><option>1536</option></select></div></div><div class="ql-row"><div><label>采样器</label><select id="ql-fast-nai-sampler"><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option></select></div><div><label>调度器</label><select id="ql-fast-nai-scheduler"><option value="karras">Karras</option><option value="native">Native</option></select></div></div><label class="ql-inline-check"><input id="ql-fast-nai-normalize" type="checkbox"> 归一化 Vibe 参考强度</label><p class="ql-muted">开启后会自动归一化 V4/V4.5 多条 Vibe 的强度；关闭则按每条参考的原始强度发送。</p></div><button id="ql-generate" class="menu_button ql-primary">生成一张</button><p id="ql-status" class="ql-muted" role="status"></p></div>
</div>
<div class="ql-page" data-page-panel="library" role="tabpanel" hidden>
<nav class="ql-subtabs" role="tablist" aria-label="预设分区"><button type="button" class="ql-subtab active" data-subpage="artists" aria-selected="true">画师串编辑</button><button type="button" class="ql-subtab" data-subpage="vibes" aria-selected="false">Vibe 管理</button><button type="button" class="ql-subtab" data-subpage="bindings" aria-selected="false">角色绑定</button></nav>
<section class="ql-subpage active" data-subpage-panel="artists"><div class="ql-card"><h3>画师串编辑区</h3><p class="ql-muted">可从下方列表切换画师串编辑；保存时更新当前选中的组合，也可以新建组合。</p><label for="ql-preset-edit-select">切换要编辑的画师串</label><div class="ql-row"><select id="ql-preset-edit-select"><option value="">新建画师串</option></select><button type="button" class="menu_button" id="ql-preset-new">新建</button></div><input id="ql-preset-name" placeholder="组合名称"><label>正向画师串</label><textarea id="ql-preset-positive" placeholder="artist:xxx, style tags..."></textarea><label>负向画师串</label><textarea id="ql-preset-negative" placeholder="可选"></textarea><button id="ql-preset-save" class="menu_button">保存画师串组合</button><div id="ql-presets-list"></div></div><div class="ql-card"><h3>提示词库</h3><div class="ql-row"><input id="ql-prompt-name" placeholder="名称"><input id="ql-prompt-category" placeholder="分类"></div><label>完整正向提示词</label><textarea id="ql-library-prompt" placeholder="保存完整提示词"></textarea><label>负向提示词</label><textarea id="ql-library-negative" placeholder="可选"></textarea><button id="ql-prompt-save" class="menu_button">保存提示词</button><div id="ql-prompts-list"></div></div><div class="ql-card"><h3>角色词条库</h3><input id="ql-character-name" placeholder="角色名称"><label>固定外貌词</label><textarea id="ql-character-appearance" placeholder="角色固定外貌特征"></textarea><button id="ql-character-save" class="menu_button">保存角色</button><div id="ql-characters-list"></div></div></section>
<section class="ql-subpage" data-subpage-panel="vibes" hidden><div class="ql-card"><h3>Vibe 导入与编辑</h3><p class="ql-muted">支持 JSON / 智绘姬组格式和可解析的 .naiv4vibe / bundle 压缩包；也可选择图片。编码可能消耗 NovelAI Anlas。图片编码需要酒馆提供 /api/novelai/encode-vibe 代理接口；若返回 404，需补充后端代理。</p><label>导入文件</label><input id="ql-vibe-import-file" type="file" accept=".json,.json5,.txt,.naiv4vibe,.naiv4vibeBundle,image/png,image/jpeg,image/webp"><button id="ql-vibe-pick" type="button" class="menu_button ql-secondary">选择 Vibe 文件 / 图片</button><label>Vibe 名称</label><input id="ql-vibe-name" placeholder="例如：柔和配色参考"><label>Information Extracted</label><input id="ql-vibe-info" type="number" min="0.01" max="1" step="0.05" value="1"><button id="ql-vibe-encode" class="menu_button">将选中的图片编码为 Vibe</button><p id="ql-vibe-status" class="ql-muted" role="status">尚未选择文件。</p><div id="ql-vibes-list"></div></div></section>
<section class="ql-subpage" data-subpage-panel="bindings" hidden><div class="ql-card"><h3>角色卡组合绑定</h3><p class="ql-muted">为角色卡绑定画师串与 Vibe，切换角色卡时自动选择已保存的组合。</p><label>角色卡</label><select id="ql-bind-character"><option value="">选择角色卡</option></select><label>画师串组合</label><select id="ql-bind-preset"><option value="-1">不绑定画师串</option></select><label>Vibe 组合</label><select id="ql-bind-vibe"><option value="-1">不绑定 Vibe</option></select><button id="ql-bind-save" class="menu_button">保存此角色绑定</button><div id="ql-bindings-list"></div></div></section>
</div>
<div class="ql-page" data-page-panel="history" role="tabpanel" hidden><div class="ql-card"><h3>最近生成</h3><p class="ql-muted">本地保存的最近生成记录。</p><div id="ql-history"></div><button id="ql-clear" class="menu_button">清空记录</button></div></div>
<div class="ql-page" data-page-panel="settings" role="tabpanel" hidden><div class="ql-card"><h3>外观与配色</h3><p class="ql-muted">内置低饱和配色，默认跟随酒馆主题；也可以自定义 CSS 变量。</p><label for="ql-theme-preset">配色预设</label><select id="ql-theme-preset"><option value="auto">自适配酒馆美化</option><option value="mist">雾灰蓝</option><option value="sage">鼠尾草绿</option><option value="lavender">灰紫</option><option value="oat">燕麦奶茶</option><option value="ink">墨蓝灰</option><option value="custom">自定义 CSS</option></select><label for="ql-theme-css">自定义 CSS（仅作用于轻绘 Lite）</label><textarea id="ql-theme-css" placeholder="例如：--ql-accent: #8799ad;\n--ql-panel: rgba(230, 235, 240, .96);"></textarea><div class="ql-row"><button id="ql-theme-apply" type="button" class="menu_button">应用配色</button><button id="ql-theme-reset" type="button" class="menu_button">恢复自适配</button></div><p id="ql-theme-status" class="ql-muted" role="status"></p></div><div class="ql-card"><h3>接口连接设置</h3><p class="ql-muted">模型、尺寸、质量、步数和采样器已放在第一页“模型参数”。此处只填写 OpenAI 兼容接口连接信息。</p><label for="ql-endpoint">API 地址</label><input id="ql-endpoint" placeholder="https://api.openai.com/v1"><label for="ql-key">API Key</label><input id="ql-key" type="password" autocomplete="off" placeholder="不会写入 GitHub"><button id="ql-save" class="menu_button ql-primary">保存接口设置</button></div><div hidden><select id="ql-provider"><option value="openai">OpenAI</option><option value="novelai">NovelAI</option></select><input id="ql-model"><select id="ql-size"><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option></select><select id="ql-quality"><option>low</option><option>medium</option><option>high</option></select><input id="ql-nai-model"><input id="ql-nai-steps"><input id="ql-nai-scale"><select id="ql-nai-width"><option>512</option><option>640</option><option>768</option><option>832</option><option>1024</option></select><select id="ql-nai-height"><option>512</option><option>640</option><option>768</option><option>832</option><option>1024</option><option>1216</option><option>1536</option></select><select id="ql-nai-sampler"><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option></select><select id="ql-nai-scheduler"><option value="karras">Karras</option><option value="native">Native</option></select><input id="ql-nai-normalize" type="checkbox"><div id="ql-openai-settings" hidden></div><div id="ql-nai-settings" hidden></div></div></div>
<div class="ql-page" data-page-panel="migration" role="tabpanel" hidden><div class="ql-card"><h3>智绘姬数据迁移</h3><p class="ql-muted">先扫描当前酒馆可访问的智绘姬设置，也可以选择智绘姬导出的 JSON 文件。迁移前会预览，已有数据不会被覆盖。</p><div class="ql-row ql-migrate-actions"><button id="ql-migrate-scan" class="menu_button">扫描当前酒馆</button><button id="ql-migrate-file-btn" class="menu_button">选择导出文件</button><input id="ql-migrate-file" type="file" accept=".json,.json5,.txt,application/json" hidden></div><div id="ql-migrate-preview" class="ql-muted" role="status">尚未扫描。</div><button id="ql-migrate-import" class="menu_button" disabled>确认导入</button><p class="ql-muted">画师串与文本预设可迁移；Vibe 项目会先保留原始数据供核对，确认资源格式后再接入生图。</p><div id="ql-vibes-migration-list"></div></div></div>
</section></div>`;}

function syncFastControls(){if(!$('#ql-fast-provider'))return;$('#ql-provider').value=$('#ql-fast-provider').value;$('#ql-model').value=$('#ql-fast-model').value;$('#ql-size').value=$('#ql-fast-size').value;$('#ql-quality').value=$('#ql-fast-quality').value;$('#ql-nai-model').value=$('#ql-fast-nai-model').value;$('#ql-nai-steps').value=$('#ql-fast-nai-steps').value;$('#ql-nai-scale').value=$('#ql-fast-nai-scale').value;$('#ql-nai-width').value=$('#ql-fast-nai-width').value;$('#ql-nai-height').value=$('#ql-fast-nai-height').value;$('#ql-nai-sampler').value=$('#ql-fast-nai-sampler').value;$('#ql-nai-scheduler').value=$('#ql-fast-nai-scheduler').value;$('#ql-nai-normalize').checked=$('#ql-fast-nai-normalize').checked;}
function read(){syncFastControls();const s=cfg();s.provider=$('#ql-provider').value;s.endpoint=$('#ql-endpoint').value.trim().replace(/\/$/,'');s.apiKey=$('#ql-key').value.trim();s.model=$('#ql-model').value.trim()||'gpt-image-1';s.size=$('#ql-size').value;s.quality=$('#ql-quality').value;s.naiModel=$('#ql-nai-model').value.trim()||'nai-diffusion-4-5-full';s.naiSteps=Number($('#ql-nai-steps').value)||28;s.naiScale=Number($('#ql-nai-scale').value)||5;s.naiWidth=Number($('#ql-nai-width').value)||832;s.naiHeight=Number($('#ql-nai-height').value)||1216;s.naiSampler=$('#ql-nai-sampler').value;s.naiScheduler=$('#ql-nai-scheduler').value;s.naiNormalizeVibeStrengths=$('#ql-nai-normalize').checked;s.prompt=$('#ql-prompt').value;s.negative=$('#ql-negative').value;save();}
function status(t){$('#ql-status').textContent=t;}
function history(){
 const host=$('#ql-history');if(!host)return;
 host.innerHTML=(cfg().records||[]).slice(0,10).map((r,i)=>'<div class="ql-record"><p>'+esc(new Date(r.at).toLocaleString())+' · '+esc((r.prompt||'').slice(0,100))+'</p><img src="'+r.dataUrl+'" alt="生成结果"><div class="ql-row"><button class="menu_button" data-ql-load="'+i+'">载入提示词</button><button class="menu_button" data-ql-download="'+i+'">保存图片</button><button class="menu_button" data-ql-delete="'+i+'">删除记录</button></div></div>').join('')||'<p class="ql-muted">暂无记录</p>';
 host.querySelectorAll('[data-ql-load]').forEach(b=>b.onclick=()=>{const r=cfg().records[+b.dataset.qlLoad];$('#ql-prompt').value=r.prompt||'';$('#ql-negative').value=r.negative||'';read();status('提示词已载入；点击生成会创建新记录。');});
 host.querySelectorAll('[data-ql-download]').forEach(b=>b.onclick=()=>{const r=cfg().records[+b.dataset.qlDownload];saveCleanImage(r.dataUrl,'qinghui-'+(r.at||Date.now())+'.png');});
 host.querySelectorAll('[data-ql-delete]').forEach(b=>b.onclick=()=>{const i=+b.dataset.qlDelete;if(!confirm('删除这条轻绘生成记录？不会删除聊天消息中的图片。'))return;cfg().records.splice(i,1);save();history();status('记录已删除。');});
}
function renderLibrary(){
 const s=cfg();
 const prompts=$('#ql-prompts-list'),chars=$('#ql-characters-list'),presets=$('#ql-presets-list'),vibes=$('#ql-vibes-list');
 if(prompts)prompts.innerHTML=(s.prompts||[]).map((p,i)=>'<div class="ql-record"><strong>'+esc(p.name)+'</strong><p>'+esc(p.category||'未分类')+' · '+esc((p.prompt||'').slice(0,100))+'</p><button class="menu_button" data-prompt-load="'+i+'">载入</button><button class="menu_button" data-prompt-delete="'+i+'">删除</button></div>').join('')||'<p class="ql-muted">暂无提示词</p>';
 if(chars)chars.innerHTML=(s.characters||[]).map((p,i)=>'<div class="ql-record"><strong>'+esc(p.name)+'</strong><p>'+esc(p.appearance)+'</p><button class="menu_button" data-character-apply="'+i+'">追加外貌词</button><button class="menu_button" data-character-edit="'+i+'">编辑</button><button class="menu_button" data-character-delete="'+i+'">删除</button></div>').join('')||'<p class="ql-muted">暂无角色</p>';
 if(presets)presets.innerHTML=(s.presets||[]).map((p,i)=>'<div class="ql-record"><strong>'+esc(p.name)+'</strong><p>'+esc(p.positive)+'</p><button class="menu_button" data-preset-apply="'+i+'">应用到生图页</button><button class="menu_button" data-preset-edit="'+i+'">编辑</button><button class="menu_button" data-preset-delete="'+i+'">删除</button></div>').join('')||'<p class="ql-muted">暂无预设</p>';
 const editorSelect=$('#ql-preset-edit-select');
 if(editorSelect){const old=editorSelect.value;editorSelect.innerHTML='<option value="">新建画师串</option>'+(s.presets||[]).map((p,i)=>'<option value="'+i+'">'+esc(p.name||('画师串 '+(i+1)))+'</option>').join('');if(old!==''&&s.presets[Number(old)])editorSelect.value=old;}
 if(vibes)vibes.innerHTML=(s.vibes||[]).map((v,i)=>{
  const entries=Array.isArray(v.entries)?v.entries:[];
  const usable=entries.filter(entry=>(typeof entry.image==='string'&&entry.image.replace(/\s+/g,'').length>160)||!!extractUsableVibe(entry.raw||entry)?.image).length;
  const active=Number(s.activeVibeIndex)===i;
  const entryRows=entries.map((entry,j)=>{
   const ready=(typeof entry.image==='string'&&entry.image.replace(/\s+/g,'').length>160)||!!extractUsableVibe(entry.raw||entry)?.image;
   return '<div class="ql-vibe-entry"><div class="ql-vibe-entry-head"><strong>参考 '+(j+1)+'</strong><span class="ql-vibe-state '+(ready?'is-ready':'is-missing')+'">'+(ready?'编码可用':'缺少编码')+'</span></div><div class="ql-row"><div><label>参考强度</label><input type="number" min="0" max="1" step="0.05" data-vibe-entry-strength="'+i+'-'+j+'" value="'+Math.max(0,Math.min(1,Number(entry.strength??0.6)))+'"></div><div><label>Information Extracted</label><input type="number" min="0" max="1" step="0.05" disabled title="编码完成后该值固定；修改它需要重新编码原始图片" data-vibe-entry-info="'+i+'-'+j+'" value="'+Math.max(0,Math.min(1,Number(entry.informationExtracted??1)))+'"></div></div><button type="button" class="menu_button" data-vibe-entry-delete="'+i+'-'+j+'">移除此参考</button></div>';
  }).join('');
  return '<div class="ql-record ql-vibe-group '+(active?'is-active':'')+'"><div class="ql-vibe-group-top"><div class="ql-vibe-group-info"><strong>'+esc(v.name||'未命名 Vibe')+'</strong><p>'+usable+' / '+entries.length+' 条参考可用'+(active?' · 当前使用中':'')+'</p></div><button type="button" class="menu_button" data-vibe-use="'+i+'">'+(active?'当前使用中':'整组使用')+'</button></div><label>组名称</label><input data-vibe-name="'+i+'" value="'+esc(v.name||'')+'"><details class="ql-vibe-details"><summary>编辑组内参考（'+entries.length+'）</summary>'+(entryRows||'<p class="ql-muted">没有可编辑的编码条目。请导入包含预编码资源的官网文件或智绘姬 Vibe 组 JSON。</p>')+'<details><summary>查看导入来源</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto">'+esc(JSON.stringify({source:v.source,sourcePath:v.sourcePath,groupName:v.groupName,identifier:entries.map(e=>e.identifier).filter(Boolean),rawPreserved:!!(v.raw||v.rawGroup)},null,2).slice(0,2000))+'</pre></details></details><div class="ql-vibe-group-actions"><button type="button" class="menu_button" data-vibe-save="'+i+'">保存修改</button><button type="button" class="menu_button" data-vibe-delete="'+i+'">删除整组</button></div></div>';
 }).join('')||'<p class="ql-muted">暂无 Vibe。导入官网预编码文件或智绘姬导出的 Vibe 组 JSON 后，可整组选择使用。</p>';
 vibes?.querySelectorAll('[data-vibe-use]').forEach(b=>b.onclick=()=>{
  const i=Number(b.dataset.vibeUse),v=s.vibes[i];if(!v)return;
  const entries=Array.isArray(v.entries)?v.entries:[];
  const usable=entries.filter(entry=>(typeof entry.image==='string'&&entry.image.replace(/\s+/g,'').length>160)||extractUsableVibe(entry.raw||entry)?.image).length;
  if(!usable){status('这组暂时没有可用的预编码 Vibe；请展开组内参考检查导入内容。');return;}
  s.activeVibeIndex=i;save();renderLibrary();status('已整组启用 Vibe：'+(v.name||'未命名 Vibe')+'（'+usable+' 条参考）');
 });
 vibes?.querySelectorAll('[data-vibe-save]').forEach(b=>b.onclick=()=>{
  const i=Number(b.dataset.vibeSave),v=s.vibes[i];if(!v)return;
  const nameInput=vibes.querySelector('[data-vibe-name="'+i+'"]');
  if(nameInput&&nameInput.value.trim())v.name=nameInput.value.trim();
  (Array.isArray(v.entries)?v.entries:[]).forEach((entry,j)=>{
   const input=vibes.querySelector('[data-vibe-entry-strength="'+i+'-'+j+'"]');
   if(input){const n=Number(input.value);if(Number.isFinite(n))entry.strength=Math.max(0,Math.min(1,n));}
  });
  v.hasPayload=(v.entries||[]).some(entry=>(typeof entry.image==='string'&&entry.image.replace(/\s+/g,'').length>160)||!!extractUsableVibe(entry.raw||entry)?.image);
  save();renderLibrary();status('Vibe 分组修改已保存。');
 });
 vibes?.querySelectorAll('[data-vibe-entry-delete]').forEach(b=>b.onclick=()=>{
  const [i,j]=b.dataset.vibeEntryDelete.split('-').map(Number),v=s.vibes[i];
  if(!v||!Array.isArray(v.entries)||!v.entries[j])return;
  v.entries.splice(j,1);v.hasPayload=v.entries.some(entry=>(typeof entry.image==='string'&&entry.image.replace(/\s+/g,'').length>160)||!!extractUsableVibe(entry.raw||entry)?.image);
  save();renderLibrary();status('已移除这张 Vibe 参考图。');
 });
 vibes?.querySelectorAll('[data-vibe-delete]').forEach(b=>b.onclick=()=>{
  const i=Number(b.dataset.vibeDelete);if(!s.vibes[i])return;
  s.vibes.splice(i,1);
  if(Number(s.activeVibeIndex)===i)s.activeVibeIndex=-1;
  else if(Number(s.activeVibeIndex)>i)s.activeVibeIndex=Number(s.activeVibeIndex)-1;
  for(const binding of s.bindings||[]){
   if(Number(binding.vibeIndex)===i)binding.vibeIndex=-1;
   else if(Number(binding.vibeIndex)>i)binding.vibeIndex=Number(binding.vibeIndex)-1;
  }
  save();renderLibrary();status('已删除 Vibe 分组。');
 });
 renderActiveVibes();renderActivePresets();renderBindings();
 prompts?.querySelectorAll('[data-prompt-load]').forEach(b=>b.onclick=()=>{const p=s.prompts[+b.dataset.promptLoad];$('#ql-prompt').value=p.prompt;$('#ql-negative').value=p.negative||'';read();status('已载入提示词：'+p.name);});
 prompts?.querySelectorAll('[data-prompt-edit]').forEach(b=>b.onclick=()=>{const p=s.prompts[+b.dataset.promptEdit];$('#ql-prompt-name').value=p.name||'';$('#ql-prompt-category').value=p.category||'';$('#ql-library-prompt').value=p.prompt||'';$('#ql-library-negative').value=p.negative||'';$('#ql-prompt-save').dataset.edit=String(+b.dataset.promptEdit);$('#ql-prompt-save').textContent='保存修改';});
  prompts?.querySelectorAll('[data-prompt-delete]').forEach(b=>b.onclick=()=>{s.prompts.splice(+b.dataset.promptDelete,1);save();renderLibrary();});
 chars?.querySelectorAll('[data-character-apply]').forEach(b=>b.onclick=()=>{const p=s.characters[+b.dataset.characterApply];$('#ql-prompt').value=[$('#ql-prompt').value.trim(),p.appearance].filter(Boolean).join(', ');read();status('已追加角色外貌词：'+p.name);});
 chars?.querySelectorAll('[data-character-edit]').forEach(b=>b.onclick=()=>{const p=s.characters[+b.dataset.characterEdit];$('#ql-character-name').value=p.name||'';$('#ql-character-appearance').value=p.appearance||'';$('#ql-character-save').dataset.edit=String(+b.dataset.characterEdit);$('#ql-character-save').textContent='保存修改';});
  chars?.querySelectorAll('[data-character-delete]').forEach(b=>b.onclick=()=>{s.characters.splice(+b.dataset.characterDelete,1);save();renderLibrary();});
 presets?.querySelectorAll('[data-preset-apply]').forEach(b=>b.onclick=()=>{const i=+b.dataset.presetApply,p=s.presets[i];s.activePresetIndex=i;renderActivePresets();save();status('已选中画师串：'+p.name+'，生成时会自动组合。');});
 const loadPresetForEdit=index=>{const p=s.presets[index];if(!p)return;$('#ql-preset-edit-select').value=String(index);$('#ql-preset-name').value=p.name||'';$('#ql-preset-positive').value=p.positive||'';$('#ql-preset-negative').value=p.negative||'';$('#ql-preset-save').dataset.edit=String(index);$('#ql-preset-save').textContent='保存修改';};
  presets?.querySelectorAll('[data-preset-edit]').forEach(b=>b.onclick=()=>loadPresetForEdit(+b.dataset.presetEdit));
  $('#ql-preset-edit-select').onchange=()=>{const value=$('#ql-preset-edit-select').value;if(value===''){delete $('#ql-preset-save').dataset.edit;$('#ql-preset-save').textContent='保存画师串组合';$('#ql-preset-name').value='';$('#ql-preset-positive').value='';$('#ql-preset-negative').value='';return;}loadPresetForEdit(Number(value));};
  $('#ql-preset-new').onclick=()=>{ $('#ql-preset-edit-select').value='';delete $('#ql-preset-save').dataset.edit;$('#ql-preset-save').textContent='保存画师串组合';$('#ql-preset-name').value='';$('#ql-preset-positive').value='';$('#ql-preset-negative').value='';$('#ql-preset-name').focus();};
  presets?.querySelectorAll('[data-preset-delete]').forEach(b=>b.onclick=()=>{s.presets.splice(+b.dataset.presetDelete,1);save();renderLibrary();});
}

async function readVibeArchiveJson(file){const buffer=await file.arrayBuffer(),view=new DataView(buffer),bytes=new Uint8Array(buffer),out=[];const u16=o=>view.getUint16(o,true),u32=o=>view.getUint32(o,true);const decoder=new TextDecoder();for(let p=0;p+46<=bytes.length;){if(u32(p)!==0x02014b50){p++;continue;}const method=u16(p+10),compressed=u32(p+20),nameLen=u16(p+28),extraLen=u16(p+30),commentLen=u16(p+32),localOffset=u32(p+42);const name=decoder.decode(bytes.slice(p+46,p+46+nameLen));if(/\.json$/i.test(name)){if(u32(localOffset)!==0x04034b50)throw new Error('Vibe 压缩包中的文件头无法识别：'+name);const localName=u16(localOffset+26),localExtra=u16(localOffset+28),start=localOffset+30+localName+localExtra,packed=bytes.slice(start,start+compressed);let raw;if(method===0)raw=packed;else if(method===8&&typeof DecompressionStream!=='undefined'){const stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));raw=new Uint8Array(await new Response(stream).arrayBuffer());}else throw new Error('当前浏览器不支持该 Vibe 压缩算法。');try{out.push(JSON.parse(decoder.decode(raw)));}catch{}}p+=46+nameLen+extraLen+commentLen;}return out;}
let migrationCandidate=null;
function walkChatu8(data, pathName='', out={artists:[],prompts:[],vibes:[],warnings:[]}, seen=new WeakSet()){
 if(!data||typeof data!=='object'||seen.has(data))return out;
 seen.add(data);
 const pushUnique=(arr,item,keyFn)=>{if(!arr.some(x=>keyFn(x)===keyFn(item)))arr.push(item);};
 const normName=(obj,fallback)=>String(obj?.name||obj?.title||obj?.label||obj?.id||fallback||'未命名').slice(0,160);
 const entries=Object.entries(data);
 const textValue=(...keys)=>{for(const [k,v] of entries)if(keys.some(re=>re.test(k))&&typeof v==='string'&&v.trim())return v.trim();return '';};
 const isChatu8VibeExport=data.groups&&typeof data.groups==='object'&&data.vibeData&&typeof data.vibeData==='object';
 if(isChatu8VibeExport){
  for(const [groupName,group] of Object.entries(data.groups)){
   if(!group||typeof group!=='object'||!Array.isArray(group.vibes))continue;
   const images=[];
   for(const ref of group.vibes){
    const stored=ref?.vibeDataId?data.vibeData[ref.vibeDataId]:null;
    if(!stored||typeof stored!=='object'){
     out.warnings.push('Vibe 分组「'+groupName+'」中的数据引用未找到：'+String(ref?.vibeDataId||'未知 ID'));
     continue;
    }
    // 智绘姬的标准 Vibe 资源使用 identifier/type 标识，stored.image 是编码载荷，不是缩略图。
    // 只有确认是 novelai-vibe-transfer 编码时才作为生图输入；缩略图单独保留。
    const previewImage=[stored.previewImage,stored.thumbnail,stored.avatar].find(v=>typeof v==='string'&&v.trim())||'';
    const storedImage=typeof stored.image==='string'?stored.image.trim():'';
    const normalizedImage=storedImage.replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/');
    // 分组引用已经明确指向 vibeData；即使导出器省略 identifier/type，也以有效编码载荷为准。
    const hasPayload=/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedImage)&&normalizedImage.length>160;
    // 编码只保留一份，避免 raw 再复制一份超大的 Base64 让酒馆设置膨胀。
    const rawMeta={identifier:stored.identifier||'',version:stored.version??1,type:stored.type||'image',informationExtracted:stored.informationExtracted??stored.information_extracted??1};
    images.push({vibeDataId:ref.vibeDataId,image:hasPayload?normalizedImage:'',previewImage,raw:rawMeta,strength:Number.isFinite(Number(ref.strength))?Number(ref.strength):0.6,informationExtracted:Number.isFinite(Number(stored.informationExtracted??stored.information_extracted))?Number(stored.informationExtracted??stored.information_extracted):1,identifier:stored.identifier||'',version:stored.version??1,type:stored.type||'image',hasPayload});
   }
   if(images.length)pushUnique(out.vibes,{name:String(groupName||'未命名 Vibe'),groupName:String(groupName||'未命名 Vibe'),entries:images,hasPayload:images.some(v=>v.hasPayload),hasRef:false,rawGroup:group,sourcePath:pathName,source:'st-chatu8'},x=>x.name+'|'+x.sourcePath);
   else if(group.vibes.length)out.warnings.push('Vibe 分组「'+groupName+'」没有可保留的数据。');
  }
  for(const [k,v] of entries){if(k==='groups'||k==='vibeData')continue;if(v&&typeof v==='object')walkChatu8(v,pathName?pathName+'.'+k:k,out,seen);}
  return out;
 }
 if(Array.isArray(data)){for(let i=0;i<data.length;i++)walkChatu8(data[i],pathName+'['+i+']',out,seen);return out;}
 // 智绘姬导出的画师串集合：presets -> 名称 -> fixedPrompt/fixedPrompt_end/negativePrompt。
 if(data.presets&&typeof data.presets==='object'&&!Array.isArray(data.presets)){
  for(const [presetName,preset] of Object.entries(data.presets)){
   if(!preset||typeof preset!=='object')continue;
   const fixed=typeof preset.fixedPrompt==='string'?preset.fixedPrompt:'';
   const end=typeof preset.fixedPrompt_end==='string'?preset.fixedPrompt_end:'';
   const positive=fixed+end;
   const negative=typeof preset.negativePrompt==='string'?preset.negativePrompt:'';
   if(positive.trim())pushUnique(out.artists,{name:String(presetName||'未命名画师串'),positive,negative,sourcePath:(pathName?pathName+'.':'')+'presets.'+presetName,source:'st-chatu8'},x=>x.name+'|'+x.positive+'|'+x.negative);
  }
 }
 const isVibeKey=/vibe|氛围转移|参考图组|参考组/i.test(pathName);
 const name=normName(data,pathName.split(/[.[]/).filter(Boolean).pop());
 const pos=textValue(/^fixedPrompt$|画师串|画师|artist|positive.?prompt|正向提示词|正面提示词|promptPositive/i);
 const neg=textValue(/^negativePrompt$|negative.?prompt|负向提示词|负面提示词/i);
 const prompt=textValue(/^prompt$|提示词内容|完整提示词|正文提示词|正向提示词/i);
 const vibeLike=isVibeKey||/vibe|氛围转移|参考图组|参考组/i.test(String(data.type||data.kind||''));
 if(vibeLike){
  const serialized=safeMigrationStringify(data)||'';
  const hasPayload=serialized.includes('data:image/')||/base64|encoded.?image|imageData|referenceImage|vibeData|vibe.*data/i.test(serialized);
  const hasRef=/https?:\/\/|blob:|cache.?id|image.?id|file.?name|path/i.test(serialized);
  pushUnique(out.vibes,{name,sourcePath:pathName,raw:data,hasPayload,hasRef},x=>x.name+'|'+x.sourcePath);
 }
 if(pos)pushUnique(out.artists,{name,positive:pos,negative:neg,sourcePath:pathName},x=>x.name+'|'+x.positive);
 else if(prompt&&(entries.some(([k])=>/preset|预设|artist|画师|style|画风/i.test(k))||/preset|预设|artist|画师|style|画风/i.test(pathName)))pushUnique(out.prompts,{name,category:'智绘姬迁移',prompt,negative:neg,sourcePath:pathName},x=>x.name+'|'+x.prompt);
 for(const [k,v] of entries){if(data.presets&&k==='presets')continue;if(v&&typeof v==='object')walkChatu8(v,pathName?pathName+'.'+k:k,out,seen);else if(typeof v==='string'&&/画师串|artist.?string/i.test(k)&&v.trim())pushUnique(out.artists,{name,positive:v.trim(),negative:neg,sourcePath:pathName+'.'+k},x=>x.name+'|'+x.positive);}
 return out;
}
function renderMigrationPreview(candidate,source){
 migrationCandidate=candidate;
 const host=$('#ql-migrate-preview');if(!host)return;
 const vibePayload=candidate.vibes.filter(v=>v.hasPayload).length;
 const vibeRef=candidate.vibes.length-vibePayload;
 host.textContent=source+'：画师串 '+candidate.artists.length+' 条，提示词预设 '+candidate.prompts.length+' 条，Vibe 项目 '+candidate.vibes.length+' 条。'+(candidate.warnings?.length?' 扫描警告 '+candidate.warnings.length+' 条。':'')+(vibeRef?' 其中 '+vibeRef+' 条未检测到可确认的内嵌图片编码。':'')+(candidate.artists.length+candidate.prompts.length+candidate.vibes.length?' 请确认后导入。':' 未识别到可迁移项目；建议在智绘姬中导出完整设置 JSON，再用文件导入。');
 $('#ql-migrate-import').disabled=!(candidate.artists.length||candidate.prompts.length||candidate.vibes.length);
}
function scanChatu8Settings(){
 const found=[];
 const isExport=value=>!!value&&typeof value==='object'&&(
  (value.groups&&typeof value.groups==='object'&&value.vibeData&&typeof value.vibeData==='object')||
  (value.presets&&typeof value.presets==='object'&&!Array.isArray(value.presets))
 );
 for(const [key,value] of Object.entries(extension_settings||{})){
  if(key===EXT)continue;
  if(/chatu8|智绘姬|zhihuiji/i.test(key)||isExport(value))found.push({key,value});
 }
 try{
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);if(!key||!/chatu8|智绘姬|zhihuiji/i.test(key))continue;
   const raw=localStorage.getItem(key);if(!raw)continue;
   try{found.push({key:'localStorage:'+key,value:JSON.parse(raw)});}catch{}
  }
 }catch(e){console.warn('[轻绘 Lite] 无法扫描 localStorage',e);}
 const merged={artists:[],prompts:[],vibes:[],warnings:[]};
 const seenKeys=new Set();
 for(const item of found){if(seenKeys.has(item.key))continue;seenKeys.add(item.key);try{walkChatu8(item.value,item.key,merged);}catch(e){merged.warnings.push(item.key+'：读取失败');}}
 renderMigrationPreview(merged,found.length?'当前酒馆扫描（'+found.map(x=>x.key).join('、')+'）':'当前酒馆扫描');
}
function safeMigrationStringify(value){try{return JSON.stringify(value);}catch{return '';}}
async function readMigrationFile(file){
 try{
  const text=await file.text();
  let data;
  try{data=JSON.parse(text);}catch{throw new Error('文件不是有效 JSON。请从智绘姬导出设置/预设文件后再选择。');}
  const candidate=walkChatu8(data,file.name);
  renderMigrationPreview(candidate,'文件 '+file.name);
 }catch(e){$('#ql-migrate-preview').textContent='读取失败：'+(e?.message||String(e));$('#ql-migrate-import').disabled=true;}
}
function importChatu8Candidate(){
 const candidate=migrationCandidate;if(!candidate)return;
 const s=cfg();let artists=0,prompts=0,vibes=0;
 for(const item of candidate.artists){
  if(!item.positive)continue;
  if(s.presets.some(x=>x.name===item.name&&x.positive===item.positive))continue;
  s.presets.unshift({name:item.name,positive:item.positive,negative:item.negative||'',source:'st-chatu8',sourcePath:item.sourcePath,updatedAt:Date.now()});artists++;
 }
 for(const item of candidate.prompts){
  if(!item.prompt)continue;
  if(s.prompts.some(x=>x.name===item.name&&x.prompt===item.prompt))continue;
  s.prompts.unshift({name:item.name,category:item.category||'智绘姬迁移',prompt:item.prompt,negative:item.negative||'',source:'st-chatu8',sourcePath:item.sourcePath,updatedAt:Date.now()});prompts++;
 }
 for(const item of candidate.vibes){
  const existingIndex=s.vibes.findIndex(x=>x.name===item.name&&x.sourcePath===item.sourcePath);
  const imported={name:item.name,groupName:item.groupName||item.name,entries:Array.isArray(item.entries)?item.entries.map(v=>({...v})):undefined,raw:item.raw,rawGroup:item.rawGroup,hasPayload:item.hasPayload,hasRef:item.hasRef,sourcePath:item.sourcePath,source:'st-chatu8',importedAt:Date.now()};
  if(existingIndex>=0){
   const existing=s.vibes[existingIndex];
   const oldHasPayload=Array.isArray(existing.entries)&&existing.entries.some(v=>typeof v.image==='string'&&v.image.replace(/\s+/g,'').length>160);
   const newHasPayload=Array.isArray(imported.entries)&&imported.entries.some(v=>typeof v.image==='string'&&v.image.replace(/\s+/g,'').length>160);
   if(!oldHasPayload&&newHasPayload){s.vibes[existingIndex]={...existing,...imported};vibes++;}
   continue;
  }
  s.vibes.push(imported);vibes++;
 }
 s.presets=s.presets.slice(0,500);s.prompts=s.prompts.slice(0,500);s.vibes=s.vibes.slice(0,200);
 save();renderLibrary();
 status('迁移完成：画师串 '+artists+' 条，提示词 '+prompts+' 条，Vibe 项目 '+vibes+' 条。Vibe 资源仍需逐项检查是否含完整编码/图片数据。');
 $('#ql-migrate-import').disabled=true;
}

function init(){const root=$('#qinghui-lite-panel');if(!root||root.dataset.ready)return;root.dataset.ready='1';const s=cfg();$('#ql-provider').value=s.provider||'openai';$('#ql-endpoint').value=s.endpoint;$('#ql-key').value=s.apiKey;$('#ql-model').value=s.model;$('#ql-size').value=s.size;$('#ql-quality').value=s.quality;$('#ql-nai-model').value=s.naiModel||'nai-diffusion-4-5-full';$('#ql-nai-steps').value=s.naiSteps||28;$('#ql-nai-scale').value=s.naiScale||5;$('#ql-nai-width').value=s.naiWidth||832;$('#ql-nai-height').value=s.naiHeight||1216;$('#ql-nai-sampler').value=s.naiSampler||'k_euler_ancestral';$('#ql-nai-scheduler').value=s.naiScheduler||'karras';$('#ql-prompt').value=s.prompt;$('#ql-negative').value=s.negative;const toggleProvider=()=>{const nai=$('#ql-provider').value==='novelai';$('#ql-openai-settings').hidden=nai;$('#ql-nai-settings').hidden=!nai;};$('#ql-provider').onchange=toggleProvider;toggleProvider();$('#ql-fast-provider').value=s.provider||'openai';$('#ql-fast-model').value=s.model||'gpt-image-1';$('#ql-fast-size').value=s.size||'1024x1024';$('#ql-fast-quality').value=s.quality||'medium';$('#ql-fast-nai-model').value=s.naiModel||'nai-diffusion-4-5-full';$('#ql-fast-nai-steps').value=s.naiSteps||28;$('#ql-fast-nai-scale').value=s.naiScale||5;$('#ql-fast-nai-width').value=s.naiWidth||832;$('#ql-fast-nai-height').value=s.naiHeight||1216;$('#ql-fast-nai-sampler').value=s.naiSampler||'k_euler_ancestral';$('#ql-fast-nai-scheduler').value=s.naiScheduler||'karras';$('#ql-fast-nai-normalize').checked=s.naiNormalizeVibeStrengths!==false;const toggleFast=()=>{const nai=$('#ql-fast-provider').value==='novelai';$('#ql-fast-openai').hidden=nai;$('#ql-fast-nai').hidden=!nai;syncFastControls();$('#ql-provider').value=$('#ql-fast-provider').value;toggleProvider();};$('#ql-fast-provider').onchange=toggleFast;toggleFast();$('#ql-tag-add').onclick=()=>{const tag=$('#ql-tag-input').value.trim();if(!tag)return;$('#ql-prompt').value=[$('#ql-prompt').value.trim(),tag].filter(Boolean).join(', ');$('#ql-tag-input').value='';read();renderTagChips();};$('#ql-prompt').addEventListener('input',renderTagChips);$('#ql-active-preset').onchange=()=>{cfg().activePresetIndex=Number($('#ql-active-preset').value);save();};$('#ql-apply-preset').onclick=()=>{const i=Number($('#ql-active-preset').value),p=cfg().presets[i];if(!p)return;cfg().activePresetIndex=i;save();status('已选中画师串：'+p.name+'，生成时会自动组合。');};$('#ql-open-preset').onclick=()=>{root.querySelector('.ql-tab[data-page="library"]')?.click();root.querySelector('.ql-subtab[data-subpage="artists"]')?.click();};$('#ql-bind-character').onchange=()=>renderBindings();$('#ql-bind-save').onclick=()=>{const key=$('#ql-bind-character').value;if(!key){status('请先选择角色卡。');return;}const ctx=getContext()||{},ch=(ctx.characters||[])[Number(key)],name=ch?.name||ch?.avatar||('角色 '+key),binding={characterKey:String(key),characterName:name,presetIndex:Number($('#ql-bind-preset').value),vibeIndex:Number($('#ql-bind-vibe').value),updatedAt:Date.now()};const old=s.bindings.findIndex(x=>x.characterKey===binding.characterKey||x.characterName===name);if(old>=0)s.bindings[old]=binding;else s.bindings.push(binding);save();renderBindings();status('已保存角色绑定：'+name);};$('#ql-vibe-pick').onclick=()=>$('#ql-vibe-import-file').click();$('#ql-vibe-import-file').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;pendingVibeImage=null;const ext=file.name.toLowerCase();if(file.type.startsWith('image/')){pendingVibeImage=file;$('#ql-vibe-name').value=$('#ql-vibe-name').value||file.name.replace(/\.[^.]+$/,'');$('#ql-vibe-status').textContent='已选择图片：'+file.name+'。点击编码开始处理；NovelAI 可能收取 Anlas。';return;}if(ext.endsWith('.json')||ext.endsWith('.json5')||ext.endsWith('.txt')||ext.endsWith('.naiv4vibe')||ext.endsWith('.naiv4vibebundle')){try{let data;try{data=JSON.parse(await file.text());}catch{const files=await readVibeArchiveJson(file);if(!files.length)throw new Error('无法从该文件中读取 JSON 资源；该 Vibe 文件可能使用了当前浏览器不支持的打包格式。');data=files;}const candidate=walkChatu8(data,file.name),added=[];for(const item of candidate.vibes){const encoded=extractUsableVibe(item.raw||item);const entries=Array.isArray(item.entries)?item.entries.map(x=>{const extracted=extractUsableVibe(x.raw||x);const image=typeof x.image==='string'&&x.image.trim()?x.image.trim().replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,''):extracted?.image||'';return {...x,image,strength:Number(x.strength??extracted?.strength??0.6),informationExtracted:Number(x.informationExtracted??extracted?.informationExtracted??1)};}):encoded?[{...encoded}]:[];const hasPayload=entries.some(x=>typeof x.image==='string'&&x.image.length>160);s.vibes.push({...item,entries,hasPayload,importedAt:Date.now()});added.push(item.name);}if(!added.length)throw new Error('文件中没有识别到 Vibe 分组；可尝试“迁移”页导入智绘姬完整设置。');save();renderLibrary();renderActiveVibes();const usable=added.filter(name=>s.vibes.find(v=>v.name===name)?.hasPayload).length;$('#ql-vibe-status').textContent='已读取 '+added.length+' 组 Vibe，其中 '+usable+' 组含可识别的预编码资源。请检查各条参考状态；未识别编码的项目不会被当作可用 Vibe。';}catch(err){$('#ql-vibe-status').textContent='导入失败：'+(err?.message||String(err));}return;}$('#ql-vibe-status').textContent='此文件格式无法直接解析。请确认它是标准 .naiv4vibe / bundle 压缩包，或使用 JSON / 智绘姬组格式。';};$('#ql-vibe-encode').onclick=async()=>{if(!pendingVibeImage){$('#ql-vibe-status').textContent='请先选择 PNG、JPG 或 WebP 图片。';return;}const button=$('#ql-vibe-encode');button.disabled=true;$('#ql-vibe-status').textContent='正在请求酒馆 NovelAI Vibe 编码接口……';try{const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('无法读取图片'));reader.readAsDataURL(pendingVibeImage);});const image=dataUrl.replace(/^data:image\/[^;]+;base64,/,'');const response=await fetch('/api/novelai/encode-vibe',{method:'POST',headers:{'Content-Type':'application/json',...getRequestHeaders(window.token)},body:JSON.stringify({image,model:cfg().naiModel||'nai-diffusion-4-5-full',information_extracted:Number($('#ql-vibe-info').value)||1,crop_to_mask:false,focus_seed:-1,info_extract_seed:-1,mask:''})});if(!response.ok)throw new Error('酒馆未能完成 Vibe 编码（HTTP '+response.status+'）。当前酒馆版本可能没有暴露 encode-vibe 代理接口。');const buffer=await response.arrayBuffer();let binary='';for(const byte of new Uint8Array(buffer))binary+=String.fromCharCode(byte);const encoded=btoa(binary);const name=$('#ql-vibe-name').value.trim()||pendingVibeImage.name;s.vibes.push({name,source:'image-encode',hasPayload:true,entries:[{image:encoded,strength:0.6,informationExtracted:Number($('#ql-vibe-info').value)||1}],importedAt:Date.now()});save();renderLibrary();renderActiveVibes();$('#ql-vibe-status').textContent='编码完成并保存：'+name;pendingVibeImage=null;}catch(err){$('#ql-vibe-status').textContent='编码失败：'+(err?.message||String(err));}finally{button.disabled=false;}};renderTagChips();renderActivePresets();renderBindings();history();renderLibrary();$('#ql-migrate-scan').onclick=scanChatu8Settings;$('#ql-migrate-file-btn').onclick=()=>$('#ql-migrate-file').click();$('#ql-migrate-file').onchange=e=>{const f=e.target.files?.[0];if(f)readMigrationFile(f);};$('#ql-migrate-import').onclick=importChatu8Candidate;
$('#ql-save').onclick=()=>{read();status('设置已保存到酒馆扩展设置。');};$('#ql-theme-preset').value=s.themePreset||'auto';$('#ql-theme-css').value=s.themeCss||'';applyTheme($('#ql-theme-preset').value,$('#ql-theme-css').value);$('#ql-theme-apply').onclick=()=>{const preset=$('#ql-theme-preset').value,css=$('#ql-theme-css').value;cfg().themePreset=preset;cfg().themeCss=css;save();applyTheme(preset,css);$('#ql-theme-status').textContent=preset==='auto'?'已恢复跟随酒馆主题。':preset==='custom'?'已应用自定义 CSS。':'已应用低饱和配色。';};$('#ql-theme-reset').onclick=()=>{$('#ql-theme-preset').value='auto';$('#ql-theme-css').value='';cfg().themePreset='auto';cfg().themeCss='';save();applyTheme('auto','');$('#ql-theme-status').textContent='已恢复自适配酒馆美化。';};$('#ql-theme-preset').onchange=()=>{if($('#ql-theme-preset').value!=='custom')$('#ql-theme-status').textContent='点击“应用配色”后生效。';};
$('#ql-generate').onclick=async()=>{
 if(busy)return;read();const conf=cfg();
 if(!conf.prompt.trim()){status('请填写正向提示词。');return;}
 if(conf.provider!=='novelai'&&(!conf.endpoint||!conf.apiKey)){status('请填写 OpenAI 兼容 API 地址和 Key。');return;}
 busy=true;$('#ql-generate').disabled=true;$('#ql-result').replaceChildren();status('正在请求生图接口……');
 try{
  const activeIndex=Number(conf.activeVibeIndex??-1);const activeVibe=activeIndex>=0?conf.vibes[activeIndex]:null;const activePresetIndex=Number(conf.activePresetIndex??-1);const activePreset=activePresetIndex>=0?conf.presets[activePresetIndex]:null;const finalPrompt=[conf.prompt.trim(),activePreset?.positive].filter(Boolean).join(', ');const finalNegative=[conf.negative.trim(),activePreset?.negative].filter(Boolean).join(', ');const url=await requestImage(finalPrompt,finalNegative,activeVibe);
  const img=document.createElement('img');img.alt='轻绘生成结果';img.src=url;$('#ql-result').append(img);
  conf.records.unshift({at:Date.now(),prompt:conf.prompt.trim(),negative:conf.negative.trim(),provider:conf.provider,model:conf.provider==='novelai'?conf.naiModel:conf.model,size:conf.provider==='novelai'?(conf.naiWidth+'x'+conf.naiHeight):conf.size,quality:conf.quality,dataUrl:url});
  conf.records=conf.records.slice(0,20);save();history();status('生成完成。记录已保存在酒馆扩展设置中。');
 }catch(e){status('生成失败：'+(e?.message||String(e))+'。');}
 finally{busy=false;$('#ql-generate').disabled=false;}
}
$('#ql-prompt-save').onclick=()=>{const name=$('#ql-prompt-name').value.trim(),prompt=$('#ql-library-prompt').value.trim();if(!name||!prompt){status('提示词名称和内容不能为空。');return;}const item={name,category:$('#ql-prompt-category').value.trim(),prompt,negative:$('#ql-library-negative').value.trim(),updatedAt:Date.now()};const edit=$('#ql-prompt-save').dataset.edit;if(edit!==undefined){cfg().prompts[Number(edit)]=item;delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';}else cfg().prompts.unshift(item);cfg().prompts=cfg().prompts.slice(0,200);save();renderLibrary();status('提示词已保存。');};
$('#ql-character-save').onclick=()=>{const name=$('#ql-character-name').value.trim(),appearance=$('#ql-character-appearance').value.trim();if(!name||!appearance){status('请填写角色名称和外貌词。');return;}const item={name,appearance,updatedAt:Date.now()};const edit=$('#ql-character-save').dataset.edit;if(edit!==undefined){cfg().characters[Number(edit)]=item;delete $('#ql-character-save').dataset.edit;$('#ql-character-save').textContent='保存角色';}else cfg().characters.unshift(item);cfg().characters=cfg().characters.slice(0,100);save();renderLibrary();status('角色已保存。');};
$('#ql-preset-save').onclick=()=>{const name=$('#ql-preset-name').value.trim(),positive=$('#ql-preset-positive').value.trim();if(!name||!positive){status('预设名称和正向画风串不能为空。');return;}const item={name,positive,negative:$('#ql-preset-negative').value.trim(),updatedAt:Date.now()};const edit=$('#ql-preset-save').dataset.edit;if(edit!==undefined){cfg().presets[Number(edit)]=item;delete $('#ql-preset-save').dataset.edit;}else cfg().presets.unshift(item);cfg().presets=cfg().presets.slice(0,100);$('#ql-preset-edit-select').value=String(cfg().presets.findIndex(x=>x.name===item.name&&x.positive===item.positive));const savedIndex=cfg().presets.findIndex(x=>x.name===item.name&&x.positive===item.positive);if(savedIndex>=0){$('#ql-preset-save').dataset.edit=String(savedIndex);$('#ql-preset-save').textContent='保存修改';}save();renderLibrary();status('画师串已保存，可通过上方下拉框切换编辑。');};
$('#ql-clear').onclick=()=>{if(confirm('清空轻绘本地生成记录？不会删除聊天图片。')){cfg().records=[];save();history();status('记录已清空。');}};
}
jQuery(()=>{
 if(!$('#ql-overlay')){
  document.documentElement.insertAdjacentHTML('beforeend',html());
  const overlay=$('#ql-overlay');
  const panel=$('#qinghui-lite-panel');
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-modal','true');
  panel.setAttribute('aria-label','轻绘 Lite');
  const close=$('#ql-close',panel);
  const open=()=>{
   overlay.hidden=false;
   document.body.classList.add('ql-modal-open');
   const first=panel.querySelector('textarea,input,select,button');
   first?.focus({preventScroll:true});
  };
  const shut=()=>{overlay.hidden=true;document.body.classList.remove('ql-modal-open');};
  close.addEventListener('click',shut);
  overlay.addEventListener('click',e=>{if(e.target===overlay)shut();});
  document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!overlay.hidden)shut();});
  const mountLauncher=()=>{
   const menu=$('#extensionsMenu');
   if(!menu)return false;
   let launch=$('#ql-chat-launch');
   if(!launch){
    // 将入口注册到酒馆原生魔法棒/扩展菜单，而不是创建发送区新按钮。
    launch=document.createElement('div');
    launch.id='ql-chat-launch';
    launch.className='list-group-item flex-container flexGap5';
    launch.setAttribute('role','button');
    launch.setAttribute('tabindex','0');
    launch.title='打开轻绘 Lite 生图工作区';
    launch.innerHTML='<i class="fa-solid fa-palette"></i><span>轻绘 Lite</span>';
    launch.addEventListener('click',open);
    launch.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
   }
   if(launch.parentElement!==menu)menu.append(launch);
   return true;
  };
  if(!mountLauncher()){
   // 等待酒馆原生扩展菜单创建完成，再注册菜单项。
   const observer=new MutationObserver(()=>{
    if(mountLauncher())observer.disconnect();
   });
   observer.observe(document.body,{childList:true,subtree:true});
  }
  panel.addEventListener('click',event=>{const tab=event.target.closest('.ql-subtab');if(!tab||!panel.contains(tab))return;event.preventDefault();const target=tab.dataset.subpage;panel.querySelectorAll('.ql-subtab').forEach(item=>{const active=item===tab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});panel.querySelectorAll('[data-subpage-panel]').forEach(page=>{const active=page.dataset.subpagePanel===target;page.hidden=!active;page.classList.toggle('active',active);});const page=panel.querySelector('[data-subpage-panel="'+target+'"]');if(page)page.scrollTop=0;});
  panel.querySelectorAll('.ql-tab').forEach(tab=>tab.addEventListener('click',()=>{
   const target=tab.dataset.page;
   panel.querySelectorAll('.ql-tab').forEach(item=>{const active=item===tab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});
   panel.querySelectorAll('[data-page-panel]').forEach(page=>{const active=page.dataset.pagePanel===target;page.hidden=!active;page.classList.toggle('active',active);});
   const activePage=panel.querySelector('[data-page-panel="'+target+'"]');
   if(activePage)activePage.scrollTop=0;
  }));
  init();
 }
 observeStatusbarFrames();
 if(!eventSource||!event_types)return;
 let scanTimer=null;
 const scheduleScan=()=>{if(scanTimer)clearTimeout(scanTimer);scanTimer=setTimeout(()=>{
  scanTimer=null;
  processLatestAssistantMessage().catch(e=>console.warn('[轻绘 Lite] 自动触发失败',e));
  processStatusbarFrames().catch(e=>console.warn('[轻绘 Lite] 状态栏触发失败',e));
 },120);};
 // 生成结束与 swipe 是稳定兜底；如果当前酒馆版本提供流式事件，则在完整 marker 到达时提前触发。
 for(const name of ['STREAM_TOKEN_RECEIVED','MESSAGE_UPDATED','GENERATION_ENDED','MESSAGE_SWIPED']){
  const eventName=event_types[name];
  if(eventName)eventSource.on(eventName,scheduleScan);
 }
 if(event_types.CHAT_CHANGED)eventSource.on(event_types.CHAT_CHANGED,()=>{autoTasks.clear();renderBindings();applyCurrentBinding();});
 if(event_types.CHARACTER_SELECTED)eventSource.on(event_types.CHARACTER_SELECTED,()=>{renderBindings();applyCurrentBinding();});
 applyCurrentBinding();
});
