/** 状态栏区块：沿用基准版本原逻辑，仅从 index.js 移出，方便单独定位。 */
let cfg, getContext, triggerRegistry, requestWithActiveSettings, storeChatRecord, saveCleanImage;

export function initStatusbarModule(dependencies) {
  ({cfg, getContext, triggerRegistry, requestWithActiveSettings, storeChatRecord, saveCleanImage} = dependencies);
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
 // 酒馆刷新后可能只留下卡片 HTML；HTML 不会保留事件监听和轮播状态，必须重建。
 if(!card||card.dataset.qlTask!==taskKey||!card._qlRender){
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
  const actionBar=document.createElement('div');actionBar.className='ql-statusbar-action-bar';actionBar.style.cssText='position:absolute!important;top:7px!important;right:7px!important;left:auto!important;bottom:auto!important;transform:none!important;display:flex!important;align-items:center!important;justify-content:center!important;gap:5px!important;width:max-content!important;max-width:96%!important;z-index:2147483647!important;pointer-events:auto!important;';
  for(const button of [favorite,remove]){button.style.cssText+=';position:static!important;top:auto!important;right:auto!important;left:auto!important;bottom:auto!important;display:flex!important;visibility:visible!important;opacity:1!important;pointer-events:auto!important;flex:0 0 27px!important;width:27px!important;height:27px!important;min-width:27px!important;min-height:27px!important;padding:5px!important;border:1px solid rgba(255,255,255,.72)!important;border-radius:8px!important;background:rgba(20,16,22,.68)!important;color:#fff!important;touch-action:manipulation!important;';}
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
   // 触屏设备的 touchend 后也会合成 click；不能在第一次轻触时立刻盖上控制层，
   // 否则第二次轻触会落在控制按钮上，被排除在双击重 Roll 之外。
   if('ontouchstart' in window)return;
   showControlsBriefly();
  });
  card.addEventListener('dblclick',e=>{e.preventDefault();e.stopPropagation();reroll();});
  img.addEventListener('contextmenu',e=>{e.preventDefault();saveCleanImage(img.src,'qinghui-'+Date.now()+'.'+(cfg().downloadFormat==='jpg'?'jpg':'png'));});
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
 if(cfg().enabled===false)return;
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

export { observeStatusbarFrames, processStatusbarFrames };
