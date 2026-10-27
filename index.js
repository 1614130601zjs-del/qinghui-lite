import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '/script.js';
import { parseImageMarkers, makeTriggerId, TriggerRegistry } from './trigger-core.js';

const EXT = 'qinghui_lite';
const defaults = { enabled:true, activeConfigMode:'combo', downloadFormat:'png', historyColumns:3, chatAlbumStyle:'classic', vibes:[], combinations:[], activeComboIndex:-1, activeVibeIndex:-1, activePresetIndex:-1, bindings:[], provider:'novelai', endpoint:'', apiKey:'', naiApiKey:'', naiThirdEndpoint:'', naiThirdKey:'', model:'gpt-image-1', size:'auto', quality:'medium', naiModel:'nai-diffusion-4-5-full', naiSteps:28, naiScale:5, naiWidth:832, naiHeight:1216, naiSampler:'k_euler_ancestral', naiScheduler:'karras', naiNormalizeVibeStrengths:true, prompt:'', negative:'', records:[], presets:[], characters:[], prompts:[] };
const $ = (s, root=document) => root.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let busy=false;
let pendingVibeImage=null;
let libraryEditMode=false;
let presetBatchMode=false;
const selectedPresets=new Set();
const selectedPrompts=new Set();
const selectedCharacters=new Set();
function cfg(){
 extension_settings[EXT] ??= JSON.parse(JSON.stringify(defaults));
 const s=extension_settings[EXT];
 if(typeof s.enabled!=='boolean')s.enabled=true;
 if(!['combo','separate'].includes(s.activeConfigMode))s.activeConfigMode='combo';
 if(typeof s.naiNormalizeVibeStrengths!=='boolean')s.naiNormalizeVibeStrengths=true;
 if(s.model==='gpt-image-2.5-sunburst'){s.model='gpt-image-1';saveSettingsDebounced();}
 for(const key of ['records','presets','characters','prompts','vibes','bindings','combinations'])if(!Array.isArray(s[key]))s[key]=[];
 // 组合配置升级只补充新字段，不清空用户已有的 Vibe 或角色绑定。
 if(!s.comboMigrationV1){
  const comboFor=(artistIndex,vibeIndex)=>{let i=s.combinations.findIndex(c=>Number(c.artistIndex??-1)===Number(artistIndex??-1)&&Number(c.vibeIndex??-1)===Number(vibeIndex??-1));if(i<0){s.combinations.push({name:[s.presets[artistIndex]?.name,s.vibes[vibeIndex]?.name].filter(Boolean).join(' + ')||'旧配置组合',artistIndex:Number(artistIndex??-1),vibeIndex:Number(vibeIndex??-1),migrated:true});i=s.combinations.length-1;}return i;};
  for(const binding of s.bindings){if(!Number.isInteger(binding.combinationIndex)&&(Number(binding.presetIndex??-1)>=0||Number(binding.vibeIndex??-1)>=0))binding.combinationIndex=comboFor(binding.presetIndex,binding.vibeIndex);}
  if(Number(s.activePresetIndex??-1)>=0||Number(s.activeVibeIndex??-1)>=0)s.activeComboIndex=comboFor(s.activePresetIndex,s.activeVibeIndex);
  s.comboMigrationV1=true;saveSettingsDebounced();
 }
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
function hideMarkersInTextNode(root,entries=[]){
 if(!root)return;
 let entryCursor=0;
 const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);
 const nodes=[];while(walker.nextNode())if(walker.currentNode.nodeValue?.includes('image###'))nodes.push(walker.currentNode);
 let ordinal=0;
 for(const node of nodes){
  const value=node.nodeValue||'',re=/image###([\s\S]*?)###/g;
  if(!re.test(value))continue;
  re.lastIndex=0;
  const fragment=document.createDocumentFragment();let last=0,match;
  while((match=re.exec(value))!==null){
   fragment.append(document.createTextNode(value.slice(last,match.index)));
   const entry=entries[entryCursor++],prompt=match[1].trim();
   if(!prompt){last=re.lastIndex;continue;}
   const button=document.createElement('button');
   button.type='button';button.className='menu_button ql-inline-image-trigger';button.textContent='相册收录';button.title='点击生成图片并收录到当前消息';
   button.dataset.qlTrigger=entry?.taskKey||('marker-'+ordinal);button.dataset.qlPrompt=prompt;applyChatAlbumButtonStyle(button,cfg().chatAlbumStyle||'classic');applyChatTheme(button);
   button.addEventListener('click',()=>runInlineImageTrigger(button,entry||{prompt,taskKey:button.dataset.qlTrigger,messageIndex:-1}));
   fragment.append(button);ordinal++;last=re.lastIndex;
  }
  fragment.append(document.createTextNode(value.slice(last)));
  node.parentNode?.replaceChild(fragment,node);
 }
}
let qlImageRequestQueue=Promise.resolve();
async function requestImage(prompt, negativeOverride, vibeItem=null){
 const queued=qlImageRequestQueue.then(()=>requestImageUnlocked(prompt,negativeOverride,vibeItem));
 qlImageRequestQueue=queued.catch(()=>{});
 return queued;
}
async function requestImageUnlocked(prompt, negativeOverride, vibeItem=null){
 const c=cfg();
 let raw='',data=null,res;
 if(c.provider==='novelai'||c.provider==='novelai-thirdparty'){
  const naiModel=c.naiModel||'nai-diffusion-4-5-full';
  // 官网使用扩展内保存的 NovelAI Key；第三方使用服务商提供的 Key 与地址。
  const negative=String(negativeOverride??c.negative??'');
  const isV4=/^nai-diffusion-(?:4(?:-|$)|5-)/i.test(naiModel);
  const isV5=/^nai-diffusion-5-/i.test(naiModel);
  const isV3=/^nai-diffusion-3(?:-|$)/i.test(naiModel);
  const width=Number(c.naiWidth)||832;
  const height=Number(c.naiHeight)||1216;
  const sampler=c.naiSampler||'k_euler_ancestral';
  const parameters={
   params_version:isV5?4:3,
   width,
   height,
   scale:Number(c.naiScale)||5,
   sampler,
   noise_schedule:c.naiScheduler||'karras',
   steps:Number(c.naiSteps)||28,
   n_samples:1,
   seed:Math.floor(Math.random()*2147483647),
   negative_prompt:negative,
   ucPreset:3,
   qualityToggle:true,
   dynamic_thresholding:false,
   controlnet_strength:1,
   legacy:false,
   legacy_uc:false,
   add_original_image:true,
   cfg_rescale:0,
   skip_cfg_above_sigma:null,
   legacy_v3_extend:false,
   stream:'msgpack',
   reference_strength_multiple:[],
   normalize_reference_strength_multiple:c.naiNormalizeVibeStrengths!==false,
   use_coords:false
  };
  if(sampler==='k_euler_ancestral'){
   parameters.deliberate_euler_ancestral_bug=false;
   parameters.prefer_brownian=true;
  }
  if(isV3){
   parameters.sm=false;
   parameters.sm_dyn=false;
   parameters.reference_image_multiple=[];
   parameters.reference_information_extracted_multiple=[];
   parameters.prompt=prompt;
  }else if(isV4){
   parameters.reference_image_multiple_cached=[];
   parameters.characterPrompts=[];
   parameters.v4_prompt={caption:{base_caption:prompt,char_captions:[]},use_coords:false,use_order:true};
   parameters.v4_negative_prompt={caption:{base_caption:negative,char_captions:[]},legacy_uc:false};
  }else{
   parameters.prompt=prompt;
  }
  if(vibeItem){
   const vibes=Array.isArray(vibeItem.entries)
    ?vibeItem.entries.map(item=>{const source=item.raw?{...item.raw,image:item.image||item.raw.image||''}:item;const extracted=extractUsableVibe(source,naiModel);const hasModelMap=JSON.stringify(source).includes('"encodings"');const image=extracted?.image||(!hasModelMap&&typeof item.image==='string'&&item.image.trim()?String(item.image).trim().replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,''):'');return image?{image,strength:Number(item.strength??extracted?.strength??0.6),informationExtracted:Number(item.informationExtracted??extracted?.informationExtracted??1)}:null;}).filter(Boolean)
    :(()=>{const one=extractUsableVibe(vibeItem.raw||vibeItem,naiModel);return one?[one]:[];})();
   if(!vibes.length)throw new Error('这个 Vibe 组没有识别到可发送的编码。请重新导入包含 encoding 数据的 .naiv4vibe / bundle 或智绘姬导出 JSON；普通预览图不能替代编码。');
   if(vibes.length>16)throw new Error('NovelAI 单次最多使用 16 条 Vibe 参考，请先删除多余条目。');
   if(vibes.some(v=>!Number.isFinite(v.strength)||v.strength<0||v.strength>1||!Number.isFinite(v.informationExtracted)||v.informationExtracted<0||v.informationExtracted>1))throw new Error('Vibe 强度与 Information Extracted 必须在 0 到 1 之间。');
   parameters.reference_strength_multiple=vibes.map(v=>v.strength);
   parameters.normalize_reference_strength_multiple=c.naiNormalizeVibeStrengths!==false;
   if(isV3){
    parameters.reference_image_multiple=vibes.map(v=>v.image);
    parameters.reference_information_extracted_multiple=vibes.map(v=>v.informationExtracted);
   }else if(isV4){
    parameters.reference_image_multiple_cached=vibes.map(v=>({cache_secret_key:(crypto.randomUUID?crypto.randomUUID():'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,ch=>{const n=Math.random()*16|0;return(ch==='x'?n:(n&3|8)).toString(16);})),data:v.image}));
   }else{
    throw new Error('当前 NovelAI 模型不支持 Vibe Transfer，请切换到 V3、V4/V4.5 或受支持的 V5 模型。');
   }
  }
  const third=c.provider==='novelai-thirdparty';
  const naiKey=third?(c.naiThirdKey||''):(c.naiApiKey||'');
  if(!naiKey)throw new Error(third?'请先填写 NAI 第三方 API Key。':'请先填写 NovelAI 官网 Key。');
  const base=third?String(c.naiThirdEndpoint||'').replace(/\/$/,''):'https://image.novelai.net';
  if(third&&!base)throw new Error('请先填写 NAI 第三方 API 地址。');
  const endpoint=/\/ai\/generate-image$/i.test(base)?base:base+'/ai/generate-image';
  const requestBody={input:prompt,model:naiModel,action:'generate',parameters,use_new_shared_trial:true};
  res=await fetch(endpoint,{method:'POST',headers:{'Content-Type':'application/json','Authorization':'Bearer '+naiKey},body:JSON.stringify(requestBody)});
  if(!res.ok){raw=await res.text();throw new Error('NovelAI 请求失败（HTTP '+res.status+'）：'+raw.slice(0,240));}
  let buffer;
  try{
   buffer=await res.arrayBuffer();
  }catch(error){
   throw new Error('读取 NovelAI 图片响应失败：'+(error?.message||String(error))+'。请检查网络、跨域代理或接口是否提前关闭连接。');
  }
  let value='';
  try{
   const view=new DataView(buffer);
   const u8=new Uint8Array(buffer);
   let eocd=-1;
   const min=Math.max(0,view.byteLength-65557);
   for(let i=view.byteLength-22;i>=min;i--){
    if(view.getUint32(i,true)===0x06054b50){eocd=i;break;}
   }
   if(eocd<0)throw new Error('响应不是有效 ZIP（未找到中央目录结束记录）');
   const entries=view.getUint16(eocd+10,true);
   let offset=view.getUint32(eocd+16,true);
   for(let n=0;n<entries && offset+46<=view.byteLength;n++){
    if(view.getUint32(offset,true)!==0x02014b50)throw new Error('ZIP 中央目录结构无效');
    const method=view.getUint16(offset+10,true);
    const compressed=view.getUint32(offset+20,true);
    const nameLen=view.getUint16(offset+28,true);
    const extraLen=view.getUint16(offset+30,true);
    const commentLen=view.getUint16(offset+32,true);
    const localOffset=view.getUint32(offset+42,true);
    if(offset+46+nameLen+extraLen+commentLen>view.byteLength)throw new Error('ZIP 中央目录长度越界');
    const name=new TextDecoder().decode(u8.subarray(offset+46,offset+46+nameLen));
    if(/\.(png|jpe?g|webp)$/i.test(name)){
     if(localOffset+30>view.byteLength||view.getUint32(localOffset,true)!==0x04034b50)throw new Error('图片文件头无效');
     const localNameLen=view.getUint16(localOffset+26,true);
     const localExtraLen=view.getUint16(localOffset+28,true);
     const dataStart=localOffset+30+localNameLen+localExtraLen;
     if(dataStart+compressed>view.byteLength)throw new Error('图片压缩数据不完整');
     let bytes=u8.slice(dataStart,dataStart+compressed);
     if(method===8){
      if(typeof DecompressionStream==='undefined')throw new Error('当前浏览器不支持 ZIP 的 DEFLATE 解压，请更新浏览器内核。');
      try{
       const reader=new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw')).getReader();
       const chunks=[];let total=0;
       while(true){
        const part=await reader.read();
        if(part.done)break;
        chunks.push(part.value);total+=part.value.length;
       }
       bytes=new Uint8Array(total);
       let pos=0;
       for(const chunk of chunks){bytes.set(chunk,pos);pos+=chunk.length;}
      }catch(error){
       throw new Error('ZIP 图片 DEFLATE 解压失败：'+(error?.message||String(error))+'。压缩数据可能不完整，或当前浏览器内核不兼容 deflate-raw。');
      }
     }else if(method!==0){
      throw new Error('暂不支持 ZIP 压缩方式：'+method);
     }
     const mime=/\.jpe?g$/i.test(name)?'jpeg':/\.webp$/i.test(name)?'webp':'png';
     let binary='';
     for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
     value='data:image/'+mime+';base64,'+btoa(binary);
     break;
    }
    offset+=46+nameLen+extraLen+commentLen;
   }
  }catch(error){
   throw new Error('无法解包 NovelAI 返回的图片 ZIP：'+(error?.message||String(error)));
  }
  if(!value)throw new Error('NovelAI 响应的 ZIP 中未找到 PNG/JPG/WebP 图片文件。');
  return value;
 }
 if(!c.endpoint||!c.apiKey)throw new Error('请先在轻绘设置中填写 OpenAI 兼容 API 地址和 Key');
 const model=String(c.model||'').toLowerCase();
 const negative=String(negativeOverride??c.negative??'').trim();
 const requestedSize=String(c.size||'1024x1024');const body={model:c.model||'gpt-image-1',prompt,n:1,size:requestedSize==='auto'?'1024x1024':requestedSize};
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
 const s=cfg(),combo=s.activeConfigMode!=='separate'&&Number(s.activeComboIndex)>=0?s.combinations[Number(s.activeComboIndex)]:null;
 const presetIndex=combo?Number(combo.artistIndex??-1):Number(s.activePresetIndex??-1);
 const preset=presetIndex>=0?s.presets[presetIndex]:null;
 const vibeIndex=combo?Number(combo.vibeIndex??-1):Number(s.activeVibeIndex??-1);
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

function vibeModelKey(model){
 if(model.includes('nai-diffusion-5-curated'))return 'v5curated';
 if(model.includes('nai-diffusion-5-full'))return 'v5full';
 if(model.includes('4-5-curated'))return 'v4-5curated';
 if(model.includes('4-5-full'))return 'v4-5full';
 if(model.includes('4-curated'))return 'v4curated';
 if(model.includes('4-full'))return 'v4full';
 if(model.includes('diffusion-3'))return 'v3';
 return 'v4-5full';
}
function extractUsableVibe(raw,model='nai-diffusion-4-5-full'){
 const seen=new WeakSet();let found='',foundGroup=null;
 const clean=value=>String(value||'').trim().replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/');
 const key=vibeModelKey(model),normalizeKey=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]/g,'');
 const isPayload=value=>{const v=clean(value);return v.length>160&&/^[A-Za-z0-9+/]+={0,2}$/.test(v);};
 const walk=(value,keyName='',canonical=false)=>{
  if(found||value==null)return;
  if(typeof value==='string'){
   const v=clean(value);
   if((canonical||/^(?:encoding|encoded|encodedVibe|encoded_vibe|vibeEncoding|vibe_encoding|vibeData|vibe_data|payload|base64|imageBase64|image_base64|referenceImage|reference_image)$/i.test(keyName))&&isPayload(v)){found=v;return;}
   return;
  }
  if(typeof value!=='object'||seen.has(value))return;
  seen.add(value);
  if(Array.isArray(value)){for(const item of value)walk(item,keyName,canonical);return;}
  const isCanonical=value.identifier==='novelai-vibe-transfer';
  if(isCanonical&&key==='v3'&&typeof value.image==='string'&&isPayload(value.image)){found=clean(value.image);return;}
  if(value.encodings&&typeof value.encodings==='object'){
   const encodings=value.encodings;
   const matchingKey=Object.keys(encodings).find(k=>normalizeKey(k)===normalizeKey(key)||normalizeKey(k).replace(/^v/,'')===normalizeKey(key).replace(/^v/,''));
   let group=matchingKey?encodings[matchingKey]:null;
   const unwrap=entry=>{
    if(typeof entry==='string')return isPayload(entry)?{payload:clean(entry),group:entry}:null;
    if(!entry||typeof entry!=='object')return null;
    const direct=entry.encoding??entry.encoded??entry.data??entry.payload??entry.base64;
    if(typeof direct==='string'&&isPayload(direct))return {payload:clean(direct),group:entry};
    for(const child of Object.values(entry)){const result=child&&typeof child==='object'?unwrap(child):null;if(result)return result;}
    return null;
   };
   let result=group?unwrap(group):null;
   if(!result){
    // Some .naiv4vibe exports spell model keys differently or nest the encoding under another level.
    for(const candidate of Object.values(encodings)){result=unwrap(candidate);if(result)break;}
   }
   if(result){found=result.payload;foundGroup=result.group;return;}
   // Do not stop here: some bundle variants keep a usable payload beside the encodings map.
  }
  if(isCanonical&&typeof value.image==='string'&&isPayload(value.image)){found=clean(value.image);return;}
  for(const [k,v] of Object.entries(value)){if(k==='encodings'||(isCanonical&&k==='image'))continue;walk(v,k,false);}
 };
 walk(raw);
 if(!found)return null;
 const serialized=safeMigrationStringify(raw)||'';
 const readNumber=(re,fallback)=>{const m=serialized.match(re);return m?Number(m[1]):fallback;};
 const strength=Number.isFinite(Number(raw?.importInfo?.strength))?Number(raw.importInfo.strength):readNumber(/"(?:reference_strength|referenceStrength|strength)"\s*:\s*([0-9.]+)/i,0.6);
 let informationExtracted=readNumber(/"(?:reference_information_extracted|referenceInformationExtracted|information_extracted|informationExtracted|info_extracted|infoExtracted)"\s*:\s*([0-9.]+)/i,1);
 const group=foundGroup&&typeof foundGroup==='object'?foundGroup:raw?.encodings?.[key];
 if(group&&typeof group==='object'){
  const enc=('encoding' in group||'encoded' in group||'data' in group||'payload' in group)?group:Object.values(group).find(v=>v&&typeof v==='object'&&('encoding' in v||'encoded' in v||'data' in v||'payload' in v));
  const info=enc?.params?.information_extracted??enc?.params?.informationExtracted??enc?.infoExtracted;
  if(Number.isFinite(Number(info)))informationExtracted=Number(info);
 }
 return {image:found,strength,informationExtracted};
}
function renderActivePresets(){const select=$('#ql-active-preset');if(!select)return;const s=cfg(),prior=String(s.activeComboIndex??-1);select.innerHTML='<option value="-1">不使用组合</option>'+s.combinations.map((p,i)=>'<option value="'+i+'">'+esc(p.name||('组合 '+(i+1)))+'</option>').join('');select.value=s.combinations[Number(prior)]?prior:'-1';}
function renderActiveArtists(){const select=$('#ql-active-artist');if(!select)return;const s=cfg(),prior=String(s.activePresetIndex??-1);select.innerHTML='<option value="-1">不使用画师串</option>'+s.presets.map((p,i)=>'<option value="'+i+'">'+esc(p.name||('画师串 '+(i+1)))+'</option>').join('');select.value=s.presets[Number(prior)]?prior:'-1';}
function renderActiveConfigMode(){const s=cfg(),mode=$('#ql-active-config-mode');if(!mode)return;mode.value=s.activeConfigMode==='separate'?'separate':'combo';$('#ql-combo-config-row').hidden=mode.value!=='combo';$('#ql-separate-config-row').hidden=mode.value!=='separate';$('#ql-apply-preset').textContent=mode.value==='combo'?'应用组合':'应用独立选择';}
function currentCharacter(){const ctx=getContext()||{},id=ctx.characterId,ch=Number.isInteger(id)&&id>=0?ctx.characters?.[id]:null;return {id:id==null?'':String(id),name:ch?.name||ch?.avatar||''};}
function renderBindings(){const s=cfg(),select=$('#ql-bind-character'),preset=$('#ql-bind-preset'),vibe=$('#ql-bind-vibe'),list=$('#ql-bindings-list');if(!select||!preset||!vibe)return;const ctx=getContext()||{},chars=Array.isArray(ctx.characters)?ctx.characters:[],current=currentCharacter();const options=chars.map((ch,i)=>({id:String(i),name:ch?.name||ch?.avatar||('角色 '+(i+1))}));if(current.id&&!options.some(x=>x.id===current.id))options.unshift({id:current.id,name:current.name||('当前角色 '+current.id)});const oldValue=select.value;select.innerHTML='<option value="">选择角色卡</option>'+options.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');if(options.some(x=>x.id===oldValue))select.value=oldValue;else if(options.some(x=>x.id===current.id))select.value=current.id;preset.innerHTML='<option value="-1">不绑定组合</option>'+s.combinations.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('组合 '+(i+1)))+'</option>').join('');vibe.innerHTML='<option value="-1">组合内 Vibe 自动绑定</option>';const selectedName=options.find(o=>o.id===select.value)?.name;const binding=s.bindings.find(x=>x.characterName===selectedName)||s.bindings.find(x=>x.characterKey===select.value);if(binding)preset.value=String(binding.combinationIndex??-1);if(list)list.innerHTML=s.bindings.map((b,i)=>'<div class="ql-record"><strong>'+esc(b.characterName||('角色 '+b.characterKey))+'</strong><p>默认组合：'+esc(s.combinations[Number(b.combinationIndex)]?.name||'未绑定')+'</p><button class="menu_button" data-binding-delete="'+i+'">删除绑定</button></div>').join('')||'<p class="ql-muted">暂无角色默认组合</p>';list?.querySelectorAll('[data-binding-delete]').forEach(btn=>btn.onclick=()=>{s.bindings.splice(+btn.dataset.bindingDelete,1);save();renderBindings();});}
function applyCurrentBinding(){const current=currentCharacter();if(!current.id)return;const s=cfg(),ch=(getContext()?.characters||[])[Number(current.id)],name=current.name||ch?.name||ch?.avatar||'';const binding=s.bindings.find(x=>x.characterName===name)||s.bindings.find(x=>x.characterKey===current.id);if(!binding)return;const i=Number(binding.combinationIndex??-1),c=s.combinations[i];s.activeConfigMode='combo';s.activeComboIndex=c?i:-1;s.activePresetIndex=c?Number(c.artistIndex??-1):-1;s.activeVibeIndex=c?Number(c.vibeIndex??-1):-1;renderActivePresets();renderActiveVibes();renderActiveConfigMode();status('已应用角色默认组合：'+(name||current.id));}
function renderActiveVibes(){
 const select=$('#ql-active-vibe');if(!select)return;
 const prior=String(cfg().activeVibeIndex??-1);
 select.innerHTML='<option value="-1">不使用 Vibe</option>'+cfg().vibes.map((v,i)=>'<option value="'+i+'">'+esc(v.name||('Vibe '+(i+1)))+(v.hasPayload?' · 已识别编码':' · 尚无可用编码')+'</option>').join('');
 select.value=cfg().vibes[Number(prior)]?prior:'-1';
}
let lastPngCleanReport='';
async function preparePngDownloadBlob(blob,forceClean=false){
 lastPngCleanReport='';
 if(!blob&&!forceClean)return blob;
 const bytes=new Uint8Array(await blob.arrayBuffer());
 const signature=[137,80,78,71,13,10,26,10];
 if(bytes.length<8||!signature.every((v,i)=>bytes[i]===v)){
  lastPngCleanReport='未执行清洗：下载内容不是标准 PNG，已保留原文件，避免错误转换。';
  return blob;
 }
 // APNG 有动画帧；canvas 只能可靠导出当前帧，因此动画 PNG 继续采用无损数据块清理。
 let hasAnimation=false,offset=8;
 while(offset+12<=bytes.length){
  const length=((bytes[offset]<<24)|(bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3])>>>0;
  const end=offset+12+length;
  if(end>bytes.length)throw new Error('PNG 数据块长度异常，已停止清洗以避免损坏图片。');
  const type=String.fromCharCode(bytes[offset+4],bytes[offset+5],bytes[offset+6],bytes[offset+7]);
  if(type==='acTL'){hasAnimation=true;break;}
  offset=end;
  if(type==='IEND')break;
 }
 if(!hasAnimation){
  // 清洗选项必须先把原图解码到同尺寸 Canvas，再导出全新的 PNG；不缩放、不裁切、不转 JPG。
  let bitmap=null, imageUrl=null;
  try{
   const canvas=document.createElement('canvas');
   let width=0,height=0,drawSource=null;
   if(typeof createImageBitmap==='function'){
    bitmap=await createImageBitmap(blob);
    width=bitmap.width;height=bitmap.height;drawSource=bitmap;
   }else{
    imageUrl=URL.createObjectURL(blob);
    const image=new Image();
    image.decoding='async';
    image.src=imageUrl;
    await new Promise((resolve,reject)=>{
     image.onload=resolve;
     image.onerror=()=>reject(new Error('浏览器无法解码 PNG，未执行重绘清洗'));
    });
    width=image.naturalWidth;height=image.naturalHeight;drawSource=image;
   }
   if(!width||!height)throw new Error('PNG 图片尺寸无效，未执行重绘清洗');
   canvas.width=width;canvas.height=height;
   const context=canvas.getContext('2d',{alpha:true,willReadFrequently:false});
   if(!context)throw new Error('无法创建 Canvas 画布，未执行重绘清洗');
   context.clearRect(0,0,width,height);
   context.drawImage(drawSource,0,0,width,height);
   const canvasBlob=await new Promise((resolve,reject)=>{
    canvas.toBlob(result=>result?resolve(result):reject(new Error('浏览器重新编码 PNG 失败，未执行重绘清洗')),'image/png');
   });
   if(!canvasBlob||canvasBlob.type!=='image/png')throw new Error('浏览器未能导出 PNG，未执行重绘清洗');

   // Canvas 重绘后再检查 PNG 数据块，明确移除文本、EXIF、时间及未知附加块。
   // 这样不只依赖浏览器是否会在 toBlob() 时自动丢弃元数据。
   const outputBytes=new Uint8Array(await canvasBlob.arrayBuffer());
   const outputSignature=[137,80,78,71,13,10,26,10];
   if(outputBytes.length<8||!outputSignature.every((v,i)=>outputBytes[i]===v))throw new Error('Canvas 导出的文件不是有效 PNG');
   const keepAfterRedraw=new Set(['IHDR','PLTE','IDAT','IEND','tRNS','sRGB','gAMA','cHRM','iCCP','sBIT','bKGD','hIST','pHYs']);
   const outputChunks=[outputBytes.slice(0,8)];
   const removedAfterRedraw=[];
   let outputOffset=8,hasIend=false;
   while(outputOffset+12<=outputBytes.length){
    const chunkLength=((outputBytes[outputOffset]<<24)|(outputBytes[outputOffset+1]<<16)|(outputBytes[outputOffset+2]<<8)|outputBytes[outputOffset+3])>>>0;
    const chunkEnd=outputOffset+12+chunkLength;
    if(chunkEnd>outputBytes.length)throw new Error('Canvas 输出 PNG 数据块长度异常');
    const chunkType=String.fromCharCode(outputBytes[outputOffset+4],outputBytes[outputOffset+5],outputBytes[outputOffset+6],outputBytes[outputOffset+7]);
    const isCritical=chunkType.charCodeAt(0)>=65&&chunkType.charCodeAt(0)<=90;
    if(isCritical||keepAfterRedraw.has(chunkType))outputChunks.push(outputBytes.slice(outputOffset,chunkEnd));
    else removedAfterRedraw.push(chunkType);
    outputOffset=chunkEnd;
    if(chunkType==='IEND'){hasIend=true;break;}
   }
   if(!hasIend)throw new Error('Canvas 输出 PNG 缺少 IEND 结束块');
   const resultBlob=new Blob(outputChunks,{type:'image/png'});
   if(!resultBlob.size)throw new Error('PNG 元数据二次清理失败');
   const uniqueRemoved=[...new Set(removedAfterRedraw)];
   lastPngCleanReport='已执行 Canvas 重绘并二次清理 PNG 数据块（原尺寸 '+width+'×'+height+'）。'+(removedAfterRedraw.length?'额外移除 '+removedAfterRedraw.length+' 个附加块：'+uniqueRemoved.join('、')+'。':'已检查重绘后的 PNG，未发现额外文本/EXIF/时间或未知附加块。');
   return resultBlob;
  }catch(error){
   console.error('[轻绘 Lite] Canvas PNG 重绘失败',error);
   throw new Error('PNG 重绘清洗失败，未下载原始文件：'+(error?.message||String(error)));
  }finally{
   bitmap?.close?.();
   if(imageUrl)URL.revokeObjectURL(imageUrl);
  }
 }
 // 动画 PNG 或浏览器不支持 Canvas 解码时，保留图像数据块并移除常见文本/附加元数据块。
 const keep=new Set(['IHDR','PLTE','IDAT','IEND','tRNS','sRGB','gAMA','cHRM','iCCP','sBIT','bKGD','hIST','pHYs','acTL','fcTL','fdAT']);
 const chunks=[bytes.slice(0,8)],removed=[];
 offset=8;let ended=false;
 while(offset+12<=bytes.length){
  const length=((bytes[offset]<<24)|(bytes[offset+1]<<16)|(bytes[offset+2]<<8)|bytes[offset+3])>>>0;
  const chunkEnd=offset+12+length;
  if(chunkEnd>bytes.length)throw new Error('PNG 数据块长度异常，已停止清洗以避免损坏图片。');
  const type=String.fromCharCode(bytes[offset+4],bytes[offset+5],bytes[offset+6],bytes[offset+7]);
  const critical=type.charCodeAt(0)>=65&&type.charCodeAt(0)<=90;
  if(critical||keep.has(type))chunks.push(bytes.slice(offset,chunkEnd));
  else removed.push(type);
  offset=chunkEnd;
  if(type==='IEND'){ended=true;break;}
 }
 if(!ended)throw new Error('PNG 缺少 IEND 结束块，无法安全清洗元数据。');
 const trailingBytes=bytes.length-offset;
 const cleaned=new Blob(chunks,{type:'image/png'});
 if(!cleaned.size)throw new Error('PNG 元数据清洗失败。');
 const unique=[...new Set(removed)];
 lastPngCleanReport=removed.length||trailingBytes
  ? '清洗完成：移除 '+removed.length+' 个附加数据块'+(unique.length?'（'+unique.join('、')+'）':'')+(trailingBytes?'，并移除 IEND 后的 '+trailingBytes+' 字节附加数据':'')+'。'
  : '检查完成：未发现可移除的数据块；此文件可能含动画或其他非标准嵌入数据。';
 return cleaned;
}
async function convertImageBlobToJpeg(blob){
 if(!blob)throw new Error('无法读取图片文件，已阻止未转换的原图下载。');
 let bitmap=null,tempUrl=null;
 try{
  let width=0,height=0,source=null;
  if(typeof createImageBitmap==='function'){bitmap=await createImageBitmap(blob);width=bitmap.width;height=bitmap.height;source=bitmap;}
  else{tempUrl=URL.createObjectURL(blob);const im=new Image();im.decoding='async';im.src=tempUrl;await new Promise((resolve,reject)=>{im.onload=resolve;im.onerror=()=>reject(new Error('浏览器无法解码图片，JPG 转换失败'));});width=im.naturalWidth;height=im.naturalHeight;source=im;}
  if(!width||!height)throw new Error('图片尺寸无效，无法转换 JPG');
  const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
  const ctx=canvas.getContext('2d');if(!ctx)throw new Error('无法创建 JPG 转换画布');
  ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.drawImage(source,0,0,width,height);
  const result=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('JPG 编码失败')),'image/jpeg',0.94));
  if(!result||result.type!=='image/jpeg')throw new Error('浏览器未能生成 JPG 文件');
  return result;
 }finally{bitmap?.close?.();if(tempUrl)URL.revokeObjectURL(tempUrl);}
}
async function saveCleanImage(src,filename,forceClean=false){
 if(!src)throw new Error('这条缓存记录没有可保存的图片数据。');
 let name=filename||'qinghui-image.png';
 const wantedExt=cfg().downloadFormat==='jpg'?'jpg':'png';name=String(name).replace(/\.(?:png|jpe?g|webp|gif|avif)$/i,'')+'.'+wantedExt;
 let objectUrl=src, fileBlob=null;
 try{
  if(/^data:image\//i.test(src)){
   const comma=src.indexOf(',');
   if(comma<0)throw new Error('图片数据格式无效');
   const header=src.slice(0,comma),raw=src.slice(comma+1);
   let blob;
   if(/;base64/i.test(header)){
    const binary=atob(raw.replace(/\s/g,''));
    const chunks=[];
    for(let i=0;i<binary.length;i+=0x8000){
     const part=binary.slice(i,i+0x8000),bytes=new Uint8Array(part.length);
     for(let j=0;j<part.length;j++)bytes[j]=part.charCodeAt(j);
     chunks.push(bytes);
    }
    blob=new Blob(chunks,{type:(header.match(/^data:([^;]+)/i)||[])[1]||'image/png'});
   }else{
    blob=new Blob([decodeURIComponent(raw)],{type:(header.match(/^data:([^;]+)/i)||[])[1]||'image/png'});
   }
   fileBlob=blob;objectUrl=URL.createObjectURL(blob);
  }else{
   // 清洗模式禁止在源文件读取失败时退回原图，否则用户会误以为下载的是已清洗文件。
   try{
    const response=await fetch(src);
    if(!response.ok)throw new Error('读取缓存图片失败（HTTP '+response.status+'）');
    fileBlob=await response.blob();
    objectUrl=URL.createObjectURL(fileBlob);
   }catch(error){
    console.warn('[轻绘 Lite] 无法读取缓存图片源',error);
    if(forceClean)throw new Error('无法读取缓存原图，因此没有下载任何文件。请重新打开缓存详情后再试。');
   }
  }
  const downloadFormat=cfg().downloadFormat==='jpg'?'jpg':'png';
  if(downloadFormat==='jpg'){
   if(!fileBlob)throw new Error('无法读取图片文件，已阻止未转换的原图下载。');
   let bitmap=null,tempUrl=null;
   try{
    let width=0,height=0,source=null;
    if(typeof createImageBitmap==='function'){bitmap=await createImageBitmap(fileBlob);width=bitmap.width;height=bitmap.height;source=bitmap;}
    else{tempUrl=URL.createObjectURL(fileBlob);const im=new Image();im.decoding='async';im.src=tempUrl;await new Promise((resolve,reject)=>{im.onload=resolve;im.onerror=()=>reject(new Error('浏览器无法解码图片，JPG 转换失败'));});width=im.naturalWidth;height=im.naturalHeight;source=im;}
    if(!width||!height)throw new Error('图片尺寸无效，无法转换 JPG');
    const canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;
    const ctx=canvas.getContext('2d');if(!ctx)throw new Error('无法创建 JPG 转换画布');
    ctx.fillStyle='#ffffff';ctx.fillRect(0,0,width,height);ctx.drawImage(source,0,0,width,height);
    fileBlob=await new Promise((resolve,reject)=>canvas.toBlob(b=>b?resolve(b):reject(new Error('JPG 编码失败')),'image/jpeg',0.94));
    if(!fileBlob||fileBlob.type!=='image/jpeg')throw new Error('浏览器未能生成 JPG 文件');
    name=name.replace(/\.(png|jpe?g|webp|gif|avif)$/i,'')+'.jpg';
    const previousUrl=objectUrl;objectUrl=URL.createObjectURL(fileBlob);if(previousUrl&&previousUrl!==src)URL.revokeObjectURL(previousUrl);
    lastPngCleanReport='JPG 已重新编码为 image/jpeg；原 PNG 元数据未复制到新文件。';
   }finally{bitmap?.close?.();if(tempUrl)URL.revokeObjectURL(tempUrl);}
  }else{
   if(!fileBlob)throw new Error('未能读取图片文件，因此已阻止原图下载。');
   const mime=(fileBlob.type||'').toLowerCase();
   const looksPng=mime==='image/png'||/\.png$/i.test(name);
   if(!looksPng)throw new Error('当前缓存不是可确认的 PNG（文件类型：'+(fileBlob.type||'未知')+'），为避免把未清洗原图误当成清洗版，已取消下载。');
   const previousUrl=objectUrl;
   fileBlob=await preparePngDownloadBlob(fileBlob,forceClean);
   if(!fileBlob||!fileBlob.size)throw new Error('PNG 清洗结果为空，已取消下载。');
   objectUrl=URL.createObjectURL(fileBlob);
   if(previousUrl&&previousUrl!==src)URL.revokeObjectURL(previousUrl);
  }
  const a=document.createElement('a');
  a.href=objectUrl;a.download=name;a.rel='noopener';
  // 从轻绘本体读取当前 CSS 主题变量；auto 模式沿用酒馆主题。
  const themeRoot=document.querySelector('#qinghui-lite-panel');
  const themeStyle=themeRoot?getComputedStyle(themeRoot):getComputedStyle(document.documentElement);
  const readTheme=(name,fallback)=>themeStyle.getPropertyValue(name).trim()||fallback;
  const theme={
   accent:readTheme('--ql-accent','#9aa9a5'),
   panel:readTheme('--ql-panel',getComputedStyle(document.body).backgroundColor||'#f5f5f5'),
   card:readTheme('--ql-card','#ffffff'),
   text:readTheme('--ql-text',getComputedStyle(document.body).color||'#333333'),
   muted:readTheme('--ql-muted','#777777'),
   border:readTheme('--ql-border','rgba(120,130,130,.25)')
  };
  const isDark=(()=>{const bg=theme.panel.toLowerCase();return bg.includes('39, 49, 61')||bg.includes('rgb(39, 49, 61')||bg==='#27313d'||bg.includes('rgba(39, 49, 61');})();
  // Always use a body-level sheet. Avoid nesting under Tavern dialogs/panels, whose transforms
  // and stacking contexts can displace fixed-position children on mobile.
  document.querySelector('[data-ql-download-sheet]')?.remove();
  // 使用原生 dialog.showModal() 将下载面板放进浏览器 Top Layer。
  // 普通 fixed + 极大 z-index 仍可能被酒馆模态框的层叠上下文压住。
  const overlay=document.createElement('dialog');
  overlay.setAttribute('data-ql-download-sheet','');
  overlay.style.cssText='position:fixed;inset:0;width:100vw;height:100dvh;max-width:none;max-height:none;border:0;background:rgba(20,12,18,.62);display:flex;align-items:flex-end;justify-content:center;padding:12px;box-sizing:border-box;margin:0;overflow:auto;overscroll-behavior:contain;color:inherit;';
  overlay.style.setProperty('background',isDark?'rgba(0,0,0,.72)':'rgba(20,12,18,.42)','important');
  overlay.style.setProperty('position','fixed','important');
  overlay.style.setProperty('inset','0','important');
  overlay.style.setProperty('width','100vw','important');
  overlay.style.setProperty('height','100dvh','important');
  overlay.style.setProperty('max-width','none','important');
  overlay.style.setProperty('max-height','none','important');
  overlay.style.setProperty('border','0','important');
  overlay.style.setProperty('z-index','2147483647','important');
  overlay.style.setProperty('transform','none','important');
  overlay.style.setProperty('visibility','visible','important');
  overlay.style.setProperty('opacity','1','important');
  overlay.style.setProperty('pointer-events','auto','important');
  const sheet=document.createElement('section');
  sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');sheet.setAttribute('aria-label','下载图片');
  sheet.style.cssText='position:relative;flex:0 1 480px;width:100%;max-width:480px;max-height:calc(100dvh - 24px);overflow:auto;box-sizing:border-box;border-radius:22px;padding:18px;box-shadow:0 12px 42px #0005;font-family:system-ui,sans-serif;margin:0 auto;transform:none;';
  Object.assign(sheet.style,{background:theme.panel,color:theme.text,border:'1px solid '+theme.border});
  const top=document.createElement('div');
  top.style.cssText='display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;';
  const title=document.createElement('strong');title.textContent='下载图片';title.style.cssText='font-size:20px;color:'+theme.text+';';
  const close=document.createElement('button');close.type='button';close.textContent='关闭';close.style.cssText='border:1px solid '+theme.border+';border-radius:10px;background:'+theme.card+';padding:9px 13px;color:'+theme.text+';font-size:14px;';
  top.append(title,close);
  const preview=document.createElement('img');preview.src=objectUrl;preview.alt='待保存的图片预览';preview.style.cssText='display:block;width:100%;max-height:min(38dvh,320px);object-fit:contain;border-radius:12px;background:'+theme.card+';border:1px solid '+theme.border+';';
  const filenameNode=document.createElement('div');filenameNode.textContent=name;filenameNode.style.cssText='margin:12px 0 6px;overflow-wrap:anywhere;font-size:14px;font-weight:600;color:'+theme.text+';';
  const hint=document.createElement('p');hint.textContent=(cfg().downloadFormat==='jpg'?'当前设置为 JPG：保存时会重新编码图片。':forceClean?'详情保存已启用 PNG 元数据清洗。':'PNG 下载会自动清洗元数据。')+' 点击下方按钮保存到设备；如果浏览器要求确认，请按提示继续。';hint.style.cssText='margin:0 0 16px;color:'+theme.muted+';font-size:13px;line-height:1.5;';
  a.textContent='保存图片';a.setAttribute('aria-label','保存图片到设备');a.style.cssText='display:block;box-sizing:border-box;width:100%;padding:14px 16px;border-radius:13px;border:1px solid '+theme.border+';background:'+theme.accent+';color:'+(isDark?'#17212a':theme.text)+';text-align:center;text-decoration:none;font-weight:750;font-size:16px;';
  a.addEventListener('click',async event=>{
   if(!fileBlob||!navigator.share||!navigator.canShare)return;
   const file=new File([fileBlob],name,{type:fileBlob.type||'image/png'});
   if(!navigator.canShare({files:[file]}))return;
   event.preventDefault();
   try{await navigator.share({files:[file],title:name});}
   catch(error){if(error?.name!=='AbortError')hint.textContent='系统分享失败：'+(error?.message||String(error))+'。请长按预览图，或尝试其他浏览器下载。';}
  });
  const cleanup=()=>{try{if(overlay.open)overlay.close();}catch{}overlay.remove();if(objectUrl!==src)setTimeout(()=>URL.revokeObjectURL(objectUrl),60*1000);};
  close.onclick=cleanup;
  overlay.addEventListener('click',e=>{if(e.target===overlay)cleanup();});
  sheet.append(top,preview,filenameNode,hint,a);
  overlay.append(sheet);
  // dialog.showModal() 会进入浏览器 Top Layer，优先级高于酒馆所有普通弹窗与插件面板。
  document.body.append(overlay);
  if(typeof overlay.showModal==='function'){
   overlay.showModal();
  }else{
   // 旧内核兜底：仍使用全屏 fixed 面板。
   overlay.setAttribute('open','');
  }
  Object.assign(overlay.style,{position:'fixed',left:'0',top:'0',right:'0',bottom:'0',width:'100vw',height:'100dvh',maxWidth:'none',maxHeight:'none',zIndex:'2147483647'});
  status('已打开下载面板，请点击“保存图片”。');
  return {opened:true,downloadStarted:false,edgeFallback:true};
 }catch(error){
  if(objectUrl!==src)URL.revokeObjectURL(objectUrl);
  throw new Error('保存图片失败：'+(error?.message||String(error))+'。如果酒馆内置页面拦截了保存，请尝试打开图片详情后长按图片。');
 }
}
function applyChatAlbumStyle(card,style){if(!card)return;card.classList.remove('ql-album-classic','ql-album-film','ql-album-soft');const valid=['classic','film','soft'].includes(style)?style:'classic';card.classList.add('ql-album-'+valid);}
function applyChatAlbumButtonStyle(button,style){if(!button)return;button.classList.remove('ql-album-classic','ql-album-film','ql-album-soft');const valid=['classic','film','soft'].includes(style)?style:'classic';button.classList.add('ql-album-'+valid);}
function applyChatTheme(element){if(!element)return;const preset=cfg().themePreset||'auto';const palette=themePalettes[preset];for(const key of ['--ql-accent','--ql-panel','--ql-card','--ql-text','--ql-muted','--ql-border','--ql-field'])element.style.removeProperty(key);if(palette){element.style.setProperty('--ql-accent',palette.accent);element.style.setProperty('--ql-panel',palette.panel);element.style.setProperty('--ql-card',palette.card);element.style.setProperty('--ql-text',palette.text);element.style.setProperty('--ql-muted',palette.muted);element.style.setProperty('--ql-border',palette.border);element.style.setProperty('--ql-field',palette.field);}}
function applyChatAlbumStyleToAll(style){document.querySelectorAll('.ql-chat-image').forEach(card=>{applyChatAlbumStyle(card,style);applyChatTheme(card);});document.querySelectorAll('#chat .ql-inline-image-trigger').forEach(button=>{applyChatAlbumButtonStyle(button,style);applyChatTheme(button);});}
function addMessageImage(host,url,prompt,taskKey,recordMeta={},anchor=null) {
 if(!host)return;
 let card=[...host.querySelectorAll('.ql-chat-image')].find(el=>el.dataset.qlTask===taskKey);
 if(!card){
  card=document.createElement('figure');card.className='ql-chat-image';card.dataset.qlTask=taskKey;card.dataset.qlPrompt=String(prompt||'');card.dataset.qlMessageIndex=String(recordMeta.messageIndex??'');card.dataset.qlChatId=String(recordMeta.chatId||getContext()?.chatId||'');
  const img=document.createElement('img');img.loading='lazy';img.alt='拾帧生成图片';
  const controls=document.createElement('div');controls.className='ql-chat-image-controls';
  const edit=document.createElement('button');edit.type='button';edit.className='menu_button ql-chat-image-edit';edit.setAttribute('aria-label','修改 tag');edit.title='修改 tag';edit.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 3.5h10l4 4V20a1.5 1.5 0 0 1-1.5 1.5h-11A1.5 1.5 0 0 1 5 20z"/><path d="M15 3.5V8h4M8 12h8M8 16h6"/><path d="m14.5 18.5 4.8-4.8 1.5 1.5-4.8 4.8-2 .5z"/></svg>';
  const prev=document.createElement('button');prev.type='button';prev.className='menu_button ql-chat-image-arrow ql-chat-image-arrow-prev';prev.setAttribute('aria-label','上一张');prev.title='上一张';prev.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 18l-6-6 6-6"/></svg>';
  const next=document.createElement('button');next.type='button';next.className='menu_button ql-chat-image-arrow ql-chat-image-arrow-next';next.setAttribute('aria-label','下一张');next.title='下一张';next.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 18l6-6-6-6"/></svg>';
  const reroll=document.createElement('button');reroll.type='button';reroll.className='menu_button ql-chat-image-reroll';reroll.setAttribute('aria-label','重 Roll');reroll.title='重 Roll';reroll.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 0 0-14-5L4 8"/><path d="M4 4v4h4"/><path d="M4 13a8 8 0 0 0 14 5l2-2"/><path d="M20 20v-4h-4"/></svg>';
  const remove=document.createElement('button');remove.type='button';remove.className='menu_button ql-chat-image-remove';remove.setAttribute('aria-label','删除当前图片');remove.title='仅从正文隐藏当前图片，缓存和相册中的原图保留';remove.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 14h10l1-14"/><path d="M9 7V4h6v3"/></svg>';
  const favorite=document.createElement('button');favorite.type='button';favorite.className='menu_button ql-chat-image-favorite';favorite.setAttribute('aria-label','收藏到角色相册');favorite.title='收藏到当前角色的相册';favorite.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>';
  remove.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const current=card._qlCandidates?.[card._qlIndex];if(!current)return;const records=cfg().records||[];let changed=false;for(const item of records){if(item?.taskKey!==taskKey||item.dataUrl!==current.url)continue;if(card.dataset.qlMessageIndex!==''&&Number(item.messageIndex)!==Number(card.dataset.qlMessageIndex))continue;if(card.dataset.qlChatId&&item.chatId&&item.chatId!==card.dataset.qlChatId)continue;item.hiddenInChat=true;changed=true;}if(changed)save();card._qlCandidates=card._qlCandidates.filter(candidate=>candidate.url!==current.url);if(!card._qlCandidates.length){card.remove();return;}card._qlIndex=Math.min(card._qlIndex,card._qlCandidates.length-1);card._qlRender?.();});

  const editor=document.createElement('div');editor.className='ql-chat-image-editor';editor.hidden=true;
  const tempConfig=document.createElement('div');tempConfig.className='ql-chat-image-temp-config';
  const tempPresetLabel=document.createElement('label');tempPresetLabel.textContent='本次组合';const tempPreset=document.createElement('select');tempPreset.className='ql-chat-image-temp-preset';tempPresetLabel.append(tempPreset);
  const tempSizeLabel=document.createElement('label');tempSizeLabel.textContent='本次尺寸';const tempSize=document.createElement('select');tempSize.className='ql-chat-image-temp-size';tempSizeLabel.append(tempSize);tempConfig.append(tempPresetLabel,tempSizeLabel);
  const textarea=document.createElement('textarea');textarea.className='ql-chat-image-tag-input';textarea.rows=3;textarea.value=String(prompt||'');textarea.setAttribute('aria-label','画面提示词');
  const saveTag=document.createElement('button');saveTag.type='button';saveTag.className='menu_button ql-chat-image-tag-save';saveTag.textContent='保存';
  const cancelTag=document.createElement('button');cancelTag.type='button';cancelTag.className='menu_button ql-chat-image-tag-cancel';cancelTag.textContent='取消';
  const editorActions=document.createElement('div');editorActions.className='ql-chat-image-editor-actions';editorActions.append(saveTag,cancelTag);editor.append(tempConfig,textarea,editorActions);
  const fillTempConfig=()=>{const c=cfg();tempPreset.innerHTML='<option value="">跟随默认组合</option>'+c.combinations.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('组合 '+(i+1)))+'</option>').join('');tempSize.innerHTML='<option value="">使用默认尺寸</option><option value="832x1216">竖版 · 832 × 1216</option><option value="768x1344">长竖版 · 768 × 1344</option><option value="1024x1024">正方形 · 1024 × 1024</option><option value="1216x832">横版 · 1216 × 832</option><option value="1344x768">宽横版 · 1344 × 768</option>';tempPreset.value=card.dataset.qlTempCombo??'';tempSize.value=card.dataset.qlTempSize??'';};fillTempConfig();
  controls.append(edit,reroll,remove,favorite);card.append(img,prev,next,controls,editor);if(anchor?.parentNode)anchor.parentNode.insertBefore(card,anchor);else host.append(card);
  edit.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();const currentUrl=card._qlCandidates[card._qlIndex]?.url||img.getAttribute('src');editor.hidden=!editor.hidden;if(!editor.hidden){fillTempConfig();textarea.value=card.dataset.qlPrompt||'';if(currentUrl)img.src=currentUrl;textarea.focus();}});
  cancelTag.addEventListener('click',()=>{textarea.value=card.dataset.qlPrompt||'';editor.hidden=true;});
  saveTag.addEventListener('click',()=>{
   const updated=textarea.value.trim();if(!updated){textarea.focus();return;}
   card.dataset.qlPrompt=updated;card.dataset.qlTempCombo=tempPreset.value;card.dataset.qlTempSize=tempSize.value;
   const record=(cfg().records||[]).find(item=>item.taskKey===taskKey);
   const matchingRecords=(cfg().records||[]).filter(item=>item.taskKey===taskKey);
   for(const record of matchingRecords){record.basePrompt=updated;record.prompt=resolveActiveGeneration(updated).prompt;record.negative=resolveActiveGeneration(updated).negative||record.negative;record.updatedAt=Date.now();}
   if(matchingRecords.length){save();history();}
   editor.hidden=true;
   const note=card.querySelector('.ql-chat-image-tag-saved');if(note)note.remove();
   const saved=document.createElement('span');saved.className='ql-chat-image-tag-saved';saved.textContent='已保存';editor.after(saved);setTimeout(()=>saved.remove(),1600);
  });
  card._qlCandidates=[];card._qlIndex=0;
  const render=()=>{const list=card._qlCandidates;const i=card._qlIndex;if(!list.length)return;img.src=list[i].url;prev.disabled=i<=0;next.disabled=i>=list.length-1;const saved=(cfg().records||[]).some(item=>item.taskKey===taskKey&&item.dataUrl===list[i].url&&item.albumCharacterName);favorite.classList.toggle('is-favorite',saved);favorite.setAttribute('aria-label',saved?'取消角色相册收藏':'收藏到角色相册');favorite.title=saved?'已收藏到角色相册':'收藏到当前角色的相册';};
  const step=delta=>{const nextIndex=card._qlIndex+delta;if(nextIndex>=0&&nextIndex<card._qlCandidates.length){card._qlIndex=nextIndex;render();}};
  prev.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();step(-1);});next.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();step(1);});
  favorite.addEventListener('click',event=>{
   event.preventDefault();event.stopPropagation();
   const current=card._qlCandidates?.[card._qlIndex];if(!current?.url)return;
   let records=(cfg().records||[]).filter(item=>item.taskKey===taskKey&&item.dataUrl===current.url);
   if(!records.length){storeChatRecord(current.url,card.dataset.qlPrompt||prompt,taskKey,recordMeta);records=(cfg().records||[]).filter(item=>item.taskKey===taskKey&&item.dataUrl===current.url);}
   const record=records[0];if(!record){status('未能找到这张图片的缓存记录。');return;}
   if(record.albumCharacterName){for(const item of records)delete item.albumCharacterName;save();render();history();status('已取消收藏；图片仍保留在缓存中。');return;}
   const currentChar=currentCharacter();
   const storedCharacter=typeof record.character==='string'?record.character:'';
   const ctx=getContext()||{};
   const name=String(record.characterName||storedCharacter||currentChar.name||recordMeta.characterName||recordMeta.character||ctx.name2||'当前角色').trim();
   for(const item of records){item.albumCharacterName=name;item.albumCharacterKey=currentChar.id||'';}
   save();render();history();status('已收藏到「'+name+'」角色相册。');
  });
  let touchX=0,touchY=0;
  img.addEventListener('touchstart',e=>{const t=e.changedTouches[0];touchX=t.clientX;touchY=t.clientY;},{passive:true});
  img.addEventListener('touchend',e=>{const t=e.changedTouches[0],dx=t.clientX-touchX,dy=t.clientY-touchY;if(Math.abs(dx)>42&&Math.abs(dx)>Math.abs(dy)*1.25)step(dx<0?1:-1);},{passive:true});
  img.addEventListener('contextmenu',e=>{e.preventDefault();saveCleanImage(img.src,'shizhen-'+Date.now());});
  img.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation();runChatReroll();});
  let lastTap=0,tapTimer=null;
  img.addEventListener('touchend',e=>{
   const t=e.changedTouches?.[0];if(!t)return;
   const now=Date.now();
   if(now-lastTap>0&&now-lastTap<480){e.preventDefault();e.stopPropagation();lastTap=0;if(tapTimer){clearTimeout(tapTimer);tapTimer=null;}reroll.click();}
   else{lastTap=now;}
  },{passive:false});
  const runChatReroll=async()=>{
   // 兼容旧版或中断请求留下的永久 busy 锁；旧锁没有时间戳时立即恢复。
   const busySince=Number(card.dataset.qlBusySince)||0;
   if(card.dataset.qlBusy==='1'&&busySince&&Date.now()-busySince<120000)return;
   if(card.dataset.qlBusy==='1'&&(!busySince||Date.now()-busySince>=120000)){card.dataset.qlBusy='0';card.dataset.qlBusySince='0';}
   const currentPrompt=String(card.dataset.qlPrompt||'').trim();
   if(!currentPrompt){alert('这张图片没有找到可用的画面提示词，请点击“修改 tag”检查。');return;}
   const rerollKey=taskKey+':reroll:'+Date.now()+':'+Math.random().toString(36).slice(2,7);
   let candidate;
   try{candidate=triggerRegistry.begin(rerollKey,{prompt:currentPrompt,source:'chat-reroll',...recordMeta});}
   catch(error){console.error('[轻绘 Lite] 重 Roll 任务初始化失败',error);alert('重 Roll 未启动：'+(error?.message||String(error)));return;}
   if(!candidate?.accepted){console.warn('[轻绘 Lite] 重 Roll 任务被拒绝',candidate);alert('重 Roll 任务暂时被拦截，请再点一次。');return;}
   triggerRegistry.markRunning(rerollKey);card.dataset.qlBusy='1';card.dataset.qlBusySince=String(Date.now());reroll.disabled=true;
   try{if(typeof navigator!=='undefined'&&typeof navigator.vibrate==='function')navigator.vibrate([45,35,45]);}catch{}
   const old=reroll.innerHTML;reroll.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.64 5.64l2.12 2.12M16.24 16.24l2.12 2.12M18.36 5.64l-2.12 2.12M7.76 16.24l2.12 2.12"/></svg>';
   try{
    const c=cfg(),old={combo:c.activeComboIndex,preset:c.activePresetIndex,vibe:c.activeVibeIndex,width:c.naiWidth,height:c.naiHeight,size:c.size};
    try{const ci=card.dataset.qlTempCombo!==''&&card.dataset.qlTempCombo!=null?Number(card.dataset.qlTempCombo):Number(c.activeComboIndex??-1),combo=c.combinations[ci];if(combo){c.activeComboIndex=ci;c.activePresetIndex=Number(combo.artistIndex??-1);c.activeVibeIndex=Number(combo.vibeIndex??-1);}const dims=String(card.dataset.qlTempSize||'').split('x').map(Number);if(dims.length===2&&dims.every(n=>Number.isFinite(n)&&n>0)){if(c.provider==='novelai'||c.provider==='novelai-thirdparty'){c.naiWidth=dims[0];c.naiHeight=dims[1];}else c.size=card.dataset.qlTempSize;}const fresh=await requestWithActiveSettings(currentPrompt);storeChatRecord(fresh,currentPrompt,taskKey,recordMeta);card._qlCandidates.push({url:fresh,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;render();}finally{c.activeComboIndex=old.combo;c.activePresetIndex=old.preset;c.activeVibeIndex=old.vibe;c.naiWidth=old.width;c.naiHeight=old.height;c.size=old.size;save();}
    triggerRegistry.markSucceeded(rerollKey,rerollKey+':candidate:'+Date.now());
   }catch(error){
    try{triggerRegistry.markFailed(rerollKey,error?.message||String(error));}catch{}
    console.error('[轻绘 Lite] 正文图片重 Roll 失败',error);
    alert('轻绘重 Roll 失败：'+(error?.message||String(error)));
   }finally{card.dataset.qlBusy='0';card.dataset.qlBusySince='0';reroll.disabled=false;reroll.innerHTML=old;}
  };
  reroll.addEventListener('click',event=>{event.preventDefault();event.stopPropagation();runChatReroll();});
  card._qlRender=render;
 }
 card.dataset.qlPrompt=String(prompt||card.dataset.qlPrompt||'');
 applyChatAlbumStyle(card,cfg().chatAlbumStyle||'classic');applyChatTheme(card);
 if(!card._qlCandidates.some(item=>item.url===url)){card._qlCandidates.push({url,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;}
 card._qlRender?.();
 return card;
}
function snapshotConfig(prompt, negativeOverride){
 const c=cfg();
 return {
  provider:c.provider, endpoint:c.provider==='openai'?c.endpoint:(c.provider==='novelai-thirdparty'?c.naiThirdEndpoint:''), model:c.provider!=='openai'?c.naiModel:c.model,
  size:c.provider!=='openai'?(c.naiWidth+'x'+c.naiHeight):c.size,
  quality:c.provider==='openai'?c.quality:null,
  negative:negativeOverride??c.negative??'',
  nai:c.provider!=='openai'?{steps:c.naiSteps,scale:c.naiScale,width:c.naiWidth,height:c.naiHeight,sampler:c.naiSampler,scheduler:c.naiScheduler}:null
 };
}
function storeChatRecord(url,prompt,taskKey,meta={}){
 const c=cfg(),resolved=resolveActiveGeneration(prompt);
 const presetIndex=Number(c.activePresetIndex??-1),preset=presetIndex>=0?c.presets[presetIndex]:null;
 const vibe=resolved.vibe;
 c.records.unshift({
  id:taskKey+':'+Date.now(),at:Date.now(),prompt:resolved.prompt,basePrompt:prompt,negative:resolved.negative||c.negative||'',
  provider:c.provider,model:c.provider!=='openai'?c.naiModel:c.model,
  size:c.provider!=='openai'?(c.naiWidth+'x'+c.naiHeight):c.size,
  quality:c.provider==='openai'?c.quality:null,dataUrl:url,
  preset:preset?{name:preset.name||'',positive:preset.positive||'',negative:preset.negative||'',index:presetIndex,source:preset.source||'local'}:null,
  vibe:vibe?{name:vibe.name||'',entries:(vibe.entries||[]).map(entry=>({strength:entry.strength??0.6,informationExtracted:entry.informationExtracted??1,identifier:entry.identifier||entry.raw?.identifier||'',type:entry.type||entry.raw?.type||'image'}))}:null,
  config:snapshotConfig(prompt,resolved.negative),source:meta.source||'chat',
  messageIndex:meta.messageIndex,taskKey,character:meta.character||null,chatId:getContext()?.chatId||null,promptEntryId:meta.promptEntryId||cfg().activePromptEntryId||null,sourcePromptEntryId:meta.sourcePromptEntryId||meta.promptEntryId||cfg().activePromptEntryId||null
 });
 c.records=c.records.slice(0,100);save();history();
}
async function runInlineImageTrigger(button,entry){
 if(!button||button.dataset.qlBusy==='1'||button.dataset.qlDone==='1')return;
 const prompt=String(entry?.prompt||button.dataset.qlPrompt||'').trim();
 let taskKey=String(entry?.taskKey||button.dataset.qlTrigger||'');
 if(!prompt||!taskKey)return;
 // 编辑消息会让酒馆重建正文 DOM。若该 marker 曾经成功生图，重新出现的按钮应可再次使用，而不是被旧成功状态永久锁住。
 if(triggerRegistry.get(taskKey)?.status==='succeeded')taskKey=taskKey+':edited:'+Date.now();
 const accepted=triggerRegistry.begin(taskKey,{prompt,source:'chat-button',messageIndex:entry.messageIndex,markerOrdinal:entry.markerOrdinal});
 if(!accepted.accepted)return;
 triggerRegistry.markRunning(taskKey);
 button.dataset.qlBusy='1';button.disabled=true;button.textContent='生成中…';
 const statusNode=document.createElement('span');statusNode.className='ql-chat-image-status';statusNode.textContent='正在提交给 NAI 生图…';button.after(statusNode);
 try{
  const context=getContext();
  const meta={messageIndex:entry.messageIndex,character:context?.name||null,chatId:context?.chatId||null};
  const url=await requestWithActiveSettings(prompt);
  const host=button.closest('.mes_text')||document.querySelector('.mes[mesid="'+entry.messageIndex+'"] .mes_text');
  if(!host)throw new Error('找不到原消息正文，图片已生成但无法插入原消息。');
  const card=addMessageImage(host,url,prompt,taskKey,meta);
  if(card)button.after(card);
  button.remove();statusNode.remove();
  storeChatRecord(url,prompt,taskKey,meta);
  triggerRegistry.markSucceeded(taskKey,taskKey+':candidate:'+Date.now());
 }catch(error){
  triggerRegistry.markFailed(taskKey,error?.message||String(error));
  button.dataset.qlBusy='0';button.disabled=false;button.textContent='重试生图';
  statusNode.remove();
  alert('轻绘生成失败：'+(error?.message||String(error)));
 }finally{if(button.isConnected)button.dataset.qlBusy='0';}
}
async function processLatestAssistantMessage(){
 // 清理旧版本遗留在正文图片下方的失败提示；当前失败统一用弹窗，不在图片卡片内留错。
 document.querySelectorAll('.ql-chat-image-status').forEach(node=>{if(/生成失败|HTTP\s*429|Concurrent generation is locked/i.test(node.textContent||''))node.remove();});
 const context=getContext();
 const chat=context?.chat;
 if(!Array.isArray(chat)||!chat.length)return;
 // 不只扫描最后一条消息：酒馆可能在扩展加载前已渲染消息，也可能在重绘时延迟更新 DOM。
 for(let messageIndex=0;messageIndex<chat.length;messageIndex++){
  const message=chat[messageIndex];
  if(!message||message.is_user||message.is_system||typeof message.mes!=='string')continue;
  const found=markers(message.mes);
  if(!found.length)continue;
  const host=document.querySelector('.mes[mesid="'+messageIndex+'"] .mes_text');
  if(!host)continue;
  const entries=found.map((marker,markerOrdinal)=>{
   const taskKey=makeTriggerId({chatId:context.chatId||'chat',messageId:String(messageIndex)+':'+String(message.swipe_id??0),markerIndex:markerOrdinal});
   return {...marker,taskKey,messageIndex,markerOrdinal};
  });
  // 先替换 marker；随后从扩展设置中恢复已生成的图片，避免酒馆编辑/保存消息重建正文时丢图。
  hideMarkersInTextNode(host,entries);
  for(const entry of entries){
   const savedRecords=(cfg().records||[]).filter(item=>item&&item.dataUrl&&!item.hiddenInChat&&item.taskKey===entry.taskKey&&Number(item.messageIndex)===messageIndex&&(!item.chatId||item.chatId===(context.chatId||''))&&(item.source||'chat')==='chat').sort((a,b)=>(Number(a.at)||0)-(Number(b.at)||0));
   if(savedRecords.length){
    const latest=savedRecords[savedRecords.length-1];
    const markerButton=host.querySelector('[data-ql-trigger="'+CSS.escape(entry.taskKey)+'"]');
    for(const record of savedRecords)addMessageImage(host,record.dataUrl,latest.basePrompt||entry.prompt,entry.taskKey,{messageIndex,source:'chat',character:latest.character||context.name||null,chatId:context.chatId||null},markerButton);
    host.querySelectorAll('[data-ql-trigger="'+CSS.escape(entry.taskKey)+'"]').forEach(button=>button.remove());
    continue;
   }
   const removedFromBody=(cfg().records||[]).some(item=>item&&item.hiddenInChat&&item.taskKey===entry.taskKey&&Number(item.messageIndex)===messageIndex&&(!item.chatId||item.chatId===(context.chatId||''))&&(item.source||'chat')==='chat');
   if(removedFromBody){host.querySelectorAll('[data-ql-trigger="'+CSS.escape(entry.taskKey)+'"]').forEach(button=>button.remove());continue;}
   if(host.querySelector('[data-ql-trigger="'+CSS.escape(entry.taskKey)+'"]'))continue;
   if([...host.querySelectorAll('[data-ql-prompt]')].some(button=>button.dataset.qlPrompt===entry.prompt&&button.dataset.qlTrigger===entry.taskKey))continue;
   const button=document.createElement('button');
   button.type='button';button.className='menu_button ql-inline-image-trigger';
   button.textContent='相册收录';
   button.title='点击生成图片并收录到当前消息（包含当前画师串预设）';
   button.dataset.qlTrigger=entry.taskKey;button.dataset.qlPrompt=entry.prompt;applyChatAlbumButtonStyle(button,cfg().chatAlbumStyle||'classic');applyChatTheme(button);
   button.addEventListener('click',()=>runInlineImageTrigger(button,entry));
   host.append(button);
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
  card._qlPrompt=prompt;card._qlCandidates=[];card._qlIndex=0;
  const controls=document.createElement('div');controls.className='ql-statusbar-controls';
  controls.style.cssText='position:absolute;inset:0;width:100%;height:100%;z-index:2147483000;display:block;visibility:hidden;opacity:0;pointer-events:none;background:transparent;border:0;padding:0;box-sizing:border-box;touch-action:manipulation;transition:opacity .22s ease;';
  const prev=document.createElement('button');prev.type='button';prev.className='ql-statusbar-arrow';prev.style.cssText='position:absolute;left:8%;top:50%;transform:translate(-50%,-50%);display:flex!important;align-items:center;justify-content:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border:1px solid rgba(255,255,255,.52);border-radius:50%;background:rgba(255,255,255,.34);color:#fff;box-shadow:0 1px 5px rgba(0,0,0,.10);pointer-events:auto;touch-action:manipulation;';prev.setAttribute('aria-label','上一张');prev.title='上一张';prev.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg>';
  const count=document.createElement('span');count.className='ql-statusbar-count';count.setAttribute('aria-live','polite');count.setAttribute('aria-label','当前图片序号');count.style.cssText='position:absolute;left:50%;bottom:10px;transform:translateX(-50%);display:inline-flex;align-items:center;justify-content:center;min-width:48px;padding:5px 10px;border:1px solid rgba(255,255,255,.5);border-radius:999px;background:rgba(20,16,22,.48);color:#fff;font-size:12px;line-height:1;pointer-events:none;backdrop-filter:blur(5px);';count.textContent='1 / 1';
  const next=document.createElement('button');next.type='button';next.className='ql-statusbar-arrow';next.style.cssText='position:absolute;right:8%;top:50%;transform:translate(50%,-50%);display:flex!important;align-items:center;justify-content:center;width:38px;height:38px;min-width:38px;min-height:38px;padding:0;border:1px solid rgba(255,255,255,.52);border-radius:50%;background:rgba(255,255,255,.34);color:#fff;box-shadow:0 1px 5px rgba(0,0,0,.10);pointer-events:auto;touch-action:manipulation;';next.setAttribute('aria-label','下一张');next.title='下一张';next.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';const favorite=document.createElement('button');favorite.type='button';favorite.className='menu_button ql-chat-image-favorite ql-statusbar-action ql-statusbar-favorite';favorite.setAttribute('aria-label','收藏到角色相册');favorite.title='收藏到角色相册';favorite.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg>';
  const remove=document.createElement('button');remove.type='button';remove.className='menu_button ql-chat-image-remove ql-statusbar-action ql-statusbar-delete';remove.setAttribute('aria-label','删除当前状态栏图片');remove.title='删除当前状态栏图片';remove.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6m-8-10 1 14h10l1-14M9 7V4h6v3"/></svg>';
  let controlsHideTimer=null;
  const showControlsBriefly=()=>{
   controls.style.setProperty('opacity','1','important');
   controls.style.setProperty('visibility','visible','important');
   controls.style.setProperty('pointer-events','auto','important');
   actionBar.style.setProperty('display','flex','important');actionBar.style.setProperty('visibility','visible','important');actionBar.style.setProperty('opacity','1','important');actionBar.style.setProperty('pointer-events','auto','important');
   if(controlsHideTimer)clearTimeout(controlsHideTimer);
   controlsHideTimer=setTimeout(()=>{
    controls.style.setProperty('opacity','0','important');
    controls.style.setProperty('pointer-events','none','important');
    controls.style.setProperty('visibility','hidden','important');
   },5000);
  };
  const hideControls=()=>{
   if(controlsHideTimer)clearTimeout(controlsHideTimer);
   controls.style.setProperty('opacity','0','important');
   controls.style.setProperty('pointer-events','none','important');
   controls.style.setProperty('visibility','hidden','important');
  };
  const matchingStatusRecords=url=>(cfg().records||[]).filter(item=>item&&item.taskKey===taskKey&&item.dataUrl===url&&(item.source||'chat')==='statusbar');
  const updateStatusActions=()=>{const current=card._qlCandidates[card._qlIndex];const records=current?.url?matchingStatusRecords(current.url):[];const saved=records.some(item=>item.albumCharacterName);favorite.classList.toggle('is-favorite',saved);favorite.title=saved?'取消收藏':'收藏到角色相册';favorite.setAttribute('aria-label',favorite.title);const star=favorite.querySelector('svg path');if(star){star.style.fill=saved?'currentColor':'none';star.style.stroke='currentColor';}remove.disabled=!current?.url;favorite.disabled=!current?.url;};
  const updateControls=()=>{const total=card._qlCandidates.length;count.textContent=total?String(card._qlIndex+1)+' / '+total:'0 / 0';prev.disabled=total<2;next.disabled=total<2;updateStatusActions();};
  card._qlRender=()=>{if(card._qlCandidates.length)img.src=card._qlCandidates[card._qlIndex].url;else img.removeAttribute('src');updateControls();};
  card._qlAddCandidate=url=>{if(!card._qlCandidates.some(item=>item.url===url)){card._qlCandidates.push({url,at:Date.now()});}card._qlIndex=card._qlCandidates.length-1;card._qlRender();};
  const moveCandidate=delta=>{const total=card._qlCandidates.length;if(total<2)return;card._qlIndex=(card._qlIndex+delta+total)%total;card._qlRender();showControlsBriefly();};
  prev.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();moveCandidate(-1);});
  next.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();moveCandidate(1);});
  for(const control of [prev,next]){control.addEventListener('touchstart',e=>e.stopPropagation(),{passive:true});control.addEventListener('touchend',e=>e.stopPropagation(),{passive:true});}
  const actionBar=document.createElement('div');actionBar.className='ql-statusbar-action-bar';actionBar.style.cssText='position:absolute!important;left:50%!important;bottom:12px!important;transform:translateX(-50%)!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:8px!important;width:max-content!important;max-width:96%!important;z-index:2147483647!important;pointer-events:auto!important;';
  for(const button of [favorite,remove]){button.style.cssText+=';position:static!important;display:flex!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;flex:0 0 40px!important;width:40px!important;height:40px!important;min-width:40px!important;min-height:40px!important;padding:8px!important;border:1px solid rgba(255,255,255,.7)!important;border-radius:50%!important;background:rgba(20,16,22,.72)!important;color:#fff!important;touch-action:manipulation!important;';}
  actionBar.append(favorite,remove);controls.append(prev,count,next,actionBar);
  favorite.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const current=card._qlCandidates[card._qlIndex];if(!current?.url)return;let records=matchingStatusRecords(current.url);if(!records.length){storeChatRecord(current.url,card._qlPrompt||prompt,taskKey,{source:'statusbar'});records=matchingStatusRecords(current.url);}if(!records.length){status('没有找到这张状态栏图片的缓存记录。');return;}if(records.some(item=>item.albumCharacterName)){for(const item of records){delete item.albumCharacterName;delete item.albumCharacterKey;}save();history();status('已取消收藏，图片仍保留在状态栏和缓存中。');}else{const character=currentCharacter();const name=String(character.name||getContext()?.name2||'当前角色').trim();for(const item of records){item.albumCharacterName=name;item.albumCharacterKey=character.id||'';}save();history();status('已收藏到「'+name+'」角色相册。');}updateStatusActions();});
  remove.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const current=card._qlCandidates[card._qlIndex];if(!current?.url)return;const records=cfg().records||[];const before=records.length;cfg().records=records.filter(item=>!(item&&item.taskKey===taskKey&&item.dataUrl===current.url&&(item.source||'chat')==='statusbar'));card._qlCandidates.splice(card._qlIndex,1);if(card._qlIndex>=card._qlCandidates.length)card._qlIndex=card._qlCandidates.length-1;save();history();card._qlRender();status(before===cfg().records.length?'已从当前状态栏轮播中移除图片。':'已删除当前状态栏图片及其缓存记录。');});
  controls.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation();});
  controls.addEventListener('click',e=>e.stopPropagation());
  const reroll=async()=>{if(card.dataset.busy==='1'||(Date.now()-(Number(card.dataset.lastRerollAt)||0))<900)return;card.dataset.lastRerollAt=Date.now();try{if(typeof navigator!=='undefined'&&typeof navigator.vibrate==='function')navigator.vibrate([28,42,28]);}catch{}const manualKey=taskKey+':manual:'+Date.now();const candidate=triggerRegistry.begin(manualKey,{prompt:card._qlPrompt,source:'statusbar-reroll'});if(!candidate.accepted)return;triggerRegistry.markRunning(manualKey);card.dataset.busy='1';try{const fresh=await requestWithActiveSettings(card._qlPrompt);card._qlAddCandidate(fresh);storeChatRecord(fresh,card._qlPrompt,taskKey,{source:'statusbar'});card._qlRender?.();triggerRegistry.markSucceeded(manualKey,manualKey+':candidate:'+Date.now());}catch(e){triggerRegistry.markFailed(manualKey,e?.message||String(e));alert('轻绘生成失败：'+(e?.message||String(e)));}finally{card.dataset.busy='0';}};
  img.style.touchAction='manipulation';
  // 手机浏览器的 pointerup 与 touchend 可能在同一次点击中都触发，混用会把单击误判成双击。
  // 触屏只使用 touchend；鼠标/触控笔使用 dblclick。监听放在覆盖层 card 上，避免图片元素被酒馆重绘替换后失效。
  let lastTouchTap=0,tapTimer=null,touchStartX=0,touchStartY=0;
  card.addEventListener('touchstart',e=>{
   if(e.target?.closest?.('.ql-statusbar-controls')||e.changedTouches?.length!==1)return;
   touchStartX=e.changedTouches[0].clientX;touchStartY=e.changedTouches[0].clientY;
  },{passive:true});
  card.addEventListener('touchend',e=>{
   if(e.target?.closest?.('.ql-statusbar-controls'))return;
   if(e.changedTouches?.length!==1)return;
   const touch=e.changedTouches[0],dx=touch.clientX-touchStartX,dy=touch.clientY-touchStartY;
   if(Math.abs(dx)>42&&Math.abs(dx)>Math.abs(dy)*1.25){
    lastTouchTap=0;
    if(tapTimer){clearTimeout(tapTimer);tapTimer=null;}
    const total=card._qlCandidates.length;
    if(total>1)moveCandidate(dx<0?1:-1);
    else showControlsBriefly();
    return;
   }
   const now=Date.now();
   if(lastTouchTap>0&&now-lastTouchTap<450){
    e.preventDefault();e.stopPropagation();lastTouchTap=0;
    if(tapTimer){clearTimeout(tapTimer);tapTimer=null;}
    reroll();
   }else{
    lastTouchTap=now;
    if(tapTimer)clearTimeout(tapTimer);
    tapTimer=setTimeout(()=>{
     tapTimer=null;lastTouchTap=0;
     showControlsBriefly();
    },450);
   }
  },{passive:false});
  card.addEventListener('click',e=>{
   if(e.detail>1||e.target?.closest?.('.ql-statusbar-controls'))return;
   // 单击图片只呼出居中的左右切换键，不直接切图。
   showControlsBriefly();
  });
  card.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation();reroll();});
  img.addEventListener('contextmenu',e=>{e.preventDefault();saveCleanImage(img.src,'shizhen-'+Date.now());});
  card.append(img,controls);frame.append(card);

 }
 if(!card._qlCandidates.some(item=>item.url===url)){card._qlCandidates.push({url,at:Date.now()});card._qlIndex=card._qlCandidates.length-1;}
 card._qlRender?.();
 frame.classList.remove('scanning');frame.dataset.qlDone='1';
}
function statusbarError(frame,prompt,taskKey,error){
 const existing=frame.querySelector('.ql-statusbar-error');if(existing)existing.remove();
 alert('轻绘生成失败：'+(error?.message||String(error)));
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
  // 恢复已缓存的状态栏图片：DOM 重绘/重新打开消息时不应自动重新请求 NAI。
  const savedStatusbar=(cfg().records||[])
   .filter(item=>item&&item.dataUrl&&item.taskKey===taskKey&&(item.source||'chat')==='statusbar')
   .sort((a,b)=>(Number(a.at)||0)-(Number(b.at)||0));
  if(savedStatusbar.length){
   const latest=savedStatusbar[savedStatusbar.length-1];
   renderStatusbarCard(frame,prompt,latest.dataUrl,taskKey);
   const card=frame.querySelector('.ql-statusbar-card');
   if(card){
    card._qlCandidates=[];
    for(const item of savedStatusbar){if(!card._qlCandidates.some(candidate=>candidate.url===item.dataUrl))card._qlCandidates.push({url:item.dataUrl,at:Number(item.at)||Date.now()});}
    card._qlIndex=card._qlCandidates.length-1;
    card._qlRender?.();
   }
   frame.dataset.qlBusy='0';
   continue;
  }
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
function albumCreateThemeStyle(){const preset=cfg().themePreset||'auto';let p=themePalettes[preset]||themePalettes.mist;if(preset==='custom'){const accent=/^#[0-9a-f]{6}$/i.test(String(cfg().themeColor||''))?cfg().themeColor:'#9aaec2';p={accent,card:'rgba(242,246,249,.98)',text:'#35434d',border:'transparent'};}return '--ql-create-bg:'+p.card+';--ql-create-text:'+p.text+';--ql-create-border:transparent;--ql-create-accent:'+p.accent+';';}
function applyTheme(preset,customColor){const panel=$('#qinghui-lite-panel');if(!panel)return;panel.querySelectorAll('#ql-custom-theme-style').forEach(x=>x.remove());if(preset==='auto'){for(const key of ['--ql-accent','--ql-panel','--ql-card','--ql-text','--ql-muted','--ql-border','--ql-field'])panel.style.removeProperty(key);panel.style.removeProperty('color');panel.style.removeProperty('background');return;}let p=themePalettes[preset];if(preset==='custom'){const accent=/^#[0-9a-f]{6}$/i.test(String(customColor||''))?customColor:'#9aaec2';p={accent,panel:'rgba(242,246,249,.98)',card:'rgba(252,253,254,.98)',text:'#35434d',muted:'#687680',border:'color-mix(in srgb, '+accent+' 32%, transparent)',field:'rgba(255,255,255,.98)'};}if(!p)return;panel.style.setProperty('--ql-accent',p.accent);panel.style.setProperty('--ql-panel',p.panel);panel.style.setProperty('--ql-card',p.card);panel.style.setProperty('--ql-text',p.text);panel.style.setProperty('--ql-muted',p.muted);panel.style.setProperty('--ql-border',p.border);panel.style.setProperty('--ql-field',p.field);panel.style.color='var(--ql-text)';panel.style.background='var(--ql-panel)';}
function save(){ saveSettingsDebounced(); }
function downloadJson(value,filename){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}
function exportVibeGroups(hideOriginalImages=false,sourceGroups=cfg().vibes||[]){
 const groups=(sourceGroups||[]).map(group=>{
  const clone=JSON.parse(JSON.stringify(group));
  if(!hideOriginalImages)return clone;
  const payloads=new Set((clone.entries||[]).map(entry=>String(entry?.image||'')).filter(value=>value.length>160));
  const placeholder='【原图已隐藏：导出时以文字占位】';
  const walk=(value,key='',insidePayload=false)=>{
   if(value==null||typeof value!=='object'){
    if(typeof value==='string'&&!insidePayload&&value.length>160&&(/^(?:image|thumbnail|preview|originalImage|sourceImage|referenceImage|imageData|image_data|thumbnailData|previewImage|original_image|source_image|reference_image)$/i.test(key)||/^data:image\//i.test(value)))return placeholder;
    return value;
   }
   if(Array.isArray(value))return value.map(item=>walk(item,key,insidePayload));
   const out={};
   for(const [childKey,childValue] of Object.entries(value)){
    const payloadBranch=insidePayload||/^(?:encodings?|encoding|encoded|encodedVibe|encoded_vibe|payload|base64|imageBase64|image_base64|vibeEncoding|vibe_encoding)$/i.test(childKey);
    if(!payloadBranch&&/^(?:thumbnail|preview|originalImage|sourceImage|thumbnailImage|previewImage|original_image|source_image|thumbnail_data|preview_data)$/i.test(childKey)&&typeof childValue==='string'&&childValue.length>80)out[childKey]=placeholder;
    else if(!payloadBranch&&/^image$/i.test(childKey)&&typeof childValue==='string'&&childValue.length>160&&!payloads.has(childValue))out[childKey]=placeholder;
    else out[childKey]=walk(childValue,childKey,payloadBranch);
   }
   return out;
  };
  clone.entries=(clone.entries||[]).map(entry=>{
   const copied={...entry};
   if(entry.raw&&typeof entry.raw==='object')copied.raw=walk(entry.raw,'raw',false);
   return copied;
  });
  if(clone.raw&&typeof clone.raw==='object')clone.raw=walk(clone.raw,'raw',false);
  if(clone.rawGroup&&typeof clone.rawGroup==='object')clone.rawGroup=walk(clone.rawGroup,'rawGroup',false);
  return clone;
 });
 return {format:'qinghui-vibe-export',version:1,exportedAt:new Date().toISOString(),hideOriginalImages:!!hideOriginalImages,groups};
}

function html(){return `<div id="ql-overlay" hidden><section id="qinghui-lite-panel">
<header class="ql-header"><div class="ql-brand"><strong>拾帧</strong><span>故事仍在继续，快门为你停留。</span></div><button id="ql-close" class="menu_button" type="button">关闭</button></header>
<nav class="ql-tabs" aria-label="拾帧功能导航" role="tablist">
<button type="button" class="ql-tab" data-page="generate" role="tab" aria-selected="false">取景</button>
<button type="button" class="ql-tab" data-page="library" role="tab" aria-selected="false">参数</button>
<button type="button" class="ql-tab" data-page="wordbank" role="tab" aria-selected="false">词笺</button>
<button type="button" class="ql-tab" data-page="history" role="tab" aria-selected="false">底片</button>
<button type="button" class="ql-tab active" data-page="albums" role="tab" aria-selected="true">拾帧</button>
<button type="button" class="ql-tab" data-page="settings" role="tab" aria-selected="false">偏好</button>
<button type="button" class="ql-tab" data-page="prompt-gallery" role="tab" aria-selected="false" style="display:none">提示词图集</button>
</nav>
<div class="ql-page" data-page-panel="generate" role="tabpanel" hidden>
<div class="ql-card ql-viewfinder-card"><div class="ql-viewfinder-heading"><h3>图片放置区</h3><div class="ql-viewfinder-actions" role="group" aria-label="图片操作"><button id="ql-generate" class="menu_button ql-primary ql-viewfinder-icon-button" type="button" aria-label="生成一张" title="生成一张"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M4 8.5h3l1.5-2h7l1.5 2h3A1.5 1.5 0 0 1 21.5 10v8A1.5 1.5 0 0 1 20 19.5H4A1.5 1.5 0 0 1 2.5 18v-8A1.5 1.5 0 0 1 4 8.5Z"/><circle cx="12" cy="13.5" r="3.2"/><path d="M17.5 11h.01"/></svg></button><button id="ql-result-favorite" class="menu_button ql-viewfinder-icon-button" type="button" aria-label="收藏到角色相册" title="收藏到角色相册" disabled><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2-5.6-3-5.6 3 1.1-6.2L3 9.6l6.2-.9L12 3Z"/></svg></button><button id="ql-result-enlarge" class="menu_button ql-viewfinder-icon-button" type="button" aria-label="放大查看" title="放大查看" disabled><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><circle cx="10.8" cy="10.8" r="6.3"/><path d="m15.5 15.5 5 5"/></svg></button></div></div><p class="ql-muted">生成后可收藏图片，或自适应屏幕查看大图。</p><div class="ql-viewfinder-layout"><div id="ql-result" class="ql-image-stage"><div class="ql-image-placeholder">等待生成图片</div></div></div></div>
<div class="ql-card"><h3>生图提示词</h3><p class="ql-muted">提示词库、角色词和画师串都直接写入下方正向/负向提示词，不另设 Tag 列表。</p><label for="ql-prompt">正向提示词</label><textarea id="ql-prompt" placeholder="输入完整提示词；从提示词库应用的内容会填入这里"></textarea><label for="ql-negative">负向提示词</label><textarea id="ql-negative" placeholder="可选"></textarea></div>
<div class="ql-card"><h3>影像配置</h3><label for="ql-active-config-mode">选择方式</label><select id="ql-active-config-mode"><option value="combo">选择组合（使用预设）</option><option value="separate">选择画师串 + 选择 Vibe</option></select><div id="ql-combo-config-row"><label for="ql-active-preset">选择预设组合</label><select id="ql-active-preset"><option value="-1">不使用组合</option></select></div><div id="ql-separate-config-row" hidden><label for="ql-active-artist">选择画师串</label><select id="ql-active-artist"><option value="-1">不使用画师串</option></select><label for="ql-active-vibe">选择 Vibe</label><select id="ql-active-vibe"><option value="-1">不使用 Vibe</option></select></div><div class="ql-row"><button id="ql-apply-preset" class="menu_button" type="button">应用组合</button><button id="ql-open-preset" class="menu_button" type="button">管理配置</button></div><p class="ql-muted">第一种直接使用已保存的预设组合；第二种分别选择画师串和 Vibe，两项可以独立设置。角色卡默认组合在「配置 → 预设」中管理。</p></div>
<div class="ql-card"><h3>模型参数</h3><label for="ql-fast-provider">生图后端</label><select id="ql-fast-provider"><option value="novelai">NovelAI 官网</option><option value="novelai-thirdparty">NovelAI 第三方</option></select><div id="ql-fast-openai" hidden><input id="ql-fast-model" value="gpt-image-1"><select id="ql-fast-size"><option value="auto">auto</option><option>1024x1024</option></select><select id="ql-fast-quality"><option>medium</option></select></div><div id="ql-fast-nai" hidden><label>NovelAI 模型</label><select id="ql-fast-nai-model"><option>nai-diffusion-4-5-full</option><option>nai-diffusion-4-5-curated</option><option>nai-diffusion-4-full</option><option>nai-diffusion-4-curated</option><option>nai-diffusion-3</option></select><div class="ql-row"><div><label>步数</label><input id="ql-fast-nai-steps" type="number" min="1" max="50"></div><div><label>CFG Scale</label><input id="ql-fast-nai-scale" type="number" min="1" max="20" step="0.5"></div></div><div class="ql-row"><div><label>画面尺寸预设</label><select id="ql-fast-nai-size-preset"><option value="832x1216">竖版 · 832 × 1216</option><option value="768x1344">长竖版 · 768 × 1344</option><option value="1024x1024">正方形 · 1024 × 1024</option><option value="1216x832">横版 · 1216 × 832</option><option value="1344x768">宽横版 · 1344 × 768</option></select><input id="ql-fast-nai-width" type="hidden"><input id="ql-fast-nai-height" type="hidden"></div></div><div class="ql-row"><div><label>采样器</label><select id="ql-fast-nai-sampler"><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option></select></div><div><label>调度器</label><select id="ql-fast-nai-scheduler"><option value="karras">Karras</option><option value="native">Native</option></select></div></div><label class="ql-inline-check"><input id="ql-fast-nai-normalize" type="checkbox"> 归一化 Vibe 参考强度</label><p class="ql-muted">开启后会自动归一化 V4/V4.5 多条 Vibe 的强度；关闭则按每条参考的原始强度发送。</p></div><p id="ql-status" class="ql-muted" role="status"></p></div>
</div>
<div class="ql-page" data-page-panel="library" role="tabpanel" hidden>
<nav class="ql-subtabs" role="tablist" aria-label="预设分区"><button type="button" class="ql-subtab active" data-subpage="artists" aria-selected="true">画师串</button><button type="button" class="ql-subtab" data-subpage="vibes" aria-selected="false">Vibe</button><button type="button" class="ql-subtab" data-subpage="bindings" aria-selected="false">预设</button></nav>
<section class="ql-subpage active" data-subpage-panel="artists"><div class="ql-card"><h3>画师串编辑区</h3><p class="ql-muted">可从下方列表切换画师串编辑；保存时更新当前选中的组合，也可以新建组合。</p><div class="ql-row ql-artist-toolbar"><select id="ql-preset-edit-select" aria-label="画师串名称"><option value="">选择要编辑的画师串</option></select><button type="button" class="menu_button ql-artist-toolbar-button" id="ql-preset-new">新建</button><button type="button" class="menu_button ql-artist-toolbar-button" id="ql-migrate-toggle" aria-expanded="false">一键迁移</button></div><div id="ql-migrate-panel" hidden><p class="ql-muted">自动扫描智绘姬与柏宝绘在当前酒馆可读取的设置，只迁移画师串的正向/负向提示词，不迁移 Vibe、参考图或其他数据。已存在的画师串会自动跳过。</p><div class="ql-row ql-migrate-actions"><button id="ql-migrate-scan" class="menu_button">开始一键迁移</button><button id="ql-migrate-file-btn" class="menu_button">导入设置 JSON（备用）</button><input id="ql-migrate-file" type="file" accept=".json,.json5,.txt,application/json" hidden></div><div id="ql-migrate-preview" class="ql-muted" role="status">点击「开始一键迁移」自动扫描。</div><button id="ql-migrate-import" class="menu_button" disabled>导入预览结果</button><p class="ql-muted">仅迁移画师串；不会导入 Vibe。</p></div><div id="ql-preset-editor" hidden><input id="ql-preset-name" placeholder="组合名称"><label>正向画师串</label><textarea id="ql-preset-positive" placeholder="artist:xxx, style tags..."></textarea><label>负向画师串</label><textarea id="ql-preset-negative" placeholder="可选"></textarea><button id="ql-preset-save" class="menu_button">保存画师串组合</button></div><button type="button" id="ql-preset-batch-toggle" class="menu_button">批量编辑</button><div id="ql-presets-batch" hidden><div class="ql-row ql-library-tools ql-preset-bulk-tools"><button type="button" id="ql-preset-export" class="menu_button">导出所选</button><button type="button" id="ql-preset-bulk-delete" class="menu_button">删除所选</button><button type="button" id="ql-preset-select-all" class="menu_button">全部选择</button><button type="button" id="ql-preset-clear-all" class="menu_button">取消全选</button></div><p class="ql-muted">点击画师串卡片可多选；再次点击可取消。选好后再导出或删除。</p><div id="ql-presets-list"></div></div></div></section><section class="ql-subpage" data-subpage-panel="vibes" hidden><div class="ql-card"><h3>Vibe 导入与编辑</h3><p class="ql-muted">支持导入预编码 Vibe 文件，也可以选择 PNG / JPG / WebP 图片，调用酒馆的 NovelAI Vibe 编码代理生成编码。图片编码可能消耗 NovelAI Anlas；如果提示接口 404，说明当前酒馆版本未提供该代理接口。</p><div class="ql-row"><button id="ql-vibe-create-group" type="button" class="menu_button">＋ 创建 Vibe 组</button><button id="ql-vibe-pick" type="button" class="menu_button ql-secondary">选择 Vibe 文件 / 图片</button></div><label for="ql-vibe-name">Vibe 名称</label><input id="ql-vibe-name" placeholder="例如：柔和配色参考"><label for="ql-vibe-info">Information Extracted</label><input id="ql-vibe-info" type="number" min="0.01" max="1" step="0.05" value="1"><label for="ql-vibe-import-target">导入方式</label><select id="ql-vibe-import-target"><option value="-1">导入为新组</option></select><p class="ql-muted">选择“导入为新组”会保留文件原有分组；选择已有组则把导入内容追加到该组，方便自己组合。</p><input id="ql-vibe-import-file" type="file" accept=".json,.json5,.txt,.naiv4vibe,.naiv4vibeBundle,image/png,image/jpeg,image/webp"><button id="ql-vibe-encode" type="button" class="menu_button">将选中的图片编码为 Vibe</button><p id="ql-vibe-status" class="ql-muted" role="status">尚未选择文件。</p><div class="ql-divider"></div><div class="ql-row"><button id="ql-vibe-import-shortcut" type="button" class="menu_button">导入 Vibe 文件</button></div><div id="ql-vibes-list"></div></div></section>
<section class="ql-subpage" data-subpage-panel="bindings" hidden><div class="ql-card ql-combo-editor-card"><div class="ql-section-heading"><div><h3>组合编辑器</h3><p class="ql-muted">先给组合命名，再分别选择画师串与 Vibe。两项都可以留空。</p></div><span class="ql-section-index">01</span></div><button type="button" id="ql-combo-new" class="menu_button ql-combo-new-button">＋ 新建组合</button><div id="ql-combo-editor" hidden><label for="ql-combo-name">组合名称</label><input id="ql-combo-name" placeholder="例如：柔和画风 + 氛围参考"><div class="ql-row ql-combo-pair"><div><label for="ql-combo-artist">画师串</label><select id="ql-combo-artist"><option value="-1">不使用画师串</option></select></div><div><label for="ql-combo-vibe">Vibe</label><select id="ql-combo-vibe"><option value="-1">不使用 Vibe</option></select></div></div><div class="ql-row"><button id="ql-combo-save" class="menu_button ql-primary">保存组合</button><button type="button" id="ql-combo-cancel" class="menu_button">取消</button></div></div></div><div class="ql-card ql-combo-list-card"><div class="ql-section-heading"><div><h3>已保存组合</h3><p class="ql-muted">每张卡只显示组合名称和对应素材，编辑或删除时再进入操作。</p></div><span class="ql-section-index">02</span></div><div id="ql-combos-list"></div></div><div class="ql-card ql-binding-default-card"><div class="ql-section-heading"><div><h3>角色卡默认绑定</h3><p class="ql-muted">角色卡直接绑定一个组合；正文单张影像临时选择不会改变默认设置。</p></div><span class="ql-section-index">03</span></div><label>角色卡</label><select id="ql-bind-character"><option value="">选择角色卡</option></select><label>默认组合</label><select id="ql-bind-preset"><option value="-1">不绑定组合</option></select><select id="ql-bind-vibe" hidden><option value="-1">组合内 Vibe 自动绑定</option></select><button id="ql-bind-save" class="menu_button">保存默认组合</button><div id="ql-bindings-list"></div></div></section>
</div>
<div class="ql-page" data-page-panel="wordbank" role="tabpanel" hidden>

<section class="ql-subpage active" data-subpage-panel="prompt-library"><div class="ql-card"><h3>提示词库</h3><p class="ql-muted">默认以小图网格浏览；点击某条才展开编辑区。</p><div id="ql-prompt-editor" hidden><section class="ql-library-prompt-field"><div class="ql-library-prompt-field-head"><label for="ql-library-prompt-en"><span class="ql-library-field-kicker">IMAGE PROMPT</span><span>画面提示词</span></label><button type="button" id="ql-library-prompt-copy" class="ql-library-copy-icon" aria-label="复制画面提示词" title="复制画面提示词"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button></div><textarea id="ql-library-prompt-en" placeholder="English prompt tags / description"></textarea></section><div class="ql-row"><input id="ql-prompt-name" placeholder="名称"><select id="ql-prompt-category"><option value="单人">单人</option><option value="双人">双人</option><option value="BG">BG</option><option value="BL">BL</option><option value="GL">GL</option><option value="其他">其他</option><option value="自定义">自定义分类…</option></select><input id="ql-prompt-category-custom" placeholder="输入自定义分类" hidden></div><label>自定义 Tag（用逗号、顿号、斜杠、空格或换行分隔）</label><textarea id="ql-library-prompt-zh" placeholder="例如：年上/暧昧，温柔 眼镜"></textarea><div class="ql-image-reference-editor"><label for="ql-library-image-file">预览图片</label><input id="ql-library-image-file" type="file" accept="image/*"><div id="ql-library-image-preview" class="ql-library-image-preview" data-image="" role="button" tabindex="0" aria-label="点击添加预览图片" title="点击此处选择图片"><span class="ql-muted">尚未添加预览图</span></div><button type="button" id="ql-library-image-clear" class="menu_button">移除预览图</button></div><div class="ql-row"><button id="ql-prompt-save" class="menu_button">保存提示词</button><button type="button" id="ql-prompt-cancel" class="menu_button">取消</button></div></div><button type="button" id="ql-prompt-add" class="menu_button ql-primary">＋ 添加提示词</button><div class="ql-row ql-library-tools ql-prompt-toolbar"><select id="ql-prompt-filter" aria-label="筛选提示词分类"><option value="">全部分类</option></select><button type="button" id="ql-library-edit-mode" class="menu_button">编辑模式</button><button type="button" id="ql-prompt-bulk-delete" class="menu_button">批量删除</button></div><p class="ql-muted" id="ql-library-edit-hint">提示词可按分类筛选；Tag 自由填写并自动拆分；应用后生成的图片会收录到对应图集。</p><div id="ql-prompts-list"></div></div></section>
<section class="ql-subpage" data-subpage-panel="character-library" hidden><div class="ql-card"><h3>角色词条库</h3><p class="ql-muted">先创建角色和生图词，再选择是否绑定到酒馆角色卡；也可以读取角色卡资料作为填写起点。</p><button type="button" id="ql-character-analyze" class="menu_button">读取所选角色卡并填入</button><label for="ql-character-card">绑定到酒馆角色卡（可选）</label><select id="ql-character-card"><option value="">暂不绑定</option></select><label for="ql-character-name">角色名称</label><input id="ql-character-name" placeholder="例如：角色名 / 卡内角色名"><label for="ql-character-appearance">生图词 / 固定外貌词</label><textarea id="ql-character-appearance" placeholder="填写外貌、发色、瞳色、服装等固定生图词"></textarea><div class="ql-row"><button id="ql-character-save" class="menu_button">保存角色词条</button><button type="button" id="ql-character-cancel" class="menu_button">新建</button></div><p class="ql-muted" id="ql-character-status" role="status"></p><div class="ql-row ql-library-tools"><button type="button" id="ql-character-export" class="menu_button">导出所选</button><button type="button" id="ql-character-bulk-delete" class="menu_button">批量删除</button></div><div id="ql-characters-list"></div></div></section>
</div>
<div class="ql-page" data-page-panel="history" role="tabpanel" hidden><div class="ql-card"><h3>影像缓存</h3><p class="ql-muted">这里保存生成过的影像记录；点击缩略图可查看提示词、参考图与生成参数。</p><label for="ql-history-columns">每行影像数量</label><select id="ql-history-columns"><option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option><option value="5">5 张</option></select><div id="ql-history"></div></div><div id="ql-cache-footer" class="ql-cache-bulk-tools"><button type="button" class="menu_button" id="ql-cache-select-mode" aria-pressed="false">多选</button><label class="ql-cache-select-all" hidden><input type="checkbox" data-ql-select-all disabled> 全选</label><span class="ql-cache-selected-count" data-ql-selected-count hidden>已选 0 张</span><button type="button" class="menu_button" data-ql-bulk-download disabled hidden>逐张下载</button><button type="button" class="menu_button" data-ql-bulk-delete disabled hidden>删除所选</button><button type="button" class="menu_button" id="ql-clear">清空影像缓存</button></div></div>
<div class="ql-page active" data-page-panel="albums" role="tabpanel"><div class="ql-card ql-album-library-card"><div id="ql-character-albums"></div></div></div>
<div class="ql-page" data-page-panel="prompt-gallery" role="tabpanel" hidden><div class="ql-card ql-prompt-gallery-page-card"><h3 id="ql-prompt-gallery-title" class="ql-muted" hidden>提示词图集</h3><p class="ql-muted" id="ql-prompt-gallery-description" hidden></p><div id="ql-prompt-gallery-content"></div></div></div>
<div class="ql-page" data-page-panel="settings" role="tabpanel" hidden><div class="ql-card"><h3>插件运行状态</h3><p class="ql-muted">关闭后会暂停拾帧的状态栏扫描、正文标记自动触发和自动生图；已有影像、相册与设置会保留。</p><div class="ql-row"><button id="ql-plugin-toggle" class="menu_button ql-primary" type="button" aria-pressed="true">插件：已启用</button></div></div><div class="ql-card"><h3>数据导出与导入</h3><p class="ql-muted">在这里导出或导入拾帧数据备份。导入备份会替换当前拾帧数据，请先备份现有内容。</p><div class="ql-row"><button id="ql-export-all-data" type="button" class="menu_button">导出拾帧数据</button><button id="ql-import-all-data" type="button" class="menu_button">导入拾帧备份</button></div><input id="ql-import-all-file" type="file" accept=".json,application/json" hidden><p id="ql-export-all-status" class="ql-muted" role="status"></p></div><div class="ql-card"><h3>图片下载选项</h3><p class="ql-muted">可选择保存为 PNG 或 JPG。PNG 保留原始文件及其元数据；JPG 会重新编码图像，不保留原 PNG 的提示词与生成参数数据块。</p><label for="ql-download-format">下载文件格式</label><select id="ql-download-format"><option value="png">PNG（.png）</option><option value="jpg">JPG（.jpg）</option></select><button id="ql-png-download-save" type="button" class="menu_button ql-primary">保存下载格式</button><p id="ql-png-download-status" class="ql-muted" role="status"></p></div><div class="ql-card"><h3>聊天相册样式</h3><p class="ql-muted">选择正文生图卡片的相册边框风格，保存后会应用到现有图片和新图片。</p><label for="ql-chat-album-style">相册外观</label><select id="ql-chat-album-style"><option value="classic">经典相册（白边留白）</option><option value="film">胶片相册（深色边框）</option><option value="soft">柔和卡片（圆角浅色）</option></select><button id="ql-chat-album-style-save" type="button" class="menu_button">应用相册样式</button><p id="ql-chat-album-style-status" class="ql-muted" role="status"></p></div><div class="ql-card"><h3>外观与配色</h3><p class="ql-muted">内置配色均为浅色、低饱和风格，避免深色边框影响图片展示；也可以用色环自选点缀色。</p><label for="ql-theme-preset">配色预设</label><select id="ql-theme-preset"><option value="auto">自适配酒馆美化</option><option value="mist">雾灰蓝</option><option value="sage">鼠尾草绿</option><option value="lavender">灰紫</option><option value="oat">燕麦奶茶</option><option value="custom">自选颜色</option></select><div id="ql-custom-color-row" hidden><label for="ql-theme-color">拖动色环选择点缀色</label><div class="ql-color-picker-row"><input id="ql-theme-color" type="color" value="#9aaec2" aria-label="自选点缀色"><span id="ql-theme-color-value">#9AAEC2</span></div><p class="ql-muted">只调整拾帧界面的点缀色，卡片和图片周围保持浅色底，不会把相框变成深色。</p></div><div class="ql-row"><button id="ql-theme-apply" type="button" class="menu_button">应用配色</button><button id="ql-theme-reset" type="button" class="menu_button">恢复自适配</button></div><p id="ql-theme-status" class="ql-muted" role="status"></p></div><div class="ql-card"><h3>接口连接设置</h3><nav class="ql-subtabs" role="tablist" aria-label="接口类型"><button type="button" class="ql-subtab active" data-subpage="conn-nai-official" aria-selected="true">NAI 官网</button><button type="button" class="ql-subtab" data-subpage="conn-nai-third" aria-selected="false">NAI 第三方</button></nav><section class="ql-subpage active" data-subpage-panel="conn-nai-official"><p class="ql-muted">官网模式使用 NovelAI 官方 API，Key 仅保存在当前酒馆扩展设置中。</p><label for="ql-nai-key">NovelAI 官网 Key</label><input id="ql-nai-key" type="password" autocomplete="off" placeholder="NovelAI Persistent API Token"><button id="ql-save-nai" class="menu_button ql-primary">保存 NAI 官网连接</button></section><section class="ql-subpage" data-subpage-panel="conn-nai-third" hidden><p class="ql-muted">第三方 NAI 兼容服务需要填写服务商提供的地址与 Key。</p><label for="ql-nai-third-endpoint">第三方 API 地址</label><input id="ql-nai-third-endpoint" placeholder="https://服务商地址"><label for="ql-nai-third-key">第三方 API Key</label><input id="ql-nai-third-key" type="password" autocomplete="off" placeholder="服务商提供的 Key"><button id="ql-save-nai-third" class="menu_button ql-primary">保存 NAI 第三方连接</button></section><div hidden><input id="ql-endpoint"><input id="ql-key"><input id="ql-gpt-endpoint"><input id="ql-gpt-key"></div></div><div hidden><select id="ql-provider"><option value="novelai">NovelAI 官网</option><option value="novelai-thirdparty">NovelAI 第三方</option></select><input id="ql-model"><select id="ql-size"><option value="auto">auto</option><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option><option>2048x2048</option><option>2048x1152</option><option>3840x2160</option><option>2160x3840</option></select><select id="ql-quality"><option>low</option><option>medium</option><option>high</option></select><input id="ql-nai-model"><input id="ql-nai-steps"><input id="ql-nai-scale"><input id="ql-nai-width" type="hidden"><input id="ql-nai-height" type="hidden"><select id="ql-nai-sampler"><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option></select><select id="ql-nai-scheduler"><option value="karras">Karras</option><option value="native">Native</option></select><input id="ql-nai-normalize" type="checkbox"><div id="ql-openai-settings" hidden></div><div id="ql-nai-settings" hidden></div></div></div>
</section></div>`;}

function syncFastControls(){if(!$('#ql-fast-provider'))return;$('#ql-provider').value=$('#ql-fast-provider').value;$('#ql-model').value=$('#ql-fast-model').value;$('#ql-size').value=$('#ql-fast-size').value;$('#ql-quality').value=$('#ql-fast-quality').value;$('#ql-nai-model').value=$('#ql-fast-nai-model').value;$('#ql-nai-steps').value=$('#ql-fast-nai-steps').value;$('#ql-nai-scale').value=$('#ql-fast-nai-scale').value;const dims=String($('#ql-fast-nai-size-preset').value||'832x1216').split('x').map(Number);$('#ql-fast-nai-width').value=dims[0]||832;$('#ql-fast-nai-height').value=dims[1]||1216;$('#ql-nai-width').value=$('#ql-fast-nai-width').value;$('#ql-nai-height').value=$('#ql-fast-nai-height').value;$('#ql-nai-sampler').value=$('#ql-fast-nai-sampler').value;$('#ql-nai-scheduler').value=$('#ql-fast-nai-scheduler').value;$('#ql-nai-normalize').checked=$('#ql-fast-nai-normalize').checked;}
function read(){syncFastControls();const s=cfg();s.provider=$('#ql-provider').value;s.endpoint=$('#ql-endpoint').value.trim().replace(/\/$/,'');s.apiKey=$('#ql-key').value.trim();s.model=$('#ql-model').value.trim()||'gpt-image-1';s.size=$('#ql-size').value;s.quality=$('#ql-quality').value;s.naiModel=$('#ql-nai-model').value.trim()||'nai-diffusion-4-5-full';s.naiSteps=Number($('#ql-nai-steps').value)||28;s.naiScale=Number($('#ql-nai-scale').value)||5;s.naiWidth=Number($('#ql-nai-width').value)||832;s.naiHeight=Number($('#ql-nai-height').value)||1216;s.naiSampler=$('#ql-nai-sampler').value;s.naiScheduler=$('#ql-nai-scheduler').value;s.naiNormalizeVibeStrengths=$('#ql-nai-normalize').checked;s.prompt=$('#ql-prompt').value;s.negative=$('#ql-negative').value;save();}
function status(t){$('#ql-status').textContent=t;}
function history(){
 const host=$('#ql-history');if(!host)return;
 const s=cfg(),records=s.records||[],cols=Math.max(1,Math.min(5,Number(s.historyColumns)||3));
 const settings=$('#ql-history-columns');
 if(settings){settings.value=String(cols);settings.onchange=()=>{s.historyColumns=Math.max(1,Math.min(5,Number(settings.value)||3));save();history();};}
 host.style.setProperty('--ql-history-columns',String(cols));
 host.innerHTML=(records.length?'<div class="ql-cache-grid" data-columns="'+cols+'">'+records.map((r,i)=>'<article class="ql-cache-tile"><button type="button" class="ql-cache-image" data-ql-detail="'+i+'" aria-label="查看影像详情"><img loading="lazy" src="'+esc(r.dataUrl||'')+'" alt="影像记录"></button></article>').join('')+'</div>':'<p class="ql-muted">暂无缓存影像。生成的影像会保存在这里。</p>');
 const albums=$('#ql-character-albums'),cacheView=host,viewTabs=document.querySelectorAll('[data-album-view]');
 const renderAlbums=()=>{
  if(!albums)return;
  const settings=cfg();if(!settings.albumNames||typeof settings.albumNames!=='object'||Array.isArray(settings.albumNames))settings.albumNames={};
  const favorites=(settings.records||[]).map((record,index)=>({...record,_cacheIndex:index})).filter(record=>record.albumCharacterName&&record.dataUrl);
  const groups=new Map();
  for(const record of favorites){const key=String(record.albumCharacterKey||record.albumCharacterName||'current');if(!groups.has(key))groups.set(key,[]);groups.get(key).push(record);}
  for(const key of Object.keys(settings.albumNames))if(!groups.has(key))groups.set(key,[]);
  const titleFor=(key,items)=>String(settings.albumNames[key]||items[0]?.albumCharacterName||'当前角色').trim()||'未命名相册';
  const imageTile=(record,index)=>'<article class="ql-cache-tile ql-album-photo '+(selectedPhotos().includes(index)?'is-selected':'')+'"><button type="button" class="ql-cache-image" data-album-photo="'+index+'" aria-label="查看照片"><img loading="lazy" src="'+esc(record.dataUrl||'')+'" alt="相册照片"></button><button type="button" class="ql-cache-favorite is-favorite" data-ql-unfavorite="'+record._cacheIndex+'" aria-label="移出相册" title="移出相册">×</button></article>';
  const selectedPhotos=()=>String(albums.dataset.albumSelectedPhotos||'').split(',').filter(Boolean).map(Number).filter(Number.isFinite);
  const setSelectedPhotos=values=>{albums.dataset.albumSelectedPhotos=[...new Set(values)].join(',');};
  const books=[...groups.entries()];
  const currentKey=albums.dataset.albumKey||'';
  const editMode=albums.dataset.albumShelfMode||'';
  const moveMode=albums.dataset.albumMoveMode||'';
  const selectedBooks=()=>String(albums.dataset.albumSelectedBooks||'').split('|').filter(Boolean);
  const setSelectedBooks=values=>{albums.dataset.albumSelectedBooks=[...new Set(values)].join('|');};
  if(currentKey&&groups.has(currentKey)){
   const key=currentKey,items=groups.get(key),name=titleFor(key,items);
   const mode=settings.albumViewMode==='flip'?'flip':'spread';
   const moving=moveMode==='select';
   albums.innerHTML='<div class="ql-album-toolbar"><button type="button" class="menu_button" data-album-back>‹ 所有相册</button><div class="ql-album-toolbar-title"><span>拾帧相册</span><strong>PHOTO ALBUM</strong><small>'+items.length+' 张照片</small></div><button type="button" class="menu_button" data-album-move>'+(moving?'完成选择并移动':'移动')+'</button></div>'+(moving?'<p class="ql-muted" role="status">已选择 '+selectedPhotos().length+' 张照片，点击照片进行多选；再次点击「完成选择并移动」选择目标相册。</p>':'')+'<div class="ql-album-mode" role="group" aria-label="照片排列方式"><button type="button" class="menu_button '+(mode==='flip'?'active':'')+'" data-album-mode="flip">翻页浏览</button><button type="button" class="menu_button '+(mode==='spread'?'active':'')+'" data-album-mode="spread">铺开浏览</button></div><div class="ql-album-paper '+(mode==='flip'?'is-flip':'is-spread')+'">'+(mode==='flip'?'<div class="ql-album-flip-book"><button type="button" class="menu_button ql-chat-image-arrow ql-chat-image-arrow-prev ql-album-page-arrow" data-album-step="-1" aria-label="上一张"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button><div class="ql-album-single-page"><button type="button" class="ql-album-single-photo" data-album-photo="'+String(items[0]?._cacheIndex ?? '')+'"><img src="'+esc(items[0]?.dataUrl||'')+'" alt="相册照片"></button><span class="ql-album-page-number" data-album-page-number>1/'+String(items.length)+'</span></div><button type="button" class="menu_button ql-chat-image-arrow ql-chat-image-arrow-next ql-album-page-arrow" data-album-step="1" aria-label="下一张"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button></div>':'<div class="ql-album-spread-book"><button type="button" class="menu_button ql-chat-image-arrow ql-chat-image-arrow-prev ql-album-page-arrow" data-spread-step="-1" aria-label="上一页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button><div class="ql-album-spread-grid" data-columns="2">'+items.slice(0,6).map(record=>imageTile(record,record._cacheIndex)).join('')+'</div><span class="ql-album-page-number" data-spread-page-number>1/'+String(Math.max(1,Math.ceil(items.length/6)))+'</span><button type="button" class="menu_button ql-chat-image-arrow ql-chat-image-arrow-next ql-album-page-arrow" data-spread-step="1" aria-label="下一页"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button></div>')+'</div><div id="ql-album-move-dialog" hidden role="dialog" aria-modal="true" aria-label="移动照片" style="position:fixed;inset:0;z-index:2147483647;background:rgba(20,16,24,.58);display:none;align-items:center;justify-content:center;padding:18px"><div style="width:min(100%,360px);max-height:80vh;overflow:auto;background:var(--SmartThemeBlurTintColor,#fff);color:var(--SmartThemeBodyColor,#333);border:1px solid var(--SmartThemeBorderColor,#ccc);border-radius:12px;padding:16px;box-shadow:0 12px 40px #0005"><h3 style="margin-top:0">移动到相册</h3><p class="ql-muted">已选择 '+selectedPhotos().length+' 张照片</p><div data-album-destinations></div><div class="ql-row" style="margin-top:12px"><button type="button" class="menu_button" data-album-move-cancel>取消</button><button type="button" class="menu_button ql-primary" data-album-move-confirm>移动照片</button></div></div></div>';
   albums.querySelector('[data-album-back]')?.addEventListener('click',()=>{albums.dataset.albumKey='';albums.dataset.albumMoveMode='';setSelectedPhotos([]);renderAlbums();});
   albums.querySelector('[data-album-move]')?.addEventListener('click',()=>{
    if(!moving){albums.dataset.albumMoveMode='select';setSelectedPhotos([]);renderAlbums();return;}
    const chosen=selectedPhotos();if(!chosen.length){status('请先选择要移动的照片。');return;}
    const dialog=albums.querySelector('#ql-album-move-dialog'),dest=dialog?.querySelector('[data-album-destinations]');if(!dialog||!dest){status('移动相册窗口无法创建，请刷新插件后重试。');return;}
    dest.innerHTML=[...groups.entries()].filter(([target])=>target!==key).map(([target,targetItems])=>'<label style="display:flex;gap:8px;align-items:center;padding:9px 4px;border-bottom:1px solid var(--SmartThemeBorderColor,rgba(127,127,127,.2))"><input type="radio" name="ql-album-destination" value="'+esc(target)+'"><span>'+esc(titleFor(target,targetItems))+'（'+targetItems.length+' 张）</span></label>').join('')+'<button type="button" class="menu_button" data-album-create-destination>＋ 新建目标相册</button>';
    dialog.hidden=false;dialog.style.display='flex';
    dialog.querySelector('[data-album-move-cancel]').onclick=()=>{dialog.hidden=true;dialog.style.display='none';};
    dialog.querySelector('[data-album-create-destination]').onclick=()=>{const label=prompt('新相册名称');if(label==null)return;const clean=label.trim();if(!clean){status('相册名称不能为空。');return;}const target='album-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);settings.albumNames[target]=clean;groups.set(target,[]);const radio=document.createElement('input');radio.type='radio';radio.name='ql-album-destination';radio.value=target;radio.checked=true;const row=document.createElement('label');row.style.cssText='display:flex;gap:8px;align-items:center;padding:9px 4px';row.append(radio,document.createTextNode(clean+'（0 张）'));dest.insertBefore(row,dest.querySelector('[data-album-create-destination]'));save();};
    dialog.querySelector('[data-album-move-confirm]').onclick=()=>{const target=dialog.querySelector('input[name="ql-album-destination"]:checked')?.value;if(!target){status('请先选择目标相册。');return;}const targetName=titleFor(target,groups.get(target)||[]);for(const index of chosen){const record=settings.records[index];if(record){record.albumCharacterKey=target;record.albumCharacterName=targetName;}}save();dialog.hidden=true;dialog.style.display='none';albums.dataset.albumKey=target;albums.dataset.albumMoveMode='';setSelectedPhotos([]);history();renderAlbums();status('已移动 '+chosen.length+' 张照片。');};
   });
   albums.querySelectorAll('[data-album-mode]').forEach(button=>button.addEventListener('click',()=>{settings.albumViewMode=button.dataset.albumMode;save();renderAlbums();}));
   const flipImage=albums.querySelector('.ql-album-single-photo img'),flipButton=albums.querySelector('.ql-album-single-photo'),pageNumber=albums.querySelector('[data-album-page-number]');
   let pageIndex=0;
   const paintFlip=()=>{if(!flipImage||!items.length)return;const item=items[pageIndex];flipImage.src=item.dataUrl;flipButton.dataset.albumPhoto=String(item._cacheIndex);if(pageNumber)pageNumber.textContent=String(pageIndex+1)+'/'+String(items.length);const prev=albums.querySelector('[data-album-step="-1"]'),next=albums.querySelector('[data-album-step="1"]');if(prev)prev.disabled=pageIndex===0;if(next)next.disabled=pageIndex===items.length-1;};
   albums.querySelectorAll('[data-album-step]').forEach(button=>button.addEventListener('click',()=>{pageIndex=Math.max(0,Math.min(items.length-1,pageIndex+Number(button.dataset.albumStep)));paintFlip();}));
   let spreadPage=0;const spreadGrid=albums.querySelector('.ql-album-spread-grid'),spreadNumber=albums.querySelector('[data-spread-page-number]');
   const paintSpread=()=>{if(!spreadGrid)return;const totalPages=Math.max(1,Math.ceil(items.length/6));spreadPage=Math.max(0,Math.min(totalPages-1,spreadPage));spreadGrid.innerHTML=items.slice(spreadPage*6,spreadPage*6+6).map(record=>imageTile(record,record._cacheIndex)).join('');if(spreadNumber)spreadNumber.textContent=String(spreadPage+1)+'/'+String(totalPages);const prev=albums.querySelector('[data-spread-step="-1"]'),next=albums.querySelector('[data-spread-step="1"]');if(prev)prev.disabled=spreadPage===0;if(next)next.disabled=spreadPage>=totalPages-1;};
   const handlePhotoClick=event=>{const photo=event.target?.closest?.('[data-album-photo]');if(!photo)return;if(albums.dataset.albumMoveMode==='select'){event.preventDefault();event.stopPropagation();const index=Number(photo.dataset.albumPhoto),chosen=selectedPhotos();setSelectedPhotos(chosen.includes(index)?chosen.filter(value=>value!==index):[...chosen,index]);photo.closest('.ql-album-photo')?.classList.toggle('is-selected',selectedPhotos().includes(index));const hint=albums.querySelector('.ql-album-toolbar')?.nextElementSibling;if(hint?.matches('.ql-muted'))hint.textContent='已选择 '+selectedPhotos().length+' 张照片，点击照片进行多选；再次点击「完成选择并移动」选择目标相册。';return;}openDetail(Number(photo.dataset.albumPhoto));};
   albums.addEventListener('click',handlePhotoClick);
   const handleRemove=event=>{const remove=event.target?.closest?.('[data-ql-unfavorite]');if(!remove)return;event.preventDefault();event.stopPropagation();const record=settings.records[Number(remove.dataset.qlUnfavorite)];if(record){delete record.albumCharacterName;delete record.albumCharacterKey;save();history();renderAlbums();status('已从相册移除，缓存图片仍保留。');}};
   spreadGrid?.addEventListener('click',handleRemove);
   albums.querySelectorAll('[data-spread-step]').forEach(button=>button.addEventListener('click',()=>{spreadPage=Math.max(0,Math.min(Math.max(0,Math.ceil(items.length/6)-1),spreadPage+Number(button.dataset.spreadStep)));paintSpread();}));
   const spreadArea=albums.querySelector('.ql-album-spread-grid');let spreadStartX=0;spreadArea?.addEventListener('touchstart',event=>{spreadStartX=event.changedTouches[0].clientX;},{passive:true});spreadArea?.addEventListener('touchend',event=>{const dx=event.changedTouches[0].clientX-spreadStartX;if(Math.abs(dx)>40){spreadPage=Math.max(0,Math.min(Math.max(0,Math.ceil(items.length/6)-1),spreadPage+(dx<0?1:-1)));paintSpread();}},{passive:true});
   if(flipButton)flipButton.addEventListener('click',event=>{if(albums.dataset.albumMoveMode==='select'){handlePhotoClick(event);}});
   let startX=0;const flipArea=albums.querySelector('.ql-album-single-page');flipArea?.addEventListener('touchstart',event=>{startX=event.changedTouches[0].clientX;},{passive:true});flipArea?.addEventListener('touchend',event=>{const dx=event.changedTouches[0].clientX-startX;if(Math.abs(dx)>40){pageIndex=Math.max(0,Math.min(items.length-1,pageIndex+(dx<0?1:-1)));paintFlip();}},{passive:true});
   paintFlip();paintSpread();return;
  }
  albums.dataset.albumKey='';
  if(!settings.albumCovers||typeof settings.albumCovers!=='object'||Array.isArray(settings.albumCovers))settings.albumCovers={};
  const createCard='<article class="ql-album-card ql-album-create-card" style="'+albumCreateThemeStyle()+'"><button type="button" class="ql-album-card-open ql-album-create-open" data-album-new aria-label="新建相册"><svg class="ql-album-create-svg" viewBox="0 0 48 48" aria-hidden="true" focusable="false"><path d="M24 9v30M9 24h30" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/></svg></button></article>';
  const characterForAlbum=key=>{const ctx=getContext()||{},chars=Array.isArray(ctx.characters)?ctx.characters:[];const n=Number(key);if(String(key).trim()!==''&&Number.isInteger(n)&&n>=0&&chars[n])return chars[n];return chars.find(ch=>String(ch?.name||'')===String(key)||String(ch?.avatar||'')===String(key))||null;};
  const cards=books.map(([key,items])=>{const name=titleFor(key,items),selected=selectedBooks().includes(key),manualCover=settings.albumCovers[key],character=characterForAlbum(key),avatar=character?.avatar?'/characters/'+encodeURIComponent(String(character.avatar)):'';const cover=manualCover||avatar;return '<article class="ql-album-card '+(selected?'is-selected':'')+'"><button type="button" class="ql-album-card-open" data-open-album="'+esc(key)+'" aria-label="打开'+esc(name)+'相册"><span class="ql-album-card-cover">'+(cover?'<img src="'+String(cover).replace(/&/g,'&amp;').replace(/"/g,'&quot;')+'" alt="" loading="lazy" onerror="this.closest(\'.ql-album-card-cover\').innerHTML=\'<span class=&quot;ql-album-cover-placeholder&quot;><span class=&quot;ql-album-placeholder-mark&quot;>✳</span><span>PHOTO ALBUM</span></span>\'">':'<span class="ql-album-cover-placeholder"><span class="ql-album-placeholder-mark">✳</span><span>PHOTO ALBUM</span></span>')+'</span></button><div class="ql-album-card-caption"><div class="ql-album-card-caption-text"><strong>'+esc(name)+'</strong><span>'+items.length+' 张照片</span></div><button type="button" class="ql-album-more" data-album-more="'+esc(key)+'" aria-label="相册菜单">⋮</button><div class="ql-album-more-menu" data-album-menu="'+esc(key)+'" hidden><button type="button" data-album-cover="'+esc(key)+'">上传封面</button><button type="button" data-album-rename="'+esc(key)+'">编辑名称</button><button type="button" data-album-delete="'+esc(key)+'">删除相册</button></div></div></article>';}).join('');
  const shelfPageCount=Math.max(1,Math.ceil((books.length+1)/9));let shelfPage=Math.max(0,Math.min(shelfPageCount-1,Number(albums.dataset.albumShelfPage||0)));albums.dataset.albumShelfPage=String(shelfPage);const shelfCards=(createCard+cards).match(/<article class="ql-album-card[\s\S]*?<\/article>/g)||[];const visibleShelfCards=shelfCards.slice(shelfPage*9,shelfPage*9+9).join('');
  albums.innerHTML='<section class="ql-album-library-shell"><div class="ql-album-library-heading"><div class="ql-album-library-title"><h3>拾帧相册</h3><span class="ql-album-library-subtitle">Framehaven · 每一帧，都有自己的故事</span></div><span class="ql-album-library-count">'+books.length+' 个相册</span></div><div class="ql-album-shelf-pager"><button type="button" class="ql-album-shelf-arrow ql-album-shelf-prev" data-shelf-step="-1" aria-label="上一页">‹</button><div class="ql-album-grid">'+visibleShelfCards+'</div><button type="button" class="ql-album-shelf-arrow ql-album-shelf-next" data-shelf-step="1" aria-label="下一页">›</button></div><div class="ql-album-shelf-page-number">'+(shelfPage+1)+' / '+shelfPageCount+'</div></section><input type="file" accept="image/*" data-album-cover-input hidden><div class="ql-album-crop-modal" data-album-crop-modal hidden><div class="ql-album-crop-panel" role="dialog" aria-modal="true" aria-label="调整相册封面"><div class="ql-album-crop-heading"><strong>调整封面</strong><span>拖动图片调整取景范围</span></div><div class="ql-album-crop-viewport" data-crop-viewport><img data-crop-image alt="封面裁剪预览"></div><div class="ql-album-crop-control"><span>缩放</span><svg class="ql-crop-slider" data-svg-slider="zoom" viewBox="0 0 260 28" role="slider" tabindex="0" aria-label="缩放" aria-valuemin="1" aria-valuemax="3" aria-valuenow="1"><line x1="10" y1="14" x2="250" y2="14" class="ql-crop-slider-base"/><line x1="10" y1="14" x2="10" y2="14" class="ql-crop-slider-fill"/><circle cx="10" cy="14" r="6" class="ql-crop-slider-thumb"/></svg><input type="range" data-crop-zoom min="1" max="3" step=".01" value="1" aria-hidden="true" tabindex="-1"></div><div class="ql-album-crop-control"><span>左右</span><svg class="ql-crop-slider" data-svg-slider="x" viewBox="0 0 260 28" role="slider" tabindex="0" aria-label="左右取景" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><line x1="10" y1="14" x2="250" y2="14" class="ql-crop-slider-base"/><line x1="10" y1="14" x2="130" y2="14" class="ql-crop-slider-fill"/><circle cx="130" cy="14" r="6" class="ql-crop-slider-thumb"/></svg><input type="range" data-crop-x min="0" max="100" value="50" aria-hidden="true" tabindex="-1"></div><div class="ql-album-crop-control"><span>上下</span><svg class="ql-crop-slider" data-svg-slider="y" viewBox="0 0 260 28" role="slider" tabindex="0" aria-label="上下取景" aria-valuemin="0" aria-valuemax="100" aria-valuenow="50"><line x1="10" y1="14" x2="250" y2="14" class="ql-crop-slider-base"/><line x1="10" y1="14" x2="130" y2="14" class="ql-crop-slider-fill"/><circle cx="130" cy="14" r="6" class="ql-crop-slider-thumb"/></svg><input type="range" data-crop-y min="0" max="100" value="50" aria-hidden="true" tabindex="-1"></div><div class="ql-album-crop-actions"><button type="button" data-crop-cancel>取消</button><button type="button" data-crop-save>设为封面</button></div></div></div>';
  albums.querySelectorAll('[data-shelf-step]').forEach(button=>button.addEventListener('click',()=>{const total=Math.max(1,Math.ceil((books.length+1)/9));albums.dataset.albumShelfPage=String(Math.max(0,Math.min(total-1,Number(albums.dataset.albumShelfPage||0)+Number(button.dataset.shelfStep))));renderAlbums();}));
  const shelfPrev=albums.querySelector('[data-shelf-step="-1"]'),shelfNext=albums.querySelector('[data-shelf-step="1"]');if(shelfPrev)shelfPrev.disabled=shelfPage===0;if(shelfNext)shelfNext.disabled=shelfPage>=shelfPageCount-1;
  albums.querySelectorAll('[data-open-album]').forEach(button=>button.addEventListener('click',()=>{albums.dataset.albumKey=button.dataset.openAlbum;albums.dataset.albumMoveMode='';setSelectedPhotos([]);renderAlbums();}));
  albums.querySelectorAll('[data-album-more]').forEach(button=>button.addEventListener('click',event=>{event.stopPropagation();const key=button.dataset.albumMore;albums.querySelectorAll('[data-album-menu]').forEach(menu=>{menu.hidden=menu.dataset.albumMenu!==key||!menu.hidden;});}));
  const cropModal=albums.querySelector('[data-album-crop-modal]'),cropImage=albums.querySelector('[data-crop-image]'),cropViewport=albums.querySelector('[data-crop-viewport]'),zoomControl=albums.querySelector('[data-crop-zoom]'),xControl=albums.querySelector('[data-crop-x]'),yControl=albums.querySelector('[data-crop-y]');
  let cropSource=null,cropKey='',cropNaturalW=0,cropNaturalH=0,dragPoint=null;
  const updateCropPreview=()=>{if(!cropImage||!cropViewport||!cropNaturalW||!cropNaturalH)return;const scale=Math.max(cropViewport.clientWidth/cropNaturalW,cropViewport.clientHeight/cropNaturalH)*Number(zoomControl.value||1),w=cropNaturalW*scale,h=cropNaturalH*scale;cropImage.style.width=w+'px';cropImage.style.height=h+'px';cropImage.style.maxWidth='none';cropImage.style.maxHeight='none';const maxX=Math.max(0,w-cropViewport.clientWidth),maxY=Math.max(0,h-cropViewport.clientHeight);cropImage.style.left=(-maxX*Number(xControl.value||50)/100)+'px';cropImage.style.top=(-maxY*Number(yControl.value||50)/100)+'px';};
  const closeCrop=()=>{cropModal.hidden=true;cropSource=null;cropImage.removeAttribute('src');};
  albums.querySelectorAll('[data-album-cover]').forEach(button=>button.addEventListener('click',()=>{albums.dataset.coverTarget=button.dataset.albumCover;albums.querySelector('[data-album-cover-input]')?.click();}));
  albums.querySelector('[data-album-cover-input]')?.addEventListener('change',event=>{const file=event.target.files?.[0],key=albums.dataset.coverTarget;event.target.value='';if(!file||!key)return;if(!file.type.startsWith('image/')){status('请选择图片文件。');return;}if(file.size>15*1024*1024){status('封面原图请小于 15 MB。');return;}const reader=new FileReader();reader.onload=()=>{cropSource=new Image();cropKey=key;cropSource.onload=()=>{cropNaturalW=cropSource.naturalWidth;cropNaturalH=cropSource.naturalHeight;cropImage.src=reader.result;zoomControl.value='1';xControl.value='50';yControl.value='50';cropModal.hidden=false;requestAnimationFrame(updateCropPreview);};cropSource.onerror=()=>status('图片读取失败，请换一张图片。');cropSource.src=reader.result;};reader.readAsDataURL(file);});
  const sliderInputs={zoom:zoomControl,x:xControl,y:yControl};
  const paintSvgSlider=name=>{const svg=albums.querySelector('[data-svg-slider="'+name+'"]'),input=sliderInputs[name];if(!svg||!input)return;const min=Number(input.min||0),max=Number(input.max||100),value=Number(input.value||min),x=10+240*(value-min)/(max-min||1);svg.querySelector('.ql-crop-slider-fill').setAttribute('x2',String(x));svg.querySelector('.ql-crop-slider-thumb').setAttribute('cx',String(x));svg.setAttribute('aria-valuenow',String(value));};
  const setSvgSlider=(name,event)=>{const svg=albums.querySelector('[data-svg-slider="'+name+'"]'),input=sliderInputs[name];if(!svg||!input)return;const rect=svg.getBoundingClientRect(),ratio=Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width));input.value=String(Number(input.min||0)+ratio*(Number(input.max||100)-Number(input.min||0)));input.dispatchEvent(new Event('input',{bubbles:true}));};
  albums.querySelectorAll('[data-svg-slider]').forEach(svg=>{const name=svg.dataset.svgSlider;let dragging=false;svg.addEventListener('pointerdown',event=>{dragging=true;svg.setPointerCapture?.(event.pointerId);setSvgSlider(name,event);});svg.addEventListener('pointermove',event=>{if(dragging)setSvgSlider(name,event);});['pointerup','pointercancel','lostpointercapture'].forEach(type=>svg.addEventListener(type,()=>{dragging=false;}));svg.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const input=sliderInputs[name],step=Number(input.step||1);if(event.key==='Home')input.value=input.min;else if(event.key==='End')input.value=input.max;else input.value=String(Math.max(Number(input.min),Math.min(Number(input.max),Number(input.value)+(event.key==='ArrowRight'?1:-1)*step*Math.max(1,(Number(input.max)-Number(input.min))/100))));input.dispatchEvent(new Event('input',{bubbles:true}));});});
  const syncSvgSliders=()=>Object.keys(sliderInputs).forEach(paintSvgSlider);
  [zoomControl,xControl,yControl].forEach(input=>input?.addEventListener('input',()=>{updateCropPreview();syncSvgSliders();}));
  syncSvgSliders();
  cropViewport?.addEventListener('pointerdown',event=>{if(!cropImage.src)return;dragPoint={x:event.clientX,y:event.clientY,left:parseFloat(cropImage.style.left)||0,top:parseFloat(cropImage.style.top)||0};cropViewport.setPointerCapture?.(event.pointerId);});
  cropViewport?.addEventListener('pointermove',event=>{if(!dragPoint)return;const maxX=Math.max(0,cropImage.offsetWidth-cropViewport.clientWidth),maxY=Math.max(0,cropImage.offsetHeight-cropViewport.clientHeight);cropImage.style.left=Math.max(-maxX,Math.min(0,dragPoint.left+event.clientX-dragPoint.x))+'px';cropImage.style.top=Math.max(-maxY,Math.min(0,dragPoint.top+event.clientY-dragPoint.y))+'px';if(maxX)xControl.value=String(Math.round(-parseFloat(cropImage.style.left)/maxX*100));if(maxY)yControl.value=String(Math.round(-parseFloat(cropImage.style.top)/maxY*100));});
  ['pointerup','pointercancel','lostpointercapture'].forEach(name=>cropViewport?.addEventListener(name,()=>{dragPoint=null;}));
  albums.querySelector('[data-crop-cancel]')?.addEventListener('click',closeCrop);
  cropModal?.addEventListener('click',event=>{if(event.target===cropModal)closeCrop();});
  albums.querySelector('[data-crop-save]')?.addEventListener('click',()=>{if(!cropSource||!cropKey)return;const width=480,height=600,scale=Math.max(width/cropNaturalW,height/cropNaturalH)*Number(zoomControl.value||1),sw=width/scale,sh=height/scale,maxSX=Math.max(0,cropNaturalW-sw),maxSY=Math.max(0,cropNaturalH-sh),sx=maxSX*Number(xControl.value||50)/100,sy=maxSY*Number(yControl.value||50)/100,canvas=document.createElement('canvas');canvas.width=width;canvas.height=height;const ctx=canvas.getContext('2d');if(!ctx){status('无法处理这张图片，请换一张。');return;}ctx.drawImage(cropSource,sx,sy,sw,sh,0,0,width,height);try{settings.albumCovers[cropKey]=canvas.toDataURL('image/jpeg',.88);save();closeCrop();renderAlbums();status('相册封面已更新。');}catch(error){status('封面保存失败，图片可能过大，请换一张。');}});
  albums.querySelectorAll('[data-album-rename]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.albumRename,old=titleFor(key,groups.get(key)||[]),next=prompt('编辑相册名称',old);if(next==null)return;const clean=next.trim();if(!clean){status('相册名称不能为空。');return;}settings.albumNames[key]=clean;for(const record of settings.records||[])if(String(record.albumCharacterKey||record.albumCharacterName||'current')===key)record.albumCharacterName=clean;save();renderAlbums();status('相册名称已更新。');}));
  albums.querySelectorAll('[data-album-delete]').forEach(button=>button.addEventListener('click',()=>{const key=button.dataset.albumDelete,name=titleFor(key,groups.get(key)||[]);if(!confirm('删除相册「'+name+'」？照片仍会保留在影像缓存中。'))return;delete settings.albumNames[key];delete settings.albumCovers[key];for(const record of settings.records||[])if(String(record.albumCharacterKey||record.albumCharacterName||'current')===key){delete record.albumCharacterKey;delete record.albumCharacterName;}save();renderAlbums();status('相册已删除，照片仍保留在影像缓存中。');}));
  albums.querySelector('[data-album-new]')?.addEventListener('click',()=>{const next=prompt('新建相册名称');if(next==null)return;const clean=next.trim();if(!clean){status('相册名称不能为空。');return;}const key='album-'+Date.now()+'-'+Math.random().toString(36).slice(2,7);settings.albumNames[key]=clean;save();renderAlbums();status('已新建相册。');});
  albums.addEventListener('click',event=>{if(!event.target.closest('[data-album-more],[data-album-menu]'))albums.querySelectorAll('[data-album-menu]').forEach(menu=>menu.hidden=true);});
 };
 const setAlbumView=view=>{const albumMode=view==='albums';if(cacheView)cacheView.hidden=albumMode;if(albums)albums.hidden=!albumMode;viewTabs.forEach(button=>{const active=button.dataset.albumView===view;button.classList.toggle('active',active);button.setAttribute('aria-selected',String(active));});if(albumMode)renderAlbums();};
 viewTabs.forEach(button=>button.onclick=()=>setAlbumView(button.dataset.albumView));
 const footer=$('#ql-cache-footer');const clearButton=footer?.querySelector('#ql-clear');if(clearButton)clearButton.onclick=()=>{if(confirm('清空拾帧本地生成记录？不会删除聊天图片。')){cfg().records=[];save();history();status('记录已清空。');}};
 let modal=document.getElementById('ql-image-cache-modal');
 if(!modal){
  const modalHost=document.getElementById('ql-overlay')||document.body;modalHost.insertAdjacentHTML('beforeend','<div id="ql-image-cache-modal" hidden role="dialog" aria-modal="true" aria-label="图片详情"><div class="ql-cache-modal-panel"><button type="button" class="menu_button ql-cache-modal-close">关闭</button><div class="ql-cache-modal-content"></div></div></div>');
  modal=document.getElementById('ql-image-cache-modal');
  modal.querySelector('.ql-cache-modal-close').addEventListener('click',()=>{modal.hidden=true;modal.style.display='';});
  modal.addEventListener('click',e=>{if(e.target===modal){modal.hidden=true;modal.style.display='';}});
 }
 const openDetail=index=>{
  const r=records[index];if(!r)return;
  const preset=r.preset||null,vibe=r.vibe||null,meta=r.config||{};
  const content=modal.querySelector('.ql-cache-modal-content');
  const themePanel=document.querySelector('#qinghui-lite-panel');
  if(themePanel){const theme=getComputedStyle(themePanel);for(const name of ['--ql-accent','--ql-panel','--ql-card','--ql-text','--ql-border','--ql-muted']){const value=theme.getPropertyValue(name).trim();if(value)modal.style.setProperty(name,value);}}
  const createdAt=new Date(r.at||Date.now());
  const promptText=String(r.basePrompt||r.prompt||'');
  const promptWords=promptText.split(/[,，\\n]+/).map(x=>x.trim()).filter(Boolean).length;
  const vibeCount=Array.isArray(vibe?.entries)?vibe.entries.length:0;
  content.innerHTML='<div class="ql-cache-detail-hero"><div class="ql-cache-detail-image-wrap"><img class="ql-cache-large" src="'+esc(r.dataUrl||'')+'" alt="生成结果"></div><div class="ql-cache-detail-heading"><span class="ql-cache-eyebrow">IMAGE ARCHIVE · 拾帧缓存</span><h3>生成记录</h3><p>'+esc(createdAt.toLocaleString())+'</p><div class="ql-cache-badges"><span>'+esc(r.provider||'未知后端')+'</span><span>'+esc(r.model||meta.model||'未知模型')+'</span><span>'+esc(r.size||meta.size||'尺寸未知')+'</span></div></div></div><div class="ql-cache-stat-grid"><div class="ql-cache-stat"><span>提示词条目</span><strong>'+promptWords+'</strong></div><div class="ql-cache-stat"><span>Vibe 参考</span><strong>'+vibeCount+'</strong></div><div class="ql-cache-stat"><span>画师串</span><strong>'+esc(preset?.name||'未使用')+'</strong></div></div><section class="ql-cache-prompt-section"><div class="ql-cache-section-title"><div><span class="ql-cache-eyebrow">PROMPT</span><h4>画面提示词</h4></div><button type="button" class="ql-cache-copy-icon ql-cache-copy-pill" data-copy-positive aria-label="复制画面提示词" title="复制画面提示词"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="11" height="13" rx="2"></rect><path d="M16 8V5a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h3"></path></svg></button></div><div class="ql-cache-prompt-box"><pre>'+esc(promptText||'此记录没有保存正向提示词')+'</pre></div></section><div class="ql-cache-detail-actions"><button type="button" class="menu_button ql-cache-action-primary" data-modal-load>载入提示词</button><button type="button" class="menu_button" data-modal-save>保存图片</button></div><div class="ql-cache-accordions"><details><summary><span>画师串预设</span><small>'+esc(preset?.name||'未使用')+'</small></summary><div class="ql-cache-accordion-body"><label>预设正文</label><pre>'+esc(preset?.positive||'未记录')+'</pre><label>预设负向词</label><pre>'+esc(preset?.negative||'未记录')+'</pre></div></details><details><summary><span>负向提示词</span><small>NEGATIVE PROMPT</small></summary><div class="ql-cache-accordion-body"><pre>'+esc(r.negative||meta.negative||'未记录')+'</pre></div></details><details><summary><span>Vibe 参考</span><small>'+vibeCount+' 条参考</small></summary><div class="ql-cache-accordion-body"><pre>'+esc(vibe?JSON.stringify(vibe,null,2):'未使用 Vibe')+'</pre></div></details><details><summary><span>完整生成参数</span><small>ADVANCED</small></summary><div class="ql-cache-accordion-body"><pre>'+esc(JSON.stringify(meta,null,2))+'</pre></div></details></div>';
  content.querySelector('[data-copy-positive]').onclick=async()=>{const value=String(r.basePrompt||r.prompt||'');try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);}else{const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw new Error('浏览器未允许复制');}const button=content.querySelector('[data-copy-positive]');button.classList.add('is-copied');button.setAttribute('title','已复制');button.setAttribute('aria-label','已复制正向提示词');status('已复制画面提示词。');setTimeout(()=>{button.classList.remove('is-copied');button.setAttribute('title','复制画面提示词');button.setAttribute('aria-label','复制画面提示词');},1300);}catch(error){status('复制失败：请长按画面提示词文本手动复制。');}};
  content.querySelector('[data-modal-load]').onclick=()=>{$('#ql-prompt').value=r.basePrompt||r.prompt||'';$('#ql-negative').value=r.negative||'';read();modal.hidden=true;modal.style.display='';status('基础提示词已载入；记录中的画师串不会自动切换，请确认当前画师串后再生成。');};
  content.querySelector('[data-modal-save]').onclick=async e=>{e.preventDefault();e.stopPropagation();const button=e.currentTarget;if(button.dataset.busy==='1')return;button.dataset.busy='1';try{const imageUrl=String(r.dataUrl||content.querySelector('.ql-cache-large')?.currentSrc||content.querySelector('.ql-cache-large')?.src||'');const result=await saveCleanImage(imageUrl,'shizhen-'+(r.at||Date.now()),true);status((result?.edgeFallback?'已打开下载面板，请点击面板中的“保存图片”。':result?.downloadStarted?'已发起图片下载；请在浏览器下载列表或系统下载目录查看。':'已发起图片下载。')+(lastPngCleanReport?' '+lastPngCleanReport:''));}catch(e){status(e.message||String(e));}finally{delete button.dataset.busy;}};
  modal.hidden=false;modal.style.display='flex';
 };
 const modeButton=footer?.querySelector('#ql-cache-select-mode');let selectionMode=false;const setSelectionMode=enabled=>{selectionMode=enabled;if(modeButton){modeButton.textContent=enabled?'完成选择':'多选';modeButton.setAttribute('aria-pressed',String(enabled));}const allLabel=footer?.querySelector('.ql-cache-select-all'),count=footer?.querySelector('[data-ql-selected-count]'),bulkDelete=footer?.querySelector('[data-ql-bulk-delete]'),bulkDownload=footer?.querySelector('[data-ql-bulk-download]');if(allLabel)allLabel.hidden=!enabled;if(count)count.hidden=!enabled;if(bulkDelete)bulkDelete.hidden=!enabled;if(bulkDownload)bulkDownload.hidden=!enabled;host.classList.toggle('ql-cache-selection-mode',enabled);if(!enabled){host.querySelectorAll('.ql-cache-tile.is-selected').forEach(tile=>tile.classList.remove('is-selected'));host.querySelectorAll('[data-ql-select]').forEach(input=>input.checked=false);}updateSelection();};if(modeButton)modeButton.onclick=()=>setSelectionMode(!selectionMode);
 host.querySelectorAll('[data-ql-detail]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();const i=Number(b.dataset.qlDetail);if(selectionMode&&b.classList.contains('ql-cache-image')){const tile=b.closest('.ql-cache-tile');const input=tile?.querySelector('[data-ql-select]');if(input)input.checked=!input.checked;else{const hidden=document.createElement('input');hidden.type='checkbox';hidden.dataset.qlSelect=String(i);hidden.checked=true;hidden.hidden=true;tile?.append(hidden);}tile?.classList.toggle('is-selected',!!tile?.querySelector('[data-ql-select]')?.checked);updateSelection();return;}openDetail(i);});
 host.querySelectorAll('[data-ql-download]').forEach(b=>b.onclick=async e=>{e.preventDefault();e.stopPropagation();const button=e.currentTarget;if(button.dataset.busy==='1')return;button.dataset.busy='1';try{const r=records[Number(button.dataset.qlDownload)];if(!r)throw new Error('找不到这条缓存记录。');const result=await saveCleanImage(r.dataUrl,'shizhen-'+(r.at||Date.now()));status((result?.edgeFallback?'已打开下载面板，请点击面板中的“保存图片”。':result?.downloadStarted?'已发起图片下载；请在浏览器下载列表或系统下载目录查看。':'已发起图片下载。')+(lastPngCleanReport?' '+lastPngCleanReport:''));}catch(e){status(e.message||String(e));}finally{delete button.dataset.busy;}});
 host.querySelectorAll('[data-ql-delete]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();const i=Number(b.dataset.qlDelete);if(!confirm('删除这条拾帧图片缓存？不会删除聊天消息中的图片。'))return;s.records.splice(i,1);save();history();status('图片缓存已删除。');});
 const updateSelection=()=>{const tiles=[...host.querySelectorAll('.ql-cache-tile')],selected=tiles.filter(tile=>tile.classList.contains('is-selected')||tile.querySelector('[data-ql-select]')?.checked);const count=footer?.querySelector('[data-ql-selected-count]'),bulkDelete=footer?.querySelector('[data-ql-bulk-delete]'),bulkDownload=footer?.querySelector('[data-ql-bulk-download]'),all=footer?.querySelector('[data-ql-select-all]');if(count)count.textContent='已选 '+selected.length+' 张';if(bulkDelete)bulkDelete.disabled=!selected.length;if(bulkDownload)bulkDownload.disabled=!selected.length;if(all){all.disabled=!tiles.length;all.checked=tiles.length>0&&selected.length===tiles.length;all.indeterminate=selected.length>0&&selected.length<tiles.length;}};
 host.querySelectorAll('[data-ql-select]').forEach(input=>input.addEventListener('change',()=>{input.closest('.ql-cache-tile')?.classList.toggle('is-selected',input.checked);updateSelection();}));
 footer?.querySelector('[data-ql-select-all]')?.addEventListener('change',e=>{host.querySelectorAll('.ql-cache-tile').forEach(tile=>{let input=tile.querySelector('[data-ql-select]');if(!input){input=document.createElement('input');input.type='checkbox';input.dataset.qlSelect=tile.querySelector('[data-ql-detail]')?.dataset.qlDetail||'';input.hidden=true;tile.append(input);}input.checked=e.currentTarget.checked;tile.classList.toggle('is-selected',input.checked);});updateSelection();});
 footer?.querySelector('[data-ql-bulk-download]')?.addEventListener('click',async e=>{e.preventDefault();e.stopPropagation();const selected=[...host.querySelectorAll('.ql-cache-tile.is-selected')].map(tile=>Number(tile.querySelector('[data-ql-detail]')?.dataset.qlDetail)).filter(i=>Number.isInteger(i)&&i>=0&&i<s.records.length);if(!selected.length)return;const button=e.currentTarget;button.disabled=true;const original=button.textContent;button.textContent='正在逐张下载…';let success=0,failed=0,redrawn=0,unchanged=0;try{const items=selected.map(i=>({record:s.records[i],index:i})).filter(x=>x.record?.dataUrl);if(!items.length)throw new Error('所选记录中没有可下载的图片数据。');status('准备逐张下载 '+items.length+' 张图片；浏览器可能会询问是否允许多个文件下载。');for(let n=0;n<items.length;n++){const {record,index}=items[n];try{const response=await fetch(record.dataUrl);if(!response.ok)throw new Error('读取图片失败');const originalBlob=await response.blob();const blob=cfg().downloadFormat==='jpg'?await convertImageBlobToJpeg(originalBlob):originalBlob;if(!blob.size)throw new Error('图片数据为空');if(cfg().downloadFormat!=='jpg')unchanged++;const url=URL.createObjectURL(blob);const ext=blob.type.includes('jpeg')?'jpg':blob.type.includes('webp')?'webp':blob.type.includes('gif')?'gif':'png';const a=document.createElement('a');a.href=url;a.download='shizhen-'+(record.at||Date.now())+'.'+ext;a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);}catch(error){failed++;console.warn('[轻绘 Lite] 单张缓存下载失败',index,error);continue;}success++;if(n<items.length-1)await new Promise(resolve=>setTimeout(resolve,350));}status('逐张下载已发起：成功 '+success+' 张'+(failed?'，失败 '+failed+' 张':'')+'。'+(cfg().downloadFormat!=='jpg'?' PNG 保留原始文件。':' JPG 已重新编码。')+' 若 Edge 拦截了多个文件，请允许此页面的多个下载，或分批选择。');}catch(error){console.error('[轻绘 Lite] 缓存逐张下载失败',error);status('下载失败：'+(error?.message||String(error)));}finally{button.disabled=false;button.textContent=original;}});
 footer?.querySelector('[data-ql-bulk-delete]')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const selected=[...host.querySelectorAll('.ql-cache-tile.is-selected')].map(tile=>Number(tile.querySelector('[data-ql-detail]')?.dataset.qlDetail)).filter(Number.isInteger);if(!selected.length)return;if(!confirm('确定删除选中的 '+selected.length+' 张缓存图片？不会删除聊天消息中的图片。'))return;selected.sort((a,b)=>b-a).forEach(i=>{if(i>=0&&i<s.records.length)s.records.splice(i,1);});save();history();status('已删除所选缓存图片。');});
 // 每次刷新缓存时同步刷新独立的角色相册页；此前只有缓存页内的子标签点击才会渲染相册。
 renderAlbums();
}
function renderLibrary(){
 const s=cfg();
 const prompts=$('#ql-prompts-list'),chars=$('#ql-characters-list'),presets=$('#ql-presets-list'),vibes=$('#ql-vibes-list');
 const characterSelect=$('#ql-character-card');
 if(characterSelect){
  const ctx=getContext()||{},cards=Array.isArray(ctx.characters)?ctx.characters:[];
  const prior=characterSelect.value;
  characterSelect.innerHTML='<option value="">选择角色卡</option>'+cards.map((ch,i)=>'<option value="'+i+'">'+esc(ch?.name||ch?.avatar||('角色 '+(i+1)))+'</option>').join('');
  if(cards.some((ch,i)=>String(i)===prior))characterSelect.value=prior;else characterSelect.value='';
 }
 const promptFilter=$('#ql-prompt-filter');
 if(promptFilter){const prior=promptFilter.value;const categories=['单人','双人','BG','BL','GL','其他',...new Set((s.prompts||[]).map(p=>String(p.category||'其他').trim()).filter(Boolean))].filter((v,i,a)=>a.indexOf(v)===i);promptFilter.innerHTML='<option value="">全部分类</option>'+categories.map(c=>'<option value="'+esc(c)+'">'+esc(c)+'</option>').join('');if(categories.includes(prior))promptFilter.value=prior;}
 const filterValue=promptFilter?.value||'';
 let promptIdsMigrated=false;(s.prompts||[]).forEach((p,i)=>{if(!p.id){p.id='prompt-'+Date.now().toString(36)+'-'+i.toString(36)+'-'+Math.random().toString(36).slice(2,7);s.prompts[i]=p;promptIdsMigrated=true;}});if(promptIdsMigrated)save();
 if(prompts)prompts.innerHTML=(s.prompts||[]).map((p,i)=>({p,i})).filter(({p})=>!filterValue||String(p.category||'其他')===filterValue).map(({p,i})=>{const tags=String(p.promptZh||'').split(/[\s,，、/／|;；·]+/u).map(tag=>tag.trim()).filter(Boolean);const normalizePrompt=value=>String(value||'').trim().replace(/[\s,，、/／|;；·]+/gu,' ').toLowerCase();const targetPrompt=normalizePrompt(p.promptEn||p.prompt||'');const photos=(s.records||[]).filter(r=>{if(!r||!r.dataUrl)return false;if(r.promptEntryId===p.id)return true;if(r.promptEntryId)return false;const oldPrompt=normalizePrompt(r.basePrompt||r.prompt||'');return Boolean(targetPrompt&&oldPrompt===targetPrompt);});return '<div class="ql-prompt-tile" data-prompt-entry="'+esc(p.id)+'"><button type="button" class="ql-prompt-thumb" data-prompt-edit="'+i+'" aria-label="编辑 '+esc(p.name)+'">'+(p.image?'<img loading="lazy" src="'+esc(p.image)+'" alt="">':'<span>无预览图</span>')+'</button>'+(libraryEditMode?'<label class="ql-bulk-check"><input type="checkbox" data-prompt-select="'+i+'" '+(selectedPrompts.has(i)?'checked':'')+'>选择</label>':'')+'<strong>'+esc(p.name)+'</strong>'+(tags.length?'<div class="ql-prompt-tags">'+tags.map(tag=>'<span class="ql-prompt-tag">'+esc(tag)+'</span>').join('')+'</div>':'')+'<div class="ql-prompt-tile-actions"><button class="menu_button" data-prompt-roll="'+i+'">应用</button><button class="menu_button" data-prompt-edit="'+i+'">编辑</button><button class="menu_button" data-prompt-gallery="'+i+'">图集</button></div><div class="ql-prompt-gallery" data-prompt-gallery-panel="'+i+'" hidden></div></div>';}).join('')||'<p class="ql-muted">暂无符合条件的提示词</p>';
 if(chars)chars.innerHTML=(s.characters||[]).map((p,i)=>'<div class="ql-record ql-library-record">'+(libraryEditMode?'<label class="ql-bulk-check"><input type="checkbox" data-character-select="'+i+'" '+(selectedCharacters.has(i)?'checked':'')+'>选择</label>':'')+'<strong>'+esc(p.name||p.characterName||'未命名角色')+'</strong><p>'+esc(p.appearance)+'</p><small>'+esc(p.characterName?'已绑定：'+p.characterName:'尚未绑定角色卡')+'</small><div class="ql-row"><button class="menu_button" data-character-apply="'+i+'">追加生图词</button><button class="menu_button" data-character-edit="'+i+'">编辑</button><button class="menu_button" data-character-delete="'+i+'">删除词条</button></div></div>').join('')||'<p class="ql-muted">尚未保存角色词条</p>';
 if(presets){const batch=$('#ql-presets-batch');if(batch)batch.hidden=!presetBatchMode;presets.innerHTML=(s.presets||[]).map((p,i)=>'<div class="ql-record ql-preset-compact'+(presetBatchMode?' ql-preset-selectable':'')+(selectedPresets.has(i)?' is-selected':'')+'" data-preset-card="'+i+'" '+(presetBatchMode?'role="button" tabindex="0" aria-pressed="'+String(selectedPresets.has(i))+'"':'')+'><div class="ql-preset-compact-info"><strong>'+esc(p.name||('画师串 '+(i+1)))+'</strong><p class="ql-muted">正向 '+(p.positive?'已设置':'空')+' · 负向 '+(p.negative?'已设置':'未设置')+'</p></div>'+(presetBatchMode?'':'<div class="ql-preset-compact-actions"><button type="button" class="menu_button" data-preset-apply="'+i+'">应用</button><button type="button" class="menu_button" data-preset-edit="'+i+'">编辑</button><button type="button" class="menu_button" data-preset-delete="'+i+'">删除</button></div>')+'</div>').join('')||'<p class="ql-muted">暂无画师串。</p>';presets.querySelectorAll('[data-preset-card]').forEach(card=>{const toggle=()=>{if(!presetBatchMode)return;const i=Number(card.dataset.presetCard);if(selectedPresets.has(i))selectedPresets.delete(i);else selectedPresets.add(i);renderLibrary();};card.addEventListener('click',event=>{if(!presetBatchMode||event.target.closest('button'))return;toggle();});card.addEventListener('keydown',event=>{if(!presetBatchMode||!['Enter',' '].includes(event.key))return;event.preventDefault();toggle();});});}
 const editorSelect=$('#ql-preset-edit-select');
 if(editorSelect){const old=editorSelect.value;editorSelect.innerHTML='<option value="">画师串名称</option>'+(s.presets||[]).map((p,i)=>'<option value="'+i+'">'+esc(p.name||('画师串 '+(i+1)))+'</option>').join('');if(old!==''&&s.presets[Number(old)])editorSelect.value=old;}
 if(vibes)vibes.innerHTML=(s.vibes||[]).map((v,i)=>{
  const entries=Array.isArray(v.entries)?v.entries:[];
  const usable=entries.filter(entry=>(typeof entry.image==='string'&&entry.image.replace(/\s+/g,'').length>160)||!!extractUsableVibe(entry.raw||entry)?.image).length;
  const active=Number(s.activeVibeIndex)===i;
  const entryRows=entries.map((entry,j)=>{
   const ready=(typeof entry.image==='string'&&entry.image.replace(/\s+/g,'').length>160)||!!extractUsableVibe(entry.raw||entry)?.image;
   const entryName=String(entry.name||entry.title||entry.label||entry.filename||entry.raw?.name||entry.raw?.title||entry.raw?.label||('参考 '+(j+1)));return '<div class="ql-vibe-entry"><div class="ql-vibe-entry-head"><strong>'+esc(entryName)+'</strong><span class="ql-vibe-state '+(ready?'is-ready':'is-missing')+'">'+(ready?'编码可用':'缺少编码')+'</span></div><label>参考名称</label><input data-vibe-entry-name="'+i+'-'+j+'" value="'+esc(entryName)+'" placeholder="给这条 Vibe 起个名字"><div class="ql-row"><div><label>参考强度</label><input type="number" min="0" max="1" step="0.05" data-vibe-entry-strength="'+i+'-'+j+'" value="'+Math.max(0,Math.min(1,Number(entry.strength??0.6)))+'"></div><div><label>Information Extracted</label><input type="number" min="0" max="1" step="0.05" disabled title="编码完成后该值固定；修改它需要重新编码原始图片" data-vibe-entry-info="'+i+'-'+j+'" value="'+Math.max(0,Math.min(1,Number(entry.informationExtracted??1)))+'"></div></div><button type="button" class="menu_button" data-vibe-entry-delete="'+i+'-'+j+'">移除此参考</button></div>';
  }).join('');
  return '<div class="ql-record ql-vibe-group '+(active?'is-active':'')+'"><div class="ql-vibe-group-top"><div class="ql-vibe-group-info"><strong>'+esc(v.name||'未命名 Vibe')+'</strong><p>'+usable+' / '+entries.length+' 条参考可用'+(active?' · 当前使用中':'')+'</p></div><button type="button" class="menu_button" data-vibe-use="'+i+'">'+(active?'当前使用中':'整组使用')+'</button></div><label>组名称</label><input data-vibe-name="'+i+'" value="'+esc(v.name||'')+'"><details class="ql-vibe-details"><summary>编辑组内参考（'+entries.length+'）</summary>'+(entryRows||'<p class="ql-muted">没有可编辑的编码条目。请导入包含预编码资源的官网文件或智绘姬 Vibe 组 JSON。</p>')+'<details><summary>查看导入来源</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere;max-height:180px;overflow:auto">'+esc(JSON.stringify({source:v.source,sourcePath:v.sourcePath,groupName:v.groupName,identifier:entries.map(e=>e.identifier).filter(Boolean),rawPreserved:!!(v.raw||v.rawGroup)},null,2).slice(0,2000))+'</pre></details></details><div class="ql-vibe-group-actions"><button type="button" class="menu_button" data-vibe-save="'+i+'">保存修改</button><button type="button" class="menu_button" data-vibe-export="'+i+'">导出本组</button><button type="button" class="menu_button" data-vibe-delete="'+i+'">删除整组</button></div></div>';
 }).join('')||'<p class="ql-muted">暂无 Vibe。导入预编码文件后会显示为独立分组；每个分组可单独导出，不会打包其他 Vibe 组或拾帧数据。</p>';
 vibes?.querySelectorAll('[data-vibe-export]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.vibeExport),group=s.vibes[i];if(!group)return;const hide=false;const payload=exportVibeGroups(false,[group]);if(payload.groups.length!==1)throw new Error('导出范围异常：一次只能导出当前 Vibe 组。');const safeName=String(group.name||('vibe-group-'+(i+1))).replace(/[\\/:*?"<>|]+/g,'_').trim()||('vibe-group-'+(i+1));downloadJson(payload,safeName+'.json');$('#ql-vibe-status').textContent='已导出 Vibe 组「'+(group.name||'未命名 Vibe')+'」，仅包含当前组。';});
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
   const entryNameInput=vibes.querySelector('[data-vibe-entry-name="'+i+'-'+j+'"]');if(entryNameInput&&entryNameInput.value.trim())entry.name=entryNameInput.value.trim();
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
 const importTarget=$('#ql-vibe-import-target');if(importTarget){const oldTarget=importTarget.value;importTarget.innerHTML='<option value="-1">导入为新组</option>'+s.vibes.map((v,i)=>'<option value="'+i+'">追加到：'+esc(v.name||('Vibe 组 '+(i+1)))+'</option>').join('');if([...importTarget.options].some(o=>o.value===oldTarget))importTarget.value=oldTarget;}
 renderActiveVibes();renderActivePresets();renderActiveArtists();renderActiveConfigMode();renderBindings();
 const fillCombos=()=>{const a=$('#ql-combo-artist'),v=$('#ql-combo-vibe'),b=$('#ql-bind-preset');if(a){const old=a.value;a.innerHTML='<option value="-1">不使用画师串</option>'+s.presets.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('画师串 '+(i+1)))+'</option>').join('');if([...a.options].some(o=>o.value===old))a.value=old;}if(v){const old=v.value;v.innerHTML='<option value="-1">不使用 Vibe</option>'+s.vibes.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('Vibe '+(i+1)))+'</option>').join('');if([...v.options].some(o=>o.value===old))v.value=old;}if(b){const old=b.value;b.innerHTML='<option value="-1">不绑定组合</option>'+s.combinations.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('组合 '+(i+1)))+'</option>').join('');if([...b.options].some(o=>o.value===old))b.value=old;}};
 fillCombos();const comboHost=$('#ql-combos-list');if(comboHost){comboHost.innerHTML=s.combinations.map((x,i)=>'<div class="ql-combo-record"><div class="ql-combo-record-head"><strong>'+esc(x.name||('组合 '+(i+1)))+'</strong></div><div class="ql-combo-materials"><div class="ql-combo-material"><span>画师串</span>'+esc(s.presets[x.artistIndex]?.name||'未使用')+'</div><div class="ql-combo-material"><span>VIBE</span>'+esc(s.vibes[x.vibeIndex]?.name||'未使用')+'</div></div><div class="ql-row"><button type="button" class="menu_button" data-combo-edit="'+i+'">编辑组合</button><button type="button" class="menu_button" data-combo-delete="'+i+'">删除</button></div></div>').join('')||'<p class="ql-muted">暂无组合。</p>';comboHost.querySelectorAll('[data-combo-edit]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.comboEdit),x=s.combinations[i];$('#ql-combo-name').value=x.name||'';$('#ql-combo-artist').value=String(x.artistIndex??-1);$('#ql-combo-vibe').value=String(x.vibeIndex??-1);$('#ql-combo-editor').hidden=false;$('#ql-combo-save').dataset.edit=String(i);$('#ql-combo-save').textContent='保存修改';$('#ql-combo-editor').scrollIntoView({behavior:'smooth',block:'nearest'});});comboHost.querySelectorAll('[data-combo-delete]').forEach(b=>b.onclick=()=>{const i=Number(b.dataset.comboDelete);s.combinations.splice(i,1);s.bindings.forEach(x=>{if(Number(x.combinationIndex)===i)x.combinationIndex=-1;else if(Number(x.combinationIndex)>i)x.combinationIndex--;});if(Number(s.activeComboIndex)===i)s.activeComboIndex=-1;else if(Number(s.activeComboIndex)>i)s.activeComboIndex--;save();renderLibrary();renderBindings();renderActivePresets();});}
 prompts?.querySelectorAll('[data-prompt-select]').forEach(b=>b.onchange=()=>{const i=Number(b.dataset.promptSelect);if(b.checked)selectedPrompts.add(i);else selectedPrompts.delete(i);});
 prompts?.querySelectorAll('[data-prompt-roll]').forEach(b=>b.onclick=()=>{const p=s.prompts[+b.dataset.promptRoll];$('#ql-prompt').value=String(p.promptEn||p.prompt||'');s.activePromptEntryId=p.id||null;s.activePromptEntryAppliedAt=Date.now();save();read();$('#qinghui-lite-panel .ql-tab[data-page="generate"]')?.click();status('已应用提示词：'+p.name+'。生成的图片会归入这条提示词的图集。');});
  prompts?.querySelectorAll('[data-prompt-gallery]').forEach(button=>button.onclick=()=>{
  const promptIndex=Number(button.dataset.promptGallery),settings=cfg(),promptEntry=settings.prompts[promptIndex];
  if(!promptEntry)return;
  const root=$('#qinghui-lite-panel');
  if(!root)return;
  const normalizePrompt=value=>String(value||'').trim().replace(/[\s,，、/／|;；·]+/gu,' ').toLowerCase();
  const targetPrompt=normalizePrompt(promptEntry.promptEn||promptEntry.prompt||'');
  const items=(settings.records||[]).map((record,cacheIndex)=>({...record,_cacheIndex:cacheIndex})).filter(record=>{
   if(!record?.dataUrl)return false;
   if(record.promptEntryId===promptEntry.id||record.sourcePromptEntryId===promptEntry.id)return true;
   // 若旧记录携带了失效/错误的词笺 ID，仍以基础画面提示词匹配，避免照片只出现在缓存区。
   return Boolean(targetPrompt&&normalizePrompt(record.basePrompt||record.prompt||'')===targetPrompt);
  });
  root.dataset.activePromptGalleryId=promptEntry.id||'';
  root.dataset.activePromptGalleryIndex=String(promptIndex);
  const title=$('#ql-prompt-gallery-title'),description=$('#ql-prompt-gallery-description'),content=$('#ql-prompt-gallery-content');
  if(title)title.textContent=(promptEntry.name||'未命名提示词')+' · 图集';
  if(description)description.textContent='仅铺开显示当前提示词关联的全部照片；点击照片只放大预览，不跳转影像缓存。';
  if(content){
   const photoButton=record=>'<article class="ql-album-photo ql-prompt-gallery-photo"><button type="button" class="ql-prompt-gallery-photo-button" data-prompt-record="'+record._cacheIndex+'" aria-label="放大预览照片"><img loading="lazy" src="'+esc(record.dataUrl||'')+'" alt="提示词图集照片"></button></article>';
   content.innerHTML='<div class="ql-album-toolbar"><button type="button" class="menu_button" data-prompt-gallery-back>‹ 返回提示词库</button><div class="ql-album-toolbar-title"><span>PHOTO ALBUM</span><strong>'+esc(promptEntry.name||'未命名提示词')+' 图集</strong><small>'+items.length+' 张照片</small></div></div><div class="ql-album-paper is-spread">'+(items.length?'<div class="ql-album-spread-grid ql-prompt-gallery-spread" data-columns="2">'+items.map(photoButton).join('')+'</div>':'<div class="ql-album-empty-book"><div class="ql-album-empty-cover"><span>PHOTO ALBUM</span><strong>这本图集还没有照片</strong><small>应用该提示词生成图片后，关联的影像会自动收录在这里，不需要进入影像缓存。</small></div></div>')+'</div>';
   content.querySelector('[data-prompt-gallery-back]')?.addEventListener('click',()=>{
    root.querySelectorAll('button.ql-tab').forEach(item=>{const active=item.dataset.page==='wordbank';item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});
    root.querySelectorAll('[data-page-panel]').forEach(node=>{const active=node.dataset.pagePanel==='wordbank';node.hidden=!active;node.classList.toggle('active',active);});
    const tab=root.querySelector('button.ql-subtab[data-subpage="prompt-library"]');
    if(tab){const scope=tab.closest('.ql-page')||root;scope.querySelectorAll('button.ql-subtab').forEach(item=>{const active=item===tab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});scope.querySelectorAll('[data-subpage-panel]').forEach(node=>{const active=node.dataset.subpagePanel==='prompt-library';node.hidden=!active;node.classList.toggle('active',active);});}
   });
   content.querySelectorAll('[data-prompt-record]').forEach(photo=>photo.addEventListener('click',()=>{
    const record=items.find(item=>item._cacheIndex===Number(photo.dataset.promptRecord));
    if(record?.dataUrl)openViewfinderImage(record.dataUrl);
   }));
  }
  root.querySelectorAll('button.ql-tab').forEach(item=>{const active=item.dataset.page==='prompt-gallery';item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});
  root.querySelectorAll('[data-page-panel]').forEach(node=>{const active=node.dataset.pagePanel==='prompt-gallery';node.hidden=!active;node.classList.toggle('active',active);});
  const galleryPage=root.querySelector('[data-page-panel="prompt-gallery"]');if(galleryPage)galleryPage.scrollTop=0;
 });
 prompts?.querySelectorAll('[data-prompt-edit]').forEach(b=>b.onclick=()=>{const p=s.prompts[+b.dataset.promptEdit];$('#ql-prompt-editor').hidden=false;$('#ql-prompt-add').hidden=true;$('#ql-prompt-name').value=p.name||'';const standard=['单人','双人','BG','BL','GL','其他'];if(standard.includes(p.category||'')){$('#ql-prompt-category').value=p.category;$('#ql-prompt-category-custom').value='';$('#ql-prompt-category-custom').hidden=true;}else{$('#ql-prompt-category').value='自定义';$('#ql-prompt-category-custom').value=p.category||'';$('#ql-prompt-category-custom').hidden=false;}$('#ql-library-prompt-zh').value=p.promptZh||'';$('#ql-library-prompt-en').value=p.promptEn||p.prompt||'';const imagePreview=$('#ql-library-image-preview');if(imagePreview){imagePreview.dataset.image=p.image||'';imagePreview.innerHTML=p.image?'<img src="'+esc(p.image)+'" alt="提示词预览图">':'<span class="ql-muted">尚未添加预览图</span>';}$('#ql-prompt-save').dataset.edit=String(+b.dataset.promptEdit);$('#ql-prompt-save').textContent='保存修改';$('#ql-prompt-editor').scrollIntoView({behavior:'smooth',block:'start'});});
  prompts?.querySelectorAll('[data-prompt-delete]').forEach(b=>b.onclick=()=>{s.prompts.splice(+b.dataset.promptDelete,1);save();renderLibrary();});
 chars?.querySelectorAll('[data-character-select]').forEach(b=>b.onchange=()=>{const i=Number(b.dataset.characterSelect);if(b.checked)selectedCharacters.add(i);else selectedCharacters.delete(i);});
  chars?.querySelectorAll('[data-character-apply]').forEach(b=>b.onclick=()=>{const p=s.characters[+b.dataset.characterApply];$('#ql-prompt').value=[$('#ql-prompt').value.trim(),p.appearance].filter(Boolean).join(', ');read();status('已追加角色外貌词：'+p.name);});
 chars?.querySelectorAll('[data-character-edit]').forEach(b=>b.onclick=()=>{const p=s.characters[+b.dataset.characterEdit],select=$('#ql-character-card');if(select)select.value=p.characterKey==null?'':String(p.characterKey);$('#ql-character-name').value=p.name||p.characterName||'';$('#ql-character-appearance').value=p.appearance||'';$('#ql-character-save').dataset.edit=String(+b.dataset.characterEdit);$('#ql-character-save').textContent='保存修改';$('#ql-character-status').textContent='正在编辑：'+(p.name||p.characterName||'未命名角色');$('#ql-character-name').scrollIntoView({behavior:'smooth',block:'center'});});
  chars?.querySelectorAll('[data-character-delete]').forEach(b=>b.onclick=()=>{s.characters.splice(+b.dataset.characterDelete,1);save();renderLibrary();});
 presets?.querySelectorAll('[data-preset-apply]').forEach(b=>b.onclick=()=>{const i=+b.dataset.presetApply,p=s.presets[i];s.activeConfigMode='separate';s.activeComboIndex=-1;s.activePresetIndex=i;renderActivePresets();renderActiveArtists();renderActiveConfigMode();save();status('已单独选中画师串：'+p.name+'。');});
 const loadPresetForEdit=index=>{const p=s.presets[index];if(!p)return;$('#ql-preset-editor').hidden=false;$('#ql-preset-edit-select').value=String(index);$('#ql-preset-name').value=p.name||'';$('#ql-preset-positive').value=p.positive||'';$('#ql-preset-negative').value=p.negative||'';$('#ql-preset-save').dataset.edit=String(index);$('#ql-preset-save').textContent='保存修改';};
  presets?.querySelectorAll('[data-preset-edit]').forEach(b=>b.onclick=()=>loadPresetForEdit(+b.dataset.presetEdit));
  $('#ql-preset-edit-select').onchange=()=>{const value=$('#ql-preset-edit-select').value;if(value===''){delete $('#ql-preset-save').dataset.edit;$('#ql-preset-save').textContent='保存画师串组合';$('#ql-preset-name').value='';$('#ql-preset-positive').value='';$('#ql-preset-negative').value='';$('#ql-preset-editor').hidden=true;return;}loadPresetForEdit(Number(value));};
  $('#ql-combo-new').onclick=()=>{delete $('#ql-combo-save').dataset.edit;$('#ql-combo-save').textContent='保存组合';$('#ql-combo-name').value='';$('#ql-combo-artist').value='-1';$('#ql-combo-vibe').value='-1';$('#ql-combo-editor').hidden=false;$('#ql-combo-name').focus();};$('#ql-combo-cancel').onclick=()=>{$('#ql-combo-editor').hidden=true;delete $('#ql-combo-save').dataset.edit;$('#ql-combo-save').textContent='保存组合';};$('#ql-combo-save').onclick=()=>{const name=$('#ql-combo-name').value.trim();if(!name){status('请填写组合名称。');return;}const item={name,artistIndex:Number($('#ql-combo-artist').value),vibeIndex:Number($('#ql-combo-vibe').value),updatedAt:Date.now()};const edit=$('#ql-combo-save').dataset.edit;if(edit!==undefined)s.combinations[Number(edit)]=item;else s.combinations.unshift(item);delete $('#ql-combo-save').dataset.edit;$('#ql-combo-save').textContent='保存组合';$('#ql-combo-editor').hidden=true;save();renderLibrary();renderActivePresets();renderBindings();status('组合已保存：'+name);};$('#ql-preset-new').onclick=()=>{ $('#ql-preset-editor').hidden=false;$('#ql-preset-edit-select').value='';delete $('#ql-preset-save').dataset.edit;$('#ql-preset-save').textContent='保存画师串组合';$('#ql-preset-name').value='';$('#ql-preset-positive').value='';$('#ql-preset-negative').value='';$('#ql-preset-name').focus();};
  presets?.querySelectorAll('[data-preset-delete]').forEach(b=>b.onclick=()=>{s.presets.splice(+b.dataset.presetDelete,1);save();renderLibrary();});
}

function collectVibeItems(data,fileName='Vibe 导入',out=[],seen=new WeakSet()){
 if(!data||typeof data!=='object'||seen.has(data))return out;
 seen.add(data);
 if(Array.isArray(data)){for(const item of data)collectVibeItems(item,fileName,out,seen);return out;}
 const name=String(data.name||data.title||data.label||data.filename||fileName||'导入的 Vibe').trim();
 const canonical=data.identifier==='novelai-vibe-transfer';
 if(canonical){
  out.push({name,raw:data,source:'novelai-vibe-transfer'});
  return out;
 }
 const groupKeys=/^(?:vibes?|vibeGroups?|groups|参考图组|参考组|氛围转移)$/i;
 for(const [key,value] of Object.entries(data)){
  if(Array.isArray(value)&&groupKeys.test(key)){
   for(const [index,item] of value.entries()){
    if(!item||typeof item!=='object')continue;
    const itemName=String(item.name||item.title||item.label||('Vibe '+(index+1))).trim();
    const entries=Array.isArray(item.entries)?item.entries:(Array.isArray(item.images)?item.images:(Array.isArray(item.references)?item.references:null));
    if(entries){
     out.push({name:itemName,raw:item,entries,source:'group'});
    }else{
     const before=out.length;collectVibeItems(item,itemName,out,seen);
     if(out.length===before&&extractUsableVibe(item))out.push({name:itemName,raw:item,source:'group-item'});
    }
   }
   continue;
  }
  if(value&&typeof value==='object')collectVibeItems(value,name,out,seen);
 }
 if(Array.isArray(data.entries)&&data.entries.length&&data.entries.some(x=>x&&typeof x==='object'&&('image' in x||'raw' in x||'encoding' in x))){
  if(!out.some(x=>x.raw===data))out.push({name,raw:data,entries:data.entries,source:'entries'});
 }
 return out;
}

async function readVibeArchiveJson(file){const buffer=await file.arrayBuffer(),view=new DataView(buffer),bytes=new Uint8Array(buffer),out=[];const u16=o=>view.getUint16(o,true),u32=o=>view.getUint32(o,true);const decoder=new TextDecoder();for(let p=0;p+46<=bytes.length;){if(u32(p)!==0x02014b50){p++;continue;}const method=u16(p+10),compressed=u32(p+20),nameLen=u16(p+28),extraLen=u16(p+30),commentLen=u16(p+32),localOffset=u32(p+42);const name=decoder.decode(bytes.slice(p+46,p+46+nameLen));if(/\.(?:json|naiv4vibe|naiv4vibebundle)$/i.test(name)){if(u32(localOffset)!==0x04034b50)throw new Error('Vibe 压缩包中的文件头无法识别：'+name);const localName=u16(localOffset+26),localExtra=u16(localOffset+28),start=localOffset+30+localName+localExtra,packed=bytes.slice(start,start+compressed);let raw;if(method===0)raw=packed;else if(method===8&&typeof DecompressionStream!=='undefined'){const stream=new Blob([packed]).stream().pipeThrough(new DecompressionStream('deflate-raw'));raw=new Uint8Array(await new Response(stream).arrayBuffer());}else throw new Error('当前浏览器不支持该 Vibe 压缩算法。');try{out.push(JSON.parse(decoder.decode(raw)));}catch{}}p+=46+nameLen+extraLen+commentLen;}return out;}
let migrationCandidate=null;
function walkChatu8(data, pathName='', out={artists:[],warnings:[]}, seen=new WeakSet()){
 if(!data||typeof data!=='object'||seen.has(data))return out;
 seen.add(data);
 const pushUnique=(arr,item,keyFn)=>{if(!arr.some(x=>keyFn(x)===keyFn(item)))arr.push(item);};
 const normName=(obj,fallback)=>String(obj?.name||obj?.title||obj?.label||obj?.id||fallback||'未命名').slice(0,160);
 if(Array.isArray(data)){for(let i=0;i<data.length;i++)walkChatu8(data[i],pathName+'['+i+']',out,seen);return out;}
 const entries=Object.entries(data);
 const textValue=(...keys)=>{for(const [k,v] of entries)if(keys.some(re=>re.test(k))&&typeof v==='string'&&v.trim())return v.trim();return '';};
 // 智绘姬/柏宝绘画师串：只提取明确的画师串正负向字段。
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
 const name=normName(data,pathName.split(/[.[]/).filter(Boolean).pop());
 const pos=textValue(/^fixedPrompt$|画师串|画师|artist|positive.?prompt|正向提示词|正面提示词|promptPositive|artistPrompt|artistTags|artistString/i);
 const neg=textValue(/^negativePrompt$|negative.?prompt|负向提示词|负面提示词/i);
 if(pos)pushUnique(out.artists,{name,positive:pos,negative:neg,sourcePath:pathName},x=>x.name+'|'+x.positive);
 for(const [k,v] of entries){
  if(k==='presets'||/vibe|氛围转移|参考图组|参考组|vibeData|reference.?image|参考图|角色图|character.?image/i.test(k))continue;
  if(v&&typeof v==='object')walkChatu8(v,pathName?pathName+'.'+k:k,out,seen);
  else if(typeof v==='string'&&/画师串|artist.?string/i.test(k)&&v.trim())pushUnique(out.artists,{name,positive:v.trim(),negative:neg,sourcePath:pathName+'.'+k},x=>x.name+'|'+x.positive);
 }
 return out;
}
function renderMigrationPreview(candidate,source){
 // 智绘姬迁移仅保留画师串，Vibe 不参与扫描预览或导入。
 const existing=cfg().presets||[];
 const seen=new Set(existing.map(item=>String(item.name||'')+'\\u0000'+String(item.positive||'')));
 const artists=[];
 for(const item of Array.isArray(candidate.artists)?candidate.artists:[]){
  if(!item?.positive)continue;
  const key=String(item.name||'')+'\\u0000'+String(item.positive||'');
  if(seen.has(key))continue;
  seen.add(key);artists.push(item);
 }
 migrationCandidate={artists,prompts:[],warnings:Array.isArray(candidate.warnings)?candidate.warnings:[]};
 const host=$('#ql-migrate-preview');if(!host)return;
 host.textContent=artists.length?'检测到 '+artists.length+' 条尚未导入的画师串。':'没有新的画师串。';
 const button=$('#ql-migrate-import');
 button.disabled=!artists.length;
 button.textContent=artists.length?'导入 '+artists.length+' 条画师串':'没有可导入的新画师串';
}
async function scanChatu8Settings(){
 const found=[];
 const looksRelevant=(value,depth=0,seen=new WeakSet())=>{
  if(!value||typeof value!=='object'||depth>6||seen.has(value))return false;
  seen.add(value);
  
  if(value.presets&&typeof value.presets==='object'&&!Array.isArray(value.presets)&&Object.values(value.presets).some(p=>p&&typeof p==='object'&&('fixedPrompt' in p||'fixedPrompt_end' in p)))return true;
  for(const [k,v] of Object.entries(value)){
   if(/chatu8|智绘姬|zhihuiji|baibai|柏宝绘|bai.?bai.?image|artist.?preset/i.test(k)&&v&&typeof v==='object')return true;
   if(v&&typeof v==='object'&&looksRelevant(v,depth+1,seen))return true;
  }
  return false;
 };
 const add=(key,value)=>{if(value&&typeof value==='object')found.push({key,value});};
 // 扫描全部扩展设置，不再依赖智绘姬设置恰好位于顶层特定键名。
 for(const [key,value] of Object.entries(extension_settings||{})){
  if(key===EXT)continue;
  if(/chatu8|智绘姬|zhihuiji|baibai|柏宝绘|bai.?bai.?image|artist.?preset/i.test(key)||looksRelevant(value))add('extension_settings:'+key,value);
 }
 // 一些版本使用非标准 localStorage 键名，读取可解析的 JSON 后再按数据结构判断。
 try{
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);if(!key)continue;
   const raw=localStorage.getItem(key);if(!raw||raw.length>30*1024*1024)continue;
   try{const value=JSON.parse(raw);if(/chatu8|智绘姬|zhihuiji|baibai|柏宝绘|bai.?bai.?image|artist.?preset/i.test(key)||looksRelevant(value))add('localStorage:'+key,value);}catch{}
  }
 }catch(e){console.warn('[轻绘 Lite] 无法扫描 localStorage',e);}
 // 只读检查可枚举的 IndexedDB，兼容将 Vibe 资源存入数据库的版本。
 try{
  if(typeof indexedDB!=='undefined'&&typeof indexedDB.databases==='function'){
   const dbs=await indexedDB.databases();
   for(const info of dbs){
    if(!info?.name)continue;
    let db;
    try{
     db=await new Promise((resolve,reject)=>{const req=indexedDB.open(info.name);req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error||new Error('数据库打开失败'));req.onblocked=()=>reject(new Error('数据库正被占用'));});
     for(const storeName of [...db.objectStoreNames]){
      try{
       const values=await new Promise((resolve,reject)=>{const tx=db.transaction(storeName,'readonly'),req=tx.objectStore(storeName).getAll();req.onsuccess=()=>resolve(req.result||[]);req.onerror=()=>reject(req.error||new Error('读取失败'));});
       values.forEach((value,i)=>{if(looksRelevant(value))add('IndexedDB:'+info.name+'/'+storeName+'['+i+']',value);});
      }catch(e){console.warn('[轻绘 Lite] IndexedDB 只读扫描失败',info.name,storeName,e);}
     }
    }catch(e){console.warn('[轻绘 Lite] 无法读取 IndexedDB',info.name,e);}
    finally{try{db?.close();}catch{}}
   }
  }
 }catch(e){console.warn('[轻绘 Lite] IndexedDB 扫描不可用',e);}
 const merged={artists:[],prompts:[],vibes:[],warnings:[]},seenKeys=new Set();
 for(const item of found){if(seenKeys.has(item.key))continue;seenKeys.add(item.key);try{walkChatu8(item.value,item.key,merged);}catch(e){merged.warnings.push(item.key+'：读取失败');}}
 merged.prompts=[];
 renderMigrationPreview(merged);
 const host=$('#ql-migrate-preview');
 if(host)host.textContent+='\\n扫描到 '+found.length+' 个可能相关的数据源；仅处理画师串。';
 if((migrationCandidate?.artists||[]).length)importChatu8Candidate();
 else if(host)host.textContent+='\\n没有发现新的可迁移画师串。若扩展数据不在当前酒馆可访问范围内，请使用备用 JSON 导入。';
}
function safeMigrationStringify(value){try{return JSON.stringify(value);}catch{return '';}}
async function readMigrationFile(file){
 try{
  const text=await file.text();
  let data;
  try{data=JSON.parse(text);}catch{throw new Error('文件不是有效 JSON。请从智绘姬导出设置/预设文件后再选择。');}
  const candidate=walkChatu8(data,file.name);
  candidate.prompts=[];
  renderMigrationPreview(candidate);
 }catch(e){$('#ql-migrate-preview').textContent='读取失败：'+(e?.message||String(e));$('#ql-migrate-import').disabled=true;}
}
function importChatu8Candidate(){
 const candidate=migrationCandidate;if(!candidate)return;
 const s=cfg();let artists=0;
 for(const item of candidate.artists||[]){
  if(!item.positive)continue;
  if(s.presets.some(x=>x.name===item.name&&x.positive===item.positive))continue;
  s.presets.unshift({name:item.name,positive:item.positive,negative:item.negative||'',source:'st-chatu8',sourcePath:item.sourcePath,updatedAt:Date.now()});artists++;
 }
 s.presets=s.presets.slice(0,500);
 save();renderLibrary();
 status('画师串一键迁移完成：新增 '+artists+' 条。来源仅限可识别的智绘姬/柏宝绘设置；Vibe 未迁移。');
 $('#ql-migrate-import').disabled=true;
 $('#ql-migrate-import').textContent='已完成导入';
}


function openViewfinderImage(url){
 if(!url)return;
 let overlay=document.querySelector('.ql-viewfinder-lightbox');
 if(!overlay){
  overlay=document.createElement('dialog');overlay.className='ql-viewfinder-lightbox';overlay.setAttribute('aria-label','放大查看图片');
  overlay.innerHTML='<button type="button" class="ql-viewfinder-lightbox-close" aria-label="关闭图片" title="关闭">×</button><img alt="放大查看的生成图片">';
  overlay.addEventListener('click',event=>{if(event.target===overlay||event.target.closest('.ql-viewfinder-lightbox-close')){if(overlay.open)overlay.close();}});
  overlay.addEventListener('close',()=>{overlay.querySelector('img')?.removeAttribute('src');});
  document.body.append(overlay);
 }
 overlay.querySelector('img').src=url;
 if(!overlay.open){
  if(typeof overlay.showModal==='function')overlay.showModal();
  else{overlay.setAttribute('open','');overlay.style.position='fixed';}
 }
}
function syncViewfinderActions(){
 const result=$('#ql-result'),favorite=$('#ql-result-favorite'),enlarge=$('#ql-result-enlarge');
 if(!result||!favorite||!enlarge)return;
 const img=result.querySelector('img');
 favorite.disabled=!img;enlarge.disabled=!img;
 const record=img?(cfg().records||[]).find(item=>item&&item.dataUrl===img.src):null;
 const saved=!!record?.albumCharacterName;
 const label=saved?'取消角色相册收藏':'收藏到角色相册';
 favorite.setAttribute('aria-label',label);favorite.title=label;
 favorite.classList.toggle('is-favorite',saved);
 const star=favorite.querySelector('svg path');
 if(star){star.style.fill=saved?'currentColor':'none';star.style.stroke='currentColor';}
}
function toggleViewfinderFavorite(){
 const img=$('#ql-result img');if(!img)return;
 const settings=cfg(),records=settings.records||[];
 const matches=records.filter(item=>item&&item.dataUrl===img.src);
 if(!matches.length){status('暂时找不到这张图片的缓存记录。');return;}
 if(matches.some(item=>item.albumCharacterName)){
  for(const item of matches){delete item.albumCharacterName;delete item.albumCharacterKey;}
  save();history();syncViewfinderActions();status('已取消收藏；图片仍保留在底片缓存中。');return;
 }
 const character=currentCharacter(),name=String(character.name||getContext()?.name2||'当前角色').trim();
 for(const item of matches){item.albumCharacterName=name;item.albumCharacterKey=character.id||'';}
 save();history();syncViewfinderActions();status('已收藏到「'+name+'」角色相册。');
}

function init(){const root=$('#qinghui-lite-panel');if(!root||root.dataset.ready)return;root.dataset.ready='1';const promptGalleryBack=$('#ql-prompt-gallery-back');if(promptGalleryBack)promptGalleryBack.onclick=()=>{const root=$('#qinghui-lite-panel');if(!root)return;const wordbank=root.querySelector('button.ql-tab[data-page="wordbank"]');if(wordbank){root.querySelectorAll('button.ql-tab').forEach(item=>{const active=item===wordbank;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});root.querySelectorAll('[data-page-panel]').forEach(pageNode=>{const active=pageNode.dataset.pagePanel==='wordbank';pageNode.hidden=!active;pageNode.classList.toggle('active',active);});}const promptTab=root.querySelector('button.ql-subtab[data-subpage="prompt-library"]');if(promptTab){const scope=promptTab.closest('.ql-page')||root;scope.querySelectorAll('button.ql-subtab').forEach(item=>{const active=item===promptTab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});scope.querySelectorAll('[data-subpage-panel]').forEach(pageNode=>{const active=pageNode.dataset.subpagePanel==='prompt-library';pageNode.hidden=!active;pageNode.classList.toggle('active',active);});}};const s=cfg();const viewfinderResult=$('#ql-result');if(viewfinderResult&&!viewfinderResult.dataset.qlViewfinderBound){viewfinderResult.dataset.qlViewfinderBound='1';viewfinderResult.addEventListener('click',event=>{if(event.target.closest('button'))return;const image=event.target.closest('img');if(image)openViewfinderImage(image.src);});new MutationObserver(()=>syncViewfinderActions()).observe(viewfinderResult,{childList:true,subtree:true});}$('#ql-result-enlarge').onclick=()=>{const image=$('#ql-result img');if(image)openViewfinderImage(image.src);};$('#ql-result-favorite').onclick=toggleViewfinderFavorite;syncViewfinderActions();const pluginToggle=$('#ql-plugin-toggle');const syncPluginToggle=()=>{const enabled=cfg().enabled!==false;pluginToggle.textContent=enabled?'插件：已启用':'插件：已停用';pluginToggle.setAttribute('aria-pressed',String(enabled));pluginToggle.classList.toggle('ql-plugin-disabled',!enabled);pluginToggle.title=enabled?'点击暂停自动扫描与自动生图':'点击恢复自动扫描与自动生图';};pluginToggle.onclick=()=>{const settings=cfg();settings.enabled=settings.enabled===false;saveSettingsDebounced();syncPluginToggle();};syncPluginToggle();if(s.provider==='openai'||!['novelai','novelai-thirdparty'].includes(s.provider)){s.provider='novelai';saveSettingsDebounced();}$('#ql-provider').value=s.provider;$('#ql-endpoint').value=s.endpoint;$('#ql-key').value=s.apiKey;$('#ql-gpt-endpoint').value='';$('#ql-gpt-key').value='';$('#ql-nai-key').value=s.naiApiKey||'';$('#ql-nai-third-endpoint').value=s.naiThirdEndpoint||'';$('#ql-nai-third-key').value=s.naiThirdKey||'';$('#ql-model').value=s.model;$('#ql-size').value=s.size;$('#ql-quality').value=s.quality;$('#ql-nai-model').value=s.naiModel||'nai-diffusion-4-5-full';$('#ql-nai-steps').value=s.naiSteps||28;$('#ql-nai-scale').value=s.naiScale||5;$('#ql-nai-width').value=s.naiWidth||832;$('#ql-nai-height').value=s.naiHeight||1216;$('#ql-fast-nai-size-preset').value=(s.naiWidth||832)+'x'+(s.naiHeight||1216);if(!$('#ql-fast-nai-size-preset').querySelector('option:checked'))$('#ql-fast-nai-size-preset').value='832x1216';$('#ql-nai-sampler').value=s.naiSampler||'k_euler_ancestral';$('#ql-nai-scheduler').value=s.naiScheduler||'karras';$('#ql-prompt').value=s.prompt;$('#ql-negative').value=s.negative;const toggleProvider=()=>{const nai=$('#ql-provider').value!=='openai';$('#ql-openai-settings').hidden=nai;$('#ql-nai-settings').hidden=!nai;};$('#ql-provider').onchange=toggleProvider;toggleProvider();$('#ql-fast-provider').value=s.provider==='novelai-thirdparty'?'novelai-thirdparty':'novelai';$('#ql-fast-model').value=s.model||'gpt-image-1';$('#ql-fast-size').value=s.size||'1024x1024';$('#ql-fast-quality').value=s.quality||'medium';$('#ql-fast-nai-model').value=s.naiModel||'nai-diffusion-4-5-full';$('#ql-fast-nai-steps').value=s.naiSteps||28;$('#ql-fast-nai-scale').value=s.naiScale||5;$('#ql-fast-nai-width').value=s.naiWidth||832;$('#ql-fast-nai-height').value=s.naiHeight||1216;$('#ql-fast-nai-size-preset').value=(s.naiWidth||832)+'x'+(s.naiHeight||1216);if(!$('#ql-fast-nai-size-preset').querySelector('option:checked'))$('#ql-fast-nai-size-preset').value='832x1216';$('#ql-fast-nai-sampler').value=s.naiSampler||'k_euler_ancestral';$('#ql-fast-nai-scheduler').value=s.naiScheduler||'karras';$('#ql-fast-nai-normalize').checked=s.naiNormalizeVibeStrengths!==false;const toggleFast=()=>{const nai=true;$('#ql-fast-openai').hidden=nai;$('#ql-fast-nai').hidden=!nai;syncFastControls();$('#ql-provider').value=$('#ql-fast-provider').value;toggleProvider();};$('#ql-fast-provider').onchange=toggleFast;toggleFast();$('#ql-prompt').addEventListener('input',()=>{cfg().prompt=$('#ql-prompt').value;save();});$('#ql-active-config-mode').onchange=()=>{const s=cfg();s.activeConfigMode=$('#ql-active-config-mode').value;if(s.activeConfigMode==='separate')s.activeComboIndex=-1;renderActiveConfigMode();renderActiveArtists();renderActiveVibes();save();};$('#ql-active-preset').onchange=()=>{const c=cfg(),i=Number($('#ql-active-preset').value),combo=c.combinations[i];c.activeConfigMode='combo';c.activeComboIndex=i;c.activePresetIndex=combo?Number(combo.artistIndex??-1):-1;c.activeVibeIndex=combo?Number(combo.vibeIndex??-1):-1;renderActiveConfigMode();renderActiveArtists();renderActiveVibes();save();};$('#ql-active-artist').onchange=()=>{const c=cfg();c.activeConfigMode='separate';c.activeComboIndex=-1;c.activePresetIndex=Number($('#ql-active-artist').value);renderActiveConfigMode();save();};$('#ql-active-vibe').onchange=()=>{const c=cfg();c.activeConfigMode='separate';c.activeComboIndex=-1;c.activeVibeIndex=Number($('#ql-active-vibe').value);renderActiveConfigMode();save();};$('#ql-apply-preset').onclick=()=>{const s=cfg();if(s.activeConfigMode==='separate'){s.activeComboIndex=-1;s.activePresetIndex=Number($('#ql-active-artist').value);s.activeVibeIndex=Number($('#ql-active-vibe').value);save();status('已应用独立配置：'+(s.presets[s.activePresetIndex]?.name||'不使用画师串')+' / '+(s.vibes[s.activeVibeIndex]?.name||'不使用 Vibe'));return;}const i=Number($('#ql-active-preset').value),c=s.combinations[i];if(!c){status('请先在配置中创建组合。');return;}s.activeComboIndex=i;s.activePresetIndex=Number(c.artistIndex??-1);s.activeVibeIndex=Number(c.vibeIndex??-1);save();renderActiveArtists();renderActiveVibes();status('已应用组合：'+c.name);};$('#ql-open-preset').onclick=()=>{root.querySelector('.ql-tab[data-page="library"]')?.click();root.querySelector('.ql-subtab[data-subpage="bindings"]')?.click();};$('#ql-bind-character').onchange=()=>renderBindings();$('#ql-bind-save').onclick=()=>{const key=$('#ql-bind-character').value;if(!key){status('请先选择角色卡。');return;}const ctx=getContext()||{},ch=(ctx.characters||[])[Number(key)],name=ch?.name||ch?.avatar||('角色 '+key),binding={characterKey:String(key),characterName:name,combinationIndex:Number($('#ql-bind-preset').value),updatedAt:Date.now()};const old=s.bindings.findIndex(x=>x.characterKey===binding.characterKey||x.characterName===name);if(old>=0)s.bindings[old]=binding;else s.bindings.push(binding);save();renderBindings();status('已保存角色默认组合：'+name);};$('#ql-export-all-data').onclick=()=>{const s=cfg();if(!confirm('将导出拾帧完整数据，其中包含已保存的 API Key、影像缓存和 Vibe 编码。请勿把文件分享给他人。继续导出吗？'))return;const backup={format:'qinghui-lite-full-backup',version:1,extension:'拾帧',exportedAt:new Date().toISOString(),data:JSON.parse(JSON.stringify(s))};downloadJson(backup,'shizhen-full-backup-'+new Date().toISOString().replace(/[:.]/g,'-')+'.json');$('#ql-export-all-status').textContent='已发起完整数据导出；请在浏览器下载列表中查看文件。'};$('#ql-import-all-data').onclick=()=>$('#ql-import-all-file').click();$('#ql-import-all-file').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;try{const backup=JSON.parse(await file.text());if(backup?.format!=='qinghui-lite-full-backup'||!backup.data||typeof backup.data!=='object'||Array.isArray(backup.data))throw new Error('文件不是有效的拾帧完整备份。');if(!confirm('确定导入这份拾帧备份并替换当前拾帧数据吗？当前数据会被覆盖，建议先导出一份备份。'))return;extension_settings[EXT]=backup.data;saveSettingsDebounced();$('#ql-export-all-status').textContent='拾帧备份已导入，正在刷新页面以应用数据。';location.reload();}catch(err){$('#ql-export-all-status').textContent='导入失败：'+(err?.message||String(err));}finally{e.target.value='';}};$('#ql-vibe-import-shortcut').onclick=()=>$('#ql-vibe-pick').click();$('#ql-vibe-create-group').onclick=()=>{const name=prompt('给新 Vibe 组起个名字：','我的 Vibe 组');if(name===null)return;const cleanName=name.trim();if(!cleanName){status('组名称不能为空。');return;}s.vibes.push({name:cleanName,entries:[],hasPayload:false,source:'manual',createdAt:Date.now()});save();renderLibrary();const target=$('#ql-vibe-import-target');if(target)target.value=String(s.vibes.length-1);status('已创建 Vibe 组「'+cleanName+'」。选择文件导入后即可追加到这个组。');};$('#ql-vibe-pick').onclick=()=>$('#ql-vibe-import-file').click();$('#ql-vibe-import-file').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;pendingVibeImage=null;const ext=file.name.toLowerCase();if(file.type.startsWith('image/')){pendingVibeImage=file;$('#ql-vibe-name').value=$('#ql-vibe-name').value||file.name.replace(/\.[^.]+$/,'');$('#ql-vibe-status').textContent='已选择图片：'+file.name+'。点击「将选中的图片编码为 Vibe」开始处理；NovelAI 可能收取 Anlas。';return;}if(ext.endsWith('.json')||ext.endsWith('.json5')||ext.endsWith('.txt')||ext.endsWith('.naiv4vibe')||ext.endsWith('.naiv4vibebundle')){const naiModel=cfg().naiModel||'nai-diffusion-4-5-full';try{let data;try{data=JSON.parse(await file.text());}catch{const files=await readVibeArchiveJson(file);if(!files.length)throw new Error('无法从该文件中读取 JSON 资源；该 Vibe 文件可能使用了当前浏览器不支持的打包格式。');data=files;}const candidate=collectVibeItems(data,file.name),added=[],targetIndex=Number($('#ql-vibe-import-target')?.value??-1);for(const item of candidate){const rawSource=item.raw||item;const encoded=extractUsableVibe(rawSource,naiModel);const entries=Array.isArray(item.entries)?item.entries.map(x=>{const source=x.raw?{...x.raw,image:x.image||x.raw.image||''}:x;const extracted=extractUsableVibe(source,naiModel);const image=typeof x.image==='string'&&x.image.trim()?x.image.trim().replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,''):extracted?.image||'';return {...x,image,raw:x.raw||undefined,strength:Number(x.strength??extracted?.strength??0.6),informationExtracted:Number(x.informationExtracted??extracted?.informationExtracted??1)};}):(encoded||(rawSource.identifier==='novelai-vibe-transfer'&&rawSource.encodings&&Object.keys(rawSource.encodings).length))?[...(encoded?[encoded]:[{image:typeof rawSource.image==='string'?rawSource.image:'',strength:Number(rawSource.importInfo?.strength??0.6),informationExtracted:1}]).map(entry=>({...entry,raw:(rawSource.identifier==='novelai-vibe-transfer'?(({image,thumbnail,...rest})=>rest)(rawSource):rawSource),image:typeof rawSource.image==='string'?rawSource.image:entry.image,strength:Number(rawSource.importInfo?.strength??entry.strength??0.6),informationExtracted:Number(entry.informationExtracted??1)}))]:[];const usableEntries=entries.filter(x=>typeof x.image==='string'&&x.image.length>160&&/^[A-Za-z0-9+/]+={0,2}$/.test(x.image));if(!usableEntries.length)continue;const hasPayload=true;const targetGroup=targetIndex>=0?s.vibes[targetIndex]:null;if(targetGroup){const known=new Set((targetGroup.entries||[]).map(entry=>JSON.stringify([entry.name,entry.image,entry.raw?.identifier,entry.raw?.encodings])));for(const entry of usableEntries){const key=JSON.stringify([entry.name,entry.image,entry.raw?.identifier,entry.raw?.encodings]);if(!known.has(key)){targetGroup.entries.push({...entry,name:entry.name||entry.title||entry.label||entry.filename||entry.raw?.name||entry.raw?.title||entry.raw?.label||('参考 '+(targetGroup.entries.length+1))});known.add(key);}}targetGroup.hasPayload=targetGroup.entries.some(entry=>typeof entry.image==='string'&&entry.image.length>160);targetGroup.updatedAt=Date.now();added.push(item.name);}else{s.vibes.push({...item,entries:usableEntries.map((entry,j)=>({...entry,name:entry.name||entry.title||entry.label||entry.filename||entry.raw?.name||entry.raw?.title||entry.raw?.label||(usableEntries.length===1&&item.name?item.name:'参考 '+(j+1))})),hasPayload,importedAt:Date.now()});added.push(item.name);}}if(!added.length)throw new Error('没有识别到可用的 Vibe 编码。请确认文件内包含当前模型对应的 NovelAI Vibe 编码，或是带有 entries 的 Vibe 分组；普通图片和仅含元数据的 bundle 无法直接使用。');save();renderLibrary();renderActiveVibes();const usable=added.filter(name=>s.vibes.find(v=>v.name===name)?.hasPayload).length;$('#ql-vibe-status').textContent=targetIndex>=0?'已将 '+added.length+' 个导入项目追加到「'+(s.vibes[targetIndex]?.name||'目标组')+'」，可在组内修改每条参考的名称。':'已读取 '+added.length+' 组 Vibe，其中 '+usable+' 组含可识别的预编码资源。请检查各条参考状态；未识别编码的项目不会被当作可用 Vibe。';}catch(err){$('#ql-vibe-status').textContent='导入失败：'+(err?.message||String(err));}return;}$('#ql-vibe-status').textContent='此文件格式无法直接解析。请确认它是标准 .naiv4vibe / bundle 压缩包，或使用 JSON / 智绘姬组格式。';};$('#ql-vibe-encode').onclick=async()=>{if(!pendingVibeImage){$('#ql-vibe-status').textContent='请先选择 PNG、JPG 或 WebP 图片。';return;}const button=$('#ql-vibe-encode');button.disabled=true;$('#ql-vibe-status').textContent='正在请求酒馆 NovelAI Vibe 编码接口……';try{const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('无法读取图片'));reader.readAsDataURL(pendingVibeImage);});const image=dataUrl.replace(/^data:image\/[^;]+;base64,/,'');const response=await fetch('/api/novelai/encode-vibe',{method:'POST',headers:{'Content-Type':'application/json',...getRequestHeaders(window.token)},body:JSON.stringify({image,model:cfg().naiModel||'nai-diffusion-4-5-full',information_extracted:Number($('#ql-vibe-info').value)||1,crop_to_mask:false,focus_seed:-1,info_extract_seed:-1,mask:''})});if(!response.ok)throw new Error('酒馆未能完成 Vibe 编码（HTTP '+response.status+'）。当前酒馆版本可能没有暴露 encode-vibe 代理接口。');const buffer=await response.arrayBuffer();let binary='';const bytes=new Uint8Array(buffer);for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));const encoded=btoa(binary);const name=$('#ql-vibe-name').value.trim()||pendingVibeImage.name.replace(/\.[^.]+$/,'');const entry={name,image:encoded,strength:0.6,informationExtracted:Number($('#ql-vibe-info').value)||1};const targetIndex=Number($('#ql-vibe-import-target')?.value??-1);const s=cfg();if(targetIndex>=0&&s.vibes[targetIndex]){const target=s.vibes[targetIndex];target.entries=Array.isArray(target.entries)?target.entries:[];target.entries.push(entry);target.hasPayload=true;target.updatedAt=Date.now();}else{s.vibes.push({name,source:'image-encode',hasPayload:true,entries:[entry],importedAt:Date.now()});}save();renderLibrary();renderActiveVibes();$('#ql-vibe-status').textContent='编码完成并保存：'+name;pendingVibeImage=null;$('#ql-vibe-import-file').value='';}catch(err){$('#ql-vibe-status').textContent='编码失败：'+(err?.message||String(err));}finally{button.disabled=false;}};try{renderActivePresets();renderActiveVibes();renderActiveArtists();renderActiveConfigMode();renderBindings();history();renderLibrary();}catch(error){console.error('[轻绘 Lite] 初始化列表失败',error);status('列表初始化失败：'+(error?.message||String(error))+'。其他按钮仍可使用，请检查控制台。')}$('#ql-migrate-toggle').onclick=()=>{const panel=$('#ql-migrate-panel');panel.hidden=!panel.hidden;$('#ql-migrate-toggle').setAttribute('aria-expanded',String(!panel.hidden));$('#ql-migrate-toggle').textContent=panel.hidden?'一键迁移画师串':'收起迁移';if(!panel.hidden){$('#ql-migrate-preview').textContent='正在扫描智绘姬与柏宝绘设置，只提取画师串…';panel.scrollIntoView({behavior:'smooth',block:'nearest'});scanChatu8Settings();}};$('#ql-migrate-scan').onclick=scanChatu8Settings;$('#ql-migrate-file-btn').onclick=()=>$('#ql-migrate-file').click();$('#ql-migrate-file').onchange=e=>{const f=e.target.files?.[0];if(f)readMigrationFile(f);};$('#ql-migrate-import').onclick=importChatu8Candidate;
$('#ql-save-nai').onclick=()=>{cfg().naiApiKey=$('#ql-nai-key').value.trim();save();status('NAI 官网 Key 已保存。');};$('#ql-save-nai-third').onclick=()=>{cfg().naiThirdEndpoint=$('#ql-nai-third-endpoint').value.trim().replace(/\/$/,'');cfg().naiThirdKey=$('#ql-nai-third-key').value.trim();save();status('NAI 第三方连接设置已保存。');};const legacySave=$('#ql-save');if(legacySave)legacySave.onclick=()=>{read();status('兼容设置已保存。');};$('#ql-chat-album-style').value=s.chatAlbumStyle||'classic';applyChatAlbumStyleToAll($('#ql-chat-album-style').value);$('#ql-chat-album-style-save').onclick=()=>{const style=$('#ql-chat-album-style').value;cfg().chatAlbumStyle=style;save();applyChatAlbumStyleToAll(style);$('#ql-chat-album-style-status').textContent='已应用相册样式。';};$('#ql-download-format').value=s.downloadFormat||'png';$('#ql-png-download-save').onclick=()=>{const format=$('#ql-download-format').value;cfg().downloadFormat=format;save();$('#ql-png-download-status').textContent='已保存：下载格式为 '+format.toUpperCase()+'。'+(format==='jpg'?'JPG 会重新编码图像。':'PNG 将保留原始文件及元数据。');};$('#ql-theme-preset').value=s.themePreset||'auto';$('#ql-theme-color').value=/^#[0-9a-f]{6}$/i.test(String(s.themeColor||''))?s.themeColor:'#9aaec2';$('#ql-theme-color-value').textContent=$('#ql-theme-color').value.toUpperCase();$('#ql-custom-color-row').hidden=$('#ql-theme-preset').value!=='custom';applyTheme($('#ql-theme-preset').value,$('#ql-theme-color').value);$('#ql-theme-color').oninput=()=>{$('#ql-theme-color-value').textContent=$('#ql-theme-color').value.toUpperCase();};$('#ql-theme-apply').onclick=()=>{const preset=$('#ql-theme-preset').value,color=$('#ql-theme-color').value;cfg().themePreset=preset;cfg().themeColor=color;delete cfg().themeCss;save();applyTheme(preset,color);$('#ql-theme-status').textContent=preset==='auto'?'已恢复跟随酒馆主题。':preset==='custom'?'已应用自选浅色主题。':'已应用浅色低饱和配色。';};$('#ql-theme-reset').onclick=()=>{$('#ql-theme-preset').value='auto';$('#ql-custom-color-row').hidden=true;cfg().themePreset='auto';delete cfg().themeCss;save();applyTheme('auto','');$('#ql-theme-status').textContent='已恢复自适配酒馆美化。';};$('#ql-theme-preset').onchange=()=>{$('#ql-custom-color-row').hidden=$('#ql-theme-preset').value!=='custom';$('#ql-theme-status').textContent='点击“应用配色”后生效。';};
$('#ql-generate').onclick=async()=>{
 if(busy)return;try{read();}catch(error){status('读取生图参数失败：'+(error?.message||String(error)));return;}const conf=cfg();
 if(!conf.prompt.trim()){status('请填写正向提示词。');return;}
 if(conf.provider==='novelai'&&!conf.naiApiKey){status('请在接口设置中填写 NovelAI 官网 Key。');return;}if(conf.provider==='novelai-thirdparty'&&(!conf.naiThirdEndpoint||!conf.naiThirdKey)){status('请填写 NAI 第三方接口地址和 Key。');return;}
 busy=true;$('#ql-generate').disabled=true;$('#ql-result').replaceChildren();status('正在请求生图接口……');
 try{
  const activeIndex=Number(conf.activeVibeIndex??-1);const activeVibe=activeIndex>=0?conf.vibes[activeIndex]:null;const activePresetIndex=Number(conf.activePresetIndex??-1);const activePreset=activePresetIndex>=0?conf.presets[activePresetIndex]:null;const finalPrompt=[conf.prompt.trim(),activePreset?.positive].filter(Boolean).join(', ');const finalNegative=[conf.negative.trim(),activePreset?.negative].filter(Boolean).join(', ');const selectedPrompt=(conf.prompts||[]).find(item=>item&&item.id&&item.id===conf.activePromptEntryId);const normalizePromptEntry=value=>String(value||'').trim().replace(/[\s,，、/／|;；·]+/gu,' ').toLowerCase();const normalizedBasePrompt=normalizePromptEntry(conf.prompt);const matchedPrompt=normalizedBasePrompt?(conf.prompts||[]).find(item=>item&&normalizePromptEntry(item.promptEn||item.prompt||'')===normalizedBasePrompt):null;const promptEntryId=conf.activePromptEntryId||selectedPrompt?.id||matchedPrompt?.id||null;const url=await requestImage(finalPrompt,finalNegative,activeVibe);
  const img=document.createElement('img');img.alt='轻绘生成结果';img.src=url;$('#ql-result').append(img);
  conf.records.unshift({at:Date.now(),prompt:finalPrompt,basePrompt:conf.prompt.trim(),negative:finalNegative,provider:conf.provider,model:conf.provider!=='openai'?conf.naiModel:conf.model,size:conf.provider!=='openai'?(conf.naiWidth+'x'+conf.naiHeight):conf.size,quality:conf.quality,dataUrl:url,preset:activePreset?{name:activePreset.name||'',positive:activePreset.positive||'',negative:activePreset.negative||'',index:activePresetIndex,source:activePreset.source||'local'}:null,vibe:activeVibe?{name:activeVibe.name||'',entries:(activeVibe.entries||[]).map(entry=>({strength:entry.strength??0.6,informationExtracted:entry.informationExtracted??1,identifier:entry.identifier||entry.raw?.identifier||'',type:entry.type||entry.raw?.type||'image'}))}:null,config:snapshotConfig(finalPrompt,finalNegative),promptEntryId,sourcePromptEntryId:promptEntryId,sourcePromptEntryAppliedAt:conf.activePromptEntryAppliedAt||null});
  conf.records=conf.records.slice(0,100);save();history();renderLibrary();status('生成完成。记录已保存在酒馆扩展设置中。');
 }catch(e){console.error('[轻绘 Lite] 生图失败',e);status('生成失败：'+(e?.message||String(e))+'。请检查接口地址、Key、模型名和网络连接。')}
 finally{busy=false;$('#ql-generate').disabled=false;}
}
$('#ql-prompt-category').onchange=()=>{$('#ql-prompt-category-custom').hidden=$('#ql-prompt-category').value!=='自定义';};
$('#ql-preset-batch-toggle').onclick=()=>{presetBatchMode=!presetBatchMode;selectedPresets.clear();$('#ql-preset-batch-toggle').textContent=presetBatchMode?'退出批量编辑':'批量编辑';renderLibrary();};
 $('#ql-preset-select-all').onclick=()=>{selectedPresets.clear();cfg().presets.forEach((_,i)=>selectedPresets.add(i));renderLibrary();};$('#ql-preset-clear-all').onclick=()=>{selectedPresets.clear();renderLibrary();};
$('#ql-preset-export').onclick=()=>{const items=[...selectedPresets].sort((a,b)=>a-b).map(i=>cfg().presets[i]).filter(Boolean);if(!items.length){status('请先勾选要导出的画师串。');return;}downloadJson(items,'shizhen-artist-presets.json');};
$('#ql-preset-bulk-delete').onclick=()=>{const indexes=[...selectedPresets].filter(i=>cfg().presets[i]);if(!indexes.length){status('请先勾选要删除的画师串。');return;}if(!confirm('确定删除选中的 '+indexes.length+' 条画师串？'))return;const removed=indexes.sort((a,b)=>b-a);for(const i of removed){if(Number(cfg().activePresetIndex)===i)cfg().activePresetIndex=-1;else if(Number(cfg().activePresetIndex)>i)cfg().activePresetIndex=Number(cfg().activePresetIndex)-1;for(const binding of cfg().bindings){if(Number(binding.presetIndex)===i)binding.presetIndex=-1;else if(Number(binding.presetIndex)>i)binding.presetIndex=Number(binding.presetIndex)-1;}}cfg().presets=removed.reduce((arr,i)=>{arr.splice(i,1);return arr;},cfg().presets.slice());selectedPresets.clear();save();renderLibrary();renderActivePresets();renderBindings();status('已删除所选画师串。');};
$('#ql-prompt-add').onclick=()=>{delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';$('#ql-prompt-name').value='';$('#ql-library-prompt-zh').value='';$('#ql-library-prompt-en').value='';$('#ql-library-image-preview').dataset.image='';$('#ql-library-image-preview').innerHTML='<span class="ql-muted">尚未添加预览图</span>';$('#ql-library-image-file').value='';$('#ql-prompt-editor').hidden=false;$('#ql-prompt-add').hidden=true;$('#ql-prompt-editor').scrollIntoView({behavior:'smooth',block:'start'});};$('#ql-prompt-cancel').onclick=()=>{delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';$('#ql-prompt-editor').hidden=true;$('#ql-prompt-add').hidden=false;};$('#ql-prompt-filter').onchange=()=>renderLibrary();
$('#ql-library-edit-mode').onclick=()=>{libraryEditMode=!libraryEditMode;$('#ql-library-edit-mode').textContent=libraryEditMode?'退出编辑模式':'编辑模式';$('#ql-library-edit-hint').textContent=libraryEditMode?'勾选要处理的条目，再使用批量删除或导出。':'提示词可按分类筛选；开启编辑模式后可多选、批量删除或导出。';renderLibrary();};

$('#ql-prompt-bulk-delete').onclick=()=>{const indexes=[...selectedPrompts].filter(i=>cfg().prompts[i]);if(!indexes.length){status('请先选择要删除的提示词。');return;}if(!confirm('确定批量删除选中的 '+indexes.length+' 条提示词？'))return;cfg().prompts=indexes.sort((a,b)=>b-a).reduce((arr,i)=>{arr.splice(i,1);return arr;},cfg().prompts.slice());selectedPrompts.clear();save();renderLibrary();status('已批量删除提示词。');};
$('#ql-character-export').onclick=()=>{const indexes=[...selectedCharacters].filter(i=>cfg().characters[i]);if(!indexes.length){status('请先开启编辑模式并选择要导出的角色。');return;}downloadJson(indexes.map(i=>cfg().characters[i]).filter(Boolean),'shizhen-characters.json');};
$('#ql-character-bulk-delete').onclick=()=>{const indexes=[...selectedCharacters].filter(i=>cfg().characters[i]);if(!indexes.length){status('请先选择要删除的角色。');return;}if(!confirm('确定批量删除选中的 '+indexes.length+' 个角色词条？'))return;cfg().characters=indexes.sort((a,b)=>b-a).reduce((arr,i)=>{arr.splice(i,1);return arr;},cfg().characters.slice());selectedCharacters.clear();save();renderLibrary();status('已批量删除角色词条。');};
$('#ql-library-image-file').onchange=e=>{const file=e.target.files?.[0];if(!file)return;if(!file.type.startsWith('image/')){status('请选择图片文件。');return;}const reader=new FileReader();reader.onload=()=>{const preview=$('#ql-library-image-preview');preview.dataset.image=String(reader.result||'');preview.innerHTML=preview.dataset.image?'<img src="'+esc(preview.dataset.image)+'" alt="提示词预览图">':'<span class="ql-muted">尚未添加预览图</span>';};reader.readAsDataURL(file);};
const qlPromptImagePreview=$('#ql-library-image-preview');qlPromptImagePreview?.addEventListener('click',()=>{if(!qlPromptImagePreview.dataset.image)$('#ql-library-image-file').click();});qlPromptImagePreview?.addEventListener('keydown',e=>{if(!qlPromptImagePreview.dataset.image&&(e.key==='Enter'||e.key===' ')){e.preventDefault();$('#ql-library-image-file').click();}});
$('#ql-library-image-clear').onclick=()=>{const preview=$('#ql-library-image-preview');preview.dataset.image='';preview.innerHTML='<span class="ql-muted">尚未添加预览图</span>';$('#ql-library-image-file').value='';};
$('#ql-library-prompt-copy').onclick=async()=>{const field=$('#ql-library-prompt-en');const button=$('#ql-library-prompt-copy');const value=field?.value||'';if(!value.trim()){status('画面提示词为空，暂时没有内容可复制。');return;}try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);}else{const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw new Error('浏览器未允许复制');}button.classList.add('is-copied');button.title='已复制画面提示词';button.setAttribute('aria-label','已复制画面提示词');status('已复制画面提示词。');setTimeout(()=>{button.classList.remove('is-copied');button.title='复制画面提示词';button.setAttribute('aria-label','复制画面提示词');},1300);}catch(error){status('复制失败：请长按画面提示词手动复制。');}};
$('#ql-prompt-save').onclick=()=>{const name=$('#ql-prompt-name').value.trim(),promptZh=$('#ql-library-prompt-zh').value.trim(),promptEn=$('#ql-library-prompt-en').value.trim();if(!name||(!promptZh&&!promptEn)){status('请填写名称，并至少填写中文或英文提示词。');return;}const selectedCategory=$('#ql-prompt-category').value;const customCategory=$('#ql-prompt-category-custom').value.trim();const category=selectedCategory==='自定义'?(customCategory||'其他'):selectedCategory;const edit=$('#ql-prompt-save').dataset.edit;const existing=edit!==undefined?cfg().prompts[Number(edit)]:null;const item={...(existing||{}),id:existing?.id||('prompt-'+Date.now().toString(36)+'-'+Math.random().toString(36).slice(2,9)),name,category,promptZh,promptEn,image:$('#ql-library-image-preview')?.dataset.image||'',updatedAt:Date.now()};if(edit!==undefined){cfg().prompts[Number(edit)]={...cfg().prompts[Number(edit)],...item};delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';}else cfg().prompts.unshift(item);cfg().prompts=cfg().prompts.slice(0,200);save();$('#ql-prompt-editor').hidden=true;$('#ql-prompt-add').hidden=false;$('#ql-prompt-name').value='';$('#ql-library-prompt-zh').value='';$('#ql-library-prompt-en').value='';$('#ql-library-image-preview').dataset.image='';$('#ql-library-image-preview').innerHTML='<span class="ql-muted">尚未添加预览图</span>';$('#ql-library-image-file').value='';delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';renderLibrary();status('提示词已保存。');};
$('#ql-character-card').onchange=()=>{if($('#ql-character-save').dataset.edit!==undefined)return;$('#ql-character-status').textContent=$('#ql-character-card').value===''?'当前角色词条不绑定酒馆角色卡。':'新建角色词条将绑定到所选角色卡。';};
$('#ql-character-save').onclick=()=>{const select=$('#ql-character-card'),characterKey=select?.value||'',name=$('#ql-character-name').value.trim(),appearance=$('#ql-character-appearance').value.trim();if(!name||!appearance){$('#ql-character-status').textContent='请填写角色名称和生图词。';return;}const card=characterKey!==''?(getContext()?.characters||[])[Number(characterKey)]:null;const item={name,characterKey:characterKey===''?null:String(characterKey),characterName:card?.name||card?.avatar||'',appearance,updatedAt:Date.now()};const edit=$('#ql-character-save').dataset.edit;if(edit!==undefined&&cfg().characters[Number(edit)])cfg().characters[Number(edit)]={...cfg().characters[Number(edit)],...item};else cfg().characters.unshift(item);cfg().characters=cfg().characters.slice(0,100);save();delete $('#ql-character-save').dataset.edit;$('#ql-character-save').textContent='保存角色词条';renderLibrary();$('#ql-character-status').textContent=characterKey!==''?'已保存，并绑定到角色卡：'+item.characterName:'已保存角色词条（尚未绑定角色卡）。';};$('#ql-character-cancel').onclick=()=>{delete $('#ql-character-save').dataset.edit;$('#ql-character-save').textContent='保存角色词条';$('#ql-character-name').value='';$('#ql-character-appearance').value='';$('#ql-character-card').value='';$('#ql-character-status').textContent='已切换到新建模式。';};$('#ql-character-analyze').onclick=()=>{let key=$('#ql-character-card').value;if(key===''){const current=getContext()?.characterId;if(!Number.isInteger(current)||current<0){$('#ql-character-status').textContent='请先选择要读取的酒馆角色卡。';return;}key=String(current);$('#ql-character-card').value=key;}const card=(getContext()?.characters||[])[Number(key)];if(!card){$('#ql-character-status').textContent='未能读取所选角色卡资料。';return;}const source=[card.description,card.personality,card.scenario,card.first_mes,card.mes_example].filter(Boolean).join('\n');$('#ql-character-name').value=card.name||card.avatar||'未命名角色';$('#ql-character-appearance').value=$('#ql-character-appearance').value.trim()||source.replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim().slice(0,3500);$('#ql-character-status').textContent='已读取角色卡描述、性格、场景与开场白作为填写参考。请检查并整理为生图词后保存。';};
$('#ql-preset-save').onclick=()=>{const name=$('#ql-preset-name').value.trim(),positive=$('#ql-preset-positive').value.trim();if(!name||!positive){status('预设名称和正向画风串不能为空。');return;}const item={name,positive,negative:$('#ql-preset-negative').value.trim(),updatedAt:Date.now()};const edit=$('#ql-preset-save').dataset.edit;if(edit!==undefined){cfg().presets[Number(edit)]=item;delete $('#ql-preset-save').dataset.edit;}else cfg().presets.unshift(item);cfg().presets=cfg().presets.slice(0,100);$('#ql-preset-edit-select').value=String(cfg().presets.findIndex(x=>x.name===item.name&&x.positive===item.positive));const savedIndex=cfg().presets.findIndex(x=>x.name===item.name&&x.positive===item.positive);if(savedIndex>=0){$('#ql-preset-save').dataset.edit=String(savedIndex);$('#ql-preset-save').textContent='保存修改';}save();renderLibrary();status('画师串已保存，可通过上方下拉框切换编辑。');};

}
jQuery(()=>{
 // 入口注册必须独立于面板创建判断：酒馆重复注入时，#ql-overlay 可能已存在，但魔法棒菜单项仍可能缺失。
 const ensureLiteLauncher=()=>{
  const menu=document.querySelector('#extensionsMenu');
  if(!menu)return false;
  let launch=menu.querySelector('#ql-chat-launch');
  if(!launch){
   // 若旧入口被酒馆移到其他容器，先复用节点，再放回原生魔法棒菜单。
   launch=document.querySelector('#ql-chat-launch')||document.createElement('div');
   launch.id='ql-chat-launch';
   launch.className='list-group-item flex-container flexGap5';
   launch.setAttribute('role','button');
   launch.setAttribute('tabindex','0');
   launch.title='打开拾帧';
   launch.innerHTML='<i class="fa-solid fa-images"></i><span>拾帧</span>';
  }
  if(launch.parentElement!==menu)menu.append(launch);
  launch.onclick=()=>{
   const overlay=document.querySelector('#ql-overlay');
   if(!overlay)return;
   overlay.hidden=false;
   document.body.classList.add('ql-modal-open');
  };
  launch.onkeydown=e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();launch.click();}};
  return true;
 };
 ensureLiteLauncher();
 // 紧急关闭兜底：热重载时若 #ql-overlay 已存在，初始化块会跳过，
 // 旧弹窗可能没有关闭监听。委托处理关闭按钮、遮罩点击和 Esc，确保随时能退出。
 if(!document.documentElement.dataset.qlEmergencyCloseWatch){
  document.documentElement.dataset.qlEmergencyCloseWatch='1';
  const emergencyClose=()=>{
   const overlay=document.querySelector('#ql-overlay');
   if(overlay)overlay.hidden=true;
   document.body.classList.remove('ql-modal-open');
  };
  document.addEventListener('click',event=>{
   const target=event.target instanceof Element?event.target:null;
   if(target?.closest('#ql-close')){emergencyClose();return;}
   const overlay=document.querySelector('#ql-overlay');
   if(overlay&&event.target===overlay)emergencyClose();
  },true);
  document.addEventListener('keydown',event=>{
   if(event.key==='Escape'){
    const overlay=document.querySelector('#ql-overlay');
    if(overlay&&!overlay.hidden)emergencyClose();
   }
  },true);
 }
 if(!document.documentElement.dataset.qlLiteMenuWatch){
  document.documentElement.dataset.qlLiteMenuWatch='1';
  new MutationObserver(()=>ensureLiteLauncher()).observe(document.documentElement,{childList:true,subtree:true});
 }
 if(!$('#ql-overlay')){
  document.documentElement.insertAdjacentHTML('beforeend',html());
  const overlay=$('#ql-overlay');
  const panel=$('#qinghui-lite-panel');
  panel.setAttribute('role','dialog');
  panel.setAttribute('aria-modal','true');
  panel.setAttribute('aria-label','拾帧');
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
    launch.title='打开拾帧';
    launch.innerHTML='<i class="fa-solid fa-images"></i><span>拾帧</span>';
    launch.addEventListener('click',open);
    launch.addEventListener('keydown',e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();open();}});
   }
   if(launch.parentElement!==menu)menu.append(launch);
   return true;
  };
  // 恢复此前稳定版本：菜单已存在就立即挂载；未创建时只等待首次出现。
  if(!mountLauncher()){
   const observer=new MutationObserver(()=>{
    if(mountLauncher())observer.disconnect();
   });
   observer.observe(document.body,{childList:true,subtree:true});
  }
   // 统一用捕获阶段委托处理所有主导航与子导航，减少移动端点击被内部控件/重绘节点打断的情况。
   panel.addEventListener('click',event=>{
    const node=event.target instanceof Element?event.target:null;
    const tab=node?.closest('button.ql-tab,button.ql-subtab');
    if(!tab||!panel.contains(tab))return;
    event.preventDefault();
    if(tab.classList.contains('ql-tab')){
     const target=tab.dataset.page;
     if(!target)return;
     panel.querySelectorAll('button.ql-tab').forEach(item=>{const active=item===tab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});
     panel.querySelectorAll('[data-page-panel]').forEach(page=>{const active=page.dataset.pagePanel===target;page.hidden=!active;page.classList.toggle('active',active);});
     const page=panel.querySelector('[data-page-panel="'+target+'"]');
     if(page)page.scrollTop=0;
      if(target==='albums')history();
     return;
    }
    const target=tab.dataset.subpage;
    if(!target)return;
    const scope=tab.closest('.ql-page')||panel;
    scope.querySelectorAll('button.ql-subtab').forEach(item=>{const active=item===tab;item.classList.toggle('active',active);item.setAttribute('aria-selected',String(active));});
    scope.querySelectorAll('[data-subpage-panel]').forEach(page=>{const active=page.dataset.subpagePanel===target;page.hidden=!active;page.classList.toggle('active',active);});
    const page=scope.querySelector('[data-subpage-panel="'+target+'"]');
    if(page)page.scrollTop=0;
   },true);
  init();
 }
 observeStatusbarFrames();
 // 扩展启用时先扫描现有聊天；再观察酒馆正文重绘，避免事件时序导致 marker 一直以原文显示。
 let inlineScanTimers=[];
 const scheduleInlineScan=()=>{
  inlineScanTimers.forEach(timer=>clearTimeout(timer));
  inlineScanTimers=[80,250,600,1200].map(delay=>setTimeout(()=>processLatestAssistantMessage().catch(e=>console.warn('[轻绘 Lite] 正文标记扫描失败',e)),delay));
 };
 scheduleInlineScan();
 const chatObserver=new MutationObserver(records=>{
  // 酒馆点击“编辑消息”时可能只切换 .mes 的 class/编辑区状态，不一定增删 .mes_text；
  // 退出编辑、保存或取消后也必须重新扫描并补回“相册收录”按钮。
  const relevant=records.some(record=>{
   if(record.target?.closest?.('.mes'))return true;
   return [...(record.addedNodes||[])].some(node=>node.nodeType===1&&(node.matches?.('.mes, .mes_text')||node.querySelector?.('.mes_text')));
  });
  if(relevant)scheduleInlineScan();
 });
 chatObserver.observe(document.body,{childList:true,subtree:true,attributes:true,attributeFilter:['class','style']});
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



/* 轻绘 Lite 魔法棒入口兜底。
 * SillyTavern 会在打开/重建扩展菜单时替换菜单 DOM，因此始终按当前菜单节点幂等挂载。
 */
jQuery(() => {
 const mountQinghuiMagicWand = () => {
  const menu = document.querySelector('#extensionsMenu');
  if (!menu) return false;
  let launch = menu.querySelector('#ql-chat-launch');
  if (!launch) {
   launch = document.createElement('div');
   launch.id = 'ql-chat-launch';
   launch.className = 'list-group-item flex-container flexGap5';
   launch.setAttribute('role', 'button');
   launch.setAttribute('tabindex', '0');
   launch.title = '打开拾帧';
   launch.innerHTML = '<i class="fa-solid fa-images"></i><span>拾帧</span>';
   launch.addEventListener('click', () => {
    const overlay = document.querySelector('#ql-overlay');
    if (!overlay) {
     console.warn('[轻绘 Lite] 工作区尚未初始化，无法打开');
     return;
    }
    overlay.hidden = false;
    document.body.classList.add('ql-modal-open');
   });
   launch.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
     event.preventDefault();
     launch.click();
    }
   });
  }
  if (launch.parentElement !== menu) menu.append(launch);
  return true;
 };
 mountQinghuiMagicWand();
 if (!document.documentElement.dataset.qlMagicWandObserver) {
  document.documentElement.dataset.qlMagicWandObserver = '1';
  const observer = new MutationObserver(() => mountQinghuiMagicWand());
  observer.observe(document.documentElement, { childList: true, subtree: true });
 }
 document.addEventListener('click', () => mountQinghuiMagicWand(), true);
});
