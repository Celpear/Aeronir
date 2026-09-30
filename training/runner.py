"""Isolated Ultralytics training/inference bridge. All commands come from the Node server."""
import argparse
import contextlib
import json
import math
import sys
import time
from pathlib import Path

PREFIX = '@@AERONIR@@'


def emit(data):
    print('\n' + PREFIX + json.dumps(data, allow_nan=False), flush=True)


def number(value):
    try:
        value = float(value)
        return value if math.isfinite(value) else None
    except (TypeError, ValueError):
        return None


def device_name(requested, torch):
    if requested != 'auto':
        return requested
    if torch.cuda.is_available():
        return '0'
    if torch.backends.mps.is_available():
        return 'mps'
    return 'cpu'


def probe():
    import torch
    import ultralytics
    emit({'type': 'environment', 'ready': True, 'version': ultralytics.__version__,
          'torch': torch.__version__, 'devices': ['cpu'] + (['mps'] if torch.backends.mps.is_available() else []) + (['0'] if torch.cuda.is_available() else [])})


def train(config_path):
    import torch
    from ultralytics import YOLO
    config = json.loads(Path(config_path).read_text())
    settings = config['settings']
    device = device_name(settings['device'], torch)
    emit({'type': 'stage', 'message': f'Loading {settings["model"]}.pt on {device}. First use may download pretrained weights.'})
    model = YOLO(settings['model'] + '.pt')
    last_progress = [0]
    current_epoch = [-1]

    def epoch_start(trainer):
        current_epoch[0] = trainer.epoch

    def batch_end(trainer):
        now = time.monotonic()
        if now - last_progress[0] >= 1:
            emit({'type': 'progress', 'epoch': trainer.epoch + 1, 'epochs': settings['epochs'], 'device': device})
            last_progress[0] = now

    def epoch_end(trainer):
        if trainer.epoch != current_epoch[0]:
            return  # Ultralytics also emits this callback for final best-model validation.
        metrics = {str(k): number(v) for k, v in (trainer.metrics or {}).items()}
        losses = trainer.label_loss_items(trainer.tloss, prefix='train')
        metrics.update({str(k): number(v) for k, v in losses.items()})
        emit({'type': 'epoch', 'epoch': trainer.epoch + 1, 'epochs': settings['epochs'], 'metrics': metrics})

    model.add_callback('on_train_epoch_start', epoch_start)
    model.add_callback('on_train_batch_end', batch_end)
    model.add_callback('on_fit_epoch_end', epoch_end)
    model.train(data=config['data'], epochs=settings['epochs'], imgsz=settings['imgsz'],
                batch=settings['batch'], device=device, patience=settings['patience'], seed=settings['seed'],
                project=config['output'], name='fit', exist_ok=True, workers=0,
                save=True, plots=True, verbose=True, amp=False)
    best = Path(model.trainer.best)
    if not best.is_file():
        raise RuntimeError('Training finished without best.pt.')
    emit({'type': 'complete', 'message': 'Training complete. best.pt is ready.'})


def infer(weights):
    import base64
    import io
    from PIL import Image
    from ultralytics import YOLO
    # Keep stdout a strict JSON protocol, even when Ultralytics prints model information.
    with contextlib.redirect_stdout(sys.stderr):
        model = YOLO(weights)
    emit({'type': 'ready'})
    for line in sys.stdin:
        try:
            request = json.loads(line)
            with contextlib.redirect_stdout(sys.stderr):
                image = Image.open(io.BytesIO(base64.b64decode(request['image']))).convert('RGB')
                if image.width * image.height > 4000000:
                    raise ValueError('Preview image is too large.')
                started = time.monotonic()
                result = model.predict(image, imgsz=640, conf=request['confidence'], device='cpu', verbose=False)[0]
            boxes = [{'xyxy': box.xyxy[0].tolist(), 'confidence': float(box.conf[0]),
                      'classId': int(box.cls[0]), 'label': result.names[int(box.cls[0])]} for box in result.boxes]
            emit({'type': 'prediction', 'id': request['id'], 'width': image.width, 'height': image.height,
                  'boxes': boxes, 'milliseconds': round((time.monotonic() - started) * 1000)})
        except Exception as error:
            emit({'type': 'error', 'id': request.get('id') if 'request' in locals() else None, 'message': str(error)})


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('command', choices=['probe', 'train', 'infer'])
    parser.add_argument('file', nargs='?')
    args = parser.parse_args()
    try:
        if args.command == 'probe':
            probe()
        elif args.command == 'train':
            train(args.file)
        else:
            infer(args.file)
    except Exception as error:
        emit({'type': 'error', 'message': str(error)})
        if args.command != 'probe':
            import traceback
            traceback.print_exc()
        sys.exit(1)
