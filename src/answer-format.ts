// 只在模型给出纯文本长段落时补充分段；已有 Markdown 结构保持原样。
export function formatAnswerMarkdown(value:string):string {
  const text=value.trim();
  if(text.length<110 || /\n\s*\n|(^|\n)\s*(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|```)/m.test(text))return text;
  if(text.includes('\n'))return text.split(/\n+/).map(line=>line.trim()).filter(Boolean).join('\n\n');
  let parts=text.split(/(?<=[。！？；])|(?<=[.!?])\s+(?=[A-Z])/u).map(part=>part.trim()).filter(Boolean);
  if(parts.length===1 && text.length>150){
    parts=(text.match(/[^，,]+[，,]?/gu)||[text]).map(part=>part.trim()).filter(Boolean);
  }
  if(parts.length===1 && text.length>170){
    parts=[];
    for(let start=0;start<text.length;start+=110)parts.push(text.slice(start,start+110));
  }
  if(parts.length===1)return text;
  const paragraphs:string[]=[];let group='';let count=0;
  for(const part of parts){
    if(group && (group.length+part.length>115 || count>=2)){paragraphs.push(group.trim());group='';count=0;}
    group+=(group && /[A-Za-z0-9]$/.test(group) && /^[A-Z]/.test(part) ? ' ' : '')+part;count++;
  }
  if(group)paragraphs.push(group.trim());
  return paragraphs.join('\n\n');
}
