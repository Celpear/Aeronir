import {test} from 'node:test';
import assert from 'node:assert/strict';
import {imageFamilies, splitImageFamilies} from '../lib/image-splits.js';

test('random split distributes 100 independent originals 80/15/5, not by upload order', () => {
    const images = Array.from({length:100}, (_, id) => ({id, split:'unassigned'}));
    splitImageFamilies(images, {}, () => 0);
    assert.deepEqual(['train','valid','test'].map(split => images.filter(i => i.split === split).length), [80,15,5]);
    assert.equal(images[0].split, 'test');
    assert.equal(images[80].split, 'train');
});
test('copy chains and orphan siblings stay together and unassigned copies inherit their family split', () => {
    const images = [{id:1,split:'valid'}, {id:2,copiedFrom:1,split:'unassigned'}, {id:3,copiedFrom:2,split:'unassigned'}, {id:4,copiedFrom:99,split:'unassigned'}, {id:5,copiedFrom:99,split:'unassigned'}];
    assert.equal(imageFamilies(images).length,2);
    assert.equal(splitImageFamilies(images).updated,4);
    assert.equal(images[2].split,'valid'); assert.equal(images[4].split,images[3].split);
});
test('reshuffle repairs leakage, keeps augmentations in train and rejects invalid ratios atomically', () => {
    const images = [{id:1,split:'valid'}, {id:2,copiedFrom:1,split:'test'}, {id:3,copiedFrom:2,split:'unassigned',filter:'augmentation'}];
    assert.throws(() => splitImageFamilies(images),/different splits/);
    assert.equal(images[2].split,'unassigned');
    splitImageFamilies(images,{onlyUnassigned:false});
    assert.ok(images.every(image => image.split === 'train'));
    for (const options of [{trainRatio:NaN},{trainRatio:.9,validRatio:.3},{validRatio:-1}]) assert.throws(() => splitImageFamilies(images,options),/ratios/);
});
test('cyclic copy metadata is grouped without hanging', () => {
    assert.equal(imageFamilies([{id:1,copiedFrom:2},{id:2,copiedFrom:1}]).length,1);
});
