import {test} from 'node:test';
import assert from 'node:assert/strict';
import {splitUnassignedTracks} from '../lib/audio-splits.js';
import {filteredTracks,adjacentTrack} from '../public/audio-workflow.js';

test('auto-split assigns 80/15/5 without touching existing assignments',()=>{
    const pending=Array.from({length:20},(_,id)=>({id,split:'unassigned'}));
    const pinned=[{id:100,split:'test'},{id:101,split:'valid'},{id:102,split:'train'}];
    const result=splitUnassignedTracks([...pending,...pinned],()=>0.5);
    assert.deepEqual(result,{updated:20,splits:{train:16,valid:3,test:1}});
    assert.deepEqual(pinned.map(t=>t.split),['test','valid','train']);
    assert.equal(splitUnassignedTracks([...pending,...pinned]).updated,0);
    assert.deepEqual(splitUnassignedTracks([]),{updated:0,splits:{train:0,valid:0,test:0}});
    const small=[{id:1,split:'unassigned'}];splitUnassignedTracks(small);assert.equal(small[0].split,'train');
});
test('navigation stays inside active split and unlabeled filters',()=>{
    const project={tracks:[{id:'a',split:'train'},{id:'b',split:'test'},{id:'c',split:'train'}],segments:[{trackId:'a'}]};
    const train=filteredTracks(project,'train');assert.deepEqual(train.map(t=>t.id),['a','c']);
    assert.equal(adjacentTrack(train,'a',1).id,'c');assert.equal(adjacentTrack(train,'a',-1).id,'c');
    assert.equal(adjacentTrack([],null,1),null);assert.equal(adjacentTrack(train,'missing',1).id,'a');
    assert.deepEqual(filteredTracks(project,'unlabeled').map(t=>t.id),['b','c']);
    project.segments.push({trackId:'b'});assert.deepEqual(filteredTracks(project,'unlabeled').map(t=>t.id),['c']);
});
