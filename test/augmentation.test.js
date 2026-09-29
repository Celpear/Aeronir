import { test } from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import { augmentImage, parseAugmentation } from '../lib/augmentation.js';

const source = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 120, g: 100, b: 80 } } }).png().toBuffer();
test('rejects malformed settings and unsafe strengths', () => {
    for (const settings of [null, [], { noise: -1 }, { blur: 100 }, { quality: NaN }, { exposure: '2' }, { resolution: 0 }]) assert.throws(() => parseAugmentation(settings));
    assert.equal(parseAugmentation({}).exposure, 0);
});
test('combined effects preserve annotation geometry and give repeatable output', async () => {
    const settings = { exposure: -1, noise: 15, blur: 1.5, resolution: 40, quality: 30 };
    const first = await augmentImage(source, settings);
    const second = await augmentImage(source, settings);
    assert.deepEqual(first.data, second.data);
    assert.equal(first.info.width, 64);
    assert.equal(first.info.height, 48);
    assert.equal(first.info.format, 'jpeg');
});
test('negative exposure darkens pixels', async () => {
    const neutral = await augmentImage(source, {});
    const darker = await augmentImage(source, { exposure: -1 });
    const a = await sharp(neutral.data).stats();
    const b = await sharp(darker.data).stats();
    assert.ok(b.channels[0].mean < a.channels[0].mean * 0.6);
});
test('noise alters a flat image and one-pixel images remain supported', async () => {
    const noisy = await augmentImage(source, { noise: 30, quality: 100 });
    const stats = await sharp(noisy.data).stats();
    assert.ok(stats.channels[0].stdev > 5);
    const tiny = await sharp(source).resize(1, 1).png().toBuffer();
    const result = await augmentImage(tiny, { resolution: 25, blur: 5 });
    assert.equal(result.info.width, 1);
    assert.equal(result.info.height, 1);
});

test('defocused camera visibly reduces edge detail after display resizing', async () => {
    const width = 1295;
    const pixels = Buffer.alloc(width * width * 3);
    for (let y = 0; y < width; y++) for (let x = 0; x < width; x++) {
        const value = (Math.floor(x / 24) + Math.floor(y / 24)) % 2 ? 240 : 16;
        pixels.fill(value, (y * width + x) * 3, (y * width + x) * 3 + 3);
    }
    const input = await sharp(pixels, { raw: { width, height: width, channels: 3 } }).png().toBuffer();
    const result = await augmentImage(input, { noise: 3, blur: 8, quality: 85, resolution: 65 });
    const original = await sharp(input).resize(280, 280).grayscale().raw().toBuffer();
    const filtered = await sharp(result.data).resize(280, 280).grayscale().raw().toBuffer();
    const detail = data => {
        let sum = 0;
        for (let y = 0; y < 280; y++) for (let x = 1; x < 280; x++) sum += Math.abs(data[y * 280 + x] - data[y * 280 + x - 1]);
        return sum;
    };
    assert.ok(detail(filtered) < detail(original) * 0.6, 'Blur must remain visible at preview size');
});
