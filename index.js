import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '/script.js';
import { parseImageMarkers, makeTriggerId, TriggerRegistry } from './trigger-core.js';

const EXT = 'qinghui_lite';
const defaults = { vibes:[], activeVibeIndex:-1, provider:'openai', endpoint:'https://api.openai.com/v1', apiKey:'', model:'gpt-image-1', size:'1024x1024', quality:'medium', naiModel:'nai-diffusion-4-5-full', naiSteps:28, naiScale:5, naiWidth:832, naiHeight:1216, naiSampler:'k_euler_ancestral', naiScheduler:'karras', prompt:'', negative:'', records:[], presets:[], characters:[], prompts:[] };
const $ = (s, root=document) => root.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let busy=false;
function cfg(){ extension_settings[EXT] ??= JSON.parse(JSON.stringify(defaults)); const s=extension_settings[EXT]; for(const key of ['records','presets','characters','prompts','vibes'])if(!Array.isArray(s[key]))s[key]=[]; return s; }
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
   const vibes=Array.isArray(vibeItem.entries)&&vibeItem.entries.length
    ?vibeItem.entries.filter(item=>typeof item.image==='string'&&item.image.trim()).map(item=>({image:item.image,strength:Number(item.strength??0.6),informationExtracted:Number(item.informationExtracted??1)}))
    :(()=>{const one=extractUsableVibe(vibeItem.raw);return one?[one]:[];})();
   if(!vibes.length)throw new Error('所选 Vibe 的原始数据已保留，但尚未识别出可安全发送给 NovelAI 的编码图像；不会将辨识用 PNG 当作 Vibe 输入。');
   payload.reference_image_multiple=vibes.map(v=>v.image);
   payload.reference_strength_multiple=vibes.map(v=>v.strength);
   payload.reference_information_extracted_multiple=vibes.map(v=>v.informationExtracted);
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
function extractUsableVibe(raw){
 const imageKeys=/^(?:image|imageData|image_data|referenceImage|reference_image|referenceImageData|reference_image_data|vibeImage|vibe_image|base64|imageBase64|image_base64|data)$/i;
 const seen=new WeakSet();let found='';
 const walk=(value,key='')=>{
  if(found||value==null)return;
  if(typeof value==='string'){
   const v=value.trim();
   if(/^data:image\/[^;]+;base64,/i.test(v)){found=v.replace(/^data:image\/[^;]+;base64,/i,'');return;}
   if(imageKeys.test(key)&&/^[A-Za-z0-9+/]+={0,2}$/.test(v)&&v.length>160){found=v;return;}
   return;
  }
  if(typeof value!=='object'||seen.has(value))return;seen.add(value);
  if(Array.isArray(value)){for(const item of value)walk(item,key);return;}
  for(const [k,v] of Object.entries(value))walk(v,k);
 };
 walk(raw);
 if(!found)return null;
 const serialized=safeMigrationStringify(raw)||'';
 const readNumber=(re,fallback)=>{const m=serialized.match(re);return m?Number(m[1]):fallback;};
 const strength=readNumber(/"(?:reference_strength|referenceStrength|strength)"\s*:\s*([0-9.]+)/i,0.6);
 const informationExtracted=readNumber(/"(?:reference_information_extracted|referenceInformationExtracted|information_extracted|informationExtracted|info_extracted)"\s*:\s*([0-9.]+)/i,0.7);
 const norm=serialized.match(/"normalize_reference_strength"\s*:\s*(true|false)/i);
 return {image:found,strength,informationExtracted,normalize:norm?norm[1]==='true':undefined};
}
function renderActiveVibes(){
 const select=$('#ql-active-vibe');if(!select)return;
 const prior=String(cfg().activeVibeIndex??-1);
 select.innerHTML='<option value="-1">不使用 Vibe</option>'+cfg().vibes.map((v,i)=>'<option value="'+i+'">'+esc(v.name||('Vibe '+(i+1)))+(v.hasPayload?' · 保留了疑似编码':' · 原始数据待核验')+'</option>').join('');
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
  reroll.addEventListener('click',async()=>{if(card.dataset.qlBusy==='1')return;const candidate=triggerRegistry.beginCandidate(taskKey,{prompt,source:'chat-reroll',...recordMeta});if(!candidate.accepted)return;triggerRegistry.markRunning(taskKey);card.dataset.qlBusy='1';reroll.disabled=true;const old=reroll.textContent;reroll.textContent='生成中…';try{const fresh=await requestImage(prompt);card._qlCandidates.push({url:fresh,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;render();storeChatRecord(fresh,prompt,taskKey,recordMeta);triggerRegistry.markSucceeded(taskKey,taskKey+':candidate:'+Date.now());}catch(e){triggerRegistry.markFailed(taskKey,e?.message||String(e));const note=document.createElement('p');note.className='ql-chat-image-status';note.textContent='轻绘生成失败：'+(e?.message||String(e));card.append(note);}finally{card.dataset.qlBusy='0';reroll.disabled=false;reroll.textContent=old;}});
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
   const url=await requestImage(marker.prompt);
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
  reroll.onclick=async()=>{if(card.dataset.busy==='1')return;const candidate=triggerRegistry.beginCandidate(taskKey,{prompt:card._qlPrompt,source:'statusbar-reroll'});if(!candidate.accepted)return;triggerRegistry.markRunning(taskKey);card.dataset.busy='1';reroll.disabled=true;const old=reroll.textContent;reroll.textContent='生成中';try{const fresh=await requestImage(card._qlPrompt);card._qlCandidates.push({url:fresh,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;render();storeChatRecord(fresh,card._qlPrompt,taskKey,{source:'statusbar'});triggerRegistry.markSucceeded(taskKey,taskKey+':candidate:'+Date.now());}catch(e){triggerRegistry.markFailed(taskKey,e?.message||String(e));statusbarError(frame,card._qlPrompt,taskKey,e);}finally{card.dataset.busy='0';reroll.disabled=false;reroll.textContent=old;}};
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
   const url=await requestImage(prompt);
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
   const url=await requestImage(prompt);
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

function save(){ saveSettingsDebounced(); }
function html(){return `<div id="ql-overlay" hidden><section id="qinghui-lite-panel">
<div class="ql-card"><h3>轻绘 Lite · 测试版</h3><p class="ql-muted">独立工作区支持 GPT / OpenAI 兼容接口和酒馆已配置的 NovelAI 连接。状态栏画面框注入已接入，尚需实际酒馆验证。</p>
<label>生图后端</label><select id="ql-provider"><option value="openai">GPT / OpenAI 兼容接口</option><option value="novelai">NovelAI（使用酒馆已配置的连接）</option></select>
<div id="ql-openai-settings"><label>API 地址</label><input id="ql-endpoint" placeholder="https://api.openai.com/v1">
<label>API Key</label><input id="ql-key" type="password" autocomplete="off" placeholder="不会写入 GitHub">
<label>模型</label><input id="ql-model" placeholder="gpt-image-1">
<div class="ql-row"><div><label>尺寸</label><select id="ql-size"><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option></select></div><div><label>质量</label><select id="ql-quality"><option>low</option><option selected>medium</option><option>high</option></select></div></div>
</div><div id="ql-nai-settings" hidden><label>NovelAI 模型</label><input id="ql-nai-model" value="nai-diffusion-4-5-full"><div class="ql-row"><div><label>步数</label><input id="ql-nai-steps" type="number" min="1" max="50"></div><div><label>CFG Scale</label><input id="ql-nai-scale" type="number" min="1" max="20" step="0.5"></div></div><div class="ql-row"><div><label>宽度</label><select id="ql-nai-width"><option>512</option><option>640</option><option>768</option><option selected>832</option><option>1024</option></select></div><div><label>高度</label><select id="ql-nai-height"><option>512</option><option>640</option><option>768</option><option selected>1216</option><option>1024</option><option>1536</option></select></div></div><label>采样器</label><select id="ql-nai-sampler"><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option></select><label>调度器</label><select id="ql-nai-scheduler"><option value="karras">Karras</option><option value="native">Native</option></select></div><button id="ql-save" class="menu_button">保存后端设置</button></div>
<div class="ql-card"><h3>独立生图工作区</h3><label for="ql-active-vibe">Vibe 参考（仅 NovelAI，需导入含图片编码的资源）</label><select id="ql-active-vibe"><option value="-1">不使用 Vibe</option></select><p class="ql-muted">导入的 Vibe 会显示在这里；如果只有名称或缓存引用，不能直接用于生成，需要先从智绘姬导出包含参考图数据的设置。</p><label>完整正向提示词</label><textarea id="ql-prompt" placeholder="输入完整提示词"></textarea><label>负向提示词</label><textarea id="ql-negative" placeholder="可选"></textarea><button id="ql-generate" class="menu_button">生成一张</button><p id="ql-status" class="ql-muted" role="status"></p><div id="ql-result"></div></div>
<div class="ql-card"><h3>最近生成（本地记录）</h3><div id="ql-history"></div><button id="ql-clear" class="menu_button">清空记录</button></div>
<div class="ql-card"><h3>提示词库</h3><div class="ql-row"><input id="ql-prompt-name" placeholder="名称"><input id="ql-prompt-category" placeholder="分类"></div><label>完整正向提示词</label><textarea id="ql-library-prompt" placeholder="保存完整提示词"></textarea><label>负向提示词</label><textarea id="ql-library-negative"></textarea><button id="ql-prompt-save" class="menu_button">保存提示词</button><div id="ql-prompts-list"></div></div>
<div class="ql-card"><h3>角色库</h3><input id="ql-character-name" placeholder="角色名称"><label>固定外貌词</label><textarea id="ql-character-appearance"></textarea><button id="ql-character-save" class="menu_button">保存角色</button><div id="ql-characters-list"></div></div>
<div class="ql-card"><h3>画风预设</h3><input id="ql-preset-name" placeholder="预设名称"><label>正向画风串</label><textarea id="ql-preset-positive"></textarea><label>负向提示词</label><textarea id="ql-preset-negative"></textarea><button id="ql-preset-save" class="menu_button">保存预设</button><div id="ql-presets-list"></div></div><div class="ql-card"><h3>智绘姬一键迁移</h3><p class="ql-muted">先扫描当前酒馆可访问的智绘姬设置；也可以选择智绘姬导出的 JSON 文件。迁移前会预览，已有数据不会被覆盖。</p><div class="ql-row"><button id="ql-migrate-scan" class="menu_button">扫描当前酒馆</button><button id="ql-migrate-file-btn" class="menu_button">选择导出文件</button><input id="ql-migrate-file" type="file" accept=".json,.json5,.txt,application/json" hidden></div><div id="ql-migrate-preview" class="ql-muted" role="status">尚未扫描。</div><button id="ql-migrate-import" class="menu_button" disabled>确认导入</button><p class="ql-muted">画师串与文本预设可迁移；Vibe 项目会先保留名称和原始数据供核对。只有确认参考图与编码字段后，才会接入实际生图调用。</p><div id="ql-vibes-list"></div></div></section></div>`;}
function read(){const s=cfg();s.provider=$('#ql-provider').value;s.endpoint=$('#ql-endpoint').value.trim().replace(/\/$/,'');s.apiKey=$('#ql-key').value.trim();s.model=$('#ql-model').value.trim()||'gpt-image-1';s.size=$('#ql-size').value;s.quality=$('#ql-quality').value;s.naiModel=$('#ql-nai-model').value.trim()||'nai-diffusion-4-5-full';s.naiSteps=Number($('#ql-nai-steps').value)||28;s.naiScale=Number($('#ql-nai-scale').value)||5;s.naiWidth=Number($('#ql-nai-width').value)||832;s.naiHeight=Number($('#ql-nai-height').value)||1216;s.naiSampler=$('#ql-nai-sampler').value;s.naiScheduler=$('#ql-nai-scheduler').value;s.prompt=$('#ql-prompt').value;s.negative=$('#ql-negative').value;save();}
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
 if(presets)presets.innerHTML=(s.presets||[]).map((p,i)=>'<div class="ql-record"><strong>'+esc(p.name)+'</strong><p>'+esc(p.positive)+'</p><button class="menu_button" data-preset-apply="'+i+'">应用</button><button class="menu_button" data-preset-delete="'+i+'">删除</button></div>').join('')||'<p class="ql-muted">暂无预设</p>';
 if(vibes)vibes.innerHTML=(s.vibes||[]).map((v,i)=>'<div class="ql-record"><strong>'+esc(v.name||'未命名 Vibe')+'</strong><p>'+esc(Array.isArray(v.entries)&&v.entries.length?'已保留 '+v.entries.length+' 条 Vibe 原始记录；头像仅用于辨识，编码字段仍需核验':(v.hasPayload?'检测到疑似内嵌编码，尚未确认格式':(v.hasRef?'检测到外部引用，需重新关联':'未识别到图片或编码字段')))+'</p><details><summary>查看迁移信息</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto">'+esc(JSON.stringify({sourcePath:v.sourcePath,hasPayload:v.hasPayload,hasRef:v.hasRef,groupName:v.groupName,entries:Array.isArray(v.entries)?v.entries.map(({image,previewImage,raw,...meta})=>({...meta,image:image?'[生图输入数据已保存，长度 '+String(image).length+' 字符]':'[未绑定生图输入]',previewImage:previewImage?'[仅供辨识的预览图已保留，长度 '+String(previewImage).length+' 字符]':'',raw:raw?'[原始 Vibe 数据已完整保留]':undefined})):undefined,raw:v.raw},null,2).slice(0,5000))+'</pre></details><button class="menu_button" data-vibe-delete="'+i+'">删除迁移项</button></div>').join('')||'<p class="ql-muted">暂无迁移的 Vibe 项目</p>';
 vibes?.querySelectorAll('[data-vibe-delete]').forEach(b=>b.onclick=()=>{if(!confirm('删除这条轻绘 Vibe 迁移记录？'))return;s.vibes.splice(+b.dataset.vibeDelete,1);save();renderLibrary();});
 renderActiveVibes();
 prompts?.querySelectorAll('[data-prompt-load]').forEach(b=>b.onclick=()=>{const p=s.prompts[+b.dataset.promptLoad];$('#ql-prompt').value=p.prompt;$('#ql-negative').value=p.negative||'';read();status('已载入提示词：'+p.name);});
 prompts?.querySelectorAll('[data-prompt-edit]').forEach(b=>b.onclick=()=>{const p=s.prompts[+b.dataset.promptEdit];$('#ql-prompt-name').value=p.name||'';$('#ql-prompt-category').value=p.category||'';$('#ql-library-prompt').value=p.prompt||'';$('#ql-library-negative').value=p.negative||'';$('#ql-prompt-save').dataset.edit=String(+b.dataset.promptEdit);$('#ql-prompt-save').textContent='保存修改';});
  prompts?.querySelectorAll('[data-prompt-delete]').forEach(b=>b.onclick=()=>{s.prompts.splice(+b.dataset.promptDelete,1);save();renderLibrary();});
 chars?.querySelectorAll('[data-character-apply]').forEach(b=>b.onclick=()=>{const p=s.characters[+b.dataset.characterApply];$('#ql-prompt').value=[$('#ql-prompt').value.trim(),p.appearance].filter(Boolean).join(', ');read();status('已追加角色外貌词：'+p.name);});
 chars?.querySelectorAll('[data-character-edit]').forEach(b=>b.onclick=()=>{const p=s.characters[+b.dataset.characterEdit];$('#ql-character-name').value=p.name||'';$('#ql-character-appearance').value=p.appearance||'';$('#ql-character-save').dataset.edit=String(+b.dataset.characterEdit);$('#ql-character-save').textContent='保存修改';});
  chars?.querySelectorAll('[data-character-delete]').forEach(b=>b.onclick=()=>{s.characters.splice(+b.dataset.characterDelete,1);save();renderLibrary();});
 presets?.querySelectorAll('[data-preset-apply]').forEach(b=>b.onclick=()=>{const p=s.presets[+b.dataset.presetApply];$('#ql-prompt').value=[$('#ql-prompt').value.trim(),p.positive].filter(Boolean).join(', ');if(p.negative)$('#ql-negative').value=[$('#ql-negative').value.trim(),p.negative].filter(Boolean).join(', ');read();status('已应用预设：'+p.name);});
 presets?.querySelectorAll('[data-preset-edit]').forEach(b=>b.onclick=()=>{const p=s.presets[+b.dataset.presetEdit];$('#ql-preset-name').value=p.name||'';$('#ql-preset-positive').value=p.positive||'';$('#ql-preset-negative').value=p.negative||'';$('#ql-preset-save').dataset.edit=String(+b.dataset.presetEdit);$('#ql-preset-save').textContent='保存修改';});
  presets?.querySelectorAll('[data-preset-delete]').forEach(b=>b.onclick=()=>{s.presets.splice(+b.dataset.presetDelete,1);save();renderLibrary();});
}

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
    // 智绘姬导出的 image 可能只是用于辨识的 PNG 头像；保留原始记录，但绝不把它当作 NovelAI Vibe 输入。
    const previewImage=[stored.previewImage,stored.thumbnail,stored.avatar,stored.image].find(v=>typeof v==='string'&&v.trim())||'';
    const payloadKeys=Object.keys(stored).filter(k=>/encoded|embedding|vibe.?data|reference.?data|payload/i.test(k)&&!/(id|name|label)/i.test(k));
    const hasPayload=payloadKeys.some(k=>typeof stored[k]==='string'&&stored[k].length>160);
    images.push({vibeDataId:ref.vibeDataId,image:'',previewImage,raw:stored,strength:Number.isFinite(Number(ref.strength))?Number(ref.strength):0.6,informationExtracted:Number.isFinite(Number(stored.informationExtracted??stored.information_extracted))?Number(stored.informationExtracted??stored.information_extracted):1,identifier:stored.identifier||'',version:stored.version??1,type:stored.type||'image',hasPayload});
   }
   if(images.length)pushUnique(out.vibes,{name:String(groupName||'未命名 Vibe'),groupName:String(groupName||'未命名 Vibe'),entries:images,hasPayload:images.some(v=>v.hasPayload),hasRef:false,rawGroup:group,sourcePath:pathName,source:'st-chatu8'},x=>x.name+'|'+x.sourcePath);
   else if(group.vibes.length)out.warnings.push('Vibe 分组「'+groupName+'」没有可保留的数据。');
  }
  for(const [k,v] of entries){if(k==='groups'||k==='vibeData')continue;if(v&&typeof v==='object')walkChatu8(v,pathName?pathName+'.'+k:k,out,seen);}
  return out;
 }
 if(Array.isArray(data)){for(let i=0;i<data.length;i++)walkChatu8(data[i],pathName+'['+i+']',out,seen);return out;}
 const isVibeKey=/vibe|氛围转移|参考图组|参考组/i.test(pathName);
 const name=normName(data,pathName.split(/[.[]/).filter(Boolean).pop());
 const pos=textValue(/画师串|画师|artist|positive.?prompt|正向提示词|正面提示词|promptPositive/i);
 const neg=textValue(/negative.?prompt|负向提示词|负面提示词/i);
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
 for(const [k,v] of entries){if(v&&typeof v==='object')walkChatu8(v,pathName?pathName+'.'+k:k,out,seen);else if(typeof v==='string'&&/画师串|artist.?string/i.test(k)&&v.trim())pushUnique(out.artists,{name,positive:v.trim(),negative:neg,sourcePath:pathName+'.'+k},x=>x.name+'|'+x.positive);}
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
 for(const [key,value] of Object.entries(extension_settings||{})){
  if(/chatu8|智绘姬|zhihuiji/i.test(key))found.push({key,value});
  else if(value&&typeof value==='object'&&/vibeGroups?|画师串|artistString|referenceImage|vibeData/i.test(safeMigrationStringify(value)))found.push({key,value});
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
  if(s.vibes.some(x=>x.name===item.name&&x.sourcePath===item.sourcePath))continue;
  s.vibes.unshift({name:item.name,groupName:item.groupName||item.name,entries:Array.isArray(item.entries)?item.entries.map(v=>({...v})):undefined,raw:item.raw,hasPayload:item.hasPayload,hasRef:item.hasRef,sourcePath:item.sourcePath,source:'st-chatu8',importedAt:Date.now()});vibes++;
 }
 s.presets=s.presets.slice(0,500);s.prompts=s.prompts.slice(0,500);s.vibes=s.vibes.slice(0,200);
 save();renderLibrary();
 status('迁移完成：画师串 '+artists+' 条，提示词 '+prompts+' 条，Vibe 项目 '+vibes+' 条。Vibe 资源仍需逐项检查是否含完整编码/图片数据。');
 $('#ql-migrate-import').disabled=true;
}

function init(){const root=$('#qinghui-lite-panel');if(!root||root.dataset.ready)return;root.dataset.ready='1';const s=cfg();$('#ql-provider').value=s.provider||'openai';$('#ql-endpoint').value=s.endpoint;$('#ql-key').value=s.apiKey;$('#ql-model').value=s.model;$('#ql-size').value=s.size;$('#ql-quality').value=s.quality;$('#ql-nai-model').value=s.naiModel||'nai-diffusion-4-5-full';$('#ql-nai-steps').value=s.naiSteps||28;$('#ql-nai-scale').value=s.naiScale||5;$('#ql-nai-width').value=s.naiWidth||832;$('#ql-nai-height').value=s.naiHeight||1216;$('#ql-nai-sampler').value=s.naiSampler||'k_euler_ancestral';$('#ql-nai-scheduler').value=s.naiScheduler||'karras';$('#ql-prompt').value=s.prompt;$('#ql-negative').value=s.negative;const toggleProvider=()=>{const nai=$('#ql-provider').value==='novelai';$('#ql-openai-settings').hidden=nai;$('#ql-nai-settings').hidden=!nai;};$('#ql-provider').onchange=toggleProvider;toggleProvider();history();renderLibrary();$('#ql-migrate-scan').onclick=scanChatu8Settings;$('#ql-migrate-file-btn').onclick=()=>$('#ql-migrate-file').click();$('#ql-migrate-file').onchange=e=>{const f=e.target.files?.[0];if(f)readMigrationFile(f);};$('#ql-migrate-import').onclick=importChatu8Candidate;
$('#ql-save').onclick=()=>{read();status('设置已保存到酒馆扩展设置。');};
$('#ql-generate').onclick=async()=>{
 if(busy)return;read();const conf=cfg();
 if(!conf.prompt.trim()){status('请填写正向提示词。');return;}
 if(conf.provider!=='novelai'&&(!conf.endpoint||!conf.apiKey)){status('请填写 OpenAI 兼容 API 地址和 Key。');return;}
 busy=true;$('#ql-generate').disabled=true;$('#ql-result').replaceChildren();status('正在请求生图接口……');
 try{
  const activeIndex=Number(conf.activeVibeIndex??-1);const activeVibe=activeIndex>=0?conf.vibes[activeIndex]:null;const url=await requestImage(conf.prompt.trim(),conf.negative.trim(),activeVibe);
  const img=document.createElement('img');img.alt='轻绘生成结果';img.src=url;$('#ql-result').append(img);
  conf.records.unshift({at:Date.now(),prompt:conf.prompt.trim(),negative:conf.negative.trim(),provider:conf.provider,model:conf.provider==='novelai'?conf.naiModel:conf.model,size:conf.provider==='novelai'?(conf.naiWidth+'x'+conf.naiHeight):conf.size,quality:conf.quality,dataUrl:url});
  conf.records=conf.records.slice(0,20);save();history();status('生成完成。记录已保存在酒馆扩展设置中。');
 }catch(e){status('生成失败：'+(e?.message||String(e))+'。');}
 finally{busy=false;$('#ql-generate').disabled=false;}
}
$('#ql-prompt-save').onclick=()=>{const name=$('#ql-prompt-name').value.trim(),prompt=$('#ql-library-prompt').value.trim();if(!name||!prompt){status('提示词名称和内容不能为空。');return;}const item={name,category:$('#ql-prompt-category').value.trim(),prompt,negative:$('#ql-library-negative').value.trim(),updatedAt:Date.now()};const edit=$('#ql-prompt-save').dataset.edit;if(edit!==undefined){cfg().prompts[Number(edit)]=item;delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';}else cfg().prompts.unshift(item);cfg().prompts=cfg().prompts.slice(0,200);save();renderLibrary();status('提示词已保存。');};
$('#ql-character-save').onclick=()=>{const name=$('#ql-character-name').value.trim(),appearance=$('#ql-character-appearance').value.trim();if(!name||!appearance){status('请填写角色名称和外貌词。');return;}const item={name,appearance,updatedAt:Date.now()};const edit=$('#ql-character-save').dataset.edit;if(edit!==undefined){cfg().characters[Number(edit)]=item;delete $('#ql-character-save').dataset.edit;$('#ql-character-save').textContent='保存角色';}else cfg().characters.unshift(item);cfg().characters=cfg().characters.slice(0,100);save();renderLibrary();status('角色已保存。');};
$('#ql-preset-save').onclick=()=>{const name=$('#ql-preset-name').value.trim(),positive=$('#ql-preset-positive').value.trim();if(!name||!positive){status('预设名称和正向画风串不能为空。');return;}const item={name,positive,negative:$('#ql-preset-negative').value.trim(),updatedAt:Date.now()};const edit=$('#ql-preset-save').dataset.edit;if(edit!==undefined){cfg().presets[Number(edit)]=item;delete $('#ql-preset-save').dataset.edit;$('#ql-preset-save').textContent='保存预设';}else cfg().presets.unshift(item);cfg().presets=cfg().presets.slice(0,100);save();renderLibrary();status('预设已保存。');};
$('#ql-clear').onclick=()=>{if(confirm('清空轻绘本地生成记录？不会删除聊天图片。')){cfg().records=[];save();history();status('记录已清空。');}};
}
jQuery(()=>{
 if(!$('#ql-overlay')){
  document.body.insertAdjacentHTML('beforeend',html());
  const overlay=$('#ql-overlay');
  const panel=$('#qinghui-lite-panel');
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-modal','true');
  panel.setAttribute('aria-label','轻绘 Lite');
  const close=document.createElement('button');
  close.type='button';close.id='ql-close';close.className='menu_button';close.textContent='关闭轻绘';
  const heading=panel.querySelector('.ql-card h3');
  if(heading)heading.parentElement.insertBefore(close,heading.nextSibling);
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
 if(event_types.CHAT_CHANGED)eventSource.on(event_types.CHAT_CHANGED,()=>{autoTasks.clear();});
});
