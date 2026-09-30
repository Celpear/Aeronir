import path from 'node:path';

export function yoloPython(root, {platform = process.platform, override = process.env.YOLO_PYTHON} = {}) {
    const paths = platform === 'win32' ? path.win32 : path.posix;
    if (override) {
        if (!paths.isAbsolute(override)) throw new Error('YOLO_PYTHON must be an absolute path to the Python executable.');
        return override;
    }
    return platform === 'win32'
        ? paths.join(root, '.venv-yolo', 'Scripts', 'python.exe')
        : paths.join(root, '.venv-yolo', 'bin', 'python');
}
