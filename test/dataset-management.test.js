import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import jwt from 'jsonwebtoken';

// Run the actual routes against a disposable database and file tree.
test('image management persists family splits, restores satellite images and preserves copy lineage on deletion', {timeout:20000}, async () => {
    const root = path.resolve('.');
    const temp = await fs.mkdtemp(path.join(os.tmpdir(),'aeronir-management-'));
    let child;
    try {
        await fs.symlink(path.join(root,'node_modules'),path.join(temp,'node_modules'),'dir');
        await fs.cp(path.join(root,'lib'),path.join(temp,'lib'),{recursive:true});
        await fs.writeFile(path.join(temp,'package.json'),' {"type":"module"}');
        const source = (await fs.readFile(path.join(root,'server.js'),'utf8')).replace('const PORT = 3000;', 'const PORT = 0;').replace('http://localhost:${PORT}', 'http://localhost:${httpServer.address().port}');
        await fs.writeFile(path.join(temp,'server.js'),source);
        await fs.mkdir(path.join(temp,'public','saved_tiles'),{recursive:true});
        await fs.mkdir(path.join(temp,'public','dataset_files','1'),{recursive:true});
        const images = Array.from({length:20},(_, i) => ({id:i+1, projectId:1, split:'unassigned', path:`/dataset_files/1/${i+1}.png`}));
        images.push({id:21,projectId:1,split:'unassigned',copiedFrom:1,path:'/dataset_files/1/21.png'}, {id:22,projectId:1,split:'unassigned',copiedFrom:21,path:'/dataset_files/1/22.png'});
        for (const image of images) await fs.writeFile(path.join(temp,'public',image.path),'fixture');
        await fs.writeFile(path.join(temp,'public','saved_tiles','tile.png'),'fixture');
        await fs.writeFile(path.join(temp,'db.json'),JSON.stringify({users:[{id:1,email:'test@example.test',role:'admin'}],projects:[{id:1,name:'Fixture'}],projectImages:images,projectLabels:[],projectAnnotations:[{id:1,projectId:1,imageId:21}],labels:[{id:1,name:'Fixture'}],boxes:[{id:1,labelId:1,image:'/saved_tiles/tile.png'}]}));
        child = spawn(process.execPath,[path.join(temp,'server.js')],{env:{...process.env,JWT_SECRET:'isolated-test-secret'},stdio:['ignore','pipe','pipe']});
        const base = await new Promise((resolve,reject) => {
            const timer=setTimeout(()=>reject(new Error('Test server did not start.')),8000);
            child.once('error',error=>{clearTimeout(timer);reject(error);});
            child.once('exit',code=>{clearTimeout(timer);reject(new Error(`Test server exited ${code}`));});
            child.stdout.on('data',chunk=>{const match=String(chunk).match(/http:\/\/localhost:(\d+)/);if(match){clearTimeout(timer);resolve(`http://127.0.0.1:${match[1]}`);}});
            child.stderr.resume();
        });
        const token=jwt.sign({id:1,email:'test@example.test',role:'admin'},'isolated-test-secret');
        const request=async(url,method='GET',body)=>{
            const response=await fetch(base+url,{method,headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:body?JSON.stringify(body):undefined});
            return {status:response.status,data:await response.json()};
        };
        assert.equal((await request('/api/projects/1','PATCH',{name:'Renamed',description:'Updated'})).status,200);
        assert.equal((await request('/api/projects/1')).data.name,'Renamed');
        assert.equal((await request('/api/projects/1/auto-split','POST',{trainRatio:.9,validRatio:.2})).status,400);
        assert.equal((await request('/api/projects/1/auto-split','POST',{})).data.updated,22);
        let project=(await request('/api/projects/1')).data;
        assert.equal(project.images.find(i=>i.id===1).split,project.images.find(i=>i.id===22).split);
        await request('/api/projects/1/images/21','PATCH',{split:'valid'});
        project=(await request('/api/projects/1')).data;
        assert.ok(project.images.filter(i=>[1,21,22].includes(i.id)).every(i=>i.split==='valid'));
        await request('/api/projects/1/images/21','DELETE');
        project=(await request('/api/projects/1')).data;
        assert.equal(project.images.find(i=>i.id===22).copiedFrom,1);
        assert.equal(project.annotations.length,0);
        await assert.rejects(fs.stat(path.join(temp,'public','dataset_files','1','21.png')),{code:'ENOENT'});
        assert.equal((await request('/api/boxes/1','DELETE')).status,200);
        assert.equal((await request('/api/boxes/1','DELETE')).status,404);
        assert.equal((await request('/api/boxes/trash')).data.length,1);
        await fs.stat(path.join(temp,'public','saved_tiles','tile.png'));
        assert.equal((await request('/api/boxes/1/restore','POST',{})).status,200);
        assert.equal((await request('/api/boxes/trash')).data.length,0);
        assert.equal((await request('/api/boxes')).data.length,1);
        const persisted=JSON.parse(await fs.readFile(path.join(temp,'db.json'),'utf8'));
        assert.equal(persisted.boxes.length,1); assert.equal(persisted.projectImages.length,21);
    } finally {
        if(child && child.exitCode===null){const exited=once(child,'exit'); child.kill('SIGTERM'); await exited;}
        await fs.rm(temp,{recursive:true,force:true});
    }
});
