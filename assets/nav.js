(()=>{document.documentElement.classList.remove('no-js');const btn=document.querySelector('.nav-toggle'),menu=document.getElementById('nav-menu');if(!btn||!menu)return;
const mq=matchMedia('(max-width:760px)');
function set(open,focusBtn){btn.setAttribute('aria-expanded',String(open));menu.classList.toggle('open',open);
 btn.querySelector('.nav-label').textContent=open?'Close':'Menu';if(open){const a=menu.querySelector('a');a&&a.focus()}else if(focusBtn)btn.focus()}
btn.addEventListener('click',()=>set(btn.getAttribute('aria-expanded')!=='true'));
document.addEventListener('click',e=>{if(btn.getAttribute('aria-expanded')==='true'&&!menu.contains(e.target)&&!btn.contains(e.target))set(false)});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&btn.getAttribute('aria-expanded')==='true'){set(false,true)}});
menu.addEventListener('click',e=>{if(e.target.closest('a'))set(false)});
menu.addEventListener('focusout',e=>{if(mq.matches&&btn.getAttribute('aria-expanded')==='true'&&e.relatedTarget&&!menu.contains(e.relatedTarget)&&e.relatedTarget!==btn)set(false)});
mq.addEventListener('change',e=>{if(!e.matches)set(false)});})();
