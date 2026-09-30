import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseFile } from 'music-metadata';

const run = promisify(execFile);
const sampleRate = 48000;
const splits = ['train', 'validation', 'test', 'unassigned'];
const splitName = value => value === 'valid' ? 'validation' : splits.includes(value) ? value : 'unassigned';
const slug = value => value.normalize('NFKD').replace(/[^a-zA-Z0-9_-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 60) || 'class';
const json = (file, data) => fs.writeFile(file, JSON.stringify(data, null, 2) + '\n');

// Build on disk so large datasets never accumulate audio or ZIP bytes in JS memory.
export async function createAudioExport(project, directory) {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'aeronir-export-'));
    const cleanup = () => fs.rm(temporary, { recursive: true, force: true });
    try {
        try {
            await run('ffmpeg', ['-version']);
            await run('zip', ['-v']);
        } catch {
            throw new Error('Audio ZIP export requires FFmpeg and zip installed on the server.');
        }
        const root = path.join(temporary, 'dataset');
        for (const split of splits) for (const kind of ['segments', 'originals']) {
            await fs.mkdir(path.join(root, kind, split), { recursive: true });
        }
        await fs.mkdir(path.join(root, 'manifests'));
        const labels = project.labels.map((label, index) => ({ ...label, index, folder: `${slug(label.name)}__${label.id}` }));
        const annotations = {
            version: 2, datasetId: project.id, name: project.name, description: project.description || '',
            timeUnit: 'seconds', intervalConvention: '[start, end)',
            segmentFormat: { container: 'WAV', codec: 'PCM signed 16-bit', sampleRate, channels: 1 },
            labels, tracks: [], segments: []
        };
        for (const track of project.tracks) {
            const split = splitName(track.split);
            const originalPath = `originals/${split}/${track.id}${path.extname(track.filename)}`;
            const source = path.join(directory, project.id, track.filename);
            await fs.copyFile(source, path.join(root, originalPath));
            const segments = project.segments.filter(s => s.trackId === track.id);
            annotations.tracks.push({ id: track.id, originalName: track.name, path: originalPath, split,
                duration: track.duration, sampleRate: track.sampleRate, channels: track.channels,
                segments: segments.map(s => ({ id: s.id, start: s.start, end: s.end, labelId: s.labelId,
                    label: labels.find(l => l.id === s.labelId)?.name })) });
            if (!segments.length) continue;
            // Decode each source once, including MP3 encoder-delay handling, to a common sample grid.
            const pcm = path.join(temporary, 'decoded.wav');
            await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-i', source, '-map', '0:a:0', '-vn',
                '-ac', '1', '-ar', String(sampleRate), '-c:a', 'pcm_s16le', pcm], { maxBuffer: 1024 * 1024 });
            const decoded = await parseFile(pcm);
            const decodedSamples = Math.round(decoded.format.duration * sampleRate);
            for (const segment of segments) {
                const label = labels.find(l => l.id === segment.labelId);
                if (!label) throw new Error('A segment references a missing class.');
                const startSample = Math.round(segment.start * sampleRate);
                const endSample = Math.min(decodedSamples, Math.max(startSample + 1, Math.round(segment.end * sampleRate)));
                if (startSample >= endSample) throw new Error('A selected segment is beyond the decoded audio duration.');
                const clipPath = `segments/${split}/${label.folder}/${track.id}__${segment.id}.wav`;
                await fs.mkdir(path.dirname(path.join(root, clipPath)), { recursive: true });
                await run('ffmpeg', ['-nostdin', '-v', 'error', '-y', '-ss', String(startSample / sampleRate),
                    '-i', pcm, '-t', String((endSample - startSample) / sampleRate), '-c:a', 'pcm_s16le',
                    path.join(root, clipPath)], { maxBuffer: 1024 * 1024 });
                annotations.segments.push({ id: segment.id, trackId: track.id, split, path: clipPath,
                    label: label.name, labelId: label.id, classIndex: label.index, originalPath,
                    start: segment.start, end: segment.end, startSample, endSample,
                    effectiveStart: startSample / sampleRate, effectiveEnd: endSample / sampleRate,
                    duration: (endSample - startSample) / sampleRate,
                    annotations: segments.filter(s => s.start < segment.end && s.end > segment.start).map(s => ({
                        labelId: s.labelId, label: labels.find(l => l.id === s.labelId)?.name,
                        start: Math.max(0, s.start - startSample / sampleRate),
                        end: Math.min((endSample - startSample) / sampleRate, s.end - startSample / sampleRate)
                    })) });
            }
            await fs.rm(pcm);
        }
        await json(path.join(root, 'annotations.json'), annotations);
        for (const split of splits) {
            await json(path.join(root, 'manifests', `${split}.json`), {
                split, labels, segmentFormat: annotations.segmentFormat,
                tracks: annotations.tracks.filter(t => t.split === split),
                segments: annotations.segments.filter(s => s.split === split)
            });
        }
        await fs.writeFile(path.join(root, 'README.md'), `# ${project.name.replace(/[\r\n]/g, ' ')} — audio dataset\n\n` +
            'segments/<split>/<class>__<class-id>/<track-id>__<segment-id>.wav\n' +
            'originals/<split>/<track-id>.wav or .mp3\nmanifests/<split>.json\nannotations.json\n\n' +
            'Splits: train, validation, test, unassigned. Every segment inherits its original track split.\n' +
            'Train on segments/train; tune on segments/validation; evaluate on segments/test.\n' +
            'Unassigned data is excluded from those splits until you assign it in the editor.\n' +
            'Clips are mono 48 kHz PCM 16-bit WAV without loudness normalization. Sources are byte-for-byte originals.\n' +
            'All JSON paths are relative to this dataset folder. Class names and stable IDs are in labels.\n' +
            'Each clip records originalPath, trackId, and start/end seconds in the original. startSample/endSample\n' +
            'use the decoded 48 kHz sample grid, with an exclusive end (rounding within one sample).\n' +
            'effectiveStart/effectiveEnd describe the actual crop; MP3 padding beyond decoded audio is omitted.\n' +
            'Run temporal detection on originals/test and compare predicted class/time intervals with tracks[].segments.\n' +
            'Do not train on validation/test originals or their clips. Unlabeled intervals are not confirmed negatives.\n' +
            'Overlapping sounds remain audible: segment annotations include all intersecting labels in clip-local seconds.\n' +
            'Class folders identify the primary label; use JSON annotations for multilabel training.\n' +
            'These are audio training examples, not YOLO image annotations.\n');
        const archive = path.join(temporary, 'audio-dataset.zip');
        await run('zip', ['-q', '-r', '-0', archive, '.'], { cwd: root, maxBuffer: 1024 * 1024 });
        return { archive, cleanup };
    } catch (error) { await cleanup(); throw error; }
}
