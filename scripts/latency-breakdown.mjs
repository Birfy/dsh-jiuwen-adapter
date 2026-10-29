// Per-stage latency, path A (dsh headless + adapter, via JIUWEN_TRACE_FILE marks) vs C (raw gateway WS). Usage: node scripts/latency-breakdown.mjs [runs]
import {spawn} from 'child_process';import fs from 'fs'
const N=Number(process.argv[2]||6);const med=a=>{a=[...a].sort((x,y)=>x-y);return a[a.length>>1]}
const A=[],C=[]
function runA(){return new Promise(res=>{const tf='/tmp/trA.jsonl';fs.rmSync(tf,{force:true});const t0=performance.now();let fin=null,sess=null
const p=spawn('dsh',['--profile','headless','--json','Reply with exactly: pong'],{cwd:'/tmp',env:{...process.env,JIUWEN_TRACE_FILE:tf}});let b='';p.stdout.on('data',d=>{b+=d;if(!sess&&b.includes('"session"'))sess=performance.now()-t0;if(!fin&&b.includes('"final"'))fin=performance.now()-t0})
p.on('close',()=>{const ex=performance.now()-t0;const r=fs.readFileSync(tf,'utf8').trim().split('\n').map(JSON.parse);const m={};for(const x of r){const k=x.at==='mark'?x.name:x.at;if(m[k]==null)m[k]=x.up}
res({apply:m['plugin-apply'],turnStart:m['turn-start'],wsAck:m['ws-ack']-m['ws-connect'],sendToFirstFrame:m['first-frame']-m['chat-send'],sendToToken:(m['first-reasoning']??m['first-delta'])-m['chat-send'],tokenToTerminal:m['terminal-final']-(m['first-reasoning']??m['first-delta']),terminalToFinish:m['finish']-m['terminal-final'],finishToStdoutFinal:Math.round(fin)-m['finish'],stdoutFinalToExit:Math.round(ex-fin),total:Math.round(ex)})})})}
function runC(){return new Promise(res=>{const ws=new WebSocket('ws://127.0.0.1:19000/ws?user_id=bench');const t0=performance.now();let ack,ft,tf,rid='r'+Math.random()
ws.onmessage=m=>{const f=JSON.parse(m.data),e=f.event,p=f.payload||{};if(e==='connection.ack'){ack=performance.now()-t0;ws.send(JSON.stringify({type:'req',id:rid,method:'chat.send',params:{session_id:'c-'+Math.random().toString(16).slice(2),query:'Reply with exactly: pong',content:'Reply with exactly: pong',mode:'agent',work_mode:'agent',user_id:'bench',supports_user_interaction:false}}))}
if((e==='chat.reasoning'||e==='chat.delta')&&!ft)ft=performance.now()-t0;if(e==='chat.final'&&p.content===''&&!tf)tf=performance.now()-t0;if(e==='chat.processing_status'&&p.is_complete&&p.request_id===rid){const t=performance.now()-t0;ws.close();res({wsAck:Math.round(ack),sendToToken:Math.round(ft-ack),tokenToTerminal:Math.round(tf-ft),terminalToComplete:Math.round(t-tf),total:Math.round(t)})}}})}
for(let i=0;i<N;i++){A.push(await runA());C.push(await runC())}
const sum=L=>Object.fromEntries(Object.keys(L[0]).map(k=>[k,med(L.map(x=>x[k]))]))
console.log(JSON.stringify({A:sum(A),C:sum(C),rawA:A,rawC:C}))
