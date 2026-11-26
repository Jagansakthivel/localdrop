/** Keep original display filename separately; sanitize only names used for local writes/exports. */
export function sanitizeSuggestedFilename(input:string):string {
  let name=input.replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g,'_').trim().replace(/[. ]+$/g,'');
  if(!name||name==='.'||name==='..')name='download';
  if(/^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\s*\.|$)/i.test(name))name='_'+name;
  const enc=new TextEncoder();let out='',count=0,bytes=0;
  for(const char of name){const n=enc.encode(char).length;if(count+1>200||bytes+n>240)break;out+=char;count++;bytes+=n;}
  return out.replace(/[. ]+$/g,'')||'download';
}
