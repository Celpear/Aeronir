export const AUDIO_SPLITS = ['unassigned', 'train', 'valid', 'test'];

export function splitUnassignedTracks(tracks, random = Math.random) {
    const pending = tracks.filter(track => track.split === 'unassigned');
    for (let i = pending.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pending[i], pending[j]] = [pending[j], pending[i]];
    }
    // Largest remainders keep small datasets as close as possible to 80/15/5.
    const ratios = [0.8, 0.15, 0.05];
    const counts = ratios.map(ratio => Math.floor(pending.length * ratio));
    const order = ratios.map((ratio, index) => ({ index, remainder: pending.length * ratio - counts[index] }))
        .sort((a, b) => b.remainder - a.remainder);
    const remaining = pending.length - counts.reduce((sum, count) => sum + count, 0);
    for (let i = 0; i < remaining; i++) counts[order[i].index]++;
    let offset = 0;
    const splits = {};
    ['train', 'valid', 'test'].forEach((split, index) => {
        splits[split] = counts[index];
        for (const track of pending.slice(offset, offset + counts[index])) track.split = split;
        offset += counts[index];
    });
    return { updated: pending.length, splits };
}
