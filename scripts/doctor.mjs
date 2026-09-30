import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {yoloPython} from '../lib/python-runtime.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
let failed=false;
function report(name,ok,detail='') {
    console.log(`${ok?'OK':'MISSING'}  ${name}${detail?' — '+detail:''}`);
    if(!ok) failed=true;
}
console.log('Aeronir full installation check (labeling, audio export, YOLO)');
report('Node.js',Number(process.versions.node.split('.')[0])>=22,process.version);
for(const name of ['express','sharp','music-metadata']) {
    try {await import(name);report(name,true);} catch(error) {report(name,false,error.message);}
}
for(const [name,args] of [['ffmpeg',['-version']],['zip',['-v']],['unzip',['-v']]]) {
    const result=spawnSync(name,args,{encoding:'utf8',timeout:10000,windowsHide:true});
    report(name,result.status===0,result.error?.message || (result.status===0?'available on PATH':'install and reopen your terminal'));
}
try {
    const python=yoloPython(root);
    const result=spawnSync(python,['-u',path.join(root,'training','runner.py'),'probe'],{
        cwd:root,encoding:'utf8',timeout:60000,windowsHide:true,
        env:{...process.env,YOLO_CONFIG_DIR:path.join(root,'training_runs','.config'),MPLCONFIGDIR:path.join(root,'training_runs','.matplotlib')}
    });
    const event=result.stdout?.split(/\r?\n/).find(line=>line.startsWith('@@AERONIR@@') && line.includes('"environment"'));
    const info=event?JSON.parse(event.slice('@@AERONIR@@'.length)):null;
    report('Python / Ultralytics / PyTorch',result.status===0 && !!info?.ready,info?.ready?`${python}; Ultralytics ${info.version}; devices: ${info.devices.join(', ')}`:result.error?.message || `Check ${python} and training/requirements.txt`);
} catch(error) {report('Python runtime',false,error.message);}
try {
    const directory=await fs.mkdtemp(path.join(root,'.aeronir-write-check-'));
    await fs.rmdir(directory);report('Project directory writable',true);
} catch(error) {report('Project directory writable',false,error.message);}
console.log('Camera permissions, GPU training and browser audio codecs require a separate browser/smoke test.');
console.log('unzip is used only by tests. Missing audio/Python tools do not prevent image labeling.');
process.exitCode=failed?1:0;
