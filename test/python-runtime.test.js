import {test} from 'node:test';
import assert from 'node:assert/strict';
import {yoloPython} from '../lib/python-runtime.js';
test('resolves native Windows, macOS and Linux virtual environments including paths with spaces',()=>{
    assert.equal(yoloPython('C:\\My Projects\\Aeronir',{platform:'win32',override:''}),'C:\\My Projects\\Aeronir\\.venv-yolo\\Scripts\\python.exe');
    for(const platform of ['darwin','linux']) assert.equal(yoloPython('/home/My Projects/Aeronir',{platform,override:''}),'/home/My Projects/Aeronir/.venv-yolo/bin/python');
    assert.equal(yoloPython('C:\\repo',{platform:'win32',override:'D:\\Python Env\\python.exe'}),'D:\\Python Env\\python.exe');
    assert.throws(()=>yoloPython('/repo',{platform:'linux',override:'python3'}),/absolute/);
});
