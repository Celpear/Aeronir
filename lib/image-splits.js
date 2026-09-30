// Copy families stay together even when an original has already been deleted.
export function imageFamilies(images) {
    const parents = new Map();
    const root = id => {
        if (!parents.has(id)) parents.set(id, id);
        let current = id;
        while (parents.get(current) !== current) current = parents.get(current);
        return current;
    };
    for (const image of images) {
        const own = root(image.id);
        if (image.copiedFrom != null) parents.set(own, root(image.copiedFrom));
    }
    const groups = new Map();
    for (const image of images) {
        const id = root(image.id);
        if (!groups.has(id)) groups.set(id, []);
        groups.get(id).push(image);
    }
    return [...groups.values()];
}

export function splitImageFamilies(images, {trainRatio = .8, validRatio = .15, onlyUnassigned = true} = {}, random = Math.random) {
    if (![trainRatio, validRatio].every(value => Number.isFinite(value) && value >= 0 && value <= 1) || trainRatio + validRatio > 1) {
        throw new Error('Split ratios must be finite numbers between 0 and 1 and sum to at most 1.');
    }
    const groups = imageFamilies(images), assignments = [];
    const pending = [];
    for (const group of groups) {
        const assigned = new Set(group.filter(image => image.split !== 'unassigned').map(image => image.split));
        if (onlyUnassigned && !group.some(image => image.split === 'unassigned')) continue;
        if (onlyUnassigned && assigned.size > 1) throw new Error('Copies already span different splits. Use Reshuffle all to repair the split.');
        const fixed = onlyUnassigned && assigned.size ? [...assigned][0] : null;
        if (group.some(image => image.filter === 'augmentation')) {
            if (fixed && fixed !== 'train') throw new Error('Training augmentations must stay in train. Use Reshuffle all to repair the split.');
            assignments.push([group, 'train']);
        } else if (fixed) assignments.push([group, fixed]);
        else pending.push(group);
    }
    for (let i = pending.length - 1; i > 0; i--) {
        const j = Math.floor(random() * (i + 1));
        [pending[i], pending[j]] = [pending[j], pending[i]];
    }
    const ratios = [trainRatio, validRatio, 1 - trainRatio - validRatio];
    const counts = ratios.map(ratio => Math.floor(pending.length * ratio));
    const order = ratios.map((ratio, index) => ({index, remainder: pending.length * ratio - counts[index]})).sort((a,b) => b.remainder - a.remainder);
    for (let i = 0, remaining = pending.length - counts.reduce((a,b) => a+b, 0); i < remaining; i++) counts[order[i].index]++;
    let offset = 0;
    ['train', 'valid', 'test'].forEach((split, i) => {
        for (const group of pending.slice(offset, offset + counts[i])) assignments.push([group, split]);
        offset += counts[i];
    });
    let updated = 0;
    for (const [group, split] of assignments) for (const image of group) {
        if (!onlyUnassigned || image.split === 'unassigned') { image.split = split; updated++; }
    }
    return {updated, families: groups.length};
}
