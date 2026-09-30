export function filteredTracks(project, filter) {
    const labeled = new Set(project.segments.map(segment => segment.trackId));
    return project.tracks.filter(track => filter === 'all' || (filter === 'unlabeled' ? !labeled.has(track.id) : track.split === filter));
}

export function adjacentTrack(tracks, id, direction) {
    if (!tracks.length) return null;
    const index = tracks.findIndex(track => track.id === id);
    return tracks[index < 0 ? (direction < 0 ? tracks.length - 1 : 0) : (index + direction + tracks.length) % tracks.length];
}
