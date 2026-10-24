'use strict';

function appendInline(parent,line,doc) {
  const pattern=/(\*\*[^*]+\*\*|__[^_]+__|\[[^\]]+\]\(https?:\/\/[^)\s]+\)|https?:\/\/[^\s<>]+)/g;
  let last=0,m;
  while((m=pattern.exec(line))!==null){
    if(m.index>last)parent.appendChild(doc.createTextNode(line.slice(last,m.index)));
    const token=m[0];
    if(token.startsWith('**')||token.startsWith('__')){
      const strong=doc.createElement('strong');
      strong.textContent=token.slice(2,-2);
      parent.appendChild(strong);
    }else {
      const linked=token.match(/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/);
      const raw=linked?linked[2]:token;
      const href=raw.replace(/[.,;]+$/,'');
      if(/^https:\/\/[^\s@]+$/i.test(href)){
        const a=doc.createElement('a');
        a.href=href;a.textContent=linked?linked[1]:href;
        a.rel='noopener noreferrer';a.target='_blank';
        a.className='update-cl-link';parent.appendChild(a);
        if(!linked&&href.length<raw.length)parent.appendChild(doc.createTextNode(raw.slice(href.length)));
      }else parent.appendChild(doc.createTextNode(token));
    }
    last=pattern.lastIndex;
  }
  if(last<line.length)parent.appendChild(doc.createTextNode(line.slice(last)));
}

function renderUpdateChangelog(container,info,doc=container.ownerDocument) {
  container.replaceChildren();
  const entries=(Array.isArray(info?.changelog)&&info.changelog.length)?info.changelog:
    info?.body?[{version:info.latest||'',body:info.body}]:[];
  if(!entries.length){
    const empty=doc.createElement('p');empty.textContent='No release notes.';
    container.appendChild(empty);return;
  }
  for(const entry of entries){
    const title=doc.createElement('h3');title.className='update-cl-version';
    title.textContent=String(entry.version||'');container.appendChild(title);
    for(const raw of String(entry.body||'').replace(/\r\n/g,'\n').split('\n')){
      const line=raw.trim();if(!line)continue;
      const heading=line.match(/^#{1,6}\s+(.+)$/);
      const bullet=line.match(/^[-*]\s+(.+)$/);
      const number=line.match(/^\d+\.\s+(.+)$/);
      const text=heading?heading[1]:bullet?bullet[1]:number?number[1]:line;
      const el=doc.createElement(heading?'h4':'div');
      el.className='update-cl-line'+((bullet||number)?' update-cl-bullet':'');
      if(bullet||number)el.appendChild(doc.createTextNode('• '));
      appendInline(el,text,doc);
      container.appendChild(el);
    }
  }
}
module.exports={renderUpdateChangelog,appendInline};
