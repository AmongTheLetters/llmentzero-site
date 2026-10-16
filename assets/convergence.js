(()=>{const c=document.getElementById('convergence');if(!c)return;const x=c.getContext('2d');
const reduce=matchMedia('(prefers-reduced-motion: reduce)'),PREVIEW=location.hash==='#preview';
const GL='ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789アカサタナハマヤラワ<>/\\{}[]=+*#$%&@λΣΔΩ∞≠',G=()=>GL[Math.random()*GL.length|0],R=Math.random,DIRS=[[0,-1],[1,0],[0,1],[-1,0]];
let W,H,lanes=[],bolts=[],sparks=[],T=0,acc=0,raf,last;
// ---- wedges: entry edge runs from side edge (y=0.22H) through the corner to top/bottom edge (x=0.40W), mirrored ----
const SY=.22,TX=.40,LANE_GAP=17,CELL=17,STOP=46;
function entry(u,q){const a=SY*H,b=TX*W,d=u*(a+b);let px=d<a?0:d-a,py=d<a?a-d:0;if(q&1)px=W-px;if(q&2)py=H-py;return[px,py]}
function build(){lanes=[];const cx=W/2,cy=H/2,n=Math.max(8,Math.round((SY*H+TX*W)/LANE_GAP));
 for(let q=0;q<4;q++)for(let i=0;i<n;i++){const[sx,sy]=entry((i+.5)/n,q),dx=cx-sx,dy=cy-sy,L=Math.hypot(dx,dy),sz=12+R()*5,step=CELL*sz/14,
  cnt=Math.max(4,Math.floor((L-STOP)/step)),pos=[];for(let k=0;k<cnt;k++)pos.push([sx+dx/L*k*step,sy+dy/L*k*step]);
  lanes.push({pos,ch:pos.map(G),font:`${sz|0}px "JetBrains Mono", monospace`,b:.6+R()*.4,h:R()*360,strands:[],next:R()*4})}}
function newStrand(l){const len=3+Math.floor(Math.pow(R(),1.6)*34);return{head:0,speed:2.5+R()*8,len,end:R()<.3?Math.floor(l.pos.length*(.3+R()*.6)):l.pos.length+len,fade:1}}
function updateRain(dt){for(const l of lanes){l.next-=dt;if(l.next<=0){l.strands.push(newStrand(l));l.next=.8+R()*6}
  l.strands=l.strands.filter(s=>{const prev=s.head|0;s.head+=s.speed*dt;if(s.head>=s.end){s.head=s.end;s.fade-=dt*1.2}
   if((s.head|0)!==prev&&(s.head|0)<l.pos.length)l.ch[s.head|0]=G();return s.fade>0&&s.head-s.len<l.pos.length})}
 const flick=Math.ceil(lanes.length*dt*3);for(let i=0;i<flick;i++){const l=lanes[R()*lanes.length|0];l.ch[R()*l.pos.length|0]=G()}}
function drawRain(){x.textAlign='center';x.textBaseline='middle';const hueT=T*40;
 for(const l of lanes){if(!l.strands.length)continue;x.font=l.font;
  for(const s of l.strands){const h=Math.floor(s.head);for(let j=0;j<s.len;j++){const k=h-j;if(k<0)break;if(k>=l.pos.length)continue;
   const a=(1-j/s.len)*l.b*s.fade,hue=(l.h+hueT+k*7)%360|0;
   x.fillStyle=j===0?`hsla(${hue},100%,93%,${Math.min(1,a+.2)})`:`hsla(${hue},95%,${62+12*(1-j/s.len)|0}%,${a})`;
   x.fillText(l.ch[k],l.pos[k][0],l.pos[k][1])}}}}
// ---- lightning (unchanged behaviour, run at a fixed 60 Hz logic step) ----
function trace(x0,y0,dir,len,depth){const pts=[[x0,y0]];let px=x0,py=y0,[dx,dy]=dir,g=0;
 while(g<len){const s=14+R()*26,off=(px-x0)*-dy+(py-y0)*dx,r=R();let mx=dx,my=dy;
  if(r<.25){mx=dx-dy;my=dy+dx}else if(r<.5){mx=dx+dy;my=dy-dx}else if(r<.62){mx=-dy;my=dx}else if(r<.74){mx=dy;my=-dx}
  if(Math.abs(off)>40){const sg=Math.sign(off);mx=dx+dy*sg;my=dy-dx*sg}
  const n=Math.hypot(mx,my);px+=mx/n*s;py+=my/n*s;g+=s*Math.abs((mx*dx+my*dy)/n)+2;pts.push([px,py])}
 const b={pts,life:14+R()*12,age:0,kids:[]};
 if(depth<2)for(let i=2;i<pts.length-1;i++)if(R()<.12){const td=R()<.5?[-dy,dx]:[dy,-dx];b.kids.push(trace(pts[i][0],pts[i][1],R()<.5?td:[dx+td[0],dy+td[1]].map(v=>v/Math.SQRT2),len*.35,depth+1))}
 return b}
const fire=a=>bolts.push(trace(W/2,H/2,DIRS[a],(a%2?W:H)/2,0));let tick=0;
function updateFx(){tick++;if(tick%10==0||R()<.05)fire(R()*4|0);if(tick%90==0)DIRS.forEach((_,a)=>fire(a));
 bolts=bolts.filter(b=>++b.age<=b.life);
 sparks=sparks.filter(s=>{s.x+=s.vx;s.y+=s.vy;s.vx*=.92;s.vy*=.92;s.l-=.05;return s.l>0});if(sparks.length>400)sparks.splice(0,sparks.length-400)}
function path(p){x.beginPath();x.moveTo(p[0][0],p[0][1]);for(const q of p)x.lineTo(q[0],q[1])}
function drawBolt(b,f){if(f<=0)return;const vis=b.pts.slice(0,Math.max(2,Math.min(1,b.age/4)*b.pts.length|0));
 path(vis);x.strokeStyle=`rgba(46,196,182,${.35*f})`;x.lineWidth=6;x.stroke();x.strokeStyle=`rgba(255,255,255,${.9*f})`;x.lineWidth=1.6;x.stroke();
 x.fillStyle=`rgba(232,200,114,${f})`;for(const p of vis)x.fillRect(p[0]-1.5,p[1]-1.5,3,3);
 const e=vis[vis.length-1];if(R()<.6)for(let i=0;i<3;i++)sparks.push({x:e[0],y:e[1],vx:(R()-.5)*5,vy:(R()-.5)*5,l:1});
 b.kids.forEach(k=>{k.age=b.age;drawBolt(k,f*.8)})}
function drawFx(){x.lineJoin='miter';bolts.forEach(b=>drawBolt(b,(R()<.2?.35:1)*(1-b.age/b.life)));
 for(const s of sparks){x.fillStyle=R()<.3?`rgba(255,255,255,${s.l})`:`rgba(232,200,114,${s.l})`;x.fillRect(s.x,s.y,2,2)}}
// ---- frame: crisp redraw every frame (no smear) ----
function render(){x.clearRect(0,0,W,H);x.fillStyle='#0B0F1A';x.fillRect(0,0,W,H);const cx=W/2,cy=H/2;
 const g=x.createRadialGradient(cx,cy,0,cx,cy,110);g.addColorStop(0,'rgba(232,200,114,.45)');g.addColorStop(1,'rgba(232,200,114,0)');x.fillStyle=g;x.fillRect(cx-110,cy-110,220,220);
 drawRain();drawFx()}
function step(dt){T+=dt;updateRain(dt);acc+=dt;while(acc>=1/60){updateFx();acc-=1/60}}
function loop(now){const dt=Math.min(.1,(now-(last??now))/1000);last=now;step(dt);render();raf=requestAnimationFrame(loop)}
function still(){cancelAnimationFrame(raf);x.fillStyle='#0B0F1A';x.fillRect(0,0,W,H);x.textAlign='center';x.textBaseline='middle';
 lanes.forEach((l,i)=>{x.font=l.font;const len=4+(i*7)%22,h=Math.floor(l.pos.length*(((i*37)%100)/100));
  for(let j=0;j<len;j++){const k=h-j;if(k<0)break;const a=(1-j/len)*l.b;x.fillStyle=j?`hsla(${(l.h+k*7)%360|0},95%,65%,${a})`:`rgba(240,245,255,${a})`;x.fillText(l.ch[k],l.pos[k][0],l.pos[k][1])}});
 const cx=W/2,cy=H/2;DIRS.forEach((d,a)=>{const b=trace(cx,cy,d,(a%2?W:H)/2,1);path(b.pts);x.strokeStyle='rgba(46,196,182,.4)';x.lineWidth=5;x.stroke();x.strokeStyle='#fff';x.lineWidth=1.4;x.stroke()})}
function size(){const D=Math.min(devicePixelRatio||1,2);W=c.clientWidth;H=c.clientHeight;c.width=W*D;c.height=H*D;x.setTransform(D,0,0,D,0,0);build()}
function start(){cancelAnimationFrame(raf);size();if(reduce.matches)return still();
 for(let i=0;i<8*30;i++)step(1/30); // pre-fill so the hero never starts empty
 if(PREVIEW){window.__step=(n=1,dt=1/25)=>{for(let i=0;i<n;i++)step(dt);render()};render();return}
 last=undefined;raf=requestAnimationFrame(loop)}
let rt;addEventListener('resize',()=>{clearTimeout(rt);rt=setTimeout(start,150)});reduce.addEventListener('change',start);start()})();
