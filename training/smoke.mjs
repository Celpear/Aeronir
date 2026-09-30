// Explicit end-to-end smoke test: downloads weights and trains one synthetic epoch.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import express from 'express';
import sharp from 'sharp';
import {trainingRouter} from '../lib/training.js';
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
await fs.mkdir(path.join(repo,'training_runs'),{recursive:true});
const root=await fs.mkdtemp(path.join(repo,'training_runs','smoke-'));
process.env.YOLO_PYTHON=process.env.YOLO_PYTHON || path.join(repo,'.venv-yolo','bin','python');
let router,server;
try {
    await fs.mkdir(path.join(root,'training'));await fs.copyFile(path.join(repo,'training','runner.py'),path.join(root,'training','runner.py'));
    const dir=path.join(root,'public','dataset_files','1');await fs.mkdir(dir,{recursive:true});
    const data={projects:[{id:1,name:'Synthetic smoke test'}],projectLabels:[{id:1,projectId:1,name:'square'}],projectImages:[],projectAnnotations:[]};
    for(let id=1;id<=4;id++) {
        const svg=`<svg width="128" height="128"><rect width="128" height="128" fill="#333"/><rect x="32" y="32" width="64" height="64" fill="${id%2?'#14b8a6':'#ffbb22'}"/></svg>`;
        await sharp(Buffer.from(svg)).png().toFile(path.join(dir,`${id}.png`));
        data.projectImages.push({id,projectId:1,path:`/dataset_files/1/${id}.png`,split:id<=2?'train':'valid'});
        data.projectAnnotations.push({id,projectId:1,imageId:id,labelId:1,yolo:{x_center:.5,y_center:.5,width:.5,height:.5}});
    }
    router=await trainingRouter({db:{data,read:async()=>{}},root});
    const app=express();app.use(express.json());app.use('/api/training',router);
    server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const base=`http://127.0.0.1:${server.address().port}/api/training`;
    const response=await fetch(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'custom:1',model:'yolo12n',epochs:1,batch:2,imgsz:64,device:'cpu'})});
    const created=await response.json();assert.equal(response.status,202,JSON.stringify(created));console.log('Started',created.id);
    let run;const deadline=Date.now()+240000;let previous='';
    do {
        await new Promise(resolve=>setTimeout(resolve,1000));run=await (await fetch(base+`/runs/${created.id}`)).json();
        const text=run.logs.slice(-2).join('\n');if(text!==previous){console.log(text);previous=text;}
    }while(['preparing','running','stopping'].includes(run.status)&&Date.now()<deadline);
    assert.equal(run.status,'completed',JSON.stringify(run));assert.ok(run.bestReady);assert.equal(run.history.length,1);assert.equal(run.epoch,1);
    const best=await fetch(base+`/runs/${run.id}/artifacts/best.pt`);assert.equal(best.status,200);assert.ok((await best.arrayBuffer()).byteLength>10000);
    const frame=await sharp(path.join(dir,'1.png')).jpeg().toBuffer();
    const inference=await fetch(base+`/runs/${run.id}/predict`,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:frame});const prediction=await inference.json();
    assert.equal(inference.status,200,JSON.stringify(prediction));assert.equal(prediction.width,128);assert.ok(Array.isArray(prediction.boxes));
    console.log('PASS: real YOLO12n training, epoch metrics, best.pt download and checkpoint inference.',{epochs:run.history.length,inferenceMs:prediction.milliseconds});
    const secondResponse=await fetch(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'custom:1',model:'yolo12n',epochs:100,batch:2,imgsz:64,device:'cpu'})});
    const second=await secondResponse.json();assert.equal(secondResponse.status,202);
    const busy=await fetch(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({source:'custom:1',model:'yolo12n'})});assert.equal(busy.status,409);
    assert.equal((await fetch(base+`/runs/${second.id}/stop`,{method:'POST'})).status,200);
    let stopped;
    for(let i=0;i<30;i++){stopped=await(await fetch(base+`/runs/${second.id}`)).json();if(stopped.status==='cancelled')break;await new Promise(resolve=>setTimeout(resolve,200));}
    assert.equal(stopped.status,'cancelled');
    router.shutdown();await new Promise(resolve=>server.close(resolve));server=null;
    router=await trainingRouter({db:{data,read:async()=>{}},root});
    const reopened=express();reopened.use('/api/training',router);server=reopened.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
    const history=await(await fetch(`http://127.0.0.1:${server.address().port}/api/training/runs`)).json();
    assert.equal(history.find(item=>item.id===run.id).status,'completed');
    assert.equal(history.find(item=>item.id===second.id).status,'cancelled');
    console.log('PASS: concurrent-run guard, cancellation and history after restart.');

} finally {
    router?.shutdown();if(server)await new Promise(resolve=>server.close(resolve));
    await fs.rm(root,{recursive:true,force:true});
}
