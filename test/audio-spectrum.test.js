import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spectrogram,hzToMel,melToHz} from '../public/audio-spectrum.js';
const rate=16000;
const tone=(hz,duration=1)=>Float32Array.from({length:rate*duration},(_,i)=>Math.sin(i/rate*2*Math.PI*hz));
function peak(result){
    const powers=result.frequencies.map((_,row)=>result.values[row*result.columns+Math.floor(result.columns/2)]);
    return result.frequencies[powers.indexOf(Math.max(...powers))];
}
test('STFT locates a known tone and respects selected time boundaries',()=>{
    const data=new Float32Array(rate*2);data.set(tone(500));data.set(tone(3000),rate);
    assert.ok(Math.abs(peak(spectrogram(data,rate,.1,.9,'stft'))-500)<150);
    assert.ok(Math.abs(peak(spectrogram(data,rate,1.1,1.9,'stft'))-3000)<150);
});
test('Mel filterbank locates a tone and conversion is reversible',()=>{
    const result=spectrogram(tone(1000),rate,0,1,'mel');
    assert.ok(Math.abs(peak(result)-1000)<100);
    assert.ok(Math.abs(melToHz(hzToMel(8000))-8000)<1e-8);
});
test('silence, sub-window segments and invalid ranges',()=>{
    const result=spectrogram(new Float32Array(rate),rate,0,1);
    assert.ok(result.values.every(v=>v===-80));
    assert.ok(spectrogram(tone(500),rate,0,.001).values.every(Number.isFinite));
    assert.throws(()=>spectrogram(tone(500),rate,2,3));
    assert.throws(()=>spectrogram(tone(500),rate,.5,.2));
});

test('FFT locates tones within the selection, averages power, and handles silence and short clips', async()=>{
    const {fftSpectrum}=await import('../public/audio-spectrum.js');
    const data=new Float32Array(rate*2);data.set(tone(500));data.set(tone(3000),rate);
    const strongest=result=>result.frequencies[result.values.indexOf(Math.max(...result.values))];
    assert.ok(Math.abs(strongest(fftSpectrum(data,rate,.1,.9))-500)<5);
    assert.ok(Math.abs(strongest(fftSpectrum(data,rate,1.1,1.9))-3000)<5);
    const mixed=fftSpectrum(data,rate,0,2);
    assert.ok(mixed.values[Math.round(500*4096/rate)]>-4);
    assert.ok(mixed.values[Math.round(3000*4096/rate)]>-4);
    assert.ok(fftSpectrum(new Float32Array(rate),rate,0,1).values.every(v=>v===-80));
    assert.ok(fftSpectrum(data,rate,0,.001).values.every(Number.isFinite));
    assert.throws(()=>fftSpectrum(data,rate,3,4));
    assert.throws(()=>fftSpectrum(data,rate,1,.5));
    assert.equal(spectrogram(data,rate,0,1).mode,'stft');
});

test('Log-Mel is the dB transform of linear Mel power',()=>{
    const data=tone(1000),linear=spectrogram(data,rate,0,1,'mel'),log=spectrogram(data,rate,0,1,'logmel');
    assert.ok(linear.values.every(v=>v>=0&&v<=1));
    for(let i=0;i<linear.values.length;i++) {
        assert.ok(Math.abs(log.values[i]-Math.max(-80,10*Math.log10(Math.max(linear.values[i],1e-30))))<.001);
    }
});
test('MFCC uses orthonormal DCT-II and retains energy in C0',async()=>{
    const {orthonormalDct}=await import('../public/audio-spectrum.js');
    const coefficients=orthonormalDct(Array(64).fill(3));
    assert.ok(Math.abs(coefficients[0]-24)<1e-10);
    assert.ok(coefficients.slice(1).every(v=>Math.abs(v)<1e-10));
    const data=Float32Array.from({length:rate},(_,i)=>Math.sin(i*i*1.234)+Math.cos(i*i*.738));
    const loud=spectrogram(data,rate,.1,.9,'mfcc'),quiet=spectrogram(data.map(v=>v*.5),rate,.1,.9,'mfcc');
    assert.equal(loud.rows,13);assert.equal(loud.values.length,13*192);
    assert.ok(loud.values.every(Number.isFinite));
    assert.ok(Math.abs((quiet.values[96]-loud.values[96])-20*Math.log10(.5)*8)<.01);
    for(let row=1;row<13;row++) assert.ok(Math.abs(quiet.values[row*192+96]-loud.values[row*192+96])<.01);
});
test('CQT resolves musical frequencies and respects selection boundaries',async()=>{
    const {cqtSpectrum}=await import('../public/audio-spectrum.js');
    const data=new Float32Array(rate*2);data.set(tone(440));data.set(tone(1760),rate);
    const low=cqtSpectrum(data,rate,.1,.9),high=cqtSpectrum(data,rate,1.1,1.9);
    assert.ok(Math.abs(peak(low)-440)<1);
    assert.ok(Math.abs(peak(high)-1760)<1);
    for(let i=1;i<low.frequencies.length;i++) assert.ok(Math.abs(low.frequencies[i]/low.frequencies[i-1]-2**(1/12))<1e-10);
});
test('Welch density integrates to signal power and preserves amplitude scaling',async()=>{
    const {welchPsd}=await import('../public/audio-spectrum.js');
    const full=welchPsd(tone(1000),rate,0,1),half=welchPsd(tone(1000).map(v=>v*.5),rate,0,1);
    const spacing=full.frequencies[1];
    assert.ok(Math.abs(full.density.reduce((a,b)=>a+b,0)*spacing-.5)<.001);
    const i=full.values.indexOf(Math.max(...full.values));
    assert.ok(Math.abs(full.frequencies[i]-1000)<5);
    assert.ok(Math.abs(half.values[i]-full.values[i]-20*Math.log10(.5))<.001);
    assert.ok(welchPsd(new Float32Array(rate).fill(.5),rate,0,1).density.every(v=>v===0),'constant detrending removes DC');
});
test('every new analysis handles silence, short ranges, and invalid selections',async()=>{
    const {analyzeAudio}=await import('../public/audio-spectrum.js');
    for(const mode of ['logmel','mfcc','cqt','psd']) {
        assert.ok(analyzeAudio(new Float32Array(rate),rate,0,1,mode).values.every(Number.isFinite));
        assert.ok(analyzeAudio(tone(500),rate,0,.0001,mode).values.every(Number.isFinite));
        assert.throws(()=>analyzeAudio(tone(500),rate,2,3,mode));
        assert.throws(()=>analyzeAudio(tone(500),rate,.5,.1,mode));
    }
});
