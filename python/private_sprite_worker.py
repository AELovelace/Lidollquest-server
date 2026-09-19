"""One headless generation: JSON prompt on stdin, normalized PNG strip on stdout."""
import base64
import io
import json
import os
import sys
from PIL import Image
from pixellab_walk_core import PixelLabClient, DIRECTIONS


def generate(prompt, client):
    character, _ = client.create_character_4dir(prompt, 64, "thin", "flat", "medium", "high top-down", None)
    idle = client.fetch_character_direction_images(character)
    walk, _ = client.animate_character_walk(character, "walking, smooth looping walk cycle, in place", 8)
    frames = []
    for direction in DIRECTIONS:
        if direction not in idle or len(walk.get(direction, [])) != 8:
            raise ValueError("Incomplete directional walk cycle")  # Paid generations must contain actual animations; no static-frame substitutes.
    for data in [idle[d] for d in DIRECTIONS] + [f for d in DIRECTIONS for f in walk[d]]:
        picture = Image.open(io.BytesIO(data))
        if picture.width > 256 or picture.height > 256:
            raise ValueError("Unexpected frame size")
        picture = picture.convert("RGBA")
        picture.thumbnail((64, 64), Image.Resampling.NEAREST)
        frame = Image.new("RGBA", (64, 64))
        frame.alpha_composite(picture, ((64-picture.width)//2, 64-picture.height))
        frames.append(frame)  # Preserve frame padding so feet do not jump between walk frames.
    strip = Image.new("RGBA", (64 * 36, 64))
    for index, frame in enumerate(frames):
        strip.alpha_composite(frame, (64 * index, 0))
    out = io.BytesIO()
    strip.save(out, format="PNG")
    if len(out.getvalue()) > 180000:
        raise ValueError("Sprite strip exceeds delivery limit")
    return {"png": base64.b64encode(out.getvalue()).decode("ascii"), "frames": 36}


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read(8192))
        token = os.environ["PIXELLAB_API_TOKEN"]
        client = PixelLabClient(token)
        client.write_debug = lambda payload: None  # Player descriptions and provider responses never enter the desktop debug file.
        print(json.dumps(generate(request["prompt"], client)))
    except Exception:
        print("Sprite generation failed", file=sys.stderr)  # Do not expose provider tokens, private prompts or response bodies in server logs.
        sys.exit(1)
