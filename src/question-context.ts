// 对图表问题优先选取图注与附近说明；其余问题使用传入的论文节选。
export function questionContext(full:string,question:string,limit:number,baseline:string):string {
  const reference=/(?:fig(?:ure)?\.?|table)\s*([0-9]+[a-z]?)|[图表]\s*([0-9]+[a-z]?)/i.exec(question);
  if(!reference)return baseline.slice(0,limit);
  const number=(reference[1]||reference[2]).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
  const pattern=new RegExp(`(?:fig(?:ure)?\\.?|table)\\s*${number}(?![0-9])|[图表]\\s*${number}(?![0-9])`,'ig');
  const snippets:string[]=[];let match:RegExpExecArray|null;
  while((match=pattern.exec(full))&&snippets.length<6){
    const start=Math.max(0,match.index-350),end=Math.min(full.length,match.index+950);
    snippets.push(full.slice(start,end));
  }
  const lead=baseline.slice(0,Math.min(1800,Math.floor(limit/3)));
  return [lead,...snippets].join('\n\n---\n\n').slice(0,limit);
}
