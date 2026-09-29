import sharp from 'sharp';

const limits = { exposure: [-2, 2, 0], contrast: [0.5, 1.5, 1], gamma: [0.5, 2, 1], noise: [0, 40, 0], blur: [0, 30, 0], quality: [10, 100, 92], resolution: [25, 100, 100] };
export function parseAugmentation(input = {}) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Invalid augmentation settings');
    const settings = {};
    for (const [key, [min, max, fallback]] of Object.entries(limits)) {
        const value = input[key] ?? fallback;
        if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${key}: expected ${min}–${max}`);
        settings[key] = value;
    }
    settings.quality = Math.round(settings.quality);
    return settings;
}

export async function augmentImage(input, settings) {
    const s = parseAugmentation(settings);
    let { data, info } = await sharp(input).flatten({ background: '#ffffff' }).toColourspace('srgb').removeAlpha().raw().toBuffer({ resolveWithObject: true });
    // Fixed seed keeps preview and saved image identical for the same source/settings.
    let seed = 123456789;
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) / 4294967296; };
    for (let i = 0; i < data.length; i += info.channels) {
        const noise = s.noise ? (random() + random() + random() + random() - 2) * s.noise : 0;
        for (let c = 0; c < info.channels; c++) {
            const exposed = Math.min(1, data[i + c] / 255 * 2 ** s.exposure);
            const value = ((exposed ** (1 / s.gamma) - 0.5) * s.contrast + 0.5) * 255 + noise;
            data[i + c] = Math.max(0, Math.min(255, Math.round(value)));
        }
    }
    let pipeline = sharp(data, { raw: info });
    if (s.blur > 0) pipeline = pipeline.blur(Math.max(0.3, s.blur));
    if (s.resolution < 100) {
        const reduced = await pipeline.resize(Math.max(1, Math.round(info.width * s.resolution / 100)), Math.max(1, Math.round(info.height * s.resolution / 100)), { fit: 'fill' }).png().toBuffer();
        pipeline = sharp(reduced).resize(info.width, info.height, { fit: 'fill' });
    }
    return pipeline.jpeg({ quality: s.quality }).toBuffer({ resolveWithObject: true });
}
