import { BasicTool } from 'zotero-plugin-toolkit';
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import katex from 'katex';

declare const Zotero: any;
declare const Services: any;
declare const IOUtils: any;
declare const PathUtils: any;
const ID = 'ai-literature-assistant@local';
const PREFIX = 'extensions.zotero.aiLiterature.';
const toolkit = new BasicTool();
let sectionID = '';
let popupHandler: any;
let root = '';
const pending = new Map<string,string[]>();
const active = new Map<string,HTMLElement>();

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
  for (const id of item.getAttachments()) {
    const a=Zotero.Items.get(id);
    if (a?.attachmentContentType==='application/pdf') {
      const result=await Zotero.PDFWorker.getFullText(a);
      if (result?.text) return result.text;
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
function questionPrompt(item:any,selected:string,question:string,web:string,context:string):string {return `你是一个学术阅读助手。用户正在阅读一篇论文，并选中了以下片段进行提问。\n\n【论文标题】${item.getField('title')}\n【选中片段】${selected}\n【论文上下文】${context}\n【联网检索结果】${web||'未启用联网，仅基于文献内容回答'}\n【用户问题】${question}\n\n回答要求：\n1. 首先基于选中片段和论文上下文给出直接回答，标注依据来自文献。\n2. 若联网结果可用，补充外部知识，标注来源。\n3. 若文献与联网信息冲突，明确指出。\n4. 回答控制在 200 字以内，简洁优先。\n\n你的回答将展示在 Zotero 侧边栏的紧凑对话区域，避免冗长铺垫。`;}

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
  const walker=doc.createTreeWalker(target,doc.defaultView!.NodeFilter.SHOW_TEXT);const nodes:Text[]=[];
  while(walker.nextNode())nodes.push(walker.currentNode as Text);
  for(const node of nodes){if(node.parentElement?.closest('code,pre'))continue;const value=node.nodeValue||'';if(!/\$[^$]+\$/.test(value))continue;
    const span=doc.createElement('span');let last=0;const re=/\$([^$]+)\$/g;let match:RegExpExecArray|null;
    while((match=re.exec(value))){span.append(doc.createTextNode(value.slice(last,match.index)));const formula=doc.createElement('span');try{formula.innerHTML=katex.renderToString(match[1],{throwOnError:false});}catch{formula.textContent=match[0];}span.append(formula);last=re.lastIndex;}
    span.append(doc.createTextNode(value.slice(last)));node.replaceWith(span);
  }
}
function button(doc:Document,label:string,action:()=>void):HTMLButtonElement {const b=doc.createElement('button');b.textContent=label;b.addEventListener('click',action);return b;}
function openWindow(md:string):void {const win=Services.ww.openWindow(null,root+'content/report.xhtml','ai-literature-report','chrome,resizable,centerscreen,width=900,height=750',null);win.addEventListener('load',()=>{const d=win.document;const content=d.getElementById('report') as HTMLElement;renderMD(content,md);}, {once:true});}
async function renderSection(body:HTMLElement, raw:any):Promise<void> {
  const item=parent(raw);body.replaceChildren();if(!item||!item.isRegularItem?.())return;
  const doc=body.ownerDocument, wrap=doc.createElement('div');wrap.className='ai-literature';body.append(wrap);
  const style=doc.createElement('style');style.textContent='.ai-literature{font:13px/1.5 sans-serif;padding:8px;min-width:0}.ai-toolbar{display:flex;gap:6px;margin-bottom:8px}.ai-literature button{cursor:pointer;padding:3px 7px}.ai-report{max-height:45vh;overflow:auto;overflow-wrap:anywhere;padding:8px;border:1px solid #9995}.ai-report pre{overflow:auto}.ai-chat{margin-top:10px}.ai-messages{max-height:28vh;overflow:auto}.ai-bubble{margin:6px 0;padding:7px;border-radius:6px;white-space:pre-wrap;overflow-wrap:anywhere}.ai-user{background:#3b78be33}.ai-assistant{background:#8882}.ai-chat textarea{box-sizing:border-box;width:100%;min-height:55px;margin:6px 0}';wrap.prepend(style);
  const toolbar=doc.createElement('div');toolbar.className='ai-toolbar';wrap.append(toolbar);
  const report=doc.createElement('div');report.className='ai-report';wrap.append(report);
  const chat=doc.createElement('div');chat.className='ai-chat';wrap.append(chat);
  const cached=await readJSON(item,'ai_summary');let md=cached?.ai_summary||'';
  if(md)renderMD(report,md);else report.textContent='尚无总结报告';
  toolbar.append(button(doc,'生成/更新总结',async()=>{report.textContent='正在读取 PDF…';try{const full=pickText(await pdfText(item),Math.max(1000,Number(Services.prefs.getIntPref(PREFIX+'maxChars',30000))));report.textContent='正在生成…';md=await llm(summaryPrompt(item,full),s=>renderMD(report,s));await writeJSON(item,'ai_summary',{ai_summary:md,updated_at:new Date().toISOString()});}catch(e){report.textContent=`生成失败：${error(e)}`;}}));
  toolbar.append(button(doc,'在新窗口打开',()=>{if(md)openWindow(md);}));
  const status=doc.createElement('div');status.textContent=`联网：${setting('searchType')==='off'||!setting('searchKey')?'OFF':'ON'}`;chat.append(status);
  const messages=doc.createElement('div');messages.className='ai-messages';chat.append(messages);
  const input=doc.createElement('textarea');input.placeholder='针对划词内容提问…';chat.append(input);
  const current=key(item);active.set(current,chat);
  const saved=await readJSON(item,'ai_conversation');const history:any[]=Array.isArray(saved?.messages)?saved.messages:[];
  function add(role:string,text:string):HTMLElement{const bubble=doc.createElement('div');bubble.className=`ai-bubble ai-${role}`;bubble.textContent=text;messages.append(bubble);return bubble;}
  history.forEach(m=>add(m.role,m.content));
  const send=button(doc,'发送',async()=>{const selected=(pending.get(current)||[]).join('\n'),question=input.value.trim();if(!question)return;input.value='';const user=selected?`${question}\n【选中】${selected}`:question;add('user',user);history.push({role:'user',content:user});const bubble=add('assistant','正在回答…');try{const web=await search(item,selected,question);const context=(item.getField('abstractNote')||'').slice(0,2000);const answer=await llm(questionPrompt(item,selected,question,web,context),s=>bubble.textContent=s);history.push({role:'assistant',content:answer});pending.delete(current);await writeJSON(item,'ai_conversation',{itemKey:item.key,messages:history});}catch(e){bubble.textContent=`回答失败：${error(e)}`;}});send.className='ai-send';chat.append(send);
}
function onSelection({reader,doc,params,append}:any):void {
  const selected=String(params?.annotation?.text||'').trim();if(!selected)return;
  const raw=Zotero.Items.get(reader.itemID);const item=parent(raw);if(!item)return;
  const row=doc.createElement('div');row.className='ai-selection-actions';
  // 参考 zotero-dsh：只追加两个按钮，保留 Zotero 原生气泡操作。
  row.append(button(doc,'加入对话',()=>{const k=key(item);pending.set(k,[...(pending.get(k)||[]),selected]);}));
  row.append(button(doc,'提问',()=>{const k=key(item);pending.set(k,[selected]);const pane=active.get(k);const input=pane?.querySelector('textarea') as HTMLTextAreaElement|null;if(input){input.focus();if(!input.value.trim())input.value=reader._iframeWindow?.prompt?.('请输入问题')||'';if(input.value.trim())(pane!.querySelector('.ai-send') as HTMLButtonElement)?.click();}else reader._iframeWindow?.alert?.('请先打开右侧的 AI 总结区域');}));append(row);
}
function setupPrefs():void {
  Zotero.AILiteraturePreferences = { init: initPreferences };
  Zotero.PreferencePanes.register({pluginID:ID,src:root+'content/preferences.xhtml',label:'AI 助手',image:root+'content/icon.svg'});
}
function initPreferences(win:Window):void {
  const controls=win.document.querySelectorAll<HTMLInputElement|HTMLSelectElement>('[data-ai-pref]');
  for(const control of Array.from(controls)){
    const name=control.dataset.aiPref!;
    control.value=name==='maxChars'
      ? String(Services.prefs.getIntPref(PREFIX+name,30000))
      : Services.prefs.getCharPref(PREFIX+name,'');
    const save=()=>{
      if(name==='maxChars'){
        const value=Number(control.value);
        if(Number.isInteger(value)&&value>=1000)Services.prefs.setIntPref(PREFIX+name,value);
      }else Services.prefs.setCharPref(PREFIX+name,control.value);
    };
    control.addEventListener(control.localName==='select'?'change':'input',save);
  }
}
export async function start(uri:string):Promise<void>{root=uri;setupPrefs();sectionID=Zotero.ItemPaneManager.registerSection({paneID:'ai-literature-summary',pluginID:ID,header:{l10nID:'ai-literature-header',icon:root+'content/icon.svg'},sidenav:{l10nID:'ai-literature-header',icon:root+'content/icon.svg'},bodyXHTML:'<div xmlns="http://www.w3.org/1999/xhtml"></div>',onAsyncRender:async({body,item}:any)=>renderSection(body,item)});popupHandler=onSelection;Zotero.Reader.registerEventListener('renderTextSelectionPopup',popupHandler,ID);}
export function stop():void{if(sectionID)Zotero.ItemPaneManager.unregisterSection(sectionID);if(popupHandler)Zotero.Reader.unregisterEventListener('renderTextSelectionPopup',popupHandler);delete Zotero.AILiteraturePreferences;active.clear();pending.clear();}
