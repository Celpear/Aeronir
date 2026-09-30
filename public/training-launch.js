const dialog = document.createElement('dialog');
dialog.className = 'management-dialog';
dialog.setAttribute('aria-labelledby', 'launch-title');
dialog.innerHTML = `<header class="dialog-header"><div><p class="eyebrow">YOLO TRAINING</p><h2 id="launch-title">Train model</h2></div><button type="button" class="icon-action" id="launch-close" aria-label="Close training settings">✕</button></header><p id="launch-environment" class="hint">Checking environment…</p><form id="launch-form">
<p id="launch-source-info" class="hint"></p>
<div class="training-fields">
<label>Model<select id="launch-model"><option>yolo12n</option><option>yolo12s</option><option>yolo12m</option><option>yolo11n</option><option>yolo11s</option><option>yolov8n</option><option>yolov8s</option></select></label>
<label>Epochs<input id="launch-epochs" type="number" min="1" max="1000" value="50" required></label>
<label>Image size<input id="launch-imgsz" type="number" min="64" max="1536" step="32" value="640" required></label>
<label>Batch size<input id="launch-batch" type="number" min="1" max="64" value="4" required></label>
<label>Device<select id="launch-device"><option value="auto">Auto</option><option value="cpu">CPU</option><option value="mps">Apple MPS</option><option value="0">CUDA GPU 0</option></select></label>
</div><details class="training-advanced"><summary>Advanced settings</summary><div class="training-fields"><label>Early stopping patience<input id="launch-patience" type="number" min="0" max="1000" value="20" required></label>
<label>Random seed<input id="launch-seed" type="number" min="0" max="2147483647" value="42" required></label>
</div></details>
<p class="hint">Runs on the Aeronir server. The first run downloads pretrained weights. Patience 0 disables early stopping. Start with a small batch if memory is limited.</p>
<button id="launch-start" class="export-btn primary" disabled>Start training</button>
</form><p id="launch-status" role="status" aria-live="polite"></p>`;
document.body.append(dialog);
const $ = id => dialog.querySelector('#' + id);
let source, busy = false, generation = 0;
async function api(path, options) {
    const response = await fetch('/api/training' + path, options);
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'Request failed.');
    return data;
}
$('launch-close').onclick = () => { if (!busy) dialog.close(); };
dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
document.addEventListener('click', async event => {
    const button = event.target.closest('[data-train-source]');
    if (!button || busy) return;
    source = button.dataset.trainSource;
    const request = ++generation;
    $('launch-form').reset(); $('launch-start').disabled = true;
    $('launch-title').textContent = 'Train model'; $('launch-source-info').textContent = '';
    $('launch-status').textContent = ''; $('launch-environment').textContent = 'Checking training environment…';
    dialog.showModal();
    try {
        const [datasets, environment, runs] = await Promise.all([api('/datasets'), api('/environment'), api('/runs')]);
        if (request !== generation) return;
        const dataset = datasets.find(item => item.id === source);
        $('launch-title').textContent = dataset ? 'Train · ' + dataset.name : 'Dataset unavailable';
        $('launch-environment').textContent = environment.ready ? `Ultralytics ${environment.version} · Devices: ${environment.devices.join(', ')}` : environment.error;
        $('launch-source-info').textContent = dataset?.ready ? `${dataset.classes} classes · ${dataset.counts.train} train · ${dataset.counts.valid} validation · ${dataset.counts.test} test. Original images and labels are preserved in a training snapshot.` : dataset?.error || 'Dataset no longer exists.';
        for (const option of $('launch-device').options) option.disabled = option.value !== 'auto' && !environment.devices?.includes(option.value);
        const running = runs.some(run => ['preparing', 'running', 'stopping'].includes(run.status));
        if (running) $('launch-status').textContent = 'A run is already active. Open Training runs to view or stop it.';
        $('launch-start').disabled = !dataset?.ready || !environment.ready || running;
    } catch (error) { $('launch-status').textContent = error.message; }
});
$('launch-form').onsubmit = async event => {
    event.preventDefault(); if (busy) return;
    busy = true; $('launch-start').disabled = true; $('launch-close').disabled = true;
    $('launch-status').textContent = 'Preparing your training run…';
    const body = { source, model: $('launch-model').value, device: $('launch-device').value };
    for (const key of ['epochs', 'imgsz', 'batch', 'patience', 'seed']) body[key] = Number($('launch-' + key).value);
    try {
        const run = await api('/runs', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
        location.href = '/training?run=' + encodeURIComponent(run.id);
    } catch (error) { $('launch-status').textContent = error.message; $('launch-start').disabled = false; }
    finally { busy = false; $('launch-close').disabled = false; }
};
