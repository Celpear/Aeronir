import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import {trainingSettings,trainingSource,snapshotTrainingDataset} from '../lib/training-dataset.js';
const yolo={x_center:.5,y_center:.5,width:.5,height:.5};
const custom=()=>({projects:[{id:1,name:'Test'}],projectLabels:[{id:7,projectId:1,name:'box: #1'}],
    projectImages:[{id:1,projectId:1,path:'/dataset_files/1/one.png',split:'train'},{id:2,projectId:1,path:'/dataset_files/1/two.png',split:'valid'},{id:3,projectId:1,path:'/dataset_files/1/three.png',split:'unassigned'}],
    projectAnnotations:[{imageId:1,projectId:1,labelId:7,yolo},{imageId:2,projectId:1,labelId:7,yolo}]});
test('training settings reject arbitrary model paths, commands and invalid resource settings',()=>{
    assert.equal(trainingSettings({model:'yolo12n'}).epochs,50);
    for(const settings of [{model:'../../evil.pt'},{model:'yolo12n',epochs:0},{model:'yolo12n',imgsz:641},{model:'yolo12n',device:';echo bad'},{model:'yolo12n',batch:500},{model:'yolo12n',epochs:'10'}])assert.throws(()=>trainingSettings(settings));
});
test('custom training respects assigned splits and rejects copy leakage and missing labels',()=>{
    const data=custom();const source=trainingSource(data,'custom:1');
    assert.deepEqual(source.counts,{train:1,valid:1,test:0});assert.equal(source.images[0].lines[0],'0 0.5 0.5 0.5 0.5');
    data.projectImages[1].copiedFrom=1;assert.throws(()=>trainingSource(data,'custom:1'),/copies/);
    delete data.projectImages[1].copiedFrom;data.projectImages[1].split='unassigned';assert.throws(()=>trainingSource(data,'custom:1'),/validation/);
    assert.throws(()=>trainingSource(custom(),'custom:2'),/not found/);
});
test('satellite split groups overlapping tile crops together',()=>{
    const boxes=Array.from({length:12},(_,i)=>({id:i+1,image:`/saved_tiles/${i}.jpg`,labelId:1,yolo,tiles:[{x:i<2?0:i,y:0,z:12}]}));
    const source=trainingSource({labels:[{id:1,name:'building'}],boxes},'satellite');
    assert.equal(source.images[0].split,source.images[1].split);
    assert.ok(source.counts.train>0&&source.counts.valid>0&&source.counts.test>0);
    assert.throws(()=>trainingSource({labels:[{id:1,name:'building'}],boxes:boxes.slice(0,2)},'satellite'),/independent/);
});
test('snapshot writes training-ready YOLO layout and safely quoted classes, preserving image geometry',async()=>{
    const root=await fs.mkdtemp(path.join(os.tmpdir(),'aeronir-training-dataset-'));
    try {
        const publicDir=path.join(root,'public'),dir=path.join(publicDir,'dataset_files','1');await fs.mkdir(dir,{recursive:true});
        const image=await sharp({create:{width:96,height:64,channels:3,background:'#14b8a6'}}).png().toBuffer();
        await fs.writeFile(path.join(dir,'one.png'),image);await fs.writeFile(path.join(dir,'two.png'),image);
        const dest=path.join(root,'snapshot'),source=trainingSource(custom(),'custom:1');
        await snapshotTrainingDataset(source,publicDir,dest);
        const config=JSON.parse(await fs.readFile(path.join(dest,'data.yaml'),'utf8'));
        assert.equal(config.names[0],'box: #1');assert.equal(config.val,'images/valid');
        assert.equal((await sharp(path.join(dest,'images','train','image_1.png')).metadata()).width,96);
        assert.equal(await fs.readFile(path.join(dest,'labels','valid','image_2.txt'),'utf8'),'0 0.5 0.5 0.5 0.5');
        source.images[0].path='/dataset_files/../../db.json';await assert.rejects(snapshotTrainingDataset(source,publicDir,path.join(root,'bad')));
    }finally{await fs.rm(root,{recursive:true,force:true});}
});
