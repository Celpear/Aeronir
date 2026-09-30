const $=id=>document.getElementById(id);
let runs=[],selected=null,polling=false;
let stream=null,cameraGeneration=0,cameraRequest=null;
const active=run=>['preparing','running','stopping'].includes(run.status);
const status=text=>$('training-status').textContent=text;
const esc=value=>String(value).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
async function api(url,options={}) {
    const response=await fetch('/api/training'+url,options);
    const data=await response.json();
    if(!response.ok)throw new Error(data.error || 'Request failed.');
    return data;
}
const post=(url,body={})=>api(url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function renderRuns() {
    $('training-runs').innerHTML=runs.map(run=>`<button class="audio-track ${selected?.id===run.id?'active':''}" data-run="${run.id}"><strong>${esc(run.datasetName)} · ${esc(run.settings.model)}</strong><small>${esc(run.status)} · ${esc(new Date(run.createdAt).toLocaleString())} · ${run.epoch}/${run.settings.epochs} epochs</small></button>`).join('') || '<p>No training runs yet.</p>';
    document.querySelectorAll('[data-run]').forEach(button=>button.onclick=()=>selectRun(button.dataset.run).catch(error=>status(error.message)));
}
async function selectRun(id) {
    if(selected?.id!==id)stopCamera();
    selected=await api(`/runs/${id}`);
    const url=new URL(location.href);url.searchParams.set('run',id);history.replaceState(null,'',url);
    renderRun();renderRuns();
}
function renderRun() {
    if(!selected)return;
    const run=selected;
    $('training-run-title').textContent=`${run.datasetName} · ${run.settings.model}`;
    $('training-run-message').textContent=`${run.status}: ${run.message}`;
    $('training-progress').max=run.settings.epochs;$('training-progress').value=run.history.at(-1)?.epoch || 0;
    $('training-progress-label').textContent=`Epoch ${run.epoch} / ${run.settings.epochs} · ${run.history.length} completed`;
    $('training-stop').disabled=!active(run)||run.status==='stopping';
    $('training-best').hidden=!run.bestReady;$('training-best').href=`/api/training/runs/${run.id}/artifacts/best.pt`;
    $('training-csv').hidden=!run.history.length;$('training-csv').href=`/api/training/runs/${run.id}/artifacts/results.csv`;
    const log=$('training-log'),wasBottom=log.scrollHeight-log.scrollTop-log.clientHeight<40;
    log.textContent=run.logs.join('\n');if(wasBottom)log.scrollTop=log.scrollHeight;
    const metrics=run.history.at(-1)?.metrics || {};
    $('training-metrics').innerHTML=Object.entries(metrics).map(([key,value])=>`<div><span>${esc(key)}</span><strong>${value===null?'—':Number(value).toFixed(4)}</strong></div>`).join('');
    drawChart();
    $('camera-start').disabled=!run.bestReady||!!stream;
    if(!stream)$('camera-status').textContent=run.bestReady?'Ready to test this run’s best.pt.':'Train a model to enable the preview.';
    $('training-results').hidden=!run.bestReady;
    if(run.bestReady){const url=`/api/training/runs/${run.id}/artifacts/results.png`;if($('training-results-image').getAttribute('src')!==url)$('training-results-image').src=url;}
}
function drawChart() {
    const canvas=$('training-chart'),width=Math.max(260,canvas.clientWidth),height=200,dpr=devicePixelRatio||1;
    canvas.width=width*dpr;canvas.height=height*dpr;const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,width,height);
    ctx.fillStyle='#aab7c4';ctx.font='12px sans-serif';
    const data=selected?.history || [];
    if(!data.length){ctx.fillText('Metrics appear after the first completed epoch.',12,30);return;}
    const loss=data.map(p=>p.metrics['train/box_loss']),map=data.map(p=>p.metrics['metrics/mAP50(B)']);
    const maxLoss=Math.max(1,...loss.filter(Number.isFinite));
    ctx.fillText(`Box loss (0–${maxLoss.toFixed(2)})`,12,18);ctx.fillText('mAP50 (0–1)',Math.max(160,width-110),18);
    ctx.strokeStyle='#30363d';ctx.strokeRect(40,30,width-55,140);
    for(const [values,max,color] of [[loss,maxLoss,'#2dd4bf'],[map,1,'#c084fc']]) {
        ctx.strokeStyle=color;ctx.fillStyle=color;ctx.beginPath();let connected=false;
        values.forEach((value,index)=>{if(!Number.isFinite(value)){connected=false;return;}const x=40+index/Math.max(1,data.length-1)*(width-55),y=170-value/max*140;if(connected)ctx.lineTo(x,y);else ctx.moveTo(x,y);connected=true;ctx.fillRect(x-2,y-2,4,4);});ctx.stroke();
    }
    ctx.fillStyle='#aab7c4';ctx.fillText('Epoch 1',40,190);ctx.textAlign='right';ctx.fillText(`Epoch ${data.at(-1).epoch}`,width-15,190);ctx.textAlign='left';
}
new ResizeObserver(drawChart).observe($('training-chart'));
$('training-stop').onclick=async()=>{try{await post(`/runs/${selected.id}/stop`);await selectRun(selected.id);}catch(error){status(error.message);}};
async function poll() {
    if(polling)return;polling=true;
    try {
        runs=await api('/runs');renderRuns();
        if(selected){const id=selected.id;const updated=await api(`/runs/${id}`);if(selected?.id===id){selected=updated;renderRun();}}
    }catch(error){status(error.message);}finally{polling=false;}
}
function stopCamera() {
    cameraGeneration++;cameraRequest?.abort();cameraRequest=null;
    stream?.getTracks().forEach(track=>track.stop());stream=null;$('camera-video').srcObject=null;
    $('camera-stop').disabled=true;$('camera-start').disabled=!selected?.bestReady;
    $('camera-output').hidden=true;$('camera-status').textContent='Webcam stopped.';
}
$('camera-stop').onclick=()=>{stopCamera();post('/preview/stop').catch(()=>{});};
$('camera-start').onclick=async()=>{
    if(!selected?.bestReady)return;
    const generation=++cameraGeneration,runId=selected.id;
    $('camera-start').disabled=true;
    try {
        const media=await navigator.mediaDevices.getUserMedia({video:{width:{ideal:640},height:{ideal:480}},audio:false});
        if(generation!==cameraGeneration){media.getTracks().forEach(t=>t.stop());return;}
        stream=media;const video=$('camera-video');video.srcObject=media;await video.play();
        $('camera-stop').disabled=false;$('camera-output').hidden=false;
        const capture=document.createElement('canvas'),output=$('camera-output');
        while(stream&&generation===cameraGeneration) {
            if(document.hidden){await new Promise(resolve=>setTimeout(resolve,300));continue;}
            capture.width=video.videoWidth;capture.height=video.videoHeight;capture.getContext('2d').drawImage(video,0,0);
            const image=await new Promise(resolve=>capture.toBlob(resolve,'image/jpeg',.8));
            const confidence=Number($('camera-confidence').value);
            if(!Number.isFinite(confidence)||confidence<.01||confidence>1)throw new Error('Confidence must be between 0.01 and 1.');
            cameraRequest=new AbortController();$('camera-status').textContent='Detecting with best.pt…';
            const result=await api(`/runs/${runId}/predict?confidence=${confidence}`,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:image,signal:cameraRequest.signal});
            if(generation!==cameraGeneration)break;
            output.width=result.width;output.height=result.height;const ctx=output.getContext('2d');ctx.drawImage(capture,0,0,output.width,output.height);
            ctx.font='15px sans-serif';ctx.lineWidth=2;
            for(const box of result.boxes){const [x1,y1,x2,y2]=box.xyxy;ctx.strokeStyle='#2dd4bf';ctx.strokeRect(x1,y1,x2-x1,y2-y1);const text=`${box.label} ${(box.confidence*100).toFixed(0)}%`,y=Math.max(18,y1);ctx.fillStyle='#042f2e';ctx.fillRect(x1,y-18,ctx.measureText(text).width+8,20);ctx.fillStyle='#ffffff';ctx.fillText(text,x1+4,y-3);}
            $('camera-status').textContent=`${result.boxes.length} detections · ${result.milliseconds} ms inference · ${selected.settings.model} / best.pt`;
            await new Promise(resolve=>setTimeout(resolve,100));
        }
    }catch(error){if(generation===cameraGeneration){stopCamera();$('camera-status').textContent=error.message;}}
};
window.addEventListener('pagehide',stopCamera);
async function init() {
    const auth=await window.requireAuth();if(!auth)return;window.updateUserUI(auth.user);
    const params=new URLSearchParams(location.search);
    await poll();const id=params.get('run') || runs[0]?.id;if(id&&runs.some(r=>r.id===id))await selectRun(id);
    setInterval(poll,2000);
}
init().catch(error=>status(error.message));
