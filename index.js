import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types, getRequestHeaders } from '/script.js';
import { parseImageMarkers, makeTriggerId, TriggerRegistry } from './trigger-core.js';

const EXT = 'qinghui_lite';
const defaults = { pngDownloadMode:'original', historyColumns:3, vibes:[], activeVibeIndex:-1, activePresetIndex:-1, bindings:[], provider:'openai', endpoint:'https://api.openai.com/v1', apiKey:'', naiApiKey:'', naiThirdEndpoint:'', naiThirdKey:'', model:'gpt-image-1', size:'auto', quality:'medium', naiModel:'nai-diffusion-4-5-full', naiSteps:28, naiScale:5, naiWidth:832, naiHeight:1216, naiSampler:'k_euler_ancestral', naiScheduler:'karras', naiNormalizeVibeStrengths:true, prompt:'', negative:'', records:[], presets:[], characters:[], prompts:[] };
const $ = (s, root=document) => root.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
let busy=false;
let libraryEditMode=false;
let presetBatchMode=false;
const selectedPresets=new Set();
const selectedPrompts=new Set();
const selectedCharacters=new Set();
function cfg(){
 extension_settings[EXT] ??= JSON.parse(JSON.stringify(defaults));
 const s=extension_settings[EXT];
 if(typeof s.naiNormalizeVibeStrengths!=='boolean')s.naiNormalizeVibeStrengths=true;
 if(s.model==='gpt-image-2.5-sunburst'){s.model='gpt-image-1';saveSettingsDebounced();}
 for(const key of ['records','presets','characters','prompts','vibes','bindings'])if(!Array.isArray(s[key]))s[key]=[];
 // 升级到本版时统一清空旧版导入的 Vibe 与角色绑定，确保迁移只保留画师串；此清理只执行一次。
 if(!s.vibeImportCleanupV2){
  s.vibes=[];
  s.activeVibeIndex=-1;
  for(const binding of s.bindings)binding.vibeIndex=-1;
  s.vibeMigrationCleared20261025=true;
  s.vibeImportCleanupV2=true;
  saveSettingsDebounced();
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
function hideMarkersInTextNode(root){if(!root)return;const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);const nodes=[];while(walker.nextNode())if(walker.currentNode.nodeValue?.includes('image###'))nodes.push(walker.currentNode);for(const node of nodes){node.nodeValue=node.nodeValue.replace(/image###[\s\S]*?###/g,'');}}
async function requestImage(prompt, negativeOverride, vibeItem=null){
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
 const seen=new WeakSet();let found='';
 const clean=value=>String(value||'').trim().replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/');
 const key=vibeModelKey(model);
 const walk=(value,keyName='',canonical=false)=>{
  if(found||value==null)return;
  if(typeof value==='string'){
   const v=clean(value);
   if((canonical||/^(?:encoding|encoded|encodedVibe|encoded_vibe|vibeEncoding|vibe_encoding|vibeData|vibe_data|payload|base64|imageBase64|image_base64|referenceImage|reference_image)$/i.test(keyName))&&/^[A-Za-z0-9+/]+={0,2}$/.test(v)&&v.length>160){found=v;return;}
   return;
  }
  if(typeof value!=='object'||seen.has(value))return;
  seen.add(value);
  if(Array.isArray(value)){for(const item of value)walk(item,keyName,canonical);return;}
  const isCanonical=value.identifier==='novelai-vibe-transfer'&&(value.type==null||value.type==='image');
  if(isCanonical&&key==='v3'&&typeof value.image==='string'&&value.image.trim()){
   const original=clean(value.image);
   if(/^[A-Za-z0-9+/]+={0,2}$/.test(original)&&original.length>160){found=original;return;}
  }
  if(value.encodings&&typeof value.encodings==='object'){
   const group=value.encodings[key];
   if(group){
    let enc=group;
    if(typeof group==='object'&&!Array.isArray(group)&&!('encoding' in group)&&!('encoded' in group)&&!('data' in group)){
     enc=Object.values(group).find(v=>v&&typeof v==='object'&&('encoding' in v||'encoded' in v||'data' in v))||group;
    }
    const payload=typeof enc==='string'?enc:enc.encoding||enc.encoded||enc.data;
    if(typeof payload==='string'&&clean(payload).length>160){found=clean(payload);return;}
   }
   return;
  }
  if(isCanonical&&typeof value.image==='string')walk(value.image,'image',true);
  for(const [k,v] of Object.entries(value)){if(k==='encodings'||(isCanonical&&k==='image'))continue;walk(v,k,false);}
 };
 walk(raw);
 if(!found)return null;
 const serialized=safeMigrationStringify(raw)||'';
 const readNumber=(re,fallback)=>{const m=serialized.match(re);return m?Number(m[1]):fallback;};
 const strength=Number.isFinite(Number(raw?.importInfo?.strength))?Number(raw.importInfo.strength):readNumber(/"(?:reference_strength|referenceStrength|strength)"\s*:\s*([0-9.]+)/i,0.6);
 let informationExtracted=readNumber(/"(?:reference_information_extracted|referenceInformationExtracted|information_extracted|informationExtracted|info_extracted|infoExtracted)"\s*:\s*([0-9.]+)/i,1);
 const group=raw?.encodings?.[key];
 if(group&&typeof group==='object'){
  const enc=('encoding' in group||'encoded' in group||'data' in group)?group:Object.values(group).find(v=>v&&typeof v==='object'&&('encoding' in v||'encoded' in v||'data' in v));
  const info=enc?.params?.information_extracted??enc?.params?.informationExtracted??enc?.infoExtracted;
  if(Number.isFinite(Number(info)))informationExtracted=Number(info);
 }
 return {image:found,strength,informationExtracted};
}
function renderActivePresets(){const select=$('#ql-active-preset');if(!select)return;const s=cfg(),prior=String(s.activePresetIndex??-1);select.innerHTML='<option value="-1">不使用画师串预设</option>'+s.presets.map((p,i)=>'<option value="'+i+'">'+esc(p.name||('画师串 '+(i+1)))+'</option>').join('');select.value=s.presets[Number(prior)]?prior:'-1';select.onchange=()=>{s.activePresetIndex=Number(select.value);save();};}
function currentCharacter(){const ctx=getContext()||{},id=ctx.characterId,ch=Number.isInteger(id)&&id>=0?ctx.characters?.[id]:null;return {id:id==null?'':String(id),name:ch?.name||ch?.avatar||''};}
function renderBindings(){const s=cfg(),select=$('#ql-bind-character'),preset=$('#ql-bind-preset'),vibe=$('#ql-bind-vibe'),list=$('#ql-bindings-list');if(!select||!preset||!vibe)return;const ctx=getContext()||{},chars=Array.isArray(ctx.characters)?ctx.characters:[],current=currentCharacter();const options=chars.map((ch,i)=>({id:String(i),name:ch?.name||ch?.avatar||('角色 '+(i+1))}));if(current.id&&!options.some(x=>x.id===current.id))options.unshift({id:current.id,name:current.name||('当前角色 '+current.id)});const oldValue=select.value;select.innerHTML='<option value="">选择角色卡</option>'+options.map(x=>'<option value="'+esc(x.id)+'">'+esc(x.name)+'</option>').join('');if(options.some(x=>x.id===oldValue))select.value=oldValue;else if(options.some(x=>x.id===current.id))select.value=current.id;preset.innerHTML='<option value="-1">不绑定画师串</option>'+s.presets.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('画师串 '+(i+1)))+'</option>').join('');vibe.innerHTML='<option value="-1">不绑定 Vibe</option>'+s.vibes.map((x,i)=>'<option value="'+i+'">'+esc(x.name||('Vibe '+(i+1)))+'</option>').join('');const selectedName=options.find(o=>o.id===select.value)?.name;const binding=s.bindings.find(x=>x.characterName===selectedName)||s.bindings.find(x=>x.characterKey===select.value);if(binding){preset.value=String(binding.presetIndex??-1);vibe.value=String(binding.vibeIndex??-1);}if(list)list.innerHTML=s.bindings.map((b,i)=>'<div class="ql-record"><strong>'+esc(b.characterName||('角色 '+b.characterKey))+'</strong><p>画师串：'+esc(s.presets[b.presetIndex]?.name||'未绑定')+' · Vibe：'+esc(s.vibes[b.vibeIndex]?.name||'未绑定')+'</p><button class="menu_button" data-binding-delete="'+i+'">删除绑定</button></div>').join('')||'<p class="ql-muted">暂无角色绑定</p>';list?.querySelectorAll('[data-binding-delete]').forEach(btn=>btn.onclick=()=>{s.bindings.splice(+btn.dataset.bindingDelete,1);save();renderBindings();});}
function applyCurrentBinding(){const current=currentCharacter();if(!current.id)return;const s=cfg(),ch=(getContext()?.characters||[])[Number(current.id)],name=current.name||ch?.name||ch?.avatar||'';const binding=s.bindings.find(x=>x.characterName===name)||s.bindings.find(x=>x.characterKey===current.id);if(!binding)return;s.activePresetIndex=Number.isInteger(binding.presetIndex)?binding.presetIndex:-1;s.activeVibeIndex=Number.isInteger(binding.vibeIndex)?binding.vibeIndex:-1;renderActivePresets();renderActiveVibes();status('已自动应用角色绑定：'+(name||current.id));}
let pendingVibeImage=null;
function renderActiveVibes(){
 const select=$('#ql-active-vibe');if(!select)return;
 const prior=String(cfg().activeVibeIndex??-1);
 select.innerHTML='<option value="-1">不使用 Vibe</option>'+cfg().vibes.map((v,i)=>'<option value="'+i+'">'+esc(v.name||('Vibe '+(i+1)))+(v.hasPayload?' · 已识别编码':' · 尚无可用编码')+'</option>').join('');
 select.value=cfg().vibes[Number(prior)]?prior:'-1';
 select.onchange=()=>{cfg().activeVibeIndex=Number(select.value);save();};
}
let lastPngCleanReport='';
async function preparePngDownloadBlob(blob){
 lastPngCleanReport='';
 if(!blob||cfg().pngDownloadMode!=='clean')return blob;
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
  // 解码后用同尺寸 Canvas 重新编码 PNG：不缩放、不裁切、不转 JPG，避免沿用原文件中的提示词/生成参数块。
  let bitmap=null;
  try{
   if(typeof createImageBitmap==='function'){
    bitmap=await createImageBitmap(blob);
    const canvas=document.createElement('canvas');
    canvas.width=bitmap.width;canvas.height=bitmap.height;
    const context=canvas.getContext('2d',{alpha:true,willReadFrequently:false});
    if(!context)throw new Error('无法创建 Canvas 画布');
    context.clearRect(0,0,canvas.width,canvas.height);
    context.drawImage(bitmap,0,0);
    const cleaned=await new Promise((resolve,reject)=>{
     canvas.toBlob(result=>result?resolve(result):reject(new Error('浏览器重新编码 PNG 失败')),'image/png');
    });
    if(!cleaned||cleaned.type!=='image/png')throw new Error('浏览器未能导出 PNG');
    lastPngCleanReport='清洗完成：已按原始宽高重新编码为 PNG，未缩放或裁切；原文件中的附加元数据不会被复制。PNG 为无损编码，但浏览器颜色管理可能造成极细微的像素差异。';
    return cleaned;
   }
  }catch(error){
   console.warn('[轻绘 Lite] Canvas PNG 重编码不可用，改用 PNG 数据块清理',error);
  }finally{
   bitmap?.close?.();
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
async function saveCleanImage(src,filename){
 if(!src)throw new Error('这条缓存记录没有可保存的图片数据。');
 const name=filename||'qinghui-image.png';
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
  }else if(/^https?:/i.test(src)){
   try{const response=await fetch(src);if(response.ok)fileBlob=await response.blob();}catch{}
  }
  if(fileBlob&&cfg().pngDownloadMode==='clean'&&(/png/i.test(fileBlob.type)||/\.png$/i.test(name))){
   const previousUrl=objectUrl;
   fileBlob=await preparePngDownloadBlob(fileBlob);
   objectUrl=URL.createObjectURL(fileBlob);
   if(previousUrl!==src)URL.revokeObjectURL(previousUrl);
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
  const hint=document.createElement('p');hint.textContent='点击下方按钮保存到设备；如果浏览器要求确认，请按提示继续。';hint.style.cssText='margin:0 0 16px;color:'+theme.muted+';font-size:13px;line-height:1.5;';
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
  messageIndex:meta.messageIndex,taskKey,character:meta.character||null,chatId:getContext()?.chatId||null
 });
 c.records=c.records.slice(0,100);save();history();
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
function downloadJson(value,filename){const blob=new Blob([JSON.stringify(value,null,2)],{type:'application/json;charset=utf-8'});const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download=filename;a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);}

function html(){return `<div id="ql-overlay" hidden><section id="qinghui-lite-panel">
<header class="ql-header"><div class="ql-brand"><strong>轻绘 Lite</strong><span>独立生图工作区</span></div><button id="ql-close" class="menu_button" type="button">关闭</button></header>
<nav class="ql-tabs" aria-label="轻绘功能导航" role="tablist">
<button type="button" class="ql-tab active" data-page="generate" role="tab" aria-selected="true">生图</button>
<button type="button" class="ql-tab" data-page="library" role="tab" aria-selected="false">预设</button>
<button type="button" class="ql-tab" data-page="wordbank" role="tab" aria-selected="false">词库</button>
<button type="button" class="ql-tab" data-page="history" role="tab" aria-selected="false">历史</button>
<button type="button" class="ql-tab" data-page="settings" role="tab" aria-selected="false">设置</button>
</nav>
<div class="ql-page active" data-page-panel="generate" role="tabpanel">
<div class="ql-card"><h3>图片放置区</h3><p class="ql-muted">生成结果会显示在这里；长按图片可保存。</p><div id="ql-result" class="ql-image-stage"><div class="ql-image-placeholder">等待生成图片</div></div></div>
<div class="ql-card"><h3>生图提示词</h3><p class="ql-muted">提示词库、角色词和画师串都直接写入下方正向/负向提示词，不另设 Tag 列表。</p><label for="ql-prompt">正向提示词</label><textarea id="ql-prompt" placeholder="输入完整提示词；从提示词库应用的内容会填入这里"></textarea><label for="ql-negative">负向提示词</label><textarea id="ql-negative" placeholder="可选"></textarea></div>
<div class="ql-card"><h3>画师串与 Vibe</h3><label for="ql-active-preset">画师串组合</label><select id="ql-active-preset"><option value="-1">不使用画师串预设</option></select><div class="ql-row"><button id="ql-apply-preset" class="menu_button" type="button">应用画师串</button><button id="ql-open-preset" class="menu_button" type="button">编辑 / 管理预设</button></div><label for="ql-active-vibe">Vibe 参考（仅 NovelAI）</label><select id="ql-active-vibe"><option value="-1">不使用 Vibe</option></select><p class="ql-muted">仅包含完整参考图编码的 Vibe 可用于生成。</p></div>
<div class="ql-card"><h3>模型参数</h3><label for="ql-fast-provider">生图后端</label><select id="ql-fast-provider"><option value="openai">GPT / OpenAI 兼容接口</option><option value="novelai">NovelAI 官网</option><option value="novelai-thirdparty">NovelAI 第三方</option></select><div id="ql-fast-openai"><label for="ql-fast-model">模型</label><input id="ql-fast-model" placeholder="gpt-image-1"><div class="ql-row"><div><label>尺寸</label><select id="ql-fast-size"><option value="auto">自动选择（官网）</option><option value="1024x1024">1024 × 1024 · 正方形</option><option value="1536x1024">1536 × 1024 · 横图</option><option value="1024x1536">1024 × 1536 · 竖图</option><option value="2048x2048">2048 × 2048 · 2K 正方形（支持时）</option><option value="2048x1152">2048 × 1152 · 2K 横图（支持时）</option><option value="3840x2160">3840 × 2160 · 4K 横图（支持时）</option><option value="2160x3840">2160 × 3840 · 4K 竖图（支持时）</option></select></div><div><label>质量</label><select id="ql-fast-quality"><option>low</option><option>medium</option><option>high</option></select></div></div></div><div id="ql-fast-nai" hidden><label>NovelAI 模型</label><select id="ql-fast-nai-model"><option>nai-diffusion-4-5-full</option><option>nai-diffusion-4-5-curated</option><option>nai-diffusion-4-full</option><option>nai-diffusion-4-curated</option><option>nai-diffusion-3</option></select><div class="ql-row"><div><label>步数</label><input id="ql-fast-nai-steps" type="number" min="1" max="50"></div><div><label>CFG Scale</label><input id="ql-fast-nai-scale" type="number" min="1" max="20" step="0.5"></div></div><div class="ql-row"><div><label>宽度</label><select id="ql-fast-nai-width"><option>512</option><option>640</option><option>768</option><option>832</option><option>1024</option></select></div><div><label>高度</label><select id="ql-fast-nai-height"><option>512</option><option>640</option><option>768</option><option>832</option><option>1024</option><option>1216</option><option>1536</option></select></div></div><div class="ql-row"><div><label>采样器</label><select id="ql-fast-nai-sampler"><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option></select></div><div><label>调度器</label><select id="ql-fast-nai-scheduler"><option value="karras">Karras</option><option value="native">Native</option></select></div></div><label class="ql-inline-check"><input id="ql-fast-nai-normalize" type="checkbox"> 归一化 Vibe 参考强度</label><p class="ql-muted">开启后会自动归一化 V4/V4.5 多条 Vibe 的强度；关闭则按每条参考的原始强度发送。</p></div><button id="ql-generate" class="menu_button ql-primary">生成一张</button><p id="ql-status" class="ql-muted" role="status"></p></div>
</div>
<div class="ql-page" data-page-panel="library" role="tabpanel" hidden>
<nav class="ql-subtabs" role="tablist" aria-label="预设分区"><button type="button" class="ql-subtab active" data-subpage="artists" aria-selected="true">画师串编辑</button><button type="button" class="ql-subtab" data-subpage="vibes" aria-selected="false">Vibe 管理</button><button type="button" class="ql-subtab" data-subpage="bindings" aria-selected="false">角色绑定</button></nav>
<section class="ql-subpage active" data-subpage-panel="artists"><div class="ql-card"><h3>画师串编辑区</h3><p class="ql-muted">可从下方列表切换画师串编辑；保存时更新当前选中的组合，也可以新建组合。</p><label for="ql-preset-edit-select">切换要编辑的画师串</label><div class="ql-row"><select id="ql-preset-edit-select"><option value="">新建画师串</option></select><button type="button" class="menu_button" id="ql-preset-new">新建</button><button type="button" class="menu_button" id="ql-migrate-toggle" aria-expanded="false">迁移智绘姬</button></div><div id="ql-migrate-panel" hidden><p class="ql-muted">扫描当前酒馆可访问的智绘姬设置，或选择智绘姬导出的 JSON 文件。迁移前会预览，已有画师串不会被覆盖。</p><div class="ql-row ql-migrate-actions"><button id="ql-migrate-scan" class="menu_button">扫描当前酒馆</button><button id="ql-migrate-file-btn" class="menu_button">选择导出文件</button><input id="ql-migrate-file" type="file" accept=".json,.json5,.txt,application/json" hidden></div><div id="ql-migrate-preview" class="ql-muted" role="status">尚未扫描。</div><button id="ql-migrate-import" class="menu_button" disabled>确认导入</button><p class="ql-muted">可迁移画师串（正向与负向提示词）及含有效预编码的 Vibe 组；不导入其他文本预设或词库图片。</p></div><div id="ql-preset-editor" hidden><input id="ql-preset-name" placeholder="组合名称"><label>正向画师串</label><textarea id="ql-preset-positive" placeholder="artist:xxx, style tags..."></textarea><label>负向画师串</label><textarea id="ql-preset-negative" placeholder="可选"></textarea><button id="ql-preset-save" class="menu_button">保存画师串组合</button></div><button type="button" id="ql-preset-batch-toggle" class="menu_button">批量编辑</button><div id="ql-presets-batch" hidden><div class="ql-row ql-library-tools"><button type="button" id="ql-preset-export" class="menu_button">导出所选</button><button type="button" id="ql-preset-bulk-delete" class="menu_button">删除所选</button></div><p class="ql-muted">勾选要删除或导出的画师串；退出批量编辑后列表会再次隐藏。</p><div id="ql-presets-list"></div></div></div></section><section class="ql-subpage" data-subpage-panel="vibes" hidden><div class="ql-card"><h3>Vibe 导入与编辑</h3><p class="ql-muted">支持 JSON / 智绘姬组格式和可解析的 .naiv4vibe / bundle 压缩包；也可选择图片。编码可能消耗 NovelAI Anlas。图片编码需要酒馆提供 /api/novelai/encode-vibe 代理接口；若返回 404，需补充后端代理。</p><label>导入文件</label><input id="ql-vibe-import-file" type="file" accept=".json,.json5,.txt,.naiv4vibe,.naiv4vibeBundle,image/png,image/jpeg,image/webp"><button id="ql-vibe-pick" type="button" class="menu_button ql-secondary">选择 Vibe 文件 / 图片</button><label>Vibe 名称</label><input id="ql-vibe-name" placeholder="例如：柔和配色参考"><label>Information Extracted</label><input id="ql-vibe-info" type="number" min="0.01" max="1" step="0.05" value="1"><button id="ql-vibe-encode" class="menu_button">将选中的图片编码为 Vibe</button><p id="ql-vibe-status" class="ql-muted" role="status">尚未选择文件。</p><div id="ql-vibes-list"></div></div></section>
<section class="ql-subpage" data-subpage-panel="bindings" hidden><div class="ql-card"><h3>角色卡组合绑定</h3><p class="ql-muted">为角色卡绑定画师串与 Vibe，切换角色卡时自动选择已保存的组合。</p><label>角色卡</label><select id="ql-bind-character"><option value="">选择角色卡</option></select><label>画师串组合</label><select id="ql-bind-preset"><option value="-1">不绑定画师串</option></select><label>Vibe 组合</label><select id="ql-bind-vibe"><option value="-1">不绑定 Vibe</option></select><button id="ql-bind-save" class="menu_button">保存此角色绑定</button><div id="ql-bindings-list"></div></div></section>
</div>
<div class="ql-page" data-page-panel="wordbank" role="tabpanel" hidden>
<nav class="ql-subtabs" role="tablist" aria-label="词库分区"><button type="button" class="ql-subtab active" data-subpage="prompt-library" aria-selected="true">提示词库</button><button type="button" class="ql-subtab" data-subpage="character-library" aria-selected="false">角色词条库</button></nav>
<section class="ql-subpage active" data-subpage-panel="prompt-library"><div class="ql-card"><h3>提示词库</h3><p class="ql-muted">默认以小图网格浏览；点击某条才展开编辑区。</p><button type="button" id="ql-prompt-add" class="menu_button ql-primary">＋ 添加提示词</button><div id="ql-prompt-editor" hidden><div class="ql-row"><input id="ql-prompt-name" placeholder="名称"><select id="ql-prompt-category"><option value="单人">单人</option><option value="双人">双人</option><option value="BG">BG</option><option value="BL">BL</option><option value="GL">GL</option><option value="其他">其他</option><option value="自定义">自定义分类…</option></select><input id="ql-prompt-category-custom" placeholder="输入自定义分类" hidden></div><label>中文提示词（方便查阅）</label><textarea id="ql-library-prompt-zh" placeholder="中文描述、创作意图或备注"></textarea><section class="ql-library-prompt-field"><div class="ql-library-prompt-field-head"><label for="ql-library-prompt-en"><span class="ql-library-field-kicker">IMAGE PROMPT</span><span>画面提示词</span></label><button type="button" id="ql-library-prompt-copy" class="ql-library-copy-icon" aria-label="复制画面提示词" title="复制画面提示词"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg></button></div><textarea id="ql-library-prompt-en" placeholder="English prompt tags / description"></textarea><p class="ql-library-field-note">用于生图的英文标签 · 点击右上角图标可直接复制</p></section><div class="ql-image-reference-editor"><label for="ql-library-image-file">预览图片（仅供词库展示，不会作为模型输入）</label><input id="ql-library-image-file" type="file" accept="image/*"><div id="ql-library-image-preview" class="ql-library-image-preview" data-image=""><span class="ql-muted">尚未添加预览图</span></div><button type="button" id="ql-library-image-clear" class="menu_button">移除预览图</button></div><div class="ql-row"><button id="ql-prompt-save" class="menu_button">保存提示词</button><button type="button" id="ql-prompt-cancel" class="menu_button">取消</button></div></div><div class="ql-row ql-library-tools"><select id="ql-prompt-filter"><option value="">全部分类</option></select><button type="button" id="ql-library-edit-mode" class="menu_button">编辑模式</button><button type="button" id="ql-prompt-export" class="menu_button">导出所选</button><button type="button" id="ql-prompt-bulk-delete" class="menu_button">批量删除</button></div><p class="ql-muted" id="ql-library-edit-hint">提示词可按分类筛选；开启编辑模式后可多选、批量删除或导出。</p><div id="ql-prompts-list"></div></div></section>
<section class="ql-subpage" data-subpage-panel="character-library" hidden><div class="ql-card"><h3>角色词条库</h3><p class="ql-muted">先创建角色和生图词，再选择是否绑定到酒馆角色卡；也可以读取角色卡资料作为填写起点。</p><button type="button" id="ql-character-analyze" class="menu_button">读取所选角色卡并填入</button><label for="ql-character-card">绑定到酒馆角色卡（可选）</label><select id="ql-character-card"><option value="">暂不绑定</option></select><label for="ql-character-name">角色名称</label><input id="ql-character-name" placeholder="例如：角色名 / 卡内角色名"><label for="ql-character-appearance">生图词 / 固定外貌词</label><textarea id="ql-character-appearance" placeholder="填写外貌、发色、瞳色、服装等固定生图词"></textarea><div class="ql-row"><button id="ql-character-save" class="menu_button">保存角色词条</button><button type="button" id="ql-character-cancel" class="menu_button">新建</button></div><p class="ql-muted" id="ql-character-status" role="status"></p><div class="ql-row ql-library-tools"><button type="button" id="ql-character-export" class="menu_button">导出所选</button><button type="button" id="ql-character-bulk-delete" class="menu_button">批量删除</button></div><div id="ql-characters-list"></div></div></section>
</div>
<div class="ql-page" data-page-panel="history" role="tabpanel" hidden><div class="ql-card"><h3>图片缓存</h3><p class="ql-muted">生成图片以图片流方式保存。点击图片可放大查看预设、提示词、Vibe 与生成参数。</p><label for="ql-history-columns">每行图片数量</label><select id="ql-history-columns"><option value="1">1 张</option><option value="2">2 张</option><option value="3">3 张</option><option value="4">4 张</option><option value="5">5 张</option></select><div id="ql-history"></div></div><div id="ql-cache-footer" class="ql-cache-bulk-tools"><button type="button" class="menu_button" id="ql-cache-select-mode" aria-pressed="false">多选</button><label class="ql-cache-select-all" hidden><input type="checkbox" data-ql-select-all disabled> 全选</label><span class="ql-cache-selected-count" data-ql-selected-count hidden>已选 0 张</span><button type="button" class="menu_button" data-ql-bulk-download disabled hidden>逐张下载</button><button type="button" class="menu_button" data-ql-bulk-delete disabled hidden>删除所选</button><button type="button" class="menu_button" id="ql-clear">清空图片缓存</button></div></div>
<div class="ql-page" data-page-panel="settings" role="tabpanel" hidden><div class="ql-card"><h3>PNG 下载选项</h3><p class="ql-muted">选择缓存图片的 PNG 下载方式。原始版本保留提示词、生成参数等嵌入数据；清洗版本移除文本、EXIF、时间等元数据，并尽量保留颜色配置与图像像素。此选项只影响 PNG，其他格式不变。</p><label for="ql-png-download-mode">PNG 下载方式</label><select id="ql-png-download-mode"><option value="original">原始 PNG（保留元数据）</option><option value="clean">清洗 PNG（移除元数据）</option></select><button id="ql-png-download-save" type="button" class="menu_button ql-primary">保存下载选项</button><p id="ql-png-download-status" class="ql-muted" role="status"></p></div><div class="ql-card"><h3>外观与配色</h3><p class="ql-muted">内置低饱和配色，默认跟随酒馆主题；也可以自定义 CSS 变量。</p><label for="ql-theme-preset">配色预设</label><select id="ql-theme-preset"><option value="auto">自适配酒馆美化</option><option value="mist">雾灰蓝</option><option value="sage">鼠尾草绿</option><option value="lavender">灰紫</option><option value="oat">燕麦奶茶</option><option value="ink">墨蓝灰</option><option value="custom">自定义 CSS</option></select><label for="ql-theme-css">自定义 CSS（仅作用于轻绘 Lite）</label><textarea id="ql-theme-css" placeholder="例如：--ql-accent: #8799ad;\n--ql-panel: rgba(230, 235, 240, .96);"></textarea><div class="ql-row"><button id="ql-theme-apply" type="button" class="menu_button">应用配色</button><button id="ql-theme-reset" type="button" class="menu_button">恢复自适配</button></div><p id="ql-theme-status" class="ql-muted" role="status"></p></div><div class="ql-card"><h3>接口连接设置</h3><nav class="ql-subtabs" role="tablist" aria-label="接口类型"><button type="button" class="ql-subtab active" data-subpage="conn-gpt" aria-selected="true">GPT</button><button type="button" class="ql-subtab" data-subpage="conn-nai-official" aria-selected="false">NAI 官网</button><button type="button" class="ql-subtab" data-subpage="conn-nai-third" aria-selected="false">NAI 第三方</button></nav><section class="ql-subpage active" data-subpage-panel="conn-gpt"><p class="ql-muted">GPT / OpenAI 兼容服务需要填写接口地址与 Key。</p><label for="ql-gpt-endpoint">API 地址</label><input id="ql-gpt-endpoint" placeholder="https://api.openai.com/v1"><label for="ql-gpt-key">API Key</label><input id="ql-gpt-key" type="password" autocomplete="off" placeholder="仅保存在酒馆扩展设置"><button id="ql-save-gpt" class="menu_button ql-primary">保存 GPT 连接</button></section><section class="ql-subpage" data-subpage-panel="conn-nai-official" hidden><p class="ql-muted">官网模式使用 NovelAI 官方 API，Key 仅保存在当前酒馆扩展设置中。</p><label for="ql-nai-key">NovelAI 官网 Key</label><input id="ql-nai-key" type="password" autocomplete="off" placeholder="NovelAI Persistent API Token"><button id="ql-save-nai" class="menu_button ql-primary">保存 NAI 官网连接</button></section><section class="ql-subpage" data-subpage-panel="conn-nai-third" hidden><p class="ql-muted">第三方 NAI 兼容服务需要填写服务商提供的地址与 Key。</p><label for="ql-nai-third-endpoint">第三方 API 地址</label><input id="ql-nai-third-endpoint" placeholder="https://服务商地址"><label for="ql-nai-third-key">第三方 API Key</label><input id="ql-nai-third-key" type="password" autocomplete="off" placeholder="服务商提供的 Key"><button id="ql-save-nai-third" class="menu_button ql-primary">保存 NAI 第三方连接</button></section><div hidden><input id="ql-endpoint"><input id="ql-key"></div></div><div hidden><select id="ql-provider"><option value="openai">OpenAI</option><option value="novelai">NovelAI 官网</option><option value="novelai-thirdparty">NovelAI 第三方</option></select><input id="ql-model"><select id="ql-size"><option value="auto">auto</option><option>1024x1024</option><option>1536x1024</option><option>1024x1536</option><option>2048x2048</option><option>2048x1152</option><option>3840x2160</option><option>2160x3840</option></select><select id="ql-quality"><option>low</option><option>medium</option><option>high</option></select><input id="ql-nai-model"><input id="ql-nai-steps"><input id="ql-nai-scale"><select id="ql-nai-width"><option>512</option><option>640</option><option>768</option><option>832</option><option>1024</option></select><select id="ql-nai-height"><option>512</option><option>640</option><option>768</option><option>832</option><option>1024</option><option>1216</option><option>1536</option></select><select id="ql-nai-sampler"><option value="k_euler_ancestral">Euler Ancestral</option><option value="k_euler">Euler</option><option value="k_dpmpp_2m">DPM++ 2M</option><option value="k_dpmpp_2s_ancestral">DPM++ 2S Ancestral</option></select><select id="ql-nai-scheduler"><option value="karras">Karras</option><option value="native">Native</option></select><input id="ql-nai-normalize" type="checkbox"><div id="ql-openai-settings" hidden></div><div id="ql-nai-settings" hidden></div></div></div>
</section></div>`;}

function syncFastControls(){if(!$('#ql-fast-provider'))return;$('#ql-provider').value=$('#ql-fast-provider').value;$('#ql-model').value=$('#ql-fast-model').value;$('#ql-size').value=$('#ql-fast-size').value;$('#ql-quality').value=$('#ql-fast-quality').value;$('#ql-nai-model').value=$('#ql-fast-nai-model').value;$('#ql-nai-steps').value=$('#ql-fast-nai-steps').value;$('#ql-nai-scale').value=$('#ql-fast-nai-scale').value;$('#ql-nai-width').value=$('#ql-fast-nai-width').value;$('#ql-nai-height').value=$('#ql-fast-nai-height').value;$('#ql-nai-sampler').value=$('#ql-fast-nai-sampler').value;$('#ql-nai-scheduler').value=$('#ql-fast-nai-scheduler').value;$('#ql-nai-normalize').checked=$('#ql-fast-nai-normalize').checked;}
function read(){syncFastControls();const s=cfg();s.provider=$('#ql-provider').value;s.endpoint=$('#ql-endpoint').value.trim().replace(/\/$/,'');s.apiKey=$('#ql-key').value.trim();s.model=$('#ql-model').value.trim()||'gpt-image-1';s.size=$('#ql-size').value;s.quality=$('#ql-quality').value;s.naiModel=$('#ql-nai-model').value.trim()||'nai-diffusion-4-5-full';s.naiSteps=Number($('#ql-nai-steps').value)||28;s.naiScale=Number($('#ql-nai-scale').value)||5;s.naiWidth=Number($('#ql-nai-width').value)||832;s.naiHeight=Number($('#ql-nai-height').value)||1216;s.naiSampler=$('#ql-nai-sampler').value;s.naiScheduler=$('#ql-nai-scheduler').value;s.naiNormalizeVibeStrengths=$('#ql-nai-normalize').checked;s.prompt=$('#ql-prompt').value;s.negative=$('#ql-negative').value;save();}
function status(t){$('#ql-status').textContent=t;}
function history(){
 const host=$('#ql-history');if(!host)return;
 const s=cfg(),records=s.records||[],cols=Math.max(1,Math.min(5,Number(s.historyColumns)||3));
 const settings=$('#ql-history-columns');
 if(settings){settings.value=String(cols);settings.onchange=()=>{s.historyColumns=Math.max(1,Math.min(5,Number(settings.value)||3));save();history();};}
 host.style.setProperty('--ql-history-columns',String(cols));
 host.innerHTML=(records.length?'<div class="ql-cache-grid" data-columns="'+cols+'">'+records.map((r,i)=>'<article class="ql-cache-tile"><button type="button" class="ql-cache-image" data-ql-detail="'+i+'" aria-label="查看图片详情"><img loading="lazy" src="'+esc(r.dataUrl||'')+'" alt="生成结果"></button></article>').join('')+'</div>':'<p class="ql-muted">暂无缓存图片。生成的图片会保存在这里。</p>');
 const footer=$('#ql-cache-footer');const clearButton=footer?.querySelector('#ql-clear');if(clearButton)clearButton.onclick=()=>{if(confirm('清空轻绘本地生成记录？不会删除聊天图片。')){cfg().records=[];save();history();status('记录已清空。');}};
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
  const promptText=String(r.prompt||'');
  const promptWords=promptText.split(/[,，\\n]+/).map(x=>x.trim()).filter(Boolean).length;
  const vibeCount=Array.isArray(vibe?.entries)?vibe.entries.length:0;
  content.innerHTML='<div class="ql-cache-detail-hero"><div class="ql-cache-detail-image-wrap"><img class="ql-cache-large" src="'+esc(r.dataUrl||'')+'" alt="生成结果"></div><div class="ql-cache-detail-heading"><span class="ql-cache-eyebrow">IMAGE ARCHIVE · 轻绘缓存</span><h3>生成记录</h3><p>'+esc(createdAt.toLocaleString())+'</p><div class="ql-cache-badges"><span>'+esc(r.provider||'未知后端')+'</span><span>'+esc(r.model||meta.model||'未知模型')+'</span><span>'+esc(r.size||meta.size||'尺寸未知')+'</span></div></div></div><div class="ql-cache-stat-grid"><div class="ql-cache-stat"><span>提示词条目</span><strong>'+promptWords+'</strong></div><div class="ql-cache-stat"><span>Vibe 参考</span><strong>'+vibeCount+'</strong></div><div class="ql-cache-stat"><span>画师串</span><strong>'+esc(preset?.name||'未使用')+'</strong></div></div><section class="ql-cache-prompt-section"><div class="ql-cache-section-title"><div><span class="ql-cache-eyebrow">PROMPT</span><h4>正向提示词</h4></div><span class="ql-cache-section-note">点击图标复制</span></div><div class="ql-cache-prompt-box"><pre>'+esc(promptText||'此记录没有保存正向提示词')+'</pre><button type="button" class="ql-cache-copy-icon" data-copy-positive aria-label="复制正向提示词" title="复制正向提示词"><svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M8 7.5V5.8A1.8 1.8 0 0 1 9.8 4h8.4A1.8 1.8 0 0 1 20 5.8v10.4a1.8 1.8 0 0 1-1.8 1.8h-1.7"/><rect x="4" y="8" width="11" height="12" rx="1.8"/><path d="M7 11h5M7 14h5"/></svg></button></div></section><div class="ql-cache-detail-actions"><button type="button" class="menu_button ql-cache-action-primary" data-modal-load>载入提示词</button><button type="button" class="menu_button" data-modal-save>保存图片</button></div><div class="ql-cache-accordions"><details><summary><span>画师串预设</span><small>'+esc(preset?.name||'未使用')+'</small></summary><div class="ql-cache-accordion-body"><label>预设正文</label><pre>'+esc(preset?.positive||'未记录')+'</pre><label>预设负向词</label><pre>'+esc(preset?.negative||'未记录')+'</pre></div></details><details><summary><span>负向提示词</span><small>NEGATIVE PROMPT</small></summary><div class="ql-cache-accordion-body"><pre>'+esc(r.negative||meta.negative||'未记录')+'</pre></div></details><details><summary><span>Vibe 参考</span><small>'+vibeCount+' 条参考</small></summary><div class="ql-cache-accordion-body"><pre>'+esc(vibe?JSON.stringify(vibe,null,2):'未使用 Vibe')+'</pre></div></details><details><summary><span>完整生成参数</span><small>ADVANCED</small></summary><div class="ql-cache-accordion-body"><pre>'+esc(JSON.stringify(meta,null,2))+'</pre></div></details></div>';
  content.querySelector('[data-copy-positive]').onclick=async()=>{const value=String(r.prompt||'');try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);}else{const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw new Error('浏览器未允许复制');}const button=content.querySelector('[data-copy-positive]');button.classList.add('is-copied');button.setAttribute('title','已复制');button.setAttribute('aria-label','已复制正向提示词');status('已复制正向提示词。');setTimeout(()=>{button.classList.remove('is-copied');button.setAttribute('title','复制正向提示词');button.setAttribute('aria-label','复制正向提示词');},1300);}catch(error){status('复制失败：请长按提示词文本手动复制。');}};
  content.querySelector('[data-modal-load]').onclick=()=>{$('#ql-prompt').value=r.basePrompt||r.prompt||'';$('#ql-negative').value=r.negative||'';read();modal.hidden=true;modal.style.display='';status('基础提示词已载入；记录中的画师串不会自动切换，请确认当前画师串后再生成。');};
  content.querySelector('[data-modal-save]').onclick=async e=>{e.preventDefault();e.stopPropagation();const button=e.currentTarget;if(button.dataset.busy==='1')return;button.dataset.busy='1';try{const imageUrl=String(r.dataUrl||content.querySelector('.ql-cache-large')?.currentSrc||content.querySelector('.ql-cache-large')?.src||'');const result=await saveCleanImage(imageUrl,'qinghui-'+(r.at||Date.now())+'.png');status((result?.edgeFallback?'已打开下载面板，请点击面板中的“保存图片”。':result?.downloadStarted?'已发起图片下载；请在浏览器下载列表或系统下载目录查看。':'已发起图片下载。')+(cfg().pngDownloadMode==='clean'&&lastPngCleanReport?' '+lastPngCleanReport:''));}catch(e){status(e.message||String(e));}finally{delete button.dataset.busy;}};
  modal.hidden=false;modal.style.display='flex';
 };
 const modeButton=footer?.querySelector('#ql-cache-select-mode');let selectionMode=false;const setSelectionMode=enabled=>{selectionMode=enabled;if(modeButton){modeButton.textContent=enabled?'完成选择':'多选';modeButton.setAttribute('aria-pressed',String(enabled));}const allLabel=footer?.querySelector('.ql-cache-select-all'),count=footer?.querySelector('[data-ql-selected-count]'),bulkDelete=footer?.querySelector('[data-ql-bulk-delete]'),bulkDownload=footer?.querySelector('[data-ql-bulk-download]');if(allLabel)allLabel.hidden=!enabled;if(count)count.hidden=!enabled;if(bulkDelete)bulkDelete.hidden=!enabled;if(bulkDownload)bulkDownload.hidden=!enabled;host.classList.toggle('ql-cache-selection-mode',enabled);if(!enabled){host.querySelectorAll('.ql-cache-tile.is-selected').forEach(tile=>tile.classList.remove('is-selected'));host.querySelectorAll('[data-ql-select]').forEach(input=>input.checked=false);}updateSelection();};if(modeButton)modeButton.onclick=()=>setSelectionMode(!selectionMode);
 host.querySelectorAll('[data-ql-detail]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();const i=Number(b.dataset.qlDetail);if(selectionMode&&b.classList.contains('ql-cache-image')){const tile=b.closest('.ql-cache-tile');const input=tile?.querySelector('[data-ql-select]');if(input)input.checked=!input.checked;else{const hidden=document.createElement('input');hidden.type='checkbox';hidden.dataset.qlSelect=String(i);hidden.checked=true;hidden.hidden=true;tile?.append(hidden);}tile?.classList.toggle('is-selected',!!tile?.querySelector('[data-ql-select]')?.checked);updateSelection();return;}openDetail(i);});
 host.querySelectorAll('[data-ql-download]').forEach(b=>b.onclick=async e=>{e.preventDefault();e.stopPropagation();const button=e.currentTarget;if(button.dataset.busy==='1')return;button.dataset.busy='1';try{const r=records[Number(button.dataset.qlDownload)];if(!r)throw new Error('找不到这条缓存记录。');const result=await saveCleanImage(r.dataUrl,'qinghui-'+(r.at||Date.now())+'.png');status(result?.edgeFallback?'已打开下载面板，请点击面板中的“保存图片”。':result?.downloadStarted?'已发起图片下载；请在浏览器下载列表或系统下载目录查看。':'已发起图片下载。');}catch(e){status(e.message||String(e));}finally{delete button.dataset.busy;}});
 host.querySelectorAll('[data-ql-delete]').forEach(b=>b.onclick=e=>{e.preventDefault();e.stopPropagation();const i=Number(b.dataset.qlDelete);if(!confirm('删除这条轻绘图片缓存？不会删除聊天消息中的图片。'))return;s.records.splice(i,1);save();history();status('图片缓存已删除。');});
 const updateSelection=()=>{const tiles=[...host.querySelectorAll('.ql-cache-tile')],selected=tiles.filter(tile=>tile.classList.contains('is-selected')||tile.querySelector('[data-ql-select]')?.checked);const count=footer?.querySelector('[data-ql-selected-count]'),bulkDelete=footer?.querySelector('[data-ql-bulk-delete]'),bulkDownload=footer?.querySelector('[data-ql-bulk-download]'),all=footer?.querySelector('[data-ql-select-all]');if(count)count.textContent='已选 '+selected.length+' 张';if(bulkDelete)bulkDelete.disabled=!selected.length;if(bulkDownload)bulkDownload.disabled=!selected.length;if(all){all.disabled=!tiles.length;all.checked=tiles.length>0&&selected.length===tiles.length;all.indeterminate=selected.length>0&&selected.length<tiles.length;}};
 host.querySelectorAll('[data-ql-select]').forEach(input=>input.addEventListener('change',()=>{input.closest('.ql-cache-tile')?.classList.toggle('is-selected',input.checked);updateSelection();}));
 footer?.querySelector('[data-ql-select-all]')?.addEventListener('change',e=>{host.querySelectorAll('.ql-cache-tile').forEach(tile=>{let input=tile.querySelector('[data-ql-select]');if(!input){input=document.createElement('input');input.type='checkbox';input.dataset.qlSelect=tile.querySelector('[data-ql-detail]')?.dataset.qlDetail||'';input.hidden=true;tile.append(input);}input.checked=e.currentTarget.checked;tile.classList.toggle('is-selected',input.checked);});updateSelection();});
 footer?.querySelector('[data-ql-bulk-download]')?.addEventListener('click',async e=>{e.preventDefault();e.stopPropagation();const selected=[...host.querySelectorAll('.ql-cache-tile.is-selected')].map(tile=>Number(tile.querySelector('[data-ql-detail]')?.dataset.qlDetail)).filter(i=>Number.isInteger(i)&&i>=0&&i<s.records.length);if(!selected.length)return;const button=e.currentTarget;button.disabled=true;const original=button.textContent;button.textContent='正在逐张下载…';let success=0,failed=0;try{const items=selected.map(i=>({record:s.records[i],index:i})).filter(x=>x.record?.dataUrl);if(!items.length)throw new Error('所选记录中没有可下载的图片数据。');status('准备逐张下载 '+items.length+' 张图片；浏览器可能会询问是否允许多个文件下载。');for(let n=0;n<items.length;n++){const {record,index}=items[n];try{const response=await fetch(record.dataUrl);if(!response.ok)throw new Error('读取图片失败');const blob=await preparePngDownloadBlob(await response.blob());if(!blob.size)throw new Error('图片数据为空');const url=URL.createObjectURL(blob);const a=document.createElement('a');a.href=url;a.download='qinghui-'+(record.at||Date.now())+'.'+(blob.type.includes('jpeg')?'jpg':blob.type.includes('webp')?'webp':'png');a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),60000);success++;}catch(error){failed++;console.warn('[轻绘 Lite] 单张缓存下载失败',index,error);}if(n<items.length-1)await new Promise(resolve=>setTimeout(resolve,350));}status('逐张下载已发起：成功 '+success+' 张'+(failed?'，失败 '+failed+' 张':'')+'。'+(cfg().pngDownloadMode==='clean'?'清洗模式已启用。':'')+' 若 Edge 拦截了多个文件，请允许此页面的多个下载，或分批选择。');}catch(error){console.error('[轻绘 Lite] 缓存逐张下载失败',error);status('下载失败：'+(error?.message||String(error)));}finally{button.disabled=false;button.textContent=original;}});
 footer?.querySelector('[data-ql-bulk-delete]')?.addEventListener('click',e=>{e.preventDefault();e.stopPropagation();const selected=[...host.querySelectorAll('.ql-cache-tile.is-selected')].map(tile=>Number(tile.querySelector('[data-ql-detail]')?.dataset.qlDetail)).filter(Number.isInteger);if(!selected.length)return;if(!confirm('确定删除选中的 '+selected.length+' 张缓存图片？不会删除聊天消息中的图片。'))return;selected.sort((a,b)=>b-a).forEach(i=>{if(i>=0&&i<s.records.length)s.records.splice(i,1);});save();history();status('已删除所选缓存图片。');});
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
 if(prompts)prompts.innerHTML=(s.prompts||[]).map((p,i)=>({p,i})).filter(({p})=>!filterValue||String(p.category||'其他')===filterValue).map(({p,i})=>'<div class="ql-prompt-tile"><button type="button" class="ql-prompt-thumb" data-prompt-edit="'+i+'" aria-label="编辑 '+esc(p.name)+'">'+(p.image?'<img loading="lazy" src="'+esc(p.image)+'" alt="">':'<span>无预览图</span>')+'</button>'+(libraryEditMode?'<label class="ql-bulk-check"><input type="checkbox" data-prompt-select="'+i+'" '+(selectedPrompts.has(i)?'checked':'')+'>选择</label>':'')+'<strong>'+esc(p.name)+'</strong><small>'+esc(p.category||'其他')+'</small><div class="ql-prompt-tile-actions"><button class="menu_button" data-prompt-roll="'+i+'">应用并 Roll</button><button class="menu_button" data-prompt-edit="'+i+'">编辑</button><button class="menu_button" data-prompt-delete="'+i+'">删除</button></div></div>').join('')||'<p class="ql-muted">暂无符合条件的提示词</p>';
 if(chars)chars.innerHTML=(s.characters||[]).map((p,i)=>'<div class="ql-record ql-library-record">'+(libraryEditMode?'<label class="ql-bulk-check"><input type="checkbox" data-character-select="'+i+'" '+(selectedCharacters.has(i)?'checked':'')+'>选择</label>':'')+'<strong>'+esc(p.name||p.characterName||'未命名角色')+'</strong><p>'+esc(p.appearance)+'</p><small>'+esc(p.characterName?'已绑定：'+p.characterName:'尚未绑定角色卡')+'</small><div class="ql-row"><button class="menu_button" data-character-apply="'+i+'">追加生图词</button><button class="menu_button" data-character-edit="'+i+'">编辑</button><button class="menu_button" data-character-delete="'+i+'">删除词条</button></div></div>').join('')||'<p class="ql-muted">尚未保存角色词条</p>';
 if(presets){const batch=$('#ql-presets-batch');if(batch)batch.hidden=!presetBatchMode;presets.innerHTML=(s.presets||[]).map((p,i)=>'<div class="ql-record ql-preset-compact">'+(presetBatchMode?'<label class="ql-bulk-check"><input type="checkbox" data-preset-select="'+i+'" '+(selectedPresets.has(i)?'checked':'')+'>选择</label>':'')+'<div class="ql-preset-compact-info"><strong>'+esc(p.name||('画师串 '+(i+1)))+'</strong><p class="ql-muted">正向 '+(p.positive?'已设置':'空')+' · 负向 '+(p.negative?'已设置':'未设置')+'</p></div>'+(presetBatchMode?'':'<div class="ql-preset-compact-actions"><button type="button" class="menu_button" data-preset-apply="'+i+'">应用</button><button type="button" class="menu_button" data-preset-edit="'+i+'">编辑</button><button type="button" class="menu_button" data-preset-delete="'+i+'">删除</button></div>')+'</div>').join('')||'<p class="ql-muted">暂无画师串。</p>';presets.querySelectorAll('[data-preset-select]').forEach(b=>b.onchange=()=>{const i=Number(b.dataset.presetSelect);if(b.checked)selectedPresets.add(i);else selectedPresets.delete(i);});}
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
 prompts?.querySelectorAll('[data-prompt-select]').forEach(b=>b.onchange=()=>{const i=Number(b.dataset.promptSelect);if(b.checked)selectedPrompts.add(i);else selectedPrompts.delete(i);});
 prompts?.querySelectorAll('[data-prompt-roll]').forEach(b=>b.onclick=()=>{const p=s.prompts[+b.dataset.promptRoll];$('#ql-prompt').value=String(p.promptEn||p.prompt||'');read();$('#qinghui-lite-panel .ql-tab[data-page="generate"]')?.click();status('已应用提示词：'+p.name+'，正在 Roll 图。');$('#ql-generate').click();});
 prompts?.querySelectorAll('[data-prompt-edit]').forEach(b=>b.onclick=()=>{const p=s.prompts[+b.dataset.promptEdit];$('#ql-prompt-editor').hidden=false;$('#ql-prompt-add').hidden=true;$('#ql-prompt-name').value=p.name||'';const standard=['单人','双人','BG','BL','GL','其他'];if(standard.includes(p.category||'')){$('#ql-prompt-category').value=p.category;$('#ql-prompt-category-custom').value='';$('#ql-prompt-category-custom').hidden=true;}else{$('#ql-prompt-category').value='自定义';$('#ql-prompt-category-custom').value=p.category||'';$('#ql-prompt-category-custom').hidden=false;}$('#ql-library-prompt-zh').value=p.promptZh||'';$('#ql-library-prompt-en').value=p.promptEn||p.prompt||'';const imagePreview=$('#ql-library-image-preview');if(imagePreview){imagePreview.dataset.image=p.image||'';imagePreview.innerHTML=p.image?'<img src="'+esc(p.image)+'" alt="提示词预览图">':'<span class="ql-muted">尚未添加预览图</span>';}$('#ql-prompt-save').dataset.edit=String(+b.dataset.promptEdit);$('#ql-prompt-save').textContent='保存修改';$('#ql-prompt-editor').scrollIntoView({behavior:'smooth',block:'start'});});
  prompts?.querySelectorAll('[data-prompt-delete]').forEach(b=>b.onclick=()=>{s.prompts.splice(+b.dataset.promptDelete,1);save();renderLibrary();});
 chars?.querySelectorAll('[data-character-select]').forEach(b=>b.onchange=()=>{const i=Number(b.dataset.characterSelect);if(b.checked)selectedCharacters.add(i);else selectedCharacters.delete(i);});
  chars?.querySelectorAll('[data-character-apply]').forEach(b=>b.onclick=()=>{const p=s.characters[+b.dataset.characterApply];$('#ql-prompt').value=[$('#ql-prompt').value.trim(),p.appearance].filter(Boolean).join(', ');read();status('已追加角色外貌词：'+p.name);});
 chars?.querySelectorAll('[data-character-edit]').forEach(b=>b.onclick=()=>{const p=s.characters[+b.dataset.characterEdit],select=$('#ql-character-card');if(select)select.value=p.characterKey==null?'':String(p.characterKey);$('#ql-character-name').value=p.name||p.characterName||'';$('#ql-character-appearance').value=p.appearance||'';$('#ql-character-save').dataset.edit=String(+b.dataset.characterEdit);$('#ql-character-save').textContent='保存修改';$('#ql-character-status').textContent='正在编辑：'+(p.name||p.characterName||'未命名角色');$('#ql-character-name').scrollIntoView({behavior:'smooth',block:'center'});});
  chars?.querySelectorAll('[data-character-delete]').forEach(b=>b.onclick=()=>{s.characters.splice(+b.dataset.characterDelete,1);save();renderLibrary();});
 presets?.querySelectorAll('[data-preset-apply]').forEach(b=>b.onclick=()=>{const i=+b.dataset.presetApply,p=s.presets[i];s.activePresetIndex=i;renderActivePresets();save();status('已选中画师串：'+p.name+'，生成时会自动组合。');});
 const loadPresetForEdit=index=>{const p=s.presets[index];if(!p)return;$('#ql-preset-editor').hidden=false;$('#ql-preset-edit-select').value=String(index);$('#ql-preset-name').value=p.name||'';$('#ql-preset-positive').value=p.positive||'';$('#ql-preset-negative').value=p.negative||'';$('#ql-preset-save').dataset.edit=String(index);$('#ql-preset-save').textContent='保存修改';};
  presets?.querySelectorAll('[data-preset-edit]').forEach(b=>b.onclick=()=>loadPresetForEdit(+b.dataset.presetEdit));
  $('#ql-preset-edit-select').onchange=()=>{const value=$('#ql-preset-edit-select').value;if(value===''){delete $('#ql-preset-save').dataset.edit;$('#ql-preset-save').textContent='保存画师串组合';$('#ql-preset-name').value='';$('#ql-preset-positive').value='';$('#ql-preset-negative').value='';$('#ql-preset-editor').hidden=true;return;}loadPresetForEdit(Number(value));};
  $('#ql-preset-new').onclick=()=>{ $('#ql-preset-editor').hidden=false;$('#ql-preset-edit-select').value='';delete $('#ql-preset-save').dataset.edit;$('#ql-preset-save').textContent='保存画师串组合';$('#ql-preset-name').value='';$('#ql-preset-positive').value='';$('#ql-preset-negative').value='';$('#ql-preset-name').focus();};
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
    // 优先从当前 NAI 模型对应的 encodings 中取编码，不能把预览图或其他模型的编码直接发给接口。
    const modelForImport=cfg().naiModel||'nai-diffusion-4-5-full';
    const extracted=extractUsableVibe(stored,modelForImport);
    const storedImage=typeof stored.image==='string'?stored.image.trim():'';
    const normalizedImage=String(extracted?.image||storedImage).replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,'').replace(/-/g,'+').replace(/_/g,'/');
    // 只有有效的模型预编码才视为可用于生图的载荷。
    const hasPayload=/^[A-Za-z0-9+/]+={0,2}$/.test(normalizedImage)&&normalizedImage.length>160;
    // 编码只保留一份，避免 raw 再复制一份超大的 Base64 让酒馆设置膨胀。
    const rawMeta={identifier:stored.identifier||'',version:stored.version??1,type:stored.type||'image',informationExtracted:stored.informationExtracted??stored.information_extracted??1};
    images.push({vibeDataId:ref.vibeDataId,image:hasPayload?normalizedImage:'',previewImage,raw:rawMeta,strength:Number.isFinite(Number(ref.strength))?Number(ref.strength):0.6,informationExtracted:Number.isFinite(Number(extracted?.informationExtracted??stored.informationExtracted??stored.information_extracted))?Number(extracted?.informationExtracted??stored.informationExtracted??stored.information_extracted):1,identifier:stored.identifier||'',version:stored.version??1,type:stored.type||'image',hasPayload});
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
 // 迁移仅导入可用的画师串与 Vibe 编码；不导入其他文本预设或词库图片。
 const existing=cfg().presets||[];
 const seen=new Set(existing.map(item=>String(item.name||'')+'\\u0000'+String(item.positive||'')));
 const artists=[];
 for(const item of Array.isArray(candidate.artists)?candidate.artists:[]){
  if(!item?.positive)continue;
  const key=String(item.name||'')+'\\u0000'+String(item.positive||'');
  if(seen.has(key))continue;
  seen.add(key);artists.push(item);
 }
 const validEntries=item=>(Array.isArray(item?.entries)?item.entries:[]).filter(entry=>typeof entry?.image==='string'&&entry.image.length>160&&/^[A-Za-z0-9+/]+={0,2}$/.test(entry.image));
 const vibeSignature=item=>String(item?.name||'')+'\\u0000'+validEntries(item).map(entry=>String(entry.vibeDataId||'')+':'+entry.image.length+':'+entry.image.slice(0,24)+':'+entry.image.slice(-24)).join('|');
 const seenVibes=new Set((cfg().vibes||[]).map(vibeSignature));
 const vibes=[];
 for(const item of Array.isArray(candidate.vibes)?candidate.vibes:[]){
  const entries=validEntries(item);
  if(!entries.length)continue;
  const normalized={...item,entries,hasPayload:true};
  const key=vibeSignature(normalized);
  if(seenVibes.has(key))continue;
  seenVibes.add(key);vibes.push(normalized);
 }
 migrationCandidate={artists,prompts:[],vibes,warnings:Array.isArray(candidate.warnings)?candidate.warnings:[]};
 const host=$('#ql-migrate-preview');if(!host)return;
 const entryCount=vibes.reduce((sum,item)=>sum+item.entries.length,0);
 host.textContent=(artists.length?'检测到 '+artists.length+' 条尚未导入的画师串':'没有新的画师串')+'；'+(vibes.length?'检测到 '+vibes.length+' 组可迁移 Vibe（'+entryCount+' 条编码）':'没有新的可用 Vibe 编码')+'。';
 const button=$('#ql-migrate-import');
 const total=artists.length+vibes.length;
 button.disabled=!total;
 button.textContent=total?'导入 '+artists.length+' 条画师串 / '+vibes.length+' 组 Vibe':'没有可导入的新内容';
}
async function scanChatu8Settings(){
 const found=[];
 const looksRelevant=(value,depth=0,seen=new WeakSet())=>{
  if(!value||typeof value!=='object'||depth>6||seen.has(value))return false;
  seen.add(value);
  if(value.groups&&typeof value.groups==='object'&&value.vibeData&&typeof value.vibeData==='object')return true;
  if(value.presets&&typeof value.presets==='object'&&!Array.isArray(value.presets)&&Object.values(value.presets).some(p=>p&&typeof p==='object'&&('fixedPrompt' in p||'fixedPrompt_end' in p)))return true;
  for(const [k,v] of Object.entries(value)){
   if(/chatu8|智绘姬|zhihuiji/i.test(k)&&v&&typeof v==='object')return true;
   if(v&&typeof v==='object'&&looksRelevant(v,depth+1,seen))return true;
  }
  return false;
 };
 const add=(key,value)=>{if(value&&typeof value==='object')found.push({key,value});};
 // 扫描全部扩展设置，不再依赖智绘姬设置恰好位于顶层特定键名。
 for(const [key,value] of Object.entries(extension_settings||{})){
  if(key===EXT)continue;
  if(/chatu8|智绘姬|zhihuiji/i.test(key)||looksRelevant(value))add('extension_settings:'+key,value);
 }
 // 一些版本使用非标准 localStorage 键名，读取可解析的 JSON 后再按数据结构判断。
 try{
  for(let i=0;i<localStorage.length;i++){
   const key=localStorage.key(i);if(!key)continue;
   const raw=localStorage.getItem(key);if(!raw||raw.length>30*1024*1024)continue;
   try{const value=JSON.parse(raw);if(/chatu8|智绘姬|zhihuiji/i.test(key)||looksRelevant(value))add('localStorage:'+key,value);}catch{}
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
 if(host)host.textContent+='\n扫描到 '+found.length+' 个可能相关的数据源。若这里仍显示 0 组 Vibe，说明当前可读取的数据源没有包含智绘姬的 Vibe 编码；请改用智绘姬完整导出 JSON。';
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
 const s=cfg();let artists=0,vibeGroups=0,vibeEntries=0;
 for(const item of candidate.artists||[]){
  if(!item.positive)continue;
  if(s.presets.some(x=>x.name===item.name&&x.positive===item.positive))continue;
  s.presets.unshift({name:item.name,positive:item.positive,negative:item.negative||'',source:'st-chatu8',sourcePath:item.sourcePath,updatedAt:Date.now()});artists++;
 }
 s.presets=s.presets.slice(0,500);
 const validEntries=item=>(Array.isArray(item?.entries)?item.entries:[]).filter(entry=>typeof entry?.image==='string'&&entry.image.length>160&&/^[A-Za-z0-9+/]+={0,2}$/.test(entry.image));
 const signature=item=>String(item?.name||'')+'\\u0000'+validEntries(item).map(entry=>String(entry.vibeDataId||'')+':'+entry.image.length+':'+entry.image.slice(0,24)+':'+entry.image.slice(-24)).join('|');
 const known=new Set((s.vibes||[]).map(signature));
 for(const item of candidate.vibes||[]){
  const entries=validEntries(item);if(!entries.length)continue;
  const vibe={...item,name:String(item.name||'智绘姬 Vibe'),entries,hasPayload:true,source:item.source||'st-chatu8',importedAt:Date.now()};
  const key=signature(vibe);if(known.has(key))continue;
  known.add(key);s.vibes.push(vibe);vibeGroups++;vibeEntries+=entries.length;
 }
 s.vibes=s.vibes.slice(0,500);
 save();renderLibrary();renderActiveVibes();
 status('智绘姬迁移完成：新增 '+artists+' 条画师串、'+vibeGroups+' 组 Vibe（'+vibeEntries+' 条编码）。未迁移其他文本预设或词库图片。');
 $('#ql-migrate-import').disabled=true;
 $('#ql-migrate-import').textContent='已完成导入';
}

function init(){const root=$('#qinghui-lite-panel');if(!root||root.dataset.ready)return;root.dataset.ready='1';const s=cfg();$('#ql-provider').value=s.provider||'openai';$('#ql-endpoint').value=s.endpoint;$('#ql-key').value=s.apiKey;$('#ql-gpt-endpoint').value=s.endpoint||'https://api.openai.com/v1';$('#ql-gpt-key').value=s.apiKey||'';$('#ql-nai-key').value=s.naiApiKey||'';$('#ql-nai-third-endpoint').value=s.naiThirdEndpoint||'';$('#ql-nai-third-key').value=s.naiThirdKey||'';$('#ql-model').value=s.model;$('#ql-size').value=s.size;$('#ql-quality').value=s.quality;$('#ql-nai-model').value=s.naiModel||'nai-diffusion-4-5-full';$('#ql-nai-steps').value=s.naiSteps||28;$('#ql-nai-scale').value=s.naiScale||5;$('#ql-nai-width').value=s.naiWidth||832;$('#ql-nai-height').value=s.naiHeight||1216;$('#ql-nai-sampler').value=s.naiSampler||'k_euler_ancestral';$('#ql-nai-scheduler').value=s.naiScheduler||'karras';$('#ql-prompt').value=s.prompt;$('#ql-negative').value=s.negative;const toggleProvider=()=>{const nai=$('#ql-provider').value!=='openai';$('#ql-openai-settings').hidden=nai;$('#ql-nai-settings').hidden=!nai;};$('#ql-provider').onchange=toggleProvider;toggleProvider();$('#ql-fast-provider').value=s.provider||'openai';$('#ql-fast-model').value=s.model||'gpt-image-1';$('#ql-fast-size').value=s.size||'1024x1024';$('#ql-fast-quality').value=s.quality||'medium';$('#ql-fast-nai-model').value=s.naiModel||'nai-diffusion-4-5-full';$('#ql-fast-nai-steps').value=s.naiSteps||28;$('#ql-fast-nai-scale').value=s.naiScale||5;$('#ql-fast-nai-width').value=s.naiWidth||832;$('#ql-fast-nai-height').value=s.naiHeight||1216;$('#ql-fast-nai-sampler').value=s.naiSampler||'k_euler_ancestral';$('#ql-fast-nai-scheduler').value=s.naiScheduler||'karras';$('#ql-fast-nai-normalize').checked=s.naiNormalizeVibeStrengths!==false;const toggleFast=()=>{const nai=$('#ql-fast-provider').value!=='openai';$('#ql-fast-openai').hidden=nai;$('#ql-fast-nai').hidden=!nai;syncFastControls();$('#ql-provider').value=$('#ql-fast-provider').value;toggleProvider();};$('#ql-fast-provider').onchange=toggleFast;toggleFast();$('#ql-prompt').addEventListener('input',()=>{cfg().prompt=$('#ql-prompt').value;save();});$('#ql-active-preset').onchange=()=>{cfg().activePresetIndex=Number($('#ql-active-preset').value);save();};$('#ql-apply-preset').onclick=()=>{const i=Number($('#ql-active-preset').value),p=cfg().presets[i];if(!p)return;cfg().activePresetIndex=i;save();status('已选中画师串：'+p.name+'，生成时会自动组合。');};$('#ql-open-preset').onclick=()=>{root.querySelector('.ql-tab[data-page="library"]')?.click();root.querySelector('.ql-subtab[data-subpage="artists"]')?.click();};$('#ql-bind-character').onchange=()=>renderBindings();$('#ql-bind-save').onclick=()=>{const key=$('#ql-bind-character').value;if(!key){status('请先选择角色卡。');return;}const ctx=getContext()||{},ch=(ctx.characters||[])[Number(key)],name=ch?.name||ch?.avatar||('角色 '+key),binding={characterKey:String(key),characterName:name,presetIndex:Number($('#ql-bind-preset').value),vibeIndex:Number($('#ql-bind-vibe').value),updatedAt:Date.now()};const old=s.bindings.findIndex(x=>x.characterKey===binding.characterKey||x.characterName===name);if(old>=0)s.bindings[old]=binding;else s.bindings.push(binding);save();renderBindings();status('已保存角色绑定：'+name);};$('#ql-vibe-pick').onclick=()=>$('#ql-vibe-import-file').click();$('#ql-vibe-import-file').onchange=async e=>{const file=e.target.files?.[0];if(!file)return;pendingVibeImage=null;const ext=file.name.toLowerCase();if(file.type.startsWith('image/')){pendingVibeImage=file;$('#ql-vibe-name').value=$('#ql-vibe-name').value||file.name.replace(/\.[^.]+$/,'');$('#ql-vibe-status').textContent='已选择图片：'+file.name+'。点击编码开始处理；NovelAI 可能收取 Anlas。';return;}if(ext.endsWith('.json')||ext.endsWith('.json5')||ext.endsWith('.txt')||ext.endsWith('.naiv4vibe')||ext.endsWith('.naiv4vibebundle')){const naiModel=cfg().naiModel||'nai-diffusion-4-5-full';try{let data;try{data=JSON.parse(await file.text());}catch{const files=await readVibeArchiveJson(file);if(!files.length)throw new Error('无法从该文件中读取 JSON 资源；该 Vibe 文件可能使用了当前浏览器不支持的打包格式。');data=files;}const candidate=walkChatu8(data,file.name),added=[];for(const item of candidate.vibes){const rawSource=item.raw||item;const encoded=extractUsableVibe(rawSource,naiModel);const entries=Array.isArray(item.entries)?item.entries.map(x=>{const source=x.raw?{...x.raw,image:x.image||x.raw.image||''}:x;const extracted=extractUsableVibe(source,naiModel);const image=typeof x.image==='string'&&x.image.trim()?x.image.trim().replace(/^data:(?:application\/octet-stream|image\/[^;]+);base64,/i,'').replace(/\s+/g,''):extracted?.image||'';return {...x,image,raw:x.raw||undefined,strength:Number(x.strength??extracted?.strength??0.6),informationExtracted:Number(x.informationExtracted??extracted?.informationExtracted??1)};}):(encoded||(rawSource.identifier==='novelai-vibe-transfer'&&rawSource.encodings&&Object.keys(rawSource.encodings).length))?[...(encoded?[encoded]:[{image:typeof rawSource.image==='string'?rawSource.image:'',strength:Number(rawSource.importInfo?.strength??0.6),informationExtracted:1}]).map(entry=>({...entry,raw:(rawSource.identifier==='novelai-vibe-transfer'?(({image,thumbnail,...rest})=>rest)(rawSource):rawSource),image:typeof rawSource.image==='string'?rawSource.image:entry.image,strength:Number(rawSource.importInfo?.strength??entry.strength??0.6),informationExtracted:Number(entry.informationExtracted??1)}))]:[];const usableEntries=entries.filter(x=>typeof x.image==='string'&&x.image.length>160&&/^[A-Za-z0-9+/]+={0,2}$/.test(x.image));if(!usableEntries.length)continue;const hasPayload=true;s.vibes.push({...item,entries:usableEntries,hasPayload,importedAt:Date.now()});added.push(item.name);}if(!added.length)throw new Error('文件中没有识别到 Vibe 分组；可尝试“迁移”页导入智绘姬完整设置。');save();renderLibrary();renderActiveVibes();const usable=added.filter(name=>s.vibes.find(v=>v.name===name)?.hasPayload).length;$('#ql-vibe-status').textContent='已读取 '+added.length+' 组 Vibe，其中 '+usable+' 组含可识别的预编码资源。请检查各条参考状态；未识别编码的项目不会被当作可用 Vibe。';}catch(err){$('#ql-vibe-status').textContent='导入失败：'+(err?.message||String(err));}return;}$('#ql-vibe-status').textContent='此文件格式无法直接解析。请确认它是标准 .naiv4vibe / bundle 压缩包，或使用 JSON / 智绘姬组格式。';};$('#ql-vibe-encode').onclick=async()=>{if(!pendingVibeImage){$('#ql-vibe-status').textContent='请先选择 PNG、JPG 或 WebP 图片。';return;}const button=$('#ql-vibe-encode');button.disabled=true;$('#ql-vibe-status').textContent='正在请求酒馆 NovelAI Vibe 编码接口……';try{const dataUrl=await new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result));reader.onerror=()=>reject(new Error('无法读取图片'));reader.readAsDataURL(pendingVibeImage);});const image=dataUrl.replace(/^data:image\/[^;]+;base64,/,'');const response=await fetch('/api/novelai/encode-vibe',{method:'POST',headers:{'Content-Type':'application/json',...getRequestHeaders(window.token)},body:JSON.stringify({image,model:cfg().naiModel||'nai-diffusion-4-5-full',information_extracted:Number($('#ql-vibe-info').value)||1,crop_to_mask:false,focus_seed:-1,info_extract_seed:-1,mask:''})});if(!response.ok)throw new Error('酒馆未能完成 Vibe 编码（HTTP '+response.status+'）。当前酒馆版本可能没有暴露 encode-vibe 代理接口。');const buffer=await response.arrayBuffer();let binary='';for(const byte of new Uint8Array(buffer))binary+=String.fromCharCode(byte);const encoded=btoa(binary);const name=$('#ql-vibe-name').value.trim()||pendingVibeImage.name;s.vibes.push({name,source:'image-encode',hasPayload:true,entries:[{image:encoded,strength:0.6,informationExtracted:Number($('#ql-vibe-info').value)||1}],importedAt:Date.now()});save();renderLibrary();renderActiveVibes();$('#ql-vibe-status').textContent='编码完成并保存：'+name;pendingVibeImage=null;}catch(err){$('#ql-vibe-status').textContent='编码失败：'+(err?.message||String(err));}finally{button.disabled=false;}};try{renderActivePresets();renderBindings();history();renderLibrary();}catch(error){console.error('[轻绘 Lite] 初始化列表失败',error);status('列表初始化失败：'+(error?.message||String(error))+'。其他按钮仍可使用，请检查控制台。')}$('#ql-migrate-toggle').onclick=()=>{const panel=$('#ql-migrate-panel');panel.hidden=!panel.hidden;$('#ql-migrate-toggle').setAttribute('aria-expanded',String(!panel.hidden));$('#ql-migrate-toggle').textContent=panel.hidden?'迁移智绘姬':'收起迁移';if(!panel.hidden){$('#ql-migrate-preview').textContent='正在扫描当前酒馆的智绘姬设置…';panel.scrollIntoView({behavior:'smooth',block:'nearest'});scanChatu8Settings();}};$('#ql-migrate-scan').onclick=scanChatu8Settings;$('#ql-migrate-file-btn').onclick=()=>$('#ql-migrate-file').click();$('#ql-migrate-file').onchange=e=>{const f=e.target.files?.[0];if(f)readMigrationFile(f);};$('#ql-migrate-import').onclick=importChatu8Candidate;
$('#ql-save-gpt').onclick=()=>{const c=cfg();c.endpoint=$('#ql-gpt-endpoint').value.trim().replace(/\/$/,'');c.apiKey=$('#ql-gpt-key').value.trim();$('#ql-endpoint').value=c.endpoint;$('#ql-key').value=c.apiKey;save();status('GPT 接口设置已保存。');};$('#ql-save-nai').onclick=()=>{cfg().naiApiKey=$('#ql-nai-key').value.trim();save();status('NAI 官网 Key 已保存。');};$('#ql-save-nai-third').onclick=()=>{cfg().naiThirdEndpoint=$('#ql-nai-third-endpoint').value.trim().replace(/\/$/,'');cfg().naiThirdKey=$('#ql-nai-third-key').value.trim();save();status('NAI 第三方连接设置已保存。');};const legacySave=$('#ql-save');if(legacySave)legacySave.onclick=()=>{read();status('兼容设置已保存。');};$('#ql-png-download-mode').value=s.pngDownloadMode||'original';$('#ql-png-download-save').onclick=()=>{const mode=$('#ql-png-download-mode').value;cfg().pngDownloadMode=mode;save();$('#ql-png-download-status').textContent=mode==='clean'?'已保存：PNG 下载时会清洗元数据。':'已保存：PNG 下载时保留原始元数据。';};$('#ql-theme-preset').value=s.themePreset||'auto';$('#ql-theme-css').value=s.themeCss||'';applyTheme($('#ql-theme-preset').value,$('#ql-theme-css').value);$('#ql-theme-apply').onclick=()=>{const preset=$('#ql-theme-preset').value,css=$('#ql-theme-css').value;cfg().themePreset=preset;cfg().themeCss=css;save();applyTheme(preset,css);$('#ql-theme-status').textContent=preset==='auto'?'已恢复跟随酒馆主题。':preset==='custom'?'已应用自定义 CSS。':'已应用低饱和配色。';};$('#ql-theme-reset').onclick=()=>{$('#ql-theme-preset').value='auto';$('#ql-theme-css').value='';cfg().themePreset='auto';cfg().themeCss='';save();applyTheme('auto','');$('#ql-theme-status').textContent='已恢复自适配酒馆美化。';};$('#ql-theme-preset').onchange=()=>{if($('#ql-theme-preset').value!=='custom')$('#ql-theme-status').textContent='点击“应用配色”后生效。';};
$('#ql-generate').onclick=async()=>{
 if(busy)return;try{read();}catch(error){status('读取生图参数失败：'+(error?.message||String(error)));return;}const conf=cfg();
 if(!conf.prompt.trim()){status('请填写正向提示词。');return;}
 if(conf.provider==='openai'&&(!conf.endpoint||!conf.apiKey)){status('请填写 GPT 接口地址和 Key。');return;}if(conf.provider==='novelai'&&!conf.naiApiKey){status('请在接口设置中填写 NovelAI 官网 Key。');return;}if(conf.provider==='novelai-thirdparty'&&(!conf.naiThirdEndpoint||!conf.naiThirdKey)){status('请填写 NAI 第三方接口地址和 Key。');return;}
 busy=true;$('#ql-generate').disabled=true;$('#ql-result').replaceChildren();status('正在请求生图接口……');
 try{
  const activeIndex=Number(conf.activeVibeIndex??-1);const activeVibe=activeIndex>=0?conf.vibes[activeIndex]:null;const activePresetIndex=Number(conf.activePresetIndex??-1);const activePreset=activePresetIndex>=0?conf.presets[activePresetIndex]:null;const finalPrompt=[conf.prompt.trim(),activePreset?.positive].filter(Boolean).join(', ');const finalNegative=[conf.negative.trim(),activePreset?.negative].filter(Boolean).join(', ');const url=await requestImage(finalPrompt,finalNegative,activeVibe);
  const img=document.createElement('img');img.alt='轻绘生成结果';img.src=url;$('#ql-result').append(img);
  conf.records.unshift({at:Date.now(),prompt:finalPrompt,basePrompt:conf.prompt.trim(),negative:finalNegative,provider:conf.provider,model:conf.provider!=='openai'?conf.naiModel:conf.model,size:conf.provider!=='openai'?(conf.naiWidth+'x'+conf.naiHeight):conf.size,quality:conf.quality,dataUrl:url,preset:activePreset?{name:activePreset.name||'',positive:activePreset.positive||'',negative:activePreset.negative||'',index:activePresetIndex,source:activePreset.source||'local'}:null,vibe:activeVibe?{name:activeVibe.name||'',entries:(activeVibe.entries||[]).map(entry=>({strength:entry.strength??0.6,informationExtracted:entry.informationExtracted??1,identifier:entry.identifier||entry.raw?.identifier||'',type:entry.type||entry.raw?.type||'image'}))}:null,config:snapshotConfig(finalPrompt,finalNegative)});
  conf.records=conf.records.slice(0,100);save();history();status('生成完成。记录已保存在酒馆扩展设置中。');
 }catch(e){console.error('[轻绘 Lite] 生图失败',e);status('生成失败：'+(e?.message||String(e))+'。请检查接口地址、Key、模型名和网络连接。')}
 finally{busy=false;$('#ql-generate').disabled=false;}
}
$('#ql-prompt-category').onchange=()=>{$('#ql-prompt-category-custom').hidden=$('#ql-prompt-category').value!=='自定义';};
$('#ql-preset-batch-toggle').onclick=()=>{presetBatchMode=!presetBatchMode;selectedPresets.clear();$('#ql-preset-batch-toggle').textContent=presetBatchMode?'退出批量编辑':'批量编辑';renderLibrary();};
$('#ql-preset-export').onclick=()=>{const items=[...selectedPresets].sort((a,b)=>a-b).map(i=>cfg().presets[i]).filter(Boolean);if(!items.length){status('请先勾选要导出的画师串。');return;}downloadJson(items,'qinghui-artist-presets.json');};
$('#ql-preset-bulk-delete').onclick=()=>{const indexes=[...selectedPresets].filter(i=>cfg().presets[i]);if(!indexes.length){status('请先勾选要删除的画师串。');return;}if(!confirm('确定删除选中的 '+indexes.length+' 条画师串？'))return;const removed=indexes.sort((a,b)=>b-a);for(const i of removed){if(Number(cfg().activePresetIndex)===i)cfg().activePresetIndex=-1;else if(Number(cfg().activePresetIndex)>i)cfg().activePresetIndex=Number(cfg().activePresetIndex)-1;for(const binding of cfg().bindings){if(Number(binding.presetIndex)===i)binding.presetIndex=-1;else if(Number(binding.presetIndex)>i)binding.presetIndex=Number(binding.presetIndex)-1;}}cfg().presets=removed.reduce((arr,i)=>{arr.splice(i,1);return arr;},cfg().presets.slice());selectedPresets.clear();save();renderLibrary();renderActivePresets();renderBindings();status('已删除所选画师串。');};
$('#ql-prompt-add').onclick=()=>{delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';$('#ql-prompt-name').value='';$('#ql-library-prompt-zh').value='';$('#ql-library-prompt-en').value='';$('#ql-library-image-preview').dataset.image='';$('#ql-library-image-preview').innerHTML='<span class="ql-muted">尚未添加预览图</span>';$('#ql-library-image-file').value='';$('#ql-prompt-editor').hidden=false;$('#ql-prompt-add').hidden=true;$('#ql-prompt-editor').scrollIntoView({behavior:'smooth',block:'start'});};$('#ql-prompt-cancel').onclick=()=>{delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';$('#ql-prompt-editor').hidden=true;$('#ql-prompt-add').hidden=false;};$('#ql-prompt-filter').onchange=()=>renderLibrary();
$('#ql-library-edit-mode').onclick=()=>{libraryEditMode=!libraryEditMode;$('#ql-library-edit-mode').textContent=libraryEditMode?'退出编辑模式':'编辑模式';$('#ql-library-edit-hint').textContent=libraryEditMode?'勾选要处理的条目，再使用批量删除或导出。':'提示词可按分类筛选；开启编辑模式后可多选、批量删除或导出。';renderLibrary();};
$('#ql-prompt-export').onclick=()=>{const indexes=selectedPrompts.size?[...selectedPrompts]:[];if(!indexes.length){status('请先开启编辑模式并选择要导出的提示词。');return;}downloadJson(indexes.map(i=>cfg().prompts[i]).filter(Boolean),'qinghui-prompts.json');};
$('#ql-prompt-bulk-delete').onclick=()=>{const indexes=[...selectedPrompts].filter(i=>cfg().prompts[i]);if(!indexes.length){status('请先选择要删除的提示词。');return;}if(!confirm('确定批量删除选中的 '+indexes.length+' 条提示词？'))return;cfg().prompts=indexes.sort((a,b)=>b-a).reduce((arr,i)=>{arr.splice(i,1);return arr;},cfg().prompts.slice());selectedPrompts.clear();save();renderLibrary();status('已批量删除提示词。');};
$('#ql-character-export').onclick=()=>{const indexes=[...selectedCharacters].filter(i=>cfg().characters[i]);if(!indexes.length){status('请先开启编辑模式并选择要导出的角色。');return;}downloadJson(indexes.map(i=>cfg().characters[i]).filter(Boolean),'qinghui-characters.json');};
$('#ql-character-bulk-delete').onclick=()=>{const indexes=[...selectedCharacters].filter(i=>cfg().characters[i]);if(!indexes.length){status('请先选择要删除的角色。');return;}if(!confirm('确定批量删除选中的 '+indexes.length+' 个角色词条？'))return;cfg().characters=indexes.sort((a,b)=>b-a).reduce((arr,i)=>{arr.splice(i,1);return arr;},cfg().characters.slice());selectedCharacters.clear();save();renderLibrary();status('已批量删除角色词条。');};
$('#ql-library-image-file').onchange=e=>{const file=e.target.files?.[0];if(!file)return;if(!file.type.startsWith('image/')){status('请选择图片文件。');return;}const reader=new FileReader();reader.onload=()=>{const preview=$('#ql-library-image-preview');preview.dataset.image=String(reader.result||'');preview.innerHTML=preview.dataset.image?'<img src="'+esc(preview.dataset.image)+'" alt="提示词预览图">':'<span class="ql-muted">尚未添加预览图</span>';};reader.readAsDataURL(file);};
$('#ql-library-image-clear').onclick=()=>{const preview=$('#ql-library-image-preview');preview.dataset.image='';preview.innerHTML='<span class="ql-muted">尚未添加预览图</span>';$('#ql-library-image-file').value='';};
$('#ql-library-prompt-copy').onclick=async()=>{const field=$('#ql-library-prompt-en');const button=$('#ql-library-prompt-copy');const value=field?.value||'';if(!value.trim()){status('画面提示词为空，暂时没有内容可复制。');return;}try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(value);}else{const area=document.createElement('textarea');area.value=value;area.style.position='fixed';area.style.opacity='0';document.body.appendChild(area);area.select();const ok=document.execCommand('copy');area.remove();if(!ok)throw new Error('浏览器未允许复制');}button.classList.add('is-copied');button.title='已复制画面提示词';button.setAttribute('aria-label','已复制画面提示词');status('已复制画面提示词。');setTimeout(()=>{button.classList.remove('is-copied');button.title='复制画面提示词';button.setAttribute('aria-label','复制画面提示词');},1300);}catch(error){status('复制失败：请长按画面提示词手动复制。');}};
$('#ql-prompt-save').onclick=()=>{const name=$('#ql-prompt-name').value.trim(),promptZh=$('#ql-library-prompt-zh').value.trim(),promptEn=$('#ql-library-prompt-en').value.trim();if(!name||(!promptZh&&!promptEn)){status('请填写名称，并至少填写中文或英文提示词。');return;}const selectedCategory=$('#ql-prompt-category').value;const customCategory=$('#ql-prompt-category-custom').value.trim();const category=selectedCategory==='自定义'?(customCategory||'其他'):selectedCategory;const item={name,category,promptZh,promptEn,image:$('#ql-library-image-preview')?.dataset.image||'',updatedAt:Date.now()};const edit=$('#ql-prompt-save').dataset.edit;if(edit!==undefined){cfg().prompts[Number(edit)]={...cfg().prompts[Number(edit)],...item};delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';}else cfg().prompts.unshift(item);cfg().prompts=cfg().prompts.slice(0,200);save();$('#ql-prompt-editor').hidden=true;$('#ql-prompt-add').hidden=false;$('#ql-prompt-name').value='';$('#ql-library-prompt-zh').value='';$('#ql-library-prompt-en').value='';$('#ql-library-image-preview').dataset.image='';$('#ql-library-image-preview').innerHTML='<span class="ql-muted">尚未添加预览图</span>';$('#ql-library-image-file').value='';delete $('#ql-prompt-save').dataset.edit;$('#ql-prompt-save').textContent='保存提示词';renderLibrary();status('提示词已保存。');};
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
   launch.title='打开轻绘 Lite 生图工作区';
   launch.innerHTML='<i class="fa-solid fa-palette"></i><span>轻绘 Lite</span>';
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


// 独立入口兜底：菜单会被酒馆重建，因此统一监听 DOM 变化并把入口放回原生魔法棒菜单。
jQuery(()=>{
 const ensureQinghuiLauncher=()=>{
  const menu=document.querySelector('#extensionsMenu');
  if(!menu)return false;
  let launch=menu.querySelector('#ql-chat-launch');
  if(!launch){
   // 只复用菜单内节点；避免误拿到已脱离菜单的旧节点。
   launch=document.createElement('div');
   launch.id='ql-chat-launch';
   launch.className='list-group-item flex-container flexGap5';
   launch.setAttribute('role','button');
   launch.setAttribute('tabindex','0');
   launch.title='打开轻绘 Lite 生图工作区';
   launch.innerHTML='<i class="fa-solid fa-palette"></i><span>轻绘 Lite</span>';
   launch.addEventListener('click',()=>{
    const overlay=document.querySelector('#ql-overlay');
    if(!overlay){console.warn('[轻绘 Lite] 找不到工作区面板，请检查扩展是否完整加载');return;}
    overlay.hidden=false;
    document.body.classList.add('ql-modal-open');
   });
   launch.addEventListener('keydown',e=>{
    if(e.key==='Enter'||e.key===' '){e.preventDefault();launch.click();}
   });
  }
  if(launch.parentElement!==menu)menu.append(launch);
  return true;
 };
 ensureQinghuiLauncher();
 // 观察整个页面，菜单被清空、替换或重新创建时都会重新挂载入口。
 if(!document.documentElement.dataset.qlLauncherObserver){
  document.documentElement.dataset.qlLauncherObserver='1';
  const observer=new MutationObserver(()=>ensureQinghuiLauncher());
  observer.observe(document.documentElement,{childList:true,subtree:true});
 }
 // 菜单可能在扩展初始化之后才打开；点击页面时再做一次幂等检查作为兜底。
 document.addEventListener('click',()=>{ensureQinghuiLauncher();},true);
});
