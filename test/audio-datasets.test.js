import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';
import { JSONFilePreset } from 'lowdb/node';
import { audioDatasetsRouter, inspectAudio, validateSegment } from '../lib/audio-datasets.js';
function wav() {
    const data=Buffer.alloc(44+16000*2*2);data.write('RIFF');data.writeUInt32LE(data.length-8,4);data.write('WAVEfmt ',8);data.writeUInt32LE(16,16);data.writeUInt16LE(1,20);data.writeUInt16LE(1,22);data.writeUInt32LE(16000,24);data.writeUInt32LE(32000,28);data.writeUInt16LE(2,32);data.writeUInt16LE(16,34);data.write('data',36);data.writeUInt32LE(data.length-44,40);
    for(let i=0;i<32000;i++)data.writeInt16LE(Math.round(Math.sin(i/16000*440*Math.PI*2)*12000),44+i*2);
    return data;
}
test('validates WAV, MP3 and segment boundaries', async()=>{
    assert.equal((await inspectAudio(wav(),'tone.wav')).duration,2);
    assert.ok((await inspectAudio(await fs.readFile(new URL('fixtures/tone.mp3',import.meta.url)),'tone.mp3')).duration>=2);
    await assert.rejects(inspectAudio(Buffer.from('not audio'),'bad.wav'));
    await assert.rejects(inspectAudio(wav(),'wrong.mp3'));
    await assert.rejects(inspectAudio(wav(),'wrong.exe'));
    for(const value of [{start:-1,end:1,labelId:'a'},{start:1,end:1,labelId:'a'},{start:0,end:3,labelId:'a'},{start:0,end:1,labelId:'other'}]) assert.throws(()=>validateSegment(value,2,[{id:'a'}]));
});
test('uploads, plays ranges, persists and edits segments, and exports annotations',async()=>{
    const directory=await fs.mkdtemp(path.join(os.tmpdir(),'aeronir-audio-'));
    const db=await JSONFilePreset(path.join(directory,'db.json'),{audioProjects:[]});
    const app=express();app.use(express.json());app.use('/api',audioDatasetsRouter({db,directory}));
    const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}/api`;
    const request=async(url,method='GET',body)=>{const res=await fetch(base+url,{method,headers:body instanceof FormData?{}:{'Content-Type':'application/json'},body:body instanceof FormData?body:body?JSON.stringify(body):undefined});return {status:res.status,data:await res.json()};};
    try{
        const {data:p}=await request('/','POST',{name:'Audio test',description:'Test audio annotations'});
        const {data:label}=await request(`/${p.id}/labels`,'POST',{name:'Tone'});
        const form=new FormData();form.append('audio',new Blob([wav()]),'tone.wav');
        const {status:uploadStatus,data:track}=await request(`/${p.id}/tracks`,'POST',form);assert.equal(uploadStatus,201);
        const assignedForm=new FormData();assignedForm.append('audio',new Blob([wav()]),'validation.wav');assignedForm.append('split','valid');
        const assigned=(await request(`/${p.id}/tracks`,'POST',assignedForm)).data;assert.equal(assigned.split,'valid');
        const invalidForm=new FormData();invalidForm.append('audio',new Blob([wav()]),'bad.wav');invalidForm.append('split','invalid');
        assert.equal((await request(`/${p.id}/tracks`,'POST',invalidForm)).status,400);
        const range=await fetch(`${base}/${p.id}/tracks/${track.id}/file`,{headers:{Range:'bytes=0-43'}});assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,44);
        const {data:segment}=await request(`/${p.id}/segments`,'POST',{trackId:track.id,labelId:label.id,start:.2,end:1});
        assert.equal((await request(`/${p.id}/segments`,'POST',{trackId:track.id,labelId:label.id,start:0,end:9})).status,400);
        assert.equal((await request(`/${p.id}/segments/${segment.id}`,'PATCH',{trackId:track.id,labelId:label.id,start:.3,end:1.5})).status,200);
        const splitResult=(await request(`/${p.id}/auto-split`,'POST',{})).data;
        assert.equal(splitResult.updated,1);assert.equal(splitResult.tracks.find(t=>t.id===track.id).split,'train');
        assert.equal(splitResult.tracks.find(t=>t.id===assigned.id).split,'valid');
        assert.equal((await request(`/${p.id}/auto-split`,'POST',{})).data.updated,0);
        await request(`/${p.id}/tracks/${track.id}`,'PATCH',{split:'test'});
        assert.equal((await request(`/${p.id}`)).data.tracks.find(t=>t.id===track.id).split,'test');
        await request(`/${p.id}/tracks/${track.id}`,'PATCH',{split:'train'});
        const exported=(await request(`/${p.id}/export/annotations`)).data;assert.equal(exported.tracks[0].segments[0].label,'Tone');assert.equal(exported.tracks[0].segments[0].end,1.5);assert.equal(exported.tracks[0].split,'train');
        const zipResponse=await fetch(`${base}/${p.id}/export`);
        assert.equal(zipResponse.status,200);assert.match(zipResponse.headers.get('content-disposition'),/audio-dataset.zip/);
        const zipBytes=Buffer.from(await zipResponse.arrayBuffer());assert.equal(zipBytes.readUInt32LE(0),0x04034b50);
        const listing=(await request('/')).data;assert.equal(listing[0].description,'Test audio annotations');assert.equal(listing[0].stats.trackCount,2);assert.equal(listing[0].stats.segmentCount,1);assert.equal(listing[0].stats.splits.train,1);
        const disk=JSON.parse(await fs.readFile(path.join(directory,'db.json'),'utf8'));assert.equal(disk.audioProjects[0].segments[0].start,.3);
        await request(`/${p.id}/segments/${segment.id}`,'DELETE');assert.equal((await request(`/${p.id}`)).data.segments.length,0);
        await request(`/${p.id}/segments`,'POST',{trackId:track.id,labelId:label.id,start:.2,end:1});
        assert.equal((await request(`/${p.id}/tracks/${track.id}`,'DELETE')).status,200);
        const remaining=(await request(`/${p.id}`)).data;
        assert.deepEqual(remaining.tracks.map(t=>t.id),[assigned.id]);
        assert.equal(remaining.segments.length,0);assert.equal(remaining.labels[0].id,label.id);
        await assert.rejects(fs.stat(path.join(directory,p.id,track.filename)),{code:'ENOENT'});
        assert.equal((await fetch(`${base}/${p.id}/tracks/${track.id}/file`)).status,404);
        assert.equal((await request(`/${p.id}/tracks/${track.id}`,'DELETE')).status,404);
        await request(`/${p.id}`,'DELETE');assert.equal((await request(`/${p.id}`)).status,404);assert.equal((await request('/')).data.length,0);
    }finally{await new Promise(resolve=>server.close(resolve));await fs.rm(directory,{recursive:true,force:true});}
});
