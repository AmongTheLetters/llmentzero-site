(()=>{document.querySelectorAll('button[data-copy]').forEach(b=>{b.hidden=false;const el=document.getElementById(b.dataset.copy),st=document.querySelector('.copy-status');
b.addEventListener('click',async()=>{const t=el.textContent.trim();let ok=false;
try{if(navigator.clipboard&&window.isSecureContext){await navigator.clipboard.writeText(t);ok=true}}catch(e){}
if(!ok){const r=document.createRange();r.selectNodeContents(el);const s=getSelection();s.removeAllRanges();s.addRange(r);try{ok=document.execCommand('copy')}catch(e){}}
st.textContent=ok?'Address copied: '+t:'Address selected. Press Ctrl+C (or Command+C) to copy it.'})})})();
