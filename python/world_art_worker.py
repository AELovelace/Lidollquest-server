"""Download a known admin character/design or pack a completed animation; never spend credits."""
import base64
import io
import json
import os
import sys
from PIL import Image
from private_sprite_worker import pack_frames, failure_diagnostic
from pixellab_walk_core import PixelLabClient, DIRECTIONS, normalize_image_bytes


def download(request, client):
    idle = client.fetch_character_direction_images(request['character'])
    if request['stage'] == 'design':
        images = [normalize_image_bytes(idle[d], 64) for d in DIRECTIONS]
        strip = Image.new('RGBA', (256, 64))
        for i, raw in enumerate(images):
            strip.alpha_composite(Image.open(io.BytesIO(raw)).convert('RGBA'), (i * 64, 0))
        out = io.BytesIO()
        strip.save(out, format='PNG')
        return {'png': base64.b64encode(out.getvalue()).decode('ascii'), 'frames': 1,
                'reference': base64.b64encode(images[0]).decode('ascii')}
    keys = {request['animation']}
    walk = {d: [] for d in DIRECTIONS}
    for index, job in enumerate(request['jobs']):
        result = client._get('background-jobs/' + job)
        if result.get('status') != 'completed':
            raise ValueError('Animation is not complete')
        output = result.get('last_response') or result.get('output') or result
        if isinstance(output, dict):
            keys.update(v for k, v in output.items() if k in ('animation_id', 'animation_name') and isinstance(v, str))
        direction = request.get('directions', [])[index] if index < len(request.get('directions', [])) else None
        for d, frames in client._extract_walk_frames(output, direction).items():
            walk[d].extend(frames)
    if any(len(walk[d]) != 8 for d in DIRECTIONS):
        stored = client._fetch_character_walk_frames(request['character'], keys, False)
        for d in DIRECTIONS:
            if len(walk[d]) != 8:
                walk[d] = stored[d]
    return pack_frames(idle, walk)  # The same union crop and packing as player walking sprites.


if __name__ == '__main__':
    try:
        client = PixelLabClient(os.environ['PIXELLAB_API_TOKEN'])
        client.write_debug = lambda payload: None
        print(json.dumps(download(json.loads(sys.stdin.read(16384)), client)))
    except Exception as error:
        print(json.dumps({'error': failure_diagnostic(error)}), file=sys.stderr)
        sys.exit(1)
