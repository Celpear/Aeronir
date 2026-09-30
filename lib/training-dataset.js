import { imageFamilies } from './image-splits.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import sharp from 'sharp';

export const TRAINING_MODELS = ['yolo12n', 'yolo12s', 'yolo12m', 'yolo11n', 'yolo11s', 'yolov8n', 'yolov8s'];
export function trainingSettings(body) {
    const integer = (name, fallback, min, max) => {
        const value = body[name] ?? fallback;
        if (!Number.isInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer from ${min} to ${max}.`);
        return value;
    };
    if (!TRAINING_MODELS.includes(body.model)) throw new Error('Choose a supported model.');
    const device = body.device || 'auto';
    if (!['auto','cpu','mps','0'].includes(device)) throw new Error('Choose Auto, CPU, Apple MPS or CUDA 0.');
    const imgsz = integer('imgsz',640,64,1536);
    if (imgsz % 32) throw new Error('Image size must be a multiple of 32.');
    return {model:body.model,device,epochs:integer('epochs',50,1,1000),batch:integer('batch',4,1,64),imgsz,
        patience:integer('patience',20,0,1000),seed:integer('seed',42,0,2147483647)};
}

export function trainingSource(data, source) {
    let labels,images,name;
    if (source === 'satellite') {
        labels=data.labels || [];name='Satellite';
        images=(data.boxes || []).filter(b=>b.image && b.yolo).map(b=>({id:b.id,path:b.image,
            annotations:[{labelId:b.labelId,yolo:b.yolo}],tiles:b.tiles || [],tileUrl:b.tileUrl || '',split:null}));
        // Keep crops sharing map tiles together, including transitive overlap.
        const parent=new Map(images.map(i=>[i.id,i.id]));
        const root=id=>{while(parent.get(id)!==id)id=parent.get(id);return id;};
        const seen=new Map();
        for(const image of images) for(const tile of image.tiles) {
            const key=`${image.tileUrl}:${tile.z}:${tile.x}:${tile.y}`;
            if(seen.has(key))parent.set(root(image.id),root(seen.get(key)));else seen.set(key,image.id);
        }
        const groups=[...new Set(images.map(i=>root(i.id)))].sort((a,b)=>hash(a).localeCompare(hash(b)));
        if(groups.length<2)throw new Error('Satellite training needs at least two independent areas without shared tiles, for train and validation.');
        const test=groups.length>=10?Math.max(1,Math.floor(groups.length*.05)):0;
        const valid=Math.max(1,Math.round(groups.length*.15));
        const assignments=new Map(groups.map((g,i)=>[g,i<test?'test':i<test+valid?'valid':'train']));
        for(const image of images) image.split=assignments.get(root(image.id));
    } else {
        const match=/^custom:(\d+)$/.exec(source || '');
        if(!match)throw new Error('Choose a satellite or custom image dataset.');
        const id=Number(match[1]),project=(data.projects || []).find(p=>p.id===id);
        if(!project)throw new Error('Dataset not found.');
        name=project.name;labels=(data.projectLabels || []).filter(l=>l.projectId===id);
        const all=(data.projectImages || []).filter(i=>i.projectId===id);
        images=all.filter(i=>['train','valid','test'].includes(i.split)).map(i=>({...i,annotations:(data.projectAnnotations || []).filter(a=>a.projectId===id&&a.imageId===i.id)}));
        for (const family of imageFamilies(all)) {
            const splits = new Set(family.filter(image => ['train','valid','test'].includes(image.split)).map(image => image.split));
            if (splits.size > 1) throw new Error('An image and its copies are in different splits. Use Reshuffle all in the dataset to keep copy families together.');
        }
    }
    if(!labels.length)throw new Error('Create at least one class before training.');
    const counts={train:0,valid:0,test:0};
    const classIds=new Map(labels.map((label,index)=>[label.id,index]));
    for(const image of images) {
        counts[image.split]++;
        image.lines=image.annotations.map(annotation=>{
            const id=classIds.get(annotation.labelId),box=annotation.yolo;
            if(id===undefined || !box)throw new Error('An annotation references a missing class or bounding box.');
            const coordinates=[box.x_center,box.y_center,box.width,box.height];
            if(coordinates.some(v=>!Number.isFinite(v)||v<0||v>1)||box.width===0||box.height===0)throw new Error('Fix invalid bounding boxes before training.');
            return `${id} ${coordinates.join(' ')}`;
        });
    }
    if(!counts.train || !counts.valid)throw new Error('Assign at least one image to train and one to validation before training. Unassigned images are excluded.');
    if(!images.some(i=>i.split==='train'&&i.lines.length))throw new Error('The train split needs labeled objects.');
    if(!images.some(i=>i.split==='valid'&&i.lines.length))throw new Error('The validation split needs labeled objects to evaluate detection.');
    return {name,source,labels:labels.map(l=>l.name),images,counts};
}
const hash=value=>createHash('sha256').update(String(value)).digest('hex');

export async function snapshotTrainingDataset(dataset, publicDir, destination) {
    for(const split of ['train','valid','test'])for(const kind of ['images','labels'])await fs.mkdir(path.join(destination,kind,split),{recursive:true});
    const sources=[];
    for(const image of dataset.images) {
        const prefix=dataset.source==='satellite'?'/saved_tiles/':'/dataset_files/';
        if(!image.path.startsWith(prefix))throw new Error('Unexpected image path.');
        const source=path.resolve(publicDir,'.'+image.path),allowed=await fs.realpath(path.resolve(publicDir,prefix.slice(1)));
        const real=await fs.realpath(source);
        if(!real.startsWith(allowed+path.sep))throw new Error('Invalid image path.');
        // Snapshot as PNG without resizing, retaining normalized annotation geometry.
        const filename=`image_${image.id}.png`;
        await sharp(real,{limitInputPixels:100000000}).png().toFile(path.join(destination,'images',image.split,filename));
        await fs.writeFile(path.join(destination,'labels',image.split,`image_${image.id}.txt`),image.lines.join('\n'));
        sources.push({id:image.id,sourcePath:image.path,split:image.split,filename,annotations:image.lines.length});
    }
    const config={path:destination,train:'images/train',val:'images/valid',names:dataset.labels};
    if(dataset.counts.test)config.test='images/test';
    // JSON is a YAML subset and safely quotes arbitrary class names and filesystem paths.
    await fs.writeFile(path.join(destination,'data.yaml'),JSON.stringify(config,null,2));
    await fs.writeFile(path.join(destination,'manifest.json'),JSON.stringify({source:dataset.source,name:dataset.name,counts:dataset.counts,classes:dataset.labels,images:sources},null,2));
}
