import { analyzeAudio } from './audio-spectrum.js';
let samples, sampleRate;
const cache = new Map();
self.onmessage = ({data}) => {
    if(data.type==='init') { samples=data.samples;sampleRate=data.sampleRate;cache.clear();return; }
    try {
        const key=`${data.start}:${data.end}:${data.mode}`;
        let result=cache.get(key);
        if(!result) {
            result=analyzeAudio(samples,sampleRate,data.start,data.end,data.mode);
            if(cache.size>=40)cache.delete(cache.keys().next().value);
            cache.set(key,result);
        }
        self.postMessage({id:data.id,result});
    }catch(err){self.postMessage({id:data.id,error:err.message});}
};
