import { filteredTracks, adjacentTrack } from './audio-workflow.js';
const $ = id => document.getElementById(id);
let project, track, selectedSegment = null, samples = null, loadingGeneration = 0;
let playbackEnd = null, dragging = null, audioContext;
let savingSegment = false;
let deletingTrack = false;
let spectrumWorker = null, spectrumRequest = 0;
let selectionPreviewTimer, selectionPreviewRequest = null, selectionActive = false;
const spectrumRequests = new Map();
const spectrumModes = new Map();
const spectrumResults = new WeakMap();
const spectrumLatest = new WeakMap();
let selectionSpectrumMode = 'stft';
const spectrumResizeObserver = new ResizeObserver(entries => {
    for (const {target} of entries) {
        const result = spectrumResults.get(target);
        if (result && target.clientWidth) paintSpectrum(target, result);
    }
});
function spectrumToggle(mode) {
    return `<div class="spectrum-toggle" role="group" aria-label="Audio analysis view">${['fft','stft','mel','logmel','mfcc','cqt','psd'].map(value => `<button type="button" data-spectrum-mode="${value}" aria-pressed="${mode === value}">${({mel:'Mel',logmel:'Log-Mel',psd:'Welch PSD'})[value] || value.toUpperCase()}</button>`).join('')}</div>`;
}
function requestSegmentSpectrum(canvas) {
    const segment = project.segments.find(s => s.id === canvas.dataset.spectrum);
    if (!spectrumWorker || !segment || segment.trackId !== track?.id) return;
    const id = ++spectrumRequest;
    const previous = spectrumLatest.get(canvas);
    spectrumRequests.delete(previous);
    spectrumLatest.set(canvas, id);
    spectrumRequests.set(id, canvas);
    canvas.nextElementSibling.textContent = 'Rendering audio analysis…';
    spectrumWorker.postMessage({id, start:segment.start, end:segment.end, mode:spectrumModes.get(segment.id) || 'stft'});
}
const spectrumObserver = new IntersectionObserver(entries => {
    for (const entry of entries) if (entry.isIntersecting && spectrumWorker) {
        spectrumObserver.unobserve(entry.target);
        requestSegmentSpectrum(entry.target);
    }
}, {rootMargin:'100px'});
function hideSelectionPreview() {
    clearTimeout(selectionPreviewTimer);
    selectionPreviewRequest = null;
    $('audio-selection-preview').hidden = true;
}
function previewSelection() {
    clearTimeout(selectionPreviewTimer);
    selectionPreviewRequest = null;
    const {start, end} = selection();
    if (!selectionActive || !track || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > track.duration) {
        hideSelectionPreview(); return;
    }
    const preview = $('audio-selection-spectrum');
    spectrumResults.delete(preview);
    $('audio-selection-preview').hidden = false;
    preview.setAttribute('aria-label', `Audio analysis of selected audio from ${seconds(start)} to ${seconds(end)} seconds`);
    preview.getContext('2d').clearRect(0, 0, preview.width, preview.height);
    preview.nextElementSibling.textContent = spectrumWorker ? 'Updating selection preview…' : 'Loading audio for preview…';
    if (!spectrumWorker) return;
    selectionPreviewTimer = setTimeout(() => {
        selectionPreviewRequest = ++spectrumRequest;
        spectrumWorker.postMessage({ id: selectionPreviewRequest, start, end, mode: selectionSpectrumMode });
    }, 120);
}
function stopSpectrum() {
    selectionActive = false;
    hideSelectionPreview();
    spectrumWorker?.terminate(); spectrumWorker=null;
    spectrumRequests.clear(); spectrumObserver.disconnect();
}
function paintSpectrum(canvas, result) {
    spectrumResults.set(canvas, result);
    const width = Math.max(100, canvas.clientWidth), height = 200;
    const ratio = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * ratio); canvas.height = Math.round(height * ratio);
    const ctx=canvas.getContext('2d'), {columns,rows,values}=result;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const plotHeight = height - 32;
    if (result.mode === 'fft' || result.mode === 'psd') {
        const left = 45, right = width - 12, top = 16, bottom = height - 30;
        ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,width,height);
        ctx.font = '11px monospace';
        const axisMax=result.axisMax ?? 0, axisMin=result.axisMin ?? -80;
        for (let db = axisMax; db >= axisMin; db -= 20) {
            const y = top + (axisMax-db)/(axisMax-axisMin) * (bottom - top);
            ctx.strokeStyle = '#28323d'; ctx.beginPath(); ctx.moveTo(left,y); ctx.lineTo(right,y); ctx.stroke();
            ctx.fillStyle = '#aab7c4'; ctx.fillText(String(db),5,y+4);
        }
        ctx.fillText(result.unit || 'dB',5,10);
        const frequencyLabel = hz => hz >= 1000 ? `${(hz/1000).toFixed(1)} kHz` : `${hz} Hz`;
        let ticks;
        // Measure the actual labels, including the inward-aligned endpoints.
        for (let count=4; count>=1; count--) {
            ticks=Array.from({length:count+1},(_,i)=>{
                const text=frequencyLabel(result.nyquist*i/count),textWidth=ctx.measureText(text).width;
                const anchor=left+(right-left)*i/count;
                const x=i===0?anchor:i===count?anchor-textWidth:anchor-textWidth/2;
                return {text,x,end:x+textWidth};
            });
            if(ticks.every((tick,i)=>i===0||tick.x>=ticks[i-1].end+12)) break;
        }
        ctx.textAlign='left';
        for(const tick of ticks) ctx.fillText(tick.text,tick.x,height-8);
        ctx.textAlign = 'left'; ctx.strokeStyle = '#2dd4bf'; ctx.lineWidth = 1.5; ctx.beginPath();
        for (let bin=0; bin<values.length; bin++) {
            const x=left+bin/(values.length-1)*(right-left), y=top+(axisMax-Math.max(axisMin,Math.min(axisMax,values[bin])))/(axisMax-axisMin)*(bottom-top);
            if (bin===0) ctx.moveTo(x,y); else ctx.lineTo(x,y);
        }
        ctx.stroke(); return;
    }
    const mfccLimits = [1,1];
    if(result.mode==='mfcc') {
        for(let i=0;i<values.length;i++) {
            const group=i<columns?0:1;
            mfccLimits[group]=Math.max(mfccLimits[group],Math.abs(values[i]));
        }
    }
    const image=new ImageData(columns,rows);
    const stops=result.mode==='mfcc'?[[30,64,175],[96,165,250],[23,30,40],[251,146,60],[239,68,68]]:[[13,17,23],[45,27,87],[148,47,114],[235,105,71],[252,218,116]];
    for(let row=0;row<rows;row++) for(let col=0;col<columns;col++) {
        const limit=mfccLimits[row===0?0:1];
        const colorMin=result.mode==='mfcc'?-limit:(result.colorMin ?? -80);
        const colorMax=result.mode==='mfcc'?limit:(result.colorMax ?? 0);
        const level=Math.max(0,Math.min(1,(values[row*columns+col]-colorMin)/(colorMax-colorMin)))*4,base=Math.min(3,Math.floor(level)),fraction=level-base;
        const index=((rows-1-row)*columns+col)*4;
        for(let c=0;c<3;c++) image.data[index+c]=stops[base][c]*(1-fraction)+stops[base+1][c]*fraction;
        image.data[index+3]=255;
    }
    const bitmap=document.createElement('canvas');bitmap.width=columns;bitmap.height=rows;bitmap.getContext('2d').putImageData(image,0,0);
    ctx.fillStyle='#0d1117';ctx.fillRect(0,0,width,height);
    ctx.imageSmoothingEnabled=result.mode!=='mfcc';
    ctx.drawImage(bitmap,45,8,width-55,plotHeight);
    ctx.fillStyle='#aab7c4';ctx.font='11px monospace';
    if (result.mode === 'mfcc') {
        ctx.fillText('C12',2,16);ctx.fillText('C6',2,8+plotHeight/2);ctx.fillText('C0',2,8+plotHeight);
        ctx.strokeStyle='#8b949e';ctx.beginPath();
        const separator=8+plotHeight*(rows-1)/rows;
        ctx.moveTo(45,separator);ctx.lineTo(width-10,separator);ctx.stroke();
        canvas.nextElementSibling.textContent=`MFCC · C0 ±${mfccLimits[0].toFixed(1)} · C1–C12 ±${mfccLimits[1].toFixed(1)} · Separate color scales · Blue: negative / orange: positive · Channel 1`;
    } else if (result.mode === 'cqt') {
        const hz=value=>value>=1000?`${(value/1000).toFixed(1)}k`:`${Math.round(value)}Hz`;
        ctx.fillText(hz(result.frequencies.at(-1)),2,16);
        ctx.fillText(hz(result.frequencies[Math.floor(rows/2)]),2,8+plotHeight/2);
        ctx.fillText(hz(result.frequencies[0]),2,8+plotHeight);
    } else {
        ctx.fillText(`${(result.nyquist/1000).toFixed(1)}k`,2,16);
        const middle=['mel','logmel'].includes(result.mode)?700*(10**((2595*Math.log10(1+result.nyquist/700)/2)/2595)-1):result.nyquist/2;
        ctx.fillText(`${(middle/1000).toFixed(1)}k`,2,8+plotHeight/2);ctx.fillText('0 Hz',2,8+plotHeight);
    }
    ctx.fillText(`${result.start.toFixed(2)} s`,45,height-7);
    ctx.textAlign='right';ctx.fillText(`${result.end.toFixed(2)} s`,width-10,height-7);ctx.textAlign='left';
}
function startSpectrum(buffer) {
    const channel=buffer.getChannelData(0).slice();
    spectrumWorker=new Worker('/audio-spectrum-worker.js',{type:'module'});
    spectrumWorker.onmessage=({data})=>{
        const canvas=data.id === selectionPreviewRequest ? $('audio-selection-spectrum') : spectrumRequests.get(data.id);spectrumRequests.delete(data.id);
        if(!canvas?.isConnected)return;
        if(data.error){canvas.nextElementSibling.textContent=data.error;return;}
        canvas.nextElementSibling.textContent=`${data.result.caption || 'FFT · mean power · 4096-point Hann · −80…0 dB relative'} · Channel 1`;
        paintSpectrum(canvas,data.result);
    };
    spectrumWorker.onerror=()=>{document.querySelectorAll('.segment-spectrum figcaption').forEach(el=>{el.textContent='Spectrogram unavailable.';});};
    spectrumWorker.postMessage({type:'init',samples:channel,sampleRate:buffer.sampleRate},[channel.buffer]);
    renderSegments();
    previewSelection();
}
const player = $('audio-player');
const canvas = $('audio-wave');
const status = message => { $('audio-status').textContent = message; };
const endpoint = suffix => `/api/audio-projects/${project.id}${suffix}`;
const escape = value => String(value).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
async function api(url, options = {}) {
    if (options.body && !(options.body instanceof FormData)) options.headers = { 'Content-Type': 'application/json' };
    const response = await fetch(url, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
}
function action(fn) { return async event => { try { await fn(event); } catch (err) { status(err.message); } }; }
const seconds = n => Number(n).toFixed(3);
const selection = () => ({ start: Number($('audio-start').value), end: Number($('audio-end').value) });
function setSelection(start, end, preview = true) {
    selectionActive = preview;
    $('audio-start').value = seconds(start);
    // Floor the endpoint to avoid rounding beyond the source duration.
    $('audio-end').value = seconds(Math.min(end, Math.floor(track.duration * 1000) / 1000));
    draw();
    previewSelection();
}
function resetSegment() {
    selectedSegment = null; $('audio-save-segment').textContent = 'Save segment';
    if (track) setSelection(0, Math.min(1, track.duration), false);
}
async function loadProject(id) {
    stopSpectrum();
    player.pause(); playbackEnd = null; loadingGeneration++; samples = null; track = null;
    $('audio-track-editor').hidden = true; $('audio-editor').hidden = true; $('audio-export').hidden = true;
    if (!id) { project = null; return; }
    project = await api(`/api/audio-projects/${id}`);
    $('audio-editor').hidden = false;
    $('audio-export').hidden = false; $('audio-export').href = endpoint('/export');
    $('audio-project-title').textContent = project.name;
    $('audio-project-description').textContent = project.description || 'Label and inspect audio segments.';
    document.title = `${project.name} · Audio · Aeronir`;
    let resume = {};
    try { resume = JSON.parse(localStorage.getItem(`audio-progress-${project.id}`) || '{}'); } catch {}
    if ([...$('audio-track-filter').options].some(option => option.value === resume.filter)) $('audio-track-filter').value = resume.filter;
    render();
    const tracks = visibleTracks();
    if (tracks.length) await selectTrack(tracks.find(item => item.id === resume.trackId)?.id || tracks[0].id);
    else if (project.tracks.length) clearTrack();
    else $('audio-track-title').textContent = 'Upload your first track';
}
function rememberProgress() {
    try { localStorage.setItem(`audio-progress-${project.id}`, JSON.stringify({trackId:track?.id,filter:$('audio-track-filter').value})); } catch {}
}
const visibleTracks = () => filteredTracks(project, $('audio-track-filter').value);
function clearTrack() {
    player.pause(); player.removeAttribute('src'); player.load();
    stopSpectrum(); loadingGeneration++; samples = null; track = null; selectedSegment = null;
    $('audio-track-editor').hidden = true;
    $('audio-track-title').textContent = 'No tracks match this filter';
    render();
}
async function reconcileTrack() {
    const tracks = visibleTracks();
    if (!tracks.some(item => item.id === track?.id)) {
        if (tracks.length) await selectTrack(tracks[0].id);
        else clearTrack();
    } else render();
}
async function navigateTrack(direction) {
    if (savingSegment || deletingTrack || !project) return;
    const next = adjacentTrack(visibleTracks(), track?.id, direction);
    if (next && next.id !== track?.id) await selectTrack(next.id);
}
function renderNavigation() {
    const busy = savingSegment || deletingTrack;
    const tracks = visibleTracks();
    const index = tracks.findIndex(item => item.id === track?.id);
    $('audio-delete-track').disabled = !track || savingSegment || deletingTrack;
    $('audio-track-position').textContent = `${index + 1} / ${tracks.length}`;
    $('audio-prev').disabled = busy || tracks.length < 2;
    $('audio-next').disabled = busy || tracks.length < 2;
    $('audio-track-filter').disabled = busy;
    $('audio-split').disabled = busy;
    $('audio-save-segment').disabled = busy;
    $('audio-save-next').disabled = busy;
    $('audio-auto-split').disabled = busy || !project.tracks.some(item => item.split === 'unassigned');
    const counts = { unassigned: 0, train: 0, valid: 0, test: 0 };
    for (const item of project.tracks) counts[item.split]++;
    $('audio-split-counts').innerHTML = ['train','valid','test','unassigned'].map(split => `<span class="split-pill ${split}">${split === 'unassigned' ? 'open' : split} ${counts[split]}</span>`).join('');
}
function render() {
    $('audio-project-stats').textContent = `${project.tracks.length} tracks · ${project.labels.length} classes · ${project.segments.length} segments`;
    const labelId = $('audio-label').value;
    $('audio-label').innerHTML = '<option value="">Choose a class</option>' + project.labels.map(l => `<option value="${l.id}">${escape(l.name)}</option>`).join('');
    if (project.labels.some(l => l.id === labelId)) $('audio-label').value = labelId;
    else if (project.labels.length === 1) $('audio-label').value = project.labels[0].id;
    $('audio-classes').textContent = project.labels.map(l => l.name).join(' · ') || 'Add a class to label segments.';
    renderNavigation();
    $('audio-tracks').innerHTML = visibleTracks().map(t => `<button class="audio-track ${t.id === track?.id ? 'active' : ''}" data-track="${t.id}"><strong>${escape(t.name)}</strong><small>${seconds(t.duration)} s · <span class="split-pill ${escape(t.split)}">${escape(t.split)}</span> · ${project.segments.filter(s => s.trackId === t.id).length} segments</small></button>`).join('') || '<p>No tracks match this filter.</p>';
    document.querySelectorAll('[data-track]').forEach(button => button.onclick = action(() => selectTrack(button.dataset.track)));
    renderSegments();
}
function renderSegments() {
    spectrumObserver.disconnect(); spectrumRequests.clear();
    spectrumResizeObserver.disconnect();
    spectrumResizeObserver.observe($('audio-selection-spectrum'));
    const segments = project.segments.filter(s => s.trackId === track?.id).sort((a,b) => a.start-b.start);
    $('audio-segments').innerHTML = segments.map(s => `<div class="audio-segment"><div class="audio-segment-header"><button class="audio-segment-select" data-segment="${s.id}"><strong>${escape(project.labels.find(l => l.id === s.labelId)?.name || '')}</strong><span>${seconds(s.start)} – ${seconds(s.end)} s</span></button><button class="export-btn" data-play-segment="${s.id}" aria-label="Play segment ${seconds(s.start)} to ${seconds(s.end)}">▶ Play</button><button class="export-btn" data-delete="${s.id}" aria-label="Delete segment ${seconds(s.start)} to ${seconds(s.end)}">Delete</button></div><figure class="segment-spectrum">${spectrumToggle(spectrumModes.get(s.id) || 'stft')}<canvas width="340" height="200" data-spectrum="${s.id}" role="img" aria-label="Audio analysis for ${escape(project.labels.find(l => l.id === s.labelId)?.name || 'segment')} from ${seconds(s.start)} to ${seconds(s.end)} seconds"></canvas><figcaption>${spectrumWorker ? 'Rendering audio analysis…' : 'Loading audio for spectrogram…'}</figcaption></figure></div>`).join('') || '<p class="hint">No labeled segments yet.</p>';
    document.querySelectorAll('[data-spectrum]').forEach(canvas => {
        spectrumObserver.observe(canvas); spectrumResizeObserver.observe(canvas);
    });
    document.querySelectorAll('[data-segment]').forEach(button => button.onclick = () => {
        const segment = project.segments.find(s => s.id === button.dataset.segment);
        selectedSegment = segment.id; $('audio-label').value = segment.labelId;
        $('audio-save-segment').textContent = 'Update segment';
        setSelection(segment.start, segment.end); player.currentTime = segment.start;
        $('audio-wave-scroll').scrollLeft = segment.start / track.duration * canvas.width - 40;
    });
    document.querySelectorAll('[data-play-segment]').forEach(button => button.onclick = action(async () => {
        const segment = project.segments.find(s => s.id === button.dataset.playSegment);
        if (!segment || segment.trackId !== track?.id) return;
        selectedSegment = segment.id; $('audio-label').value = segment.labelId;
        $('audio-save-segment').textContent = 'Update segment';
        setSelection(segment.start, segment.end);
        await playSelection();
    }));
    document.querySelectorAll('[data-delete]').forEach(button => button.onclick = action(async () => {
        if (!confirm('Delete this labeled segment?')) return;
        await api(endpoint(`/segments/${button.dataset.delete}`), { method: 'DELETE' });
        project.segments = project.segments.filter(s => s.id !== button.dataset.delete);
        resetSegment(); render(); draw(); status('Segment deleted.');
    }));
}
async function selectTrack(id) {
    if (savingSegment || deletingTrack) return;
    stopSpectrum();
    player.pause(); playbackEnd = null;
    const generation = ++loadingGeneration;
    track = project.tracks.find(t => t.id === id); samples = null;
    rememberProgress();
    $('audio-track-title').textContent = track.name;
    $('audio-track-editor').hidden = false; $('audio-split').value = track.split;
    $('audio-zoom').value = 1;
    $('audio-start').max = track.duration; $('audio-end').max = track.duration;
    player.src = endpoint(`/tracks/${track.id}/file`);
    $('audio-seek').max = track.duration;
    $('audio-seek').value = 0;
    resetSegment(); render(); draw(); status('Loading waveform…');
    try {
        const response = await fetch(player.src);
        if (!response.ok) throw new Error('Could not load audio.');
        audioContext ||= new AudioContext();
        const buffer = await audioContext.decodeAudioData(await response.arrayBuffer());
        if (generation !== loadingGeneration) return;
        // Retain compact waveform peaks; the worker owns one channel for spectral previews.
        const stride = Math.ceil(buffer.length / 60000), count = Math.ceil(buffer.length / stride);
        samples = new Float32Array(count);
        for (let channel = 0; channel < buffer.numberOfChannels; channel++) {
            const values = buffer.getChannelData(channel);
            for (let i = 0; i < count; i++) for (let j = i*stride; j < Math.min((i+1)*stride, values.length); j++) samples[i] = Math.max(samples[i], Math.abs(values[j]));
        }
        startSpectrum(buffer);
        status('Drag on the waveform or enter times to label a segment.'); draw();
    } catch (err) {
        if (generation === loadingGeneration) {
            status('Waveform unavailable. You can still use playback and the start/end fields if your browser supports this file.');
            document.querySelectorAll('.segment-spectrum figcaption').forEach(el => { el.textContent = 'Spectrogram unavailable: audio could not be decoded.'; });
        }
    }
}
function draw() {
    if (!track || $('audio-track-editor').hidden) return;
    const width = Math.max(300, $('audio-wave-scroll').clientWidth) * Number($('audio-zoom').value);
    canvas.width = width;
    const ctx = canvas.getContext('2d'), h = canvas.height;
    ctx.fillStyle = '#0d1117'; ctx.fillRect(0,0,width,h);
    ctx.strokeStyle = '#14b8a6'; ctx.beginPath();
    if (samples) for (let x=0;x<width;x++) {
        let peak=0;
        for(let i=Math.floor(x/width*samples.length);i<Math.max(Math.floor(x/width*samples.length)+1,Math.floor((x+1)/width*samples.length));i++) peak=Math.max(peak,samples[i] || 0);
        ctx.moveTo(x,h/2-peak*65);ctx.lineTo(x,h/2+peak*65);
    }
    ctx.stroke();
    for (const s of project.segments.filter(s=>s.trackId===track.id)) {
        ctx.fillStyle='#a855f733';ctx.fillRect(s.start/track.duration*width,22,(s.end-s.start)/track.duration*width,h-22);
    }
    const {start,end}=selection();
    ctx.fillStyle='#14b8a644';ctx.fillRect(start/track.duration*width,22,(end-start)/track.duration*width,h-22);
    ctx.strokeStyle='#2dd4bf';ctx.strokeRect(start/track.duration*width,22,(end-start)/track.duration*width,h-23);
    // Label only the visible part of an interval, so text stays readable when zoomed and scrolled.
    const viewport = $('audio-wave-scroll');
    const occupied = [];
    ctx.font = '600 13px sans-serif';
    for (const segment of project.segments.filter(s => s.trackId === track.id).sort((a,b) => a.start-b.start)) {
        const label = project.labels.find(l => l.id === segment.labelId)?.name;
        if (!label) continue;
        const left = Math.max(segment.start / track.duration * width, viewport.scrollLeft);
        const right = Math.min(segment.end / track.duration * width, viewport.scrollLeft + viewport.clientWidth);
        const textWidth = ctx.measureText(label).width;
        if (right - left < textWidth + 16) continue;
        const x = left + 8;
        const row = occupied.findIndex(end => end + 8 < x);
        const lane = row < 0 ? occupied.length : row;
        if (32 + lane * 24 > h - 22) continue;
        occupied[lane] = x + textWidth;
        ctx.fillStyle = '#29153e';ctx.fillRect(x - 4, 28 + lane * 24, textWidth + 8, 20);
        ctx.fillStyle = '#f3e8ff';ctx.fillText(label, x, 42 + lane * 24);
    }
    ctx.fillStyle='#8b949e';ctx.font='12px monospace';
    const ticks=Math.max(2,Math.floor(width/100));
    for(let i=0;i<=ticks;i++) ctx.fillText((i/ticks*track.duration).toFixed(1)+'s',i/ticks*width+3,15);
    ctx.fillStyle='#ffffff';ctx.fillRect(player.currentTime/track.duration*width,22,2,h-22);
    $('audio-seek').value = player.currentTime;
    $('audio-time').textContent = `${seconds(player.currentTime)} / ${seconds(track.duration)} s`;
}
function pointerTime(event) {
    const rect=canvas.getBoundingClientRect(); return Math.max(0,Math.min(track.duration,(event.clientX-rect.left)/rect.width*track.duration));
}
canvas.addEventListener('pointerdown', event => {
    if (!track) return;
    selectedSegment=null; $('audio-save-segment').textContent='Save segment';
    dragging=pointerTime(event);canvas.setPointerCapture(event.pointerId);setSelection(dragging,dragging);
});
canvas.addEventListener('pointermove', event => {if(dragging!==null){const time=pointerTime(event);setSelection(Math.min(dragging,time),Math.max(dragging,time));}});
canvas.addEventListener('pointerup', () => { dragging=null; });
canvas.addEventListener('pointercancel', () => { dragging=null; });
$('audio-play').onclick=action(async()=>{playbackEnd=null;if(player.paused)await player.play();else player.pause();});
$('audio-stop').onclick=()=>{player.pause();playbackEnd=null;player.currentTime=0;draw();};
$('audio-seek').oninput=()=>{playbackEnd=null;player.currentTime=Number($('audio-seek').value);draw();};
function watchSelectionEnd() {
    if (player.paused) return;
    if (playbackEnd !== null && player.currentTime >= playbackEnd) {
        player.pause(); player.currentTime = playbackEnd; playbackEnd = null; draw(); return;
    }
    requestAnimationFrame(watchSelectionEnd);
}
player.addEventListener('play',()=>{$('audio-play').textContent='Pause';requestAnimationFrame(watchSelectionEnd);});
player.addEventListener('pause',()=>{$('audio-play').textContent='Play track';});
player.addEventListener('timeupdate', () => { if(playbackEnd!==null && player.currentTime>=playbackEnd){player.pause();player.currentTime=playbackEnd;playbackEnd=null;} draw(); });
player.addEventListener('error', () => status('This audio file could not be played by your browser.'));
$('audio-editor').addEventListener('click', event => {
    const button = event.target.closest('[data-spectrum-mode]');
    if (!button) return;
    const figure = button.closest('.segment-spectrum');
    const canvas = figure.querySelector('canvas');
    const mode = button.dataset.spectrumMode;
    figure.querySelectorAll('[data-spectrum-mode]').forEach(item => item.setAttribute('aria-pressed', String(item === button)));
    if (canvas.id === 'audio-selection-spectrum') {
        selectionSpectrumMode = mode; previewSelection();
    } else {
        spectrumModes.set(canvas.dataset.spectrum, mode);
        requestSegmentSpectrum(canvas);
    }
});
$('audio-zoom').oninput=draw;
window.addEventListener('resize',draw);
$('audio-wave-scroll').addEventListener('scroll',draw);
$('audio-start').oninput=$('audio-end').oninput=()=>{selectionActive=true;draw();previewSelection();};
$('audio-new-segment').onclick=resetSegment;
async function playSelection() {
    const {start,end}=selection();
    if(!track || !Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start || end>track.duration) throw new Error('Choose a valid start and end within the track.');
    player.pause();
    player.currentTime=start; playbackEnd=end;
    try { await player.play(); status(`Playing selection: ${seconds(start)}–${seconds(end)} s`); }
    catch(err) { playbackEnd=null; throw err; }
}
$('audio-play-selection').onclick=action(playSelection);
$('audio-preview-play').onclick=action(playSelection);
$('audio-delete-track').onclick=action(async()=>{
    if(!track || savingSegment || deletingTrack) return;
    const source=track;
    if(!confirm(`Delete "${source.name}" and all of its labeled segments? This cannot be undone.`)) return;
    deletingTrack=true; renderNavigation();
    try {
        await api(endpoint(`/tracks/${source.id}`),{method:'DELETE'});
        project.tracks=project.tracks.filter(item=>item.id!==source.id);
        project.segments=project.segments.filter(item=>item.trackId!==source.id);
        playbackEnd=null; clearTrack();
    } finally { deletingTrack=false;renderNavigation(); }
    await reconcileTrack(); rememberProgress();status('Track and its labeled segments deleted.');
});
$('audio-add-class').onsubmit=action(async event=>{event.preventDefault();const label=await api(endpoint('/labels'),{method:'POST',body:JSON.stringify({name:$('audio-class-name').value})});project.labels.push(label);$('audio-add-class').reset();render();$('audio-label').value=label.id;status('Class added.');});
$('audio-split').onchange=action(async()=>{
    const source = track;
    try {
        const updated=await api(endpoint(`/tracks/${source.id}`),{method:'PATCH',body:JSON.stringify({split:$('audio-split').value})});
        Object.assign(source,updated); await reconcileTrack(); status('Track split saved. All its segments stay together.');
    } catch (err) { if(track?.id === source.id) $('audio-split').value=source.split; throw err; }
});
$('audio-track-filter').onchange=action(async()=>{await reconcileTrack();rememberProgress();});
$('audio-prev').onclick=action(()=>navigateTrack(-1));
$('audio-next').onclick=action(()=>navigateTrack(1));
$('audio-auto-split').onclick=action(async()=>{
    if(!confirm('Randomly assign all unassigned tracks to train/valid/test (80/15/5)? Existing assignments stay unchanged.')) return;
    $('audio-auto-split').disabled=true;
    try {
        const result=await api(endpoint('/auto-split'),{method:'POST',body:JSON.stringify({})});
        for(const updated of result.tracks) Object.assign(project.tracks.find(item=>item.id===updated.id),updated);
        await reconcileTrack();
        status(`Assigned ${result.updated} tracks: ${result.splits.train} train, ${result.splits.valid} validation, ${result.splits.test} test.`);
    } finally { renderNavigation(); }
});
document.addEventListener('keydown', action(async event=>{
    if(event.target.closest('input,select,textarea,button,[contenteditable="true"]') || event.ctrlKey || event.metaKey || event.altKey) return;
    if(event.key==='ArrowLeft' || event.key==='ArrowRight') {
        event.preventDefault(); await navigateTrack(event.key==='ArrowLeft'?-1:1);
    }
}));
$('audio-segment-form').onsubmit=action(async event=>{
    event.preventDefault(); if(savingSegment || !track) return;
    const advance = event.submitter?.id === 'audio-save-next';
    const source = track;
    const nextId = adjacentTrack(visibleTracks(), source.id, 1)?.id;
    savingSegment=true; $('audio-save-segment').disabled=true; $('audio-save-next').disabled=true; renderNavigation();
    let saved = false;
    try {
        const segment=await api(endpoint(selectedSegment?`/segments/${selectedSegment}`:'/segments'),{method:selectedSegment?'PATCH':'POST',body:JSON.stringify({...selection(),labelId:$('audio-label').value,trackId:source.id})});
        project.segments=project.segments.filter(s=>s.id!==segment.id);project.segments.push(segment);
        resetSegment(); render(); draw(); saved=true;
    } finally {
        savingSegment=false; $('audio-save-segment').disabled=false; $('audio-save-next').disabled=false; renderNavigation();
    }
    if(saved) {
        if(advance && nextId !== source.id && visibleTracks().some(item=>item.id===nextId)) await selectTrack(nextId);
        else await reconcileTrack();
        status(advance ? (track && track.id!==source.id ? 'Segment saved. Continue with the next track.' : 'Segment saved. No further tracks in this filter.') : 'Segment saved.');
    }
});

let uploading=false;
async function uploadFiles(files){
    if(!project || uploading)return; uploading=true;
    const errors=[];
    const uploadSplit=$('audio-upload-split').value;
    try{
        for(const file of files){
            status(`Uploading ${file.name}…`);
            try{
                if(!/\.(wav|mp3)$/i.test(file.name) || file.size>100*1024*1024)throw new Error('Use WAV or MP3 files up to 100 MB.');
                const form=new FormData();form.append('audio',file);form.append('split',uploadSplit);
                const item=await api(endpoint('/tracks'),{method:'POST',body:form});project.tracks.push(item);render();
            }catch(err){errors.push(`${file.name}: ${err.message}`);}
        }
        await reconcileTrack();
        status(errors.length?errors.join(' '):'Upload complete. Choose a track to start labeling.');
    }finally{uploading=false;$('audio-upload').value='';}
}
$('audio-upload').onchange=action(event=>uploadFiles([...event.target.files]));
$('audio-dropzone').ondragover=event=>{event.preventDefault();};
$('audio-dropzone').ondrop=action(event=>{event.preventDefault();return uploadFiles([...event.dataTransfer.files]);});
(async()=>{try{const auth=await requireAuth();if(!auth)return;updateUserUI(auth.user);if(auth.user.role==='admin'){$('admin-link').style.display='';$('db-link').style.display='';}const id=new URLSearchParams(location.search).get('id');if(!id){location.replace('/audio-datasets');return;}await loadProject(id);}catch(err){status(err.message);}})();
