// Periodic Hann STFT power and HTK triangular Mel filters.
// References: docs.scipy.org/doc/scipy/reference/generated/scipy.signal.stft.html
// librosa.org/doc/main/generated/librosa.filters.mel.html
export const hzToMel = hz => 2595 * Math.log10(1 + hz / 700);
export const melToHz = mel => 700 * (10 ** (mel / 2595) - 1);
function powerSpectrum(values) {
    const n = values.length, real = Float64Array.from(values), imag = new Float64Array(n);
    for (let i=1,j=0;i<n;i++) {
        let bit=n>>1;
        for(;j & bit;bit>>=1) j^=bit;
        j^=bit;
        if(i<j) [real[i],real[j]]=[real[j],real[i]];
    }
    for(let size=2;size<=n;size*=2) {
        const angle=-2*Math.PI/size;
        for(let offset=0;offset<n;offset+=size) for(let j=0;j<size/2;j++) {
            const a=offset+j,b=a+size/2,c=Math.cos(angle*j),s=Math.sin(angle*j);
            const re=real[b]*c-imag[b]*s,im=real[b]*s+imag[b]*c;
            real[b]=real[a]-re;imag[b]=imag[a]-im;real[a]+=re;imag[a]+=im;
        }
    }
    return Float64Array.from({length:n/2+1},(_,i)=>(real[i]**2+imag[i]**2)/(n*n));
}
export function spectrogram(samples, sampleRate, start, end, mode='stft', columns=192, rows=64) {
    if (!['mel','logmel','mfcc','stft'].includes(mode) || !Number.isFinite(sampleRate) || sampleRate<=0 || !Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start) throw new Error('Invalid spectrogram selection.');
    const first=Math.floor(start*sampleRate),last=Math.min(samples.length,Math.ceil(end*sampleRate));
    if(last<=first) throw new Error('No decoded audio in this segment.');
    const n=1024, nyquist=sampleRate/2;
    const frame=new Float64Array(n), values=new Float32Array(columns*rows), frequencies=[];
    const filters=[];
    for(let row=0;row<rows;row++) {
        if(mode!=='stft') {
            const left=melToHz(row/(rows+1)*hzToMel(nyquist));
            const center=melToHz((row+1)/(rows+1)*hzToMel(nyquist));
            const right=melToHz((row+2)/(rows+1)*hzToMel(nyquist));
            frequencies.push(center);
            const weights=[];
            for(let bin=Math.ceil(left/sampleRate*n);bin<=Math.min(n/2,Math.floor(right/sampleRate*n));bin++) {
                const hz=bin*sampleRate/n,weight=Math.max(0,Math.min((hz-left)/(center-left),(right-hz)/(right-center)));
                if(weight>0) weights.push([bin,weight]);
            }
            filters.push(weights);
        } else frequencies.push((row+0.5)/rows*nyquist);
    }
    let peak=0;
    for(let col=0;col<columns;col++) {
        // Uniformly sampled centered STFT frames for a bounded-size preview.
        const center=first+Math.floor((col+0.5)/columns*(last-first));
        for(let i=0;i<n;i++) {
            const index=center+i-n/2;
            frame[i]=(index>=first && index<last ? samples[index] : 0)*(0.5-0.5*Math.cos(2*Math.PI*i/n));
        }
        const power=powerSpectrum(frame);
        for(let row=0;row<rows;row++) {
            let value=0;
            if(mode!=='stft') for(const [bin,weight] of filters[row]) value+=power[bin]*weight;
            else for(let bin=Math.floor(row/rows*power.length);bin<Math.floor((row+1)/rows*power.length);bin++) value=Math.max(value,power[bin]);
            values[row*columns+col]=value;peak=Math.max(peak,value);
        }
    }
    if (mode === 'mfcc') {
        const coefficients = 13, cepstra = new Float32Array(coefficients * columns);
        let limit = 1;
        for (let col=0; col<columns; col++) {
            const logPowers = Array.from({length:rows}, (_,row) => 10*Math.log10(Math.max(values[row*columns+col],1e-10)));
            const dct = orthonormalDct(logPowers, coefficients);
            for (let row=0; row<coefficients; row++) {
                cepstra[row*columns+col] = dct[row]; limit = Math.max(limit, Math.abs(dct[row]));
            }
        }
        return {values:cepstra, columns, rows:coefficients, sampleRate, start, end, mode, colorMin:-limit, colorMax:limit,
            caption:'MFCC · C0–C12 · 64 HTK Mel bands · orthonormal DCT-II · signed coefficients'};
    }
    for(let i=0;i<values.length;i++) values[i]=mode==='mel' ? (peak>1e-20 ? values[i]/peak : 0) : (peak>1e-20 ? Math.max(-80,10*Math.log10(Math.max(values[i],1e-30)/peak)) : -80);
    return { values, columns, rows, frequencies, sampleRate, fftSize:n, start, end, mode, nyquist,
        colorMin:mode==='mel'?0:-80, colorMax:mode==='mel'?1:0,
        caption:mode==='mel'?'Mel · 64 bands · linear power / peak':mode==='logmel'?'Log-Mel · 64 bands · −80…0 dB relative':'STFT · linear frequency · −80…0 dB relative' };

}

// Mean FFT power across uniformly distributed Hann windows in the selected range.
export function fftSpectrum(samples, sampleRate, start, end) {
    if (!Number.isFinite(sampleRate) || sampleRate <= 0 || !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) throw new Error('Invalid FFT selection.');
    const first = Math.floor(start * sampleRate), last = Math.min(samples.length, Math.ceil(end * sampleRate));
    if (last <= first) throw new Error('No decoded audio in this segment.');
    const n = 4096, length = last - first;
    const frames = Math.min(256, Math.max(1, Math.ceil(length / (n / 2))));
    const frame = new Float64Array(n), powers = new Float64Array(n / 2 + 1);
    for (let f = 0; f < frames; f++) {
        const offset = length <= n ? first - Math.floor((n - length) / 2) : first + Math.round(f / Math.max(1, frames - 1) * (length - n));
        for (let i = 0; i < n; i++) {
            const index = offset + i;
            frame[i] = (index >= first && index < last ? samples[index] : 0) * (.5 - .5 * Math.cos(2 * Math.PI * i / n));
        }
        const power = powerSpectrum(frame);
        for (let bin = 0; bin < powers.length; bin++) powers[bin] += power[bin] / frames;
    }
    const peak = Math.max(...powers);
    const values = Float32Array.from(powers, value => peak > 1e-20 ? Math.max(-80, 10 * Math.log10(Math.max(value, 1e-30) / peak)) : -80);
    return {mode:'fft', values, frequencies:Float32Array.from(powers, (_,bin)=>bin*sampleRate/n), nyquist:sampleRate/2, sampleRate, fftSize:n, frames, start, end};
}


export function orthonormalDct(values, count=13) {
    return Float64Array.from({length:count}, (_,k) => {
        let sum=0;
        for(let i=0;i<values.length;i++) sum+=values[i]*Math.cos(Math.PI/values.length*(i+.5)*k);
        return sum*Math.sqrt((k===0?1:2)/values.length);
    });
}
function sampleBounds(samples, sampleRate, start, end) {
    if(!samples || !Number.isFinite(sampleRate) || sampleRate<=0 || !Number.isFinite(start) || !Number.isFinite(end) || start<0 || end<=start) throw new Error('Invalid audio selection.');
    const first=Math.floor(start*sampleRate),last=Math.min(samples.length,Math.ceil(end*sampleRate));
    if(last<=first) throw new Error('No decoded audio in this segment.');
    return [first,last];
}

// Direct variable-length constant-Q kernels: 12 bins/octave, C2 minimum.
export function cqtSpectrum(samples, sampleRate, start, end, columns=128) {
    const [first,last]=sampleBounds(samples,sampleRate,start,end);
    const binsPerOctave=12, q=1/(2**(1/binsPerOctave)-1), fmin=65.40639132514966;
    const frequencies=[];
    for(let f=fmin; f*(1+1/(2*q))<sampleRate/2; f*=2**(1/binsPerOctave)) frequencies.push(f);
    if(!frequencies.length) throw new Error('Sample rate is too low for CQT from C2.');
    const rows=frequencies.length, values=new Float32Array(rows*columns);
    let peak=0;
    for(let row=0;row<rows;row++) {
        const frequency=frequencies[row],n=Math.ceil(q*sampleRate/frequency);
        const real=new Float64Array(n),imag=new Float64Array(n);
        let norm=0;
        for(let i=0;i<n;i++) {
            const window=.5-.5*Math.cos(2*Math.PI*i/n),phase=2*Math.PI*frequency*(i-n/2)/sampleRate;
            real[i]=window*Math.cos(phase);imag[i]=window*Math.sin(phase);norm+=window;
        }
        for(let col=0;col<columns;col++) {
            const offset=first+Math.floor((col+.5)/columns*(last-first))-Math.floor(n/2);
            let re=0,im=0;
            for(let i=Math.max(0,first-offset);i<Math.min(n,last-offset);i++) {
                re+=samples[offset+i]*real[i];im+=samples[offset+i]*imag[i];
            }
            const power=(re*re+im*im)/(norm*norm);
            values[row*columns+col]=power;peak=Math.max(peak,power);
        }
    }
    for(let i=0;i<values.length;i++) values[i]=peak>1e-20?Math.max(-80,10*Math.log10(Math.max(values[i],1e-30)/peak)):-80;
    return {mode:'cqt',values,frequencies,rows,columns,sampleRate,start,end,colorMin:-80,colorMax:0,
        caption:'CQT · 12 bins/octave · C2 minimum · variable Hann windows · −80…0 dB relative'};
}

// One-sided density scaling, constant detrend, periodic Hann, 50% overlap.
// Long selections sample at most 512 of the regular Welch windows for responsive previews.
export function welchPsd(samples,sampleRate,start,end) {
    const [first,last]=sampleBounds(samples,sampleRate,start,end), length=last-first;
    const n=Math.max(2,2**Math.floor(Math.log2(Math.min(4096,length))));
    const hop=n/2,totalFrames=Math.max(1,1+Math.floor((length-n)/hop)),frames=Math.min(512,totalFrames);
    const window=Float64Array.from({length:n},(_,i)=>.5-.5*Math.cos(2*Math.PI*i/n));
    const windowPower=window.reduce((sum,v)=>sum+v*v,0),frame=new Float64Array(n),density=new Float64Array(n/2+1);
    for(let f=0;f<frames;f++) {
        const index=frames===1?0:Math.round(f*(totalFrames-1)/(frames-1));
        const offset=first+index*hop, available=Math.min(n,last-offset);
        let mean=0;
        for(let i=0;i<available;i++) mean+=samples[offset+i]/available;
        for(let i=0;i<n;i++) frame[i]=i<available?(samples[offset+i]-mean)*window[i]:0;
        const power=powerSpectrum(frame);
        for(let bin=0;bin<power.length;bin++) density[bin]+=power[bin]*n*n/(sampleRate*windowPower)*((bin===0||bin===n/2)?1:2)/frames;
    }
    const values=Float32Array.from(density,v=>10*Math.log10(Math.max(v,1e-20)));
    const max=Math.max(...values),axisMax=Math.max(-100,Math.ceil(max/20)*20);
    return {mode:'psd',values,density,frequencies:Float32Array.from(density,(_,i)=>i*sampleRate/n),sampleRate,nyquist:sampleRate/2,start,end,frames,totalFrames,
        axisMin:axisMax-100,axisMax,unit:'dB/Hz',caption:`Welch PSD · ${n}-point Hann · 50% overlap · ${frames}/${totalFrames} windows${frames<totalFrames?' (sampled preview)':''} · dB re 1 amplitude²/Hz`};
}
export function analyzeAudio(samples,sampleRate,start,end,mode='stft') {
    if(mode==='fft') return fftSpectrum(samples,sampleRate,start,end);
    if(mode==='cqt') return cqtSpectrum(samples,sampleRate,start,end);
    if(mode==='psd') return welchPsd(samples,sampleRate,start,end);
    return spectrogram(samples,sampleRate,start,end,mode);
}
