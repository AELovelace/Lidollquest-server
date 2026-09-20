"""One headless generation: JSON prompt on stdin, normalized PNG strip on stdout."""
import base64
import io
import json
import os
import re
import sys
try:
    import requests
    from PIL import Image
    from pixellab_walk_core import PixelLabClient, DIRECTIONS, compute_combined_bbox
except ImportError:
    if __name__ == "__main__":
        print(json.dumps({"error": {"code": "python_dependency_missing", "stage": "startup"}}), file=sys.stderr)
        sys.exit(1)  # Report missing imports without printing interpreter paths or a traceback.
    raise


def generation_stage(stage, work):
    try:
        return work()
    except Exception as error:
        error.sprite_stage = stage  # Retain the failing step while keeping provider response bodies out of service logs.
        raise


def failure_diagnostic(error):
    stage = getattr(error, "sprite_stage", "pack")
    if stage not in ("create", "fetch", "animate", "pack"):
        stage = "pack"
    result = {"code": "generation_failed", "stage": stage}
    status = getattr(getattr(error, "response", None), "status_code", None)
    # The shared desktop client wraps POST failures; extract only its numeric HTTP status.
    match = re.match(r"^PixelLab POST [a-zA-Z0-9/_-]+ failed with HTTP ([0-9]{3})\.", str(error))
    if match:
        status = int(match.group(1))
    if isinstance(status, int) and 400 <= status <= 599:
        result.update(code="provider_http_error", http_status=status)
    elif isinstance(error, requests.exceptions.Timeout):
        result["code"] = "provider_timeout"
    elif isinstance(error, requests.exceptions.RequestException):
        result["code"] = "provider_network_error"
    elif str(error) == "Incomplete directional walk cycle":
        result["code"] = "incomplete_animation"
        counts = getattr(error, "sprite_counts", {})
        for key in ("idle_count", "south", "north", "east", "west"):
            if type(counts.get(key)) is int and 0 <= counts[key] <= 256:
                result[key] = counts[key]  # Counts distinguish missing output from unexpected frame totals without exposing image URLs.
    elif str(error) in ("Unexpected frame size", "Sprite strip exceeds delivery limit"):
        result["code"] = "invalid_sprite_output"
    return result  # Return allowlisted metadata only, never the exception text, token, prompt or provider body.


def generate(prompt, client):
    character, _ = generation_stage("create", lambda: client.create_character_4dir(prompt, 64, "thin", "flat", "medium", "high top-down", None))
    idle = generation_stage("fetch", lambda: client.fetch_character_direction_images(character))
    walk, _ = generation_stage("animate", lambda: client.animate_character_walk(character, "walking, smooth looping walk cycle, in place", 8))
    return pack_frames(idle, walk)


def pack_frames(idle, walk):
    """Pack downloaded frames without submitting any provider generation."""
    frames = []
    for direction in DIRECTIONS:
        if direction not in idle or len(walk.get(direction, [])) != 8:
            error = ValueError("Incomplete directional walk cycle")
            error.sprite_counts = {"idle_count": len(idle), **{d: len(walk.get(d, [])) for d in DIRECTIONS}}
            raise error  # Paid generations must contain actual animations; no static-frame substitutes.
    pictures = []
    for data in [idle[d] for d in DIRECTIONS] + [f for d in DIRECTIONS for f in walk[d]]:
        picture = Image.open(io.BytesIO(data))
        if picture.width > 256 or picture.height > 256:
            raise ValueError("Unexpected frame size")
        pictures.append(picture.convert("RGBA"))  # Decode every frame first; the crop below must see the whole cycle at once.
    sheet_w = max(picture.width for picture in pictures)
    sheet_h = max(picture.height for picture in pictures)  # Frames may differ slightly, so measure one shared canvas before cropping.
    padded = []
    for picture in pictures:
        canvas = Image.new("RGBA", (sheet_w, sheet_h))
        canvas.alpha_composite(picture, ((sheet_w-picture.width)//2, sheet_h-picture.height))
        padded.append(canvas)  # Bottom-center each frame onto that canvas so every pose shares one baseline.
    left, top, right, bottom = compute_combined_bbox(padded, sheet_w, sheet_h)  # One union box over all 36 frames; per-frame crops would make the sprite bob while walking.
    box = (left, top, right+1, bottom+1)
    scale = min(64/max(1, box[2]-box[0]), 64/max(1, box[3]-box[1]))  # Fill the 64px cell the way compiled NPC sprites do instead of leaving transparent margin.
    art_w = max(1, min(64, int(round((box[2]-box[0])*scale))))
    art_h = max(1, min(64, int(round((box[3]-box[1])*scale))))
    for picture in padded:
        art = picture.crop(box).resize((art_w, art_h), Image.Resampling.NEAREST)  # Identical crop and scale per frame keeps the walk cycle steady.
        frame = Image.new("RGBA", (64, 64))
        frame.alpha_composite(art, ((64-art_w)//2, 64-art_h))
        frames.append(frame)  # Bottom-center leaves the character standing on the tile's lower edge.
    strip = Image.new("RGBA", (64 * 36, 64))
    for index, frame in enumerate(frames):
        strip.alpha_composite(frame, (64 * index, 0))
    out = io.BytesIO()
    strip.save(out, format="PNG")
    if len(out.getvalue()) > 180000:
        raise ValueError("Sprite strip exceeds delivery limit")
    reference = io.BytesIO()
    frames[0].save(reference, format="PNG")  # Use the same character as the shared monster portrait reference.
    return {"png": base64.b64encode(out.getvalue()).decode("ascii"), "frames": 36, "reference": base64.b64encode(reference.getvalue()).decode("ascii")}


if __name__ == "__main__":
    try:
        request = json.loads(sys.stdin.read(8192))
        token = os.environ["PIXELLAB_API_TOKEN"]
        client = PixelLabClient(token)
        client.write_debug = lambda payload: None  # Player descriptions and provider responses never enter the desktop debug file.
        print(json.dumps(generate(request["prompt"], client)))
    except Exception as error:
        print(json.dumps({"error": failure_diagnostic(error)}), file=sys.stderr)  # Preserve a useful failure category without exposing provider response bodies.
        sys.exit(1)
