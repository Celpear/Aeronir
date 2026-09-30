import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { parseBuffer } from 'music-metadata';
import { createAudioExport } from '../lib/audio-export.js';
const run = promisify(execFile);
function sourceWav() {
    const data = Buffer.alloc(44 + 48000 * 2 * 2);
    data.write('RIFF'); data.writeUInt32LE(data.length-8,4); data.write('WAVEfmt ',8);
    data.writeUInt32LE(16,16); data.writeUInt16LE(1,20); data.writeUInt16LE(1,22);
    data.writeUInt32LE(48000,24); data.writeUInt32LE(96000,28); data.writeUInt16LE(2,32);
    data.writeUInt16LE(16,34); data.write('data',36); data.writeUInt32LE(data.length-44,40);
    // Sound followed by silence makes a wrong crop offset observable.
    for (let i=0;i<48000;i++) data.writeInt16LE(Math.round(12000*Math.sin(i*440*2*Math.PI/48000)),44+i*2);
    return data;
}
test('ZIP contains exact originals, correctly cropped WAV/MP3 segments, split manifests and source references', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'audio-export-test-'));
    let bundle;
    try {
        await fs.mkdir(path.join(directory, 'project'));
        const wav=sourceWav(), mp3=await fs.readFile(new URL('fixtures/tone.mp3',import.meta.url));
        await fs.writeFile(path.join(directory,'project','wave.wav'),wav);
        await fs.writeFile(path.join(directory,'project','mpeg.mp3'),mp3);
        const project={id:'project',name:'Dataset',labels:[{id:'a',name:'../lawn/mower'},{id:'b',name:'lawn mower'}],tracks:[
            {id:'wave',filename:'wave.wav',name:'source.wav',duration:2,sampleRate:48000,channels:1,split:'train'},
            {id:'mpeg',filename:'mpeg.mp3',name:'source.mp3',duration:2.088,sampleRate:44100,channels:1,split:'valid'}
        ],segments:[
            {id:'tone',trackId:'wave',labelId:'a',start:.2,end:.6},
            {id:'overlap',trackId:'wave',labelId:'b',start:.4,end:.8},
            {id:'silence',trackId:'wave',labelId:'b',start:1.1,end:1.6},
            {id:'mp3',trackId:'mpeg',labelId:'a',start:.3,end:1.3}
        ]};
        bundle=await createAudioExport(project,directory);
        const read=async name=>(await run('unzip',['-p',bundle.archive,name],{encoding:'buffer',maxBuffer:1024*1024})).stdout;
        const annotations=JSON.parse(await read('annotations.json'));
        assert.deepEqual(await read('originals/train/wave.wav'),wav);
        assert.deepEqual(await read('originals/validation/mpeg.mp3'),mp3);
        assert.equal(annotations.segments.length,4);
        assert.notEqual(annotations.labels[0].folder,annotations.labels[1].folder);
        assert.ok(annotations.labels.every(l=>!l.folder.includes('/')&&!l.folder.includes('..')));
        const train=JSON.parse(await read('manifests/train.json'));
        const valid=JSON.parse(await read('manifests/validation.json'));
        assert.equal(train.segments.length,3); assert.equal(valid.segments.length,1);
        assert.equal(JSON.parse(await read('manifests/unassigned.json')).segments.length,0);
        for(const segment of annotations.segments) {
            assert.equal(segment.originalPath,annotations.tracks.find(t=>t.id===segment.trackId).path);
            assert.equal(segment.split,annotations.tracks.find(t=>t.id===segment.trackId).split);
            const clip=await read(segment.path), {format}=await parseBuffer(clip);
            assert.equal(format.sampleRate,48000);assert.equal(format.numberOfChannels,1);assert.equal(format.bitsPerSample,16);
            assert.ok(Math.abs(format.duration-(segment.end-segment.start))<1/48000);
            if(segment.id==='silence') {
                const i=clip.indexOf(Buffer.from('data'));
                assert.ok(i>=0);assert.ok(clip.subarray(i+8).every(byte=>byte===0),'silence crop must not include the earlier tone');
            }
        }
        const tone=annotations.segments.find(s=>s.id==='tone');
        assert.equal(tone.startSample,9600);assert.equal(tone.endSample,28800);
        assert.equal(tone.annotations.length,2);
        assert.ok(Math.abs(tone.annotations[1].start-.2)<1e-9);
        await bundle.cleanup();await assert.rejects(fs.stat(bundle.archive),{code:'ENOENT'});
    } finally {if(bundle) await bundle.cleanup();await fs.rm(directory,{recursive:true,force:true});}
});
