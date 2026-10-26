/** 正文生图区块：只处理正文标记抓取、触发与图片恢复。 */
let parseImageMarkers, makeTriggerId, triggerRegistry, cfg, getContext, requestWithActiveSettings, addMessageImage, storeChatRecord, applyChatAlbumButtonStyle, applyChatTheme;

export function initBodyModule(dependencies) {
  ({parseImageMarkers, makeTriggerId, triggerRegistry, cfg, getContext, requestWithActiveSettings, addMessageImage, storeChatRecord, applyChatAlbumButtonStyle, applyChatTheme} = dependencies);
}

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
  button.type='button';button.className='menu_button ql-inline-image-trigger';button.textContent='定格此刻';button.title='定格此刻：生成图片并收录到当前消息';
  button.dataset.qlTrigger=entry?.taskKey||('marker-'+ordinal);button.dataset.qlPrompt=prompt;applyChatAlbumButtonStyle(button,cfg().chatAlbumStyle||'classic');applyChatTheme(button);
  button.addEventListener('click',()=>runInlineImageTrigger(button,entry||{prompt,taskKey:button.dataset.qlTrigger,messageIndex:-1}));
  const buttonWrap=document.createElement('span');buttonWrap.className='ql-inline-image-trigger-wrap';buttonWrap.append(button);fragment.append(buttonWrap);ordinal++;last=re.lastIndex;
 }
 fragment.append(document.createTextNode(value.slice(last)));
 node.parentNode?.replaceChild(fragment,node);
}
}

async function runInlineImageTrigger(button,entry){
if(!button||button.dataset.qlBusy==='1'||button.dataset.qlDone==='1')return;
const prompt=String(entry?.prompt||button.dataset.qlPrompt||'').trim();
const recordTaskKey=String(entry?.taskKey||button.dataset.qlTrigger||'');
if(!prompt){alert('没有读取到 image### 标记中的提示词，请检查正文标记是否完整。');return;}
if(!recordTaskKey){alert('没有取得这条影像的任务标识，请刷新聊天后重试。');return;}
// 每次用户主动点击都创建独立请求任务，避免旧的 running/pending 状态把按钮静默拦截。
const requestTaskKey=recordTaskKey+':manual:'+Date.now()+':'+Math.random().toString(36).slice(2,8);
const accepted=triggerRegistry.begin(requestTaskKey,{prompt,source:'chat-button',messageIndex:entry?.messageIndex,markerOrdinal:entry?.markerOrdinal});
if(!accepted.accepted){alert('这次生图任务未能启动，请再点一次。');return;}
triggerRegistry.markRunning(requestTaskKey);
button.dataset.qlBusy='1';button.disabled=true;button.textContent='生成中…';
const statusNode=document.createElement('span');statusNode.className='ql-chat-image-status';statusNode.textContent='正在提交生图请求…';button.after(statusNode);
try{
 const context=getContext();
 const meta={messageIndex:entry?.messageIndex,character:context?.name||null,chatId:context?.chatId||null};
 const url=await requestWithActiveSettings(prompt);
 const host=button.closest('.mes_text')||(Number.isInteger(Number(entry?.messageIndex))?document.querySelector('.mes[mesid="'+entry.messageIndex+'"] .mes_text'):null);
 if(!host)throw new Error('找不到原消息正文，图片已生成但无法插入原消息。');
 const card=addMessageImage(host,url,prompt,recordTaskKey,meta);
 if(card)button.after(card);
 button.remove();statusNode.remove();
 storeChatRecord(url,prompt,recordTaskKey,meta);
 triggerRegistry.markSucceeded(requestTaskKey,requestTaskKey+':candidate:'+Date.now());
}catch(error){
 try{triggerRegistry.markFailed(requestTaskKey,error?.message||String(error));}catch{}
 button.dataset.qlBusy='0';button.disabled=false;button.textContent='重试生图';
 statusNode.remove();
 console.error('[拾帧] 定格此刻提交失败',error);
 alert('拾帧生图失败：'+(error?.message||String(error)));
}finally{if(button.isConnected)button.dataset.qlBusy='0';}
}
async function processLatestAssistantMessage(){
if(cfg().enabled===false)return;
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
 const host=document.querySelector('.mes[mesid="'+messageIndex+'"] .mes_text');
 if(!host)continue;
 // 编辑消息时不改写原始正文；编辑器关闭后由延迟重扫恢复按钮。
 const messageElement=host.closest('.mes');
 if(messageElement?.querySelector('textarea:not(.ql-chat-image-tag-input), [contenteditable="true"]'))continue;
 const entries=found.map((marker,markerOrdinal)=>{
  const taskKey=makeTriggerId({chatId:context.chatId||'chat',messageId:String(messageIndex)+':'+String(message.swipe_id??0),markerIndex:markerOrdinal});
  return {...marker,taskKey,messageIndex,markerOrdinal};
 });
 // 先替换 marker；随后从扩展设置中恢复已生成的图片，避免酒馆编辑/保存消息重建正文时丢图。
 hideMarkersInTextNode(host,entries);
 for(const entry of entries){
  // 只有正文中真正存在的 marker 按钮才是可靠锚点。
  // 酒馆刷新时可能先恢复到一份尚未完成渲染的正文；此时不能把图片/按钮追加到末尾。
  const markerButton=host.querySelector('[data-ql-trigger="'+CSS.escape(entry.taskKey)+'"]');
  if(!markerButton){
   const waitingCard=[...host.querySelectorAll('.ql-chat-image')].find(el=>el.dataset.qlTask===entry.taskKey);
   if(waitingCard){
    // 没有 marker 锚点时仍要恢复旧卡片的事件监听；以旧卡片的下一个兄弟节点作为锚点，
    // 让新卡片原位替换旧 HTML，不把它追加到消息末尾，也不需要用户先点小铅笔。
    const nextSibling=waitingCard.nextSibling;
    const records=(cfg().records||[]).filter(item=>item&&item.dataUrl&&!item.hiddenInChat&&item.taskKey===entry.taskKey&&Number(item.messageIndex)===messageIndex&&(!item.chatId||item.chatId===(context.chatId||''))&&(item.source||'chat')==='chat').sort((a,b)=>(Number(a.at)||0)-(Number(b.at)||0));
    if(!waitingCard._qlRender&&records.length){
     const latest=records[records.length-1];
     addMessageImage(host,latest.dataUrl,latest.basePrompt||entry.prompt,entry.taskKey,{messageIndex,source:'chat',character:latest.character||context.name||null,chatId:context.chatId||null},nextSibling);
     const rebuilt=[...host.querySelectorAll('.ql-chat-image')].find(el=>el.dataset.qlTask===entry.taskKey);
     if(rebuilt){rebuilt.hidden=false;delete rebuilt.dataset.qlWaitingForAnchor;}
    }else{
     waitingCard.hidden=true;waitingCard.dataset.qlWaitingForAnchor='1';
    }
   }
   continue;
  }
  const savedRecords=(cfg().records||[]).filter(item=>item&&item.dataUrl&&!item.hiddenInChat&&item.taskKey===entry.taskKey&&Number(item.messageIndex)===messageIndex&&(!item.chatId||item.chatId===(context.chatId||''))&&(item.source||'chat')==='chat').sort((a,b)=>(Number(a.at)||0)-(Number(b.at)||0));
  if(savedRecords.length){
   const latest=savedRecords[savedRecords.length-1];
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
  button.textContent='定格此刻';
  button.title='点击生成图片并收录到当前消息（包含当前画师串预设）';
  button.dataset.qlTrigger=entry.taskKey;button.dataset.qlPrompt=entry.prompt;applyChatAlbumButtonStyle(button,cfg().chatAlbumStyle||'classic');applyChatTheme(button);
  button.addEventListener('click',()=>runInlineImageTrigger(button,entry));
  const buttonWrap=document.createElement('span');buttonWrap.className='ql-inline-image-trigger-wrap';buttonWrap.append(button);host.append(buttonWrap);
 }
 // 即使编辑消息后原始 image### 标记被酒馆改写/截断，也从已保存的记录恢复图片卡片。
 // 这一步同时重建刷新后只剩 HTML、丢失事件监听的旧卡片。
 const restoredKeys=new Set(entries.map(entry=>entry.taskKey));
 const savedForMessage=(cfg().records||[])
  .filter(item=>item&&item.dataUrl&&!item.hiddenInChat&&Number(item.messageIndex)===messageIndex&&(!item.chatId||item.chatId===(context.chatId||''))&&(item.source||'chat')==='chat'&&item.taskKey)
  .sort((a,b)=>(Number(a.at)||0)-(Number(b.at)||0));
 for(const record of savedForMessage){
  // 当前消息仍包含 image### 标记时，不能把未匹配到锚点的记录作为兜底追加到正文末尾。
  // 等正文锚点可用后，由上面的定点恢复分支重新放回原位。
  if(entries.length)continue;
  if(restoredKeys.has(record.taskKey))continue;
  restoredKeys.add(record.taskKey);
  addMessageImage(host,record.dataUrl,record.basePrompt||record.prompt||'',record.taskKey,{
   messageIndex,source:'chat',character:record.character||context.name||null,chatId:context.chatId||null
  });
 }
}
}

export { processLatestAssistantMessage, runInlineImageTrigger };
