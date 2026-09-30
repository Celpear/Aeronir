import { AUDIO_SPLITS, splitUnassignedTracks } from './audio-splits.js';
import { Router } from 'express';
import multer from 'multer';
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseBuffer } from 'music-metadata';
import { createAudioExport } from './audio-export.js';

export function validateSegment(body, duration, labels) {
    const { start, end, labelId } = body;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || end > duration) throw new Error('Choose a segment within the track: 0 ≤ start < end ≤ duration.');
    if (!labels.some(label => label.id === labelId)) throw new Error('Choose a class from this dataset.');
    return { start, end, labelId };
}

export async function inspectAudio(buffer, name) {
    const ext = path.extname(name).toLowerCase();
    if (!['.wav', '.mp3'].includes(ext)) throw new Error('Only WAV and MP3 files are supported.');
    const { format } = await parseBuffer(buffer, { mimeType: ext === '.wav' ? 'audio/wav' : 'audio/mpeg' }, { duration: true });
    const validContainer = ext === '.wav' ? format.container === 'WAVE' : format.container === 'MPEG';
    if (!validContainer || !Number.isFinite(format.duration) || format.duration <= 0) throw new Error('Invalid or unreadable audio file.');
    if (format.duration > 3600) throw new Error('Tracks must be at most one hour long.');
    return { duration: format.duration, sampleRate: format.sampleRate, channels: format.numberOfChannels, ext };
}

export function audioDatasetsRouter({ db, directory }) {
    const router = Router();
    const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 100 * 1024 * 1024, files: 1 } });
    // Serialize audio reads and writes so requests cannot replace an in-flight snapshot.
    let queue = Promise.resolve();
    const route = fn => (req, res, next) => {
        const run = async () => { await db.read(); db.data.audioProjects ||= []; await fn(req, res); };
        const result = queue = queue.catch(() => {}).then(run);
        result.catch(next);
    };
    const project = (req, res) => {
        const value = db.data.audioProjects.find(p => p.id === req.params.id);
        if (!value) res.status(404).json({ error: 'Audio dataset not found.' });
        return value;
    };
    const save = async p => { p.updatedAt = new Date().toISOString(); await db.write(); };
    router.get('/', route(async (req, res) => res.json(db.data.audioProjects.map(p => ({
        id: p.id, name: p.name, description: p.description || '', createdAt: p.createdAt, updatedAt: p.updatedAt,
        stats: { trackCount: p.tracks.length, segmentCount: p.segments.length, labelCount: p.labels.length,
            splits: p.tracks.reduce((counts, t) => { counts[t.split]++; return counts; }, { train: 0, valid: 0, test: 0, unassigned: 0 }) }
    })).sort((a,b) => new Date(b.updatedAt) - new Date(a.updatedAt)))));
    router.post('/', route(async (req, res) => {
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (!name || name.length > 80) return res.status(400).json({ error: 'Enter a name of 1–80 characters.' });
        if (db.data.audioProjects.some(p => p.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'An audio dataset with this name already exists.' });
        const p = { id: randomUUID(), name, description: typeof req.body.description === 'string' ? req.body.description.trim().slice(0,200) : '', labels: [], tracks: [], segments: [], createdAt: new Date().toISOString() };
        db.data.audioProjects.push(p); await save(p); res.status(201).json(p);
    }));
    router.delete('/:id', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        await fs.rm(path.join(directory, p.id), { recursive: true, force: true });
        db.data.audioProjects = db.data.audioProjects.filter(item => item.id !== p.id);
        await db.write(); res.json({ success: true });
    }));
    router.get('/:id', route(async (req, res) => { const p = project(req, res); if (p) res.json(p); }));
    router.post('/:id/tracks', (req, res, next) => upload.single('audio')(req, res, err => err ? res.status(400).json({ error: err.message }) : next()), route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        if (!req.file) return res.status(400).json({ error: 'Select a WAV or MP3 file.' });
        const split = req.body.split || 'unassigned';
        if (!AUDIO_SPLITS.includes(split)) return res.status(400).json({ error: 'Invalid split.' });
        let meta;
        try { meta = await inspectAudio(req.file.buffer, req.file.originalname); }
        catch (err) { return res.status(400).json({ error: err.message }); }
        const id = randomUUID(), filename = id + meta.ext;
        await fs.mkdir(path.join(directory, p.id), { recursive: true });
        await fs.writeFile(path.join(directory, p.id, filename), req.file.buffer);
        const track = { id, filename, name: req.file.originalname, duration: meta.duration, sampleRate: meta.sampleRate, channels: meta.channels, split };
        p.tracks.push(track); await save(p); res.status(201).json(track);
    }));
    router.get('/:id/tracks/:trackId/file', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        const track = p.tracks.find(t => t.id === req.params.trackId);
        if (!track) return res.status(404).json({ error: 'Track not found.' });
        res.sendFile(path.join(directory, p.id, track.filename));
    }));
    router.delete('/:id/tracks/:trackId', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        const track = p.tracks.find(t => t.id === req.params.trackId);
        if (!track) return res.status(404).json({ error: 'Track not found.' });
        await fs.rm(path.join(directory, p.id, track.filename), { force: true });
        p.tracks = p.tracks.filter(t => t.id !== track.id);
        p.segments = p.segments.filter(s => s.trackId !== track.id);
        await save(p); res.json({ success: true });
    }));
    router.patch('/:id/tracks/:trackId', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        const track = p.tracks.find(t => t.id === req.params.trackId);
        if (!track) return res.status(404).json({ error: 'Track not found.' });
        if (!AUDIO_SPLITS.includes(req.body.split)) return res.status(400).json({ error: 'Invalid split.' });
        track.split = req.body.split; await save(p); res.json(track);
    }));
    router.post('/:id/auto-split', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        const result = splitUnassignedTracks(p.tracks);
        await save(p);
        res.json({ ...result, tracks: p.tracks });
    }));
    router.post('/:id/labels', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
        if (!name || name.length > 80) return res.status(400).json({ error: 'Enter a class name of 1–80 characters.' });
        if (p.labels.some(l => l.name.toLowerCase() === name.toLowerCase())) return res.status(400).json({ error: 'Class already exists.' });
        const label = { id: randomUUID(), name }; p.labels.push(label); await save(p); res.status(201).json(label);
    }));
    const storeSegment = editing => route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        const track = p.tracks.find(t => t.id === req.body.trackId);
        if (!track) return res.status(404).json({ error: 'Track not found.' });
        let values;
        try { values = validateSegment(req.body, track.duration, p.labels); }
        catch (err) { return res.status(400).json({ error: err.message }); }
        let segment = editing ? p.segments.find(s => s.id === req.params.segmentId && s.trackId === track.id) : { id: randomUUID(), trackId: track.id };
        if (!segment) return res.status(404).json({ error: 'Segment not found.' });
        Object.assign(segment, values);
        if (!editing) p.segments.push(segment);
        await save(p); res.status(editing ? 200 : 201).json(segment);
    });
    router.post('/:id/segments', storeSegment(false));
    router.patch('/:id/segments/:segmentId', storeSegment(true));
    router.delete('/:id/segments/:segmentId', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        p.segments = p.segments.filter(s => s.id !== req.params.segmentId); await save(p); res.json({ success: true });
    }));
    router.get('/:id/export', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        let bundle;
        try { bundle = await createAudioExport(p, directory); }
        catch (error) {
            console.error('Audio export failed:', error);
            return res.status(500).json({ error: error.message.includes('requires FFmpeg') ? error.message : 'Could not create the audio ZIP. Check that all source files are available and readable.' });
        }
        try {
            await new Promise((resolve, reject) => res.download(bundle.archive, 'audio-dataset.zip', error => error ? reject(error) : resolve()));
        } finally { await bundle.cleanup(); }
    }));
    router.get('/:id/export/annotations', route(async (req, res) => {
        const p = project(req, res); if (!p) return;
        res.attachment('audio-annotations.json').json({ version: 1, name: p.name, timeUnit: 'seconds', labels: p.labels, tracks: p.tracks.map(t => ({ ...t, audioUrl: `/api/audio-projects/${p.id}/tracks/${t.id}/file`, segments: p.segments.filter(s => s.trackId === t.id).map(s => ({ start: s.start, end: s.end, label: p.labels.find(l => l.id === s.labelId)?.name, labelId: s.labelId })) })) });
    }));
    router.use((err, req, res, next) => { console.error('Audio dataset error:', err); if (!res.headersSent) res.status(500).json({ error: 'Could not complete the audio dataset operation.' }); });
    return router;
}
