import { yoloPython } from './python-runtime.js';
import { Router, raw } from 'express';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { TRAINING_MODELS, trainingSettings, trainingSource, snapshotTrainingDataset } from './training-dataset.js';

const PREFIX='@@AERONIR@@';
const runningStates=new Set(['preparing','running','stopping']);
export async function trainingRouter({db,root}) {
    const router=Router(),directory=path.join(root,'training_runs');
    await fs.mkdir(directory,{recursive:true});
    const python=yoloPython(root);
    const runner=path.join(root,'training','runner.py');
    const runs=new Map();let active=null,preview=null;
    const runDir=id=>path.join(directory,id);
    const checkpoint=id=>path.join(runDir(id),'output','fit','weights','best.pt');
    const exists=async file=>fs.access(file).then(()=>true,()=>false);
    for(const entry of await fs.readdir(directory,{withFileTypes:true})) {
        if(!entry.isDirectory())continue;
        try {
            const run=JSON.parse(await fs.readFile(path.join(directory,entry.name,'run.json'),'utf8'));
            if(run.id!==entry.name)continue;
            if(runningStates.has(run.status)) {run.status='interrupted';run.message='The server stopped during training. Start a new run.';}
            run.logs ||= [];run.history ||= [];runs.set(run.id,run);
        } catch { /* Ignore incomplete directories without a run record. */ }
    }
    let writes=Promise.resolve();
    const save=run=>{
        const serialized=JSON.stringify(run);
        writes=writes.catch(()=>{}).then(async()=>{await fs.writeFile(path.join(runDir(run.id),'run.json.tmp'),serialized);await fs.rename(path.join(runDir(run.id),'run.json.tmp'),path.join(runDir(run.id),'run.json'));});
        return writes;
    };
    const log=(run,line)=>{run.logs.push(String(line).replace(/\x1b\[[0-9;]*[A-Za-z]/g,'').slice(0,3000));if(run.logs.length>600)run.logs.shift();};
    const launch=(command,file)=>spawn(python,['-u',runner,command,...(file?[file]:[])],{cwd:directory,env:{...process.env,PYTHONUNBUFFERED:'1',YOLO_CONFIG_DIR:path.join(directory,'.config'),MPLCONFIGDIR:path.join(directory,'.matplotlib')}});
    const environment=()=>new Promise(resolve=>{
        const child=launch('probe');let result=null,done=false;
        const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
        const timer=setTimeout(()=>{child.kill();finish({ready:false,error:'YOLO environment check timed out.'});},30000);
        createInterface({input:child.stdout}).on('line',line=>{if(line.startsWith(PREFIX)){try{const value=JSON.parse(line.slice(PREFIX.length));if(value.type==='environment')result=value;else if(value.type==='error')result={ready:false,error:value.message};}catch{}}});
        child.stderr.resume();child.on('error',()=>finish({ready:false,error:'Python training environment is missing. Follow the setup instructions in README.'}));
        child.on('close',()=>finish(result || {ready:false,error:'Could not load Ultralytics. Follow the setup instructions in README.'}));
    });
    const summary=run=>({id:run.id,source:run.source,datasetName:run.datasetName,status:run.status,settings:run.settings,createdAt:run.createdAt,epoch:run.epoch,message:run.message,bestReady:run.bestReady,counts:run.counts});
    const route=fn=>(req,res,next)=>Promise.resolve(fn(req,res)).catch(next);
    const getRun=(req,res)=>{const run=runs.get(req.params.id);if(!run)res.status(404).json({error:'Training run not found.'});return run;};
    router.get('/environment',route(async(req,res)=>res.json({...await environment(),models:TRAINING_MODELS})));
    router.get('/datasets',route(async(req,res)=>{
        await db.read();
        const entries=[{id:'satellite',name:'Satellite'},...(db.data.projects || []).map(p=>({id:`custom:${p.id}`,name:p.name}))];
        res.json(entries.map(entry=>{try{const source=trainingSource(db.data,entry.id);return {...entry,ready:true,counts:source.counts,classes:source.labels.length};}catch(error){return {...entry,ready:false,error:error.message};}}));
    }));
    router.get('/runs',route(async(req,res)=>res.json([...runs.values()].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)).map(summary))));
    router.get('/runs/:id',route(async(req,res)=>{const run=getRun(req,res);if(run)res.json(run);}));
    router.post('/runs',route(async(req,res)=>{
        if(active)return res.status(409).json({error:'A training run is already active.'});
        let settings,dataset;
        try {settings=trainingSettings(req.body);await db.read();dataset=trainingSource(db.data,req.body.source);}catch(error){return res.status(400).json({error:error.message});}
        if(active)return res.status(409).json({error:'A training run is already active.'});
        // Reserve before asynchronous environment probing/snapshotting.
        const id=randomUUID();active={id,child:null,cancelled:false};
        const reservation=active;
        const env=await environment();
        if(!env.ready){active=null;return res.status(503).json({error:env.error});}
        if(settings.device!=='auto'&&!env.devices.includes(settings.device)){active=null;return res.status(400).json({error:'The selected device is unavailable on this server.'});}
        await fs.mkdir(runDir(id),{recursive:true});
        const run={id,source:req.body.source,datasetName:dataset.name,settings,counts:dataset.counts,status:'preparing',createdAt:new Date().toISOString(),epoch:0,message:'Preparing a dataset snapshot…',history:[],logs:[],bestReady:false};
        runs.set(id,run);await save(run);res.status(202).json(summary(run));
        (async()=>{
            try {
                await snapshotTrainingDataset(dataset,path.join(root,'public'),path.join(runDir(id),'dataset'));
                if(reservation.cancelled){run.status='cancelled';run.message='Training cancelled.';return;}
                const config={settings,data:path.join(runDir(id),'dataset','data.yaml'),output:path.join(runDir(id),'output')};
                await fs.writeFile(path.join(runDir(id),'config.json'),JSON.stringify(config));
                run.status='running';run.message='Starting Ultralytics…';await save(run);
                const child=launch('train',path.join(runDir(id),'config.json'));reservation.child=child;
                const handle=line=>{
                    if(line.startsWith(PREFIX)) {
                        try {
                            const event=JSON.parse(line.slice(PREFIX.length));
                            if(event.message){run.message=event.message;log(run,event.message);}
                            if(event.epoch)run.epoch=event.epoch;
                            if(event.type==='epoch'){const previous=run.history.findIndex(item=>item.epoch===event.epoch);const point={epoch:event.epoch,metrics:event.metrics};if(previous>=0)run.history[previous]=point;else run.history.push(point);void save(run).catch(console.error);}
                        } catch {log(run,line);}
                    } else log(run,line);
                };
                createInterface({input:child.stdout}).on('line',handle);
                createInterface({input:child.stderr,crlfDelay:Infinity}).on('line',handle);
                const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
                run.bestReady=code===0&&!reservation.cancelled&&await exists(checkpoint(id));
                run.status=reservation.cancelled?'cancelled':run.bestReady?'completed':'failed';
                run.message=reservation.cancelled?'Training cancelled.':run.bestReady?'Training complete. best.pt is ready.':`Training failed (exit ${code}). See the log below.`;
            } catch(error){run.status='failed';run.message=error.message;log(run,error.stack || error.message);}
            finally {run.finishedAt=new Date().toISOString();if(active===reservation)active=null;await save(run);}
        })().catch(console.error);
    }));
    router.post('/runs/:id/stop',route(async(req,res)=>{
        const run=getRun(req,res);if(!run)return;
        if(active?.id!==run.id)return res.status(409).json({error:'This run is not active.'});
        active.cancelled=true;run.status='stopping';run.message='Stopping training…';
        const child=active.child;
        if(child){child.kill('SIGTERM');const timer=setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},5000);timer.unref();}
        await save(run);res.json(summary(run));
    }));
    router.get('/runs/:id/artifacts/:name',route(async(req,res)=>{
        const run=getRun(req,res);if(!run)return;
        const artifacts={'best.pt':'weights/best.pt','results.png':'results.png','confusion_matrix.png':'confusion_matrix.png','results.csv':'results.csv'};
        const artifact=artifacts[req.params.name];if(!artifact)return res.status(404).end();
        const filename=path.join(runDir(run.id),'output','fit',artifact);
        if(!await exists(filename))return res.status(404).json({error:'This artifact is not available yet.'});
        if(req.params.name==='best.pt')res.download(filename,'best.pt');else res.sendFile(filename);
    }));

    function closePreview() {
        if(!preview)return;
        preview.child.kill();if(preview.pending)clearTimeout(preview.pending.timer);preview.pending?.reject(new Error('Preview stopped.'));preview=null;
    }
    async function predictor(run) {
        if(preview?.id===run.id)return preview;
        closePreview();
        const child=launch('infer',checkpoint(run.id)),instance={id:run.id,child,pending:null};preview=instance;
        child.stderr.resume();
        const fail=message=>{if(instance.pending){clearTimeout(instance.pending.timer);instance.pending.reject(new Error(message));instance.pending=null;}if(preview===instance)preview=null;};
        child.on('error',error=>fail(error.message));child.on('close',()=>fail('Inference process stopped.'));
        createInterface({input:child.stdout}).on('line',line=>{
            if(!line.startsWith(PREFIX))return;
            let value;try{value=JSON.parse(line.slice(PREFIX.length));}catch{return;}
            if(value.type==='ready')return;
            if(!instance.pending)return;
            if(value.id && value.id!==instance.pending.id)return;
            clearTimeout(instance.pending.timer);
            if(value.type==='error')instance.pending.reject(new Error(value.message));else instance.pending.resolve(value);
            instance.pending=null;
        });
        return instance;
    }
    router.post('/runs/:id/predict',raw({type:'image/jpeg',limit:'2mb'}),route(async(req,res)=>{
        const run=getRun(req,res);if(!run)return;
        if(!run.bestReady||!await exists(checkpoint(run.id)))return res.status(409).json({error:'Finish training to use best.pt.'});
        if(!Buffer.isBuffer(req.body)||!req.body.length)return res.status(400).json({error:'Send a JPEG webcam frame.'});
        const confidence=Number(req.query.confidence ?? .25);
        if(!Number.isFinite(confidence)||confidence<.01||confidence>1)return res.status(400).json({error:'Confidence must be between 0.01 and 1.'});
        let frame;try{frame=await sharp(req.body,{limitInputPixels:4000000}).resize({width:960,height:720,fit:'inside',withoutEnlargement:true}).jpeg().toBuffer();}catch{return res.status(400).json({error:'Invalid preview image.'});}
        if(preview?.pending)return res.status(429).json({error:'A preview frame is still processing.'});
        const instance=await predictor(run);
        if(instance.pending)return res.status(429).json({error:"A preview frame is still processing."});
        const prediction=await new Promise((resolve,reject)=>{
            const id=randomUUID();const timer=setTimeout(()=>{if(instance.pending?.id===id){instance.pending=null;reject(new Error('Inference timed out.'));closePreview();}},60000);
            instance.pending={id,resolve,reject,timer};
            instance.child.stdin.write(JSON.stringify({id,confidence,image:frame.toString('base64')})+'\n',error=>{if(error&&instance.pending?.id===id){clearTimeout(timer);instance.pending=null;reject(error);}});
        });
        res.json(prediction);
    }));
    router.post('/preview/stop',(req,res)=>{closePreview();res.json({success:true});});
    const shutdown=()=>{active?.child?.kill();closePreview();};
    router.shutdown=shutdown;
    router.use((error,req,res,next)=>{console.error('Training:',error);if(active&&!runs.has(active.id))active=null;if(!res.headersSent)res.status(error.status || 500).json({error:error.message || 'Training request failed.'});});
    return router;
}
