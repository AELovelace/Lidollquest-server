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
    from pixellab_walk_core import PixelLabClient, DIRECTIONS
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
    elif str(error) in ("Unexpected frame size", "Sprite strip exceeds delivery limit"):
        result["code"] = "invalid_sprite_output"
    return result  # Return allowlisted metadata only, never the exception text, token, prompt or provider body.


def generate(prompt, client):
    character, _ = generation_stage("create", lambda: client.create_character_4dir(prompt, 64, "thin", "flat", "medium", "high top-down", None))
    idle = generation_stage("fetch", lambda: client.fetch_character_direction_images(character))
    walk, _ = generation_stage("animate", lambda: client.animate_character_walk(character, "walking, smooth looping walk cycle, in place", 8))
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
    except Exception as error:
        print(json.dumps({"error": failure_diagnostic(error)}), file=sys.stderr)  # Preserve a useful failure category without exposing provider response bodies.
        sys.exit(1)
