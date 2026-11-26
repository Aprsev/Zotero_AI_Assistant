import { BasicTool } from 'zotero-plugin-toolkit';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';
import { questionContext } from './question-context';
import { formatAnswerMarkdown } from './answer-format';
import panelCSS from '../addon/content/panel.css';

declare const Zotero: any;
declare const Services: any;
declare const IOUtils: any;
declare const PathUtils: any;
const ID = 'ai-literature-assistant@local';
const PREFIX = 'extensions.zotero.aiLiterature.';
const PROVIDER_DEFAULTS = {
  openai: { apiURL: 'https://api.openai.com/v1/chat/completions', model: 'gpt-4o-mini' },
  deepseek: { apiURL: 'https://api.deepseek.com/chat/completions', model: 'deepseek-flash' },
};
const toolkit = new BasicTool();
let sectionID = '';
let popupHandler: any;
let toolbarHandler: any;
let root = '';
const pending = new Map<string,string[]>();
const pendingQuestion = new Map<string,string>();
const active = new Map<string,HTMLElement>();
const fullTextCache = new Map<string,string>();

function pref(key:string):any { return Services.prefs.getCharPref(PREFIX+key, ''); }
function setting(key:string):string { return String(pref(key) || ''); }
function parent(item:any):any { return item?.isAttachment?.() ? Zotero.Items.get(item.parentID) : item; }
function key(item:any):string { return `${item.libraryID}:${item.key}`; }
function error(e:unknown):string { return e instanceof Error ? e.message : String(e); }

// 参考 zotero-ai-assistant：每篇文献的对话及报告各用一个 JSON 附件持久化。
async function attachment(item:any, kind:'ai_summary'|'ai_conversation'):Promise<any> {
  for (const id of item.getAttachments()) {
    const a = Zotero.Items.get(id);
    if (a?.getField('title') === `AI Literature ${kind}.json`) return a;
  }
  return null;
}
async function readJSON(item:any, kind:'ai_summary'|'ai_conversation'):Promise<any> {
  const a = await attachment(item,kind);
  if (!a) return null;
  try { return JSON.parse(await Zotero.File.getContentsAsync(a.getFilePath())); } catch { return null; }
}
async function writeJSON(item:any, kind:'ai_summary'|'ai_conversation', value:any):Promise<void> {
  const old = await attachment(item,kind);
  const file = PathUtils.join(PathUtils.tempDir, `${kind}-${item.key}-${Date.now()}.json`);
  await IOUtils.writeUTF8(file,JSON.stringify(value,null,2));
  try {
    if (old) { await IOUtils.writeUTF8(old.getFilePath(),JSON.stringify(value,null,2)); return; }
    await Zotero.Attachments.importFromFile({file,parentItemID:item.id,title:`AI Literature ${kind}.json`,contentType:'application/json'});
  } finally { await IOUtils.remove(file).catch(()=>{}); }
}
function pickText(text:string, max:number):string {
  if (text.length<=max) return text;
  const sections = ['abstract','introduction','method','experiment','result','conclusion'];
  const chunks = sections.map(s=>{const re=new RegExp(`(?:^|\\n)\\s*(?:\\d+[. ]+)?${s}[^\\n]*\\n`,'im');const m=re.exec(text);return m?text.slice(m.index,m.index+Math.floor(max/sections.length)):'';}).filter(Boolean);
  return (chunks.length?chunks.join('\n\n'):text).slice(0,max);
}
async function pdfText(item:any):Promise<string> {
  const cached=fullTextCache.get(key(item));if(cached)return cached;
  for (const id of item.getAttachments()) {
    const a=Zotero.Items.get(id);
    if (a?.attachmentContentType==='application/pdf') {
      const result=await Zotero.PDFWorker.getFullText(a.id);
      if (result?.text){fullTextCache.set(key(item),result.text);return result.text;}
    }
  }
  throw new Error('此条目没有可提取文本的 PDF 附件');
}
const names:Record<string,string>={cv:'计算机视觉',llm:'大语言模型',llm_app:'大语言模型应用',neuro:'神经科学'};
function domain(item:any):string {
  const selected=setting('domain'); if(names[selected]) return names[selected];
  const t=`${item.getField('title')} ${item.getField('abstractNote')}`.toLowerCase();
  if (/neuro|brain|neural recording|fmri|eeg/.test(t)) return names.neuro;
  if (/vision|image|video|detection|segmentation/.test(t)) return names.cv;
  if (/agent|rag|retrieval.augmented|prompt engineering/.test(t)) return names.llm_app;
  return names.llm;
}
function summaryPrompt(item:any, full:string):string {return `你是一个${domain(item)}领域的资深研究者。请阅读以下论文内容，生成一份结构化的中文总结报告，使用 Markdown 格式输出。\n\n要求：\n1. **一句话概括**：用一句话说明这篇论文做了什么、解决了什么问题。\n2. **核心贡献**（3-5 条）：区分“方法创新”与“实验发现”。\n3. **方法要点**：针对${domain(item)}领域，提取关键技术细节（网络架构/训练策略/实验范式/数据采集方式等，按领域自动适配）。\n4. **关键结果**：列出最重要的 2-3 个量化结果或定性发现。\n5. **局限与启示**：作者承认的局限，以及对后续研究的启发。\n6. **关联概念**：列出 3-5 个核心术语/方法名。\n\n论文内容：\n${full}`;}
function questionPrompt(item:any,selected:string,question:string,web:string,context:string):string {return `你是一个学术阅读助手。用户正在阅读一篇论文，可能直接提问，也可能划选了片段。请基于提供的论文证据回答。\n\n【论文标题】${item.getField('title')}\n【选中片段】${selected||'无'}\n【论文上下文（含相关图注及附近文字）】${context}\n【联网检索结果】${web||'未启用联网，仅基于文献内容回答'}\n【用户问题】${question}\n\n回答要求：\n1. 优先依据论文正文、图注和选中片段直接回答，并说明依据。没有划词时也要理解问题。\n2. 用户询问 Fig./Figure/图/表时，先解释图注和正文对该图表的描述；如果仅有文字、无法看到图像本身，不要臆测视觉细节。\n3. 若联网结果可用，可补充外部知识并标明来源；若与文献冲突，要指出。\n4. 输出易读的 Markdown：先用一小段直接回答，再用 2-4 条短要点解释依据。每段最多两句话；段落之间留空行。不要把所有内容写成一整段。通常控制在 300-500 字内。`;}

async function search(item:any, selected:string, question:string):Promise<string> {
  const type=setting('searchType'), apiKey=setting('searchKey');
  if(type==='off'||!apiKey) return '';
  const q=`${item.getField('title')} ${selected.slice(0,50)} ${question}`;
  try {
    let url=setting('searchURL'), body:any, headers:any={'Content-Type':'application/json'};
    if(type==='tavily') {url=url||'https://api.tavily.com/search';body={api_key:apiKey,query:q,max_results:5};}
    else if(type==='serper') {url=url||'https://google.serper.dev/search';headers['X-API-KEY']=apiKey;body={q,num:5};}
    else {if(!url)return '';headers.Authorization=`Bearer ${apiKey}`;body={query:q,count:5};}
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body)});
    if(!response.ok) throw new Error(String(response.status));
    const data=await response.json();
    const rows=(data.results||data.organic||data.items||[]).slice(0,5);
    return rows.map((r:any,i:number)=>`${i+1}. ${r.title||''} — ${r.content||r.snippet||r.description||''} (${r.url||r.link||''})`).join('\n');
  } catch(e) { Zotero.debug(`AI Literature search degraded: ${error(e)}`); return ''; }
}
async function llm(prompt:string,onDelta:(s:string)=>void):Promise<string> {
  const provider=setting('provider');
  const configuredURL=setting('apiURL');
  const url=provider==='deepseek' && (!configuredURL || configuredURL==='https://api.openai.com/v1/chat/completions')
    ? 'https://api.deepseek.com/chat/completions' : configuredURL;
  const configuredModel=setting('model');
  const model=provider==='deepseek' && (!configuredModel || configuredModel==='gpt-4o-mini')
    ? 'deepseek-flash' : configuredModel;
  const apiKey=setting('apiKey');
  if(!url||!apiKey) throw new Error('请先在设置中填写 LLM API URL 和 Key');
  const response=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${apiKey}`},body:JSON.stringify({model,messages:[{role:'user',content:prompt}],stream:true})});
  if(!response.ok) throw new Error(`LLM API ${response.status}: ${(await response.text()).slice(0,200)}`);
  if(!response.body) throw new Error('LLM API 没有返回响应流');
  // 参考 zotero-ai-assistant 的 SSE 增量拼接；逐行处理跨 chunk 的 data 事件。
  const reader=response.body.getReader(), decoder=new TextDecoder(); let buffer='',out='';
  while(true){const {done,value}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});let pos;
    while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos).trim();buffer=buffer.slice(pos+1);if(!line.startsWith('data:'))continue;const payload=line.slice(5).trim();if(payload==='[DONE]')continue;
      try {const data=JSON.parse(payload);const delta=data.choices?.[0]?.delta?.content||'';out+=delta;onDelta(out);}catch{}
    }
  }
  if(!out) throw new Error('LLM 返回了空内容'); return out;
}
function renderMD(target:HTMLElement,md:string):void {
  const doc=target.ownerDocument;
  const html=DOMPurify(doc.defaultView as any).sanitize(marked.parse(md,{async:false}) as string,{ADD_TAGS:['math']});
  target.innerHTML=html;
  // 参考 AI-Butler 的 Markdown 与 KaTeX 侧栏展示思路；公式只处理文本节点。
  const walker=doc.createTreeWalker(target,doc.defaultView?.NodeFilter?.SHOW_TEXT ?? 4);const nodes:Text[]=[];
  while(walker.nextNode())nodes.push(walker.currentNode as Text);
  for(const node of nodes){if(node.parentElement?.closest('code,pre'))continue;const value=node.nodeValue||'';if(!/\$[^$]+\$/.test(value))continue;
    const span=doc.createElement('span');let last=0;const re=/\$([^$]+)\$/g;let match:RegExpExecArray|null;
    while((match=re.exec(value))){span.append(doc.createTextNode(value.slice(last,match.index)));const formula=doc.createElement('span');try{formula.innerHTML=katex.renderToString(match[1],{throwOnError:false});}catch{formula.textContent=match[0];}span.append(formula);last=re.lastIndex;}
    span.append(doc.createTextNode(value.slice(last)));node.replaceWith(span);
  }
}
function button(doc:Document,label:string,action:()=>void):HTMLButtonElement {const b=doc.createElement('button');b.textContent=label;b.addEventListener('click',action);return b;}
function shortError(e:unknown):string {const message=error(e).split('[QUERY:')[0].trim();return message.length>180?message.slice(0,180)+'…':message;}
function openWindow(md:string):void {const win=Services.ww.openWindow(null,root+'content/report.xhtml','ai-literature-report','chrome,resizable,centerscreen,width=900,height=750',null);win.addEventListener('load',()=>{const d=win.document;const content=d.getElementById('report') as HTMLElement;renderMD(content,md);}, {once:true});}
async function renderSection(body:HTMLElement, raw:any):Promise<void> {
  const item=parent(raw);body.replaceChildren();if(!item||!item.isRegularItem?.())return;
  const doc=body.ownerDocument, wrap=doc.createElement('div');wrap.className='ai-literature';body.append(wrap);
  const css=doc.createElementNS('http://www.w3.org/1999/xhtml','style');css.textContent=panelCSS;wrap.prepend(css);
  const header=doc.createElement('div');header.className='ai-header';wrap.append(header);
  const brand=doc.createElement('div');brand.className='ai-brand';brand.textContent='✦';header.append(brand);
  const heading=doc.createElement('div');heading.className='ai-heading';header.append(heading);
  const title=doc.createElement('strong');title.textContent='AI 文献助手';heading.append(title);
  const subtitle=doc.createElement('span');subtitle.textContent='与你一起阅读这篇论文';heading.append(subtitle);
  const tabs=doc.createElement('div');tabs.className='ai-tabs';wrap.append(tabs);
  const summaryTab=button(doc,'文献总结',()=>showTab('summary'));summaryTab.dataset.aiTab='summary';tabs.append(summaryTab);
  const chatTab=button(doc,'问答',()=>showTab('chat'));chatTab.dataset.aiTab='chat';tabs.append(chatTab);
  const summary=doc.createElement('section');summary.className='ai-summary-panel';wrap.append(summary);
  const actions=doc.createElement('div');actions.className='ai-summary-actions';summary.append(actions);
  const report=doc.createElement('article');report.className='ai-report';summary.append(report);
  const chat=doc.createElement('section');chat.className='ai-chat';wrap.append(chat);
  function showTab(tab:'summary'|'chat'):void {summary.hidden=tab!=='summary';chat.hidden=tab!=='chat';summaryTab.classList.toggle('is-active',tab==='summary');chatTab.classList.toggle('is-active',tab==='chat');}
  function showEmpty(titleText:string,detail:string,kind='empty'):void {report.replaceChildren();const card=doc.createElement('div');card.className=`ai-state ai-state-${kind}`;const icon=doc.createElement('div');icon.className='ai-state-icon';icon.textContent=kind==='error'?'!':'✦';const heading=doc.createElement('strong');heading.textContent=titleText;const note=doc.createElement('p');note.textContent=detail;card.append(icon,heading,note);report.append(card);}
  const cached=await readJSON(item,'ai_summary');let md=cached?.ai_summary||'';
  if(md)renderMD(report,md);else showEmpty('从这篇论文开始','生成结构化摘要，快速了解贡献、方法和结果。');
  const generate=button(doc,md?'重新生成':'生成总结',async()=>{showEmpty('正在读取论文','正在提取 PDF 文本，请稍候。','loading');try{const full=pickText(await pdfText(item),Math.max(1000,Number(Services.prefs.getIntPref(PREFIX+'maxChars',30000))));showEmpty('正在生成总结','模型正在整理这篇论文。','loading');md=await llm(summaryPrompt(item,full),s=>renderMD(report,s));await writeJSON(item,'ai_summary',{ai_summary:md,updated_at:new Date().toISOString()});generate.textContent='重新生成';}catch(e){Zotero.logError(e);showEmpty('暂时无法生成',shortError(e),'error');}});generate.className='ai-primary';actions.append(generate);
  const popout=button(doc,'↗',()=>{if(md)openWindow(md);});popout.className='ai-icon-button';popout.title='在新窗口打开报告';actions.append(popout);
  const status=doc.createElement('div');status.className='ai-status';status.textContent=setting('searchType')==='off'||!setting('searchKey')?'○ 仅文献':'● 已联网';chat.append(status);
  const messages=doc.createElement('div');messages.className='ai-messages';chat.append(messages);
  const chatEmpty=doc.createElement('div');chatEmpty.className='ai-chat-empty';chatEmpty.innerHTML='<span>✦</span><strong>针对论文提问</strong><p>划选一段文字，或直接输入你的问题。</p>';messages.append(chatEmpty);
  const composer=doc.createElement('div');composer.className='ai-composer';chat.append(composer);
  const input=doc.createElement('textarea');input.placeholder='问问这篇论文…';input.rows=2;composer.append(input);
  const current=key(item);active.set(current,chat);
  const saved=await readJSON(item,'ai_conversation');const history:any[]=Array.isArray(saved?.messages)?saved.messages:[];
  function add(role:string,text:string):{bubble:HTMLElement,setContent:(value:string)=>void}{
    chatEmpty.hidden=true;const line=doc.createElement('div');line.className=`ai-message ai-message-${role}`;
    const bubble=doc.createElement('div');bubble.className=`ai-bubble ai-${role}`;line.append(bubble);messages.append(line);
    let current=text;
    const setContent=(value:string)=>{current=role==='assistant'?formatAnswerMarkdown(value):value;if(role==='assistant')renderMD(bubble,current);else bubble.textContent=current;messages.scrollTop=messages.scrollHeight;};
    setContent(text);
    if(role==='assistant'){
      const copy=button(doc,'复制',()=>{try{Zotero.Utilities.Internal.copyTextToClipboard(current);copy.textContent='已复制';setTimeout(()=>copy.textContent='复制',1500);}catch(e){Zotero.logError(e);}});
      copy.className='ai-copy';copy.title='复制回答 Markdown';line.append(copy);
    }
    return {bubble,setContent};
  }
  history.forEach(m=>add(m.role,m.content));
  const send=button(doc,'↑',async()=>{
    const selected=(pending.get(current)||[]).join('\n'),question=input.value.trim();if(!question)return;
    input.value='';const user=selected?`${question}\n【选中】${selected}`:question;add('user',user);history.push({role:'user',content:user});
    const response=add('assistant','正在查找论文内容…');
    try{
      const web=await search(item,selected,question);
      const limit=Math.min(12000,Math.max(1000,Services.prefs.getIntPref(PREFIX+'maxChars',30000)));
      let context=String(item.getField('abstractNote')||'').slice(0,1800);
      try{const full=await pdfText(item);context=[context,questionContext(full,question,limit,pickText(full,limit))].filter(Boolean).join('\n\n');}
      catch(e){Zotero.debug(`AI Literature PDF context unavailable: ${shortError(e)}`);context+='\n（PDF 正文不可用，请勿推测图像细节。）';}
      response.setContent('正在回答…');
      const answer=await llm(questionPrompt(item,selected,question,web,context),response.setContent);
      response.setContent(answer);history.push({role:'assistant',content:answer});pending.delete(current);
      await writeJSON(item,'ai_conversation',{itemKey:item.key,messages:history});
    }catch(e){Zotero.logError(e);response.setContent(`**回答失败：** ${shortError(e)}`);}
  });send.className='ai-send';send.title='发送问题';composer.append(send);
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!e.shiftKey){e.preventDefault();send.click();}});
  showTab('summary');
  const queued=pendingQuestion.get(current);if(queued){pendingQuestion.delete(current);showTab('chat');input.value=queued;send.click();}
}
function openAIPane(reader:any):boolean {
  const windows=[reader?._iframeWindow?.top,Zotero.getMainWindow()].filter(Boolean);
  for(const win of windows){
    try{
      const doc=win.document as Document;
      const nav=doc.getElementById('zotero-context-pane-sidenav') || doc.getElementById('zotero-view-item-sidenav');
      const target=nav?.querySelector<HTMLElement>('[data-pane="ai-literature-summary"]');
      if(target){if(win.ZoteroContextPane?.collapsed)win.ZoteroContextPane.collapsed=false;target.click();return true;}
    }catch{}
  }
  return false;
}
function onToolbar({reader,doc,append}:any):void {
  // Zotero Reader renderToolbar：提供可见的右侧 AI 入口。
  const control=doc.createElement('button');control.type='button';control.className='ai-literature-toolbar-button';
  control.title='打开右侧 AI 总结与问答';control.setAttribute('aria-label','打开 AI 助手');
  control.innerHTML='<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true"><path fill="currentColor" d="m10 1 1.6 5.4L17 8l-5.4 1.6L10 15l-1.6-5.4L3 8l5.4-1.6L10 1Zm6 11 .8 2.2L19 15l-2.2.8L16 18l-.8-2.2L13 15l2.2-.8L16 12Z"/></svg><span>AI 助手</span>';
  control.style.cssText='display:inline-flex;align-items:center;gap:5px;border:1px solid var(--border-color,#c8c8c8);border-radius:7px;padding:5px 9px;margin:0 4px;background:var(--toolbar-bg,#f8f8f8);color:var(--text-color,#333);font:600 12px sans-serif;cursor:pointer;white-space:nowrap';
  control.addEventListener('click',()=>{if(!openAIPane(reader))reader?._iframeWindow?.alert?.('请在右侧条目面板中打开“AI 总结”');});
  append(control);
}
function onSelection({reader,doc,params,append}:any):void {
  const selected=String(params?.annotation?.text||'').trim();if(!selected)return;
  const raw=Zotero.Items.get(reader.itemID);const item=parent(raw);if(!item)return;
  const row=doc.createElement('div');row.className='ai-selection-actions';
  row.style.cssText='display:flex;align-items:center;gap:4px;padding:4px;border-radius:8px;background:var(--popup-bg,#fff);box-shadow:0 1px 5px #0002';
  const action=(label:string,icon:string,handler:()=>void)=>{const b=button(doc,`${icon} ${label}`,handler);b.type='button';b.style.cssText='border:0;border-radius:6px;background:transparent;color:var(--text-color,#333);font:500 12px sans-serif;white-space:nowrap;padding:5px 8px;cursor:pointer';b.addEventListener('mouseenter',()=>b.style.background='var(--fill-quinary,#e9edf5)');b.addEventListener('mouseleave',()=>b.style.background='transparent');return b;};
  // 参考 zotero-dsh：只追加两个按钮，保留 Zotero 原生气泡操作。
  row.append(action('加入对话','+',()=>{const k=key(item);pending.set(k,[...(pending.get(k)||[]),selected]);openAIPane(reader);active.get(k)?.closest('.ai-literature')?.querySelector<HTMLButtonElement>('[data-ai-tab="chat"]')?.click();}));
  row.append(action('提问','✦',()=>{const k=key(item);pending.set(k,[selected]);const pane=active.get(k);const input=pane?.isConnected?pane.querySelector('textarea') as HTMLTextAreaElement:null;const question=input?.value.trim()||reader._iframeWindow?.prompt?.('请输入问题')?.trim()||'';if(!question)return;if(input){pane!.closest('.ai-literature')?.querySelector<HTMLButtonElement>('[data-ai-tab="chat"]')?.click();input.value=question;(pane!.querySelector('.ai-send') as HTMLButtonElement)?.click();}else{pendingQuestion.set(k,question);if(!openAIPane(reader))reader._iframeWindow?.alert?.('请在右侧条目面板中打开“AI 总结”');}}));append(row);
}
function setupPrefs():void {
  Zotero.AILiteraturePreferences = { init: initPreferences };
  Zotero.PreferencePanes.register({pluginID:ID,src:root+'content/preferences.xhtml',label:'AI 助手',image:root+'content/icon.svg'});
}
function initPreferences(win:Window):void {
  const controls=win.document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-ai-pref]');
  const field=(name:string)=>win.document.querySelector<HTMLInputElement>(`[data-ai-pref="${name}"]`)!;
  for(const control of Array.from(controls)){
    const name=control.dataset.aiPref!;
    control.value=name==='maxChars'
      ? String(Services.prefs.getIntPref(PREFIX+name,30000))
      : Services.prefs.getCharPref(PREFIX+name,'');
    const save=()=>{
      if(name==='provider'){
        const previous=Services.prefs.getCharPref(PREFIX+'provider','openai');
        const next=control.value as keyof typeof PROVIDER_DEFAULTS;
        if(previous===next || !PROVIDER_DEFAULTS[next])return;
        if(PROVIDER_DEFAULTS[previous as keyof typeof PROVIDER_DEFAULTS]){
          Services.prefs.setCharPref(PREFIX+previous+'ApiURL',field('apiURL').value);
          Services.prefs.setCharPref(PREFIX+previous+'Model',field('model').value);
        }
        Services.prefs.setCharPref(PREFIX+'provider',next);
        for(const property of ['apiURL','model'] as const){
          const saved=Services.prefs.getCharPref(PREFIX+next+(property==='apiURL'?'ApiURL':'Model'),PROVIDER_DEFAULTS[next][property]);
          field(property).value=saved;
          Services.prefs.setCharPref(PREFIX+property,saved);
        }
      }else if(name==='maxChars'){
        const value=Number(control.value);
        if(Number.isInteger(value)&&value>=1000)Services.prefs.setIntPref(PREFIX+name,value);
      }else Services.prefs.setCharPref(PREFIX+name,control.value);
    };
    control.addEventListener(control.localName==='select'?'change':'input',save);
  }
  // 旧版本仅切换服务商标识时，页面可能仍保留另一家的默认地址和模型。
  const provider=Services.prefs.getCharPref(PREFIX+'provider','openai') as keyof typeof PROVIDER_DEFAULTS;
  if(PROVIDER_DEFAULTS[provider]){
    const other=provider==='openai'?'deepseek':'openai';
    for(const property of ['apiURL','model'] as const){
      if(field(property).value===PROVIDER_DEFAULTS[other][property]){
        field(property).value=PROVIDER_DEFAULTS[provider][property];
        Services.prefs.setCharPref(PREFIX+property,field(property).value);
      }
    }
  }
}
export async function start(uri:string):Promise<void>{root=uri;setupPrefs();sectionID=Zotero.ItemPaneManager.registerSection({paneID:'ai-literature-summary',pluginID:ID,header:{l10nID:'ai-literature-header',icon:root+'content/icon.svg'},sidenav:{l10nID:'ai-literature-header',icon:root+'content/icon.svg'},bodyXHTML:'<div xmlns="http://www.w3.org/1999/xhtml"></div>',onItemChange:({item,setEnabled}:any)=>{setEnabled(Boolean(parent(item)?.isRegularItem?.()));return true;},onRender:({body}:any)=>{body.textContent='正在加载 AI 助手…';},onAsyncRender:async({body,item}:any)=>renderSection(body,item)});popupHandler=onSelection;toolbarHandler=onToolbar;Zotero.Reader.registerEventListener('renderTextSelectionPopup',popupHandler,ID);Zotero.Reader.registerEventListener('renderToolbar',toolbarHandler,ID);}
export function stop():void{if(sectionID)Zotero.ItemPaneManager.unregisterSection(sectionID);if(popupHandler)Zotero.Reader.unregisterEventListener('renderTextSelectionPopup',popupHandler);if(toolbarHandler)Zotero.Reader.unregisterEventListener('renderToolbar',toolbarHandler);delete Zotero.AILiteraturePreferences;active.clear();pending.clear();pendingQuestion.clear();fullTextCache.clear();}
