#!/usr/bin/env python3
"""
PixelLab walk sprite generator GUI.

Docs source:
  https://api.pixellab.ai/v2/llms.txt

This tool is based on the proven create-character + animate-character flow from
regenerate_sprites_64px.py, but keeps the workflow interactive:
  1. Generate a 4-direction character.
  2. Automatically generate a walk cycle from the returned character_id.
  3. Preview, save, and register both static and walk sprites in GameMaker.
"""

from __future__ import annotations

import base64
import binascii
import io
import json
import os
import re
import shutil
import time
import uuid
import zipfile
from dataclasses import dataclass

import requests
from PIL import Image


PIXELLAB_API_BASE_URL = os.getenv("PIXELLAB_API_BASE_URL", "https://api.pixellab.ai/v2")
PIXELLAB_API_TOKEN = os.getenv("PIXELLAB_API_TOKEN", "")
REQUEST_TIMEOUT_SECONDS = 120
BACKGROUND_JOB_POLL_SECONDS = 2.0
BACKGROUND_JOB_MAX_POLLS = 240
DEFAULT_PROJECT_YYP = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "lidollquest.yyp"))
DEFAULT_SPRITE_PARENT_FOLDER = "folders/Sprites.yy"
DEBUG_RESPONSE_PATH = os.path.join(os.path.dirname(__file__), "_last_pixellab_response.json")
SPRITE_NAME_PATTERN = re.compile(r"[A-Za-z_][A-Za-z0-9_]*\Z")

SIZE_MIN = 64
SIZE_MAX = 128
FRAME_COUNT_MIN = 4
FRAME_COUNT_MAX = 16
STATIC_PLAYBACK_SPEED = 0.0
WALK_PLAYBACK_SPEED = 15.0
DIRECTIONS = ("south", "north", "east", "west")
DIRECTION_LABELS = {
    "south": "South",
    "north": "North",
    "east": "East",
    "west": "West",
}
DIRECTION_SORT_ORDER = {
    "South": 0,
    "North": 1,
    "East": 2,
    "West": 3,
}


def new_guid() -> str:
    return str(uuid.uuid4())


def decode_b64(value: str) -> bytes | None:
    try:
        return base64.b64decode(value)
    except (binascii.Error, ValueError):
        return None


def decode_rgba_raw(value: str, width: int, height: int) -> bytes | None:
    raw = decode_b64(value)
    if raw is None or len(raw) != width * height * 4:
        return None
    try:
        image = Image.frombytes("RGBA", (width, height), raw)
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        return buffer.getvalue()
    except Exception:
        return None


def decode_data_url(value: str) -> bytes | None:
    if "," not in value:
        return None
    _, encoded = value.split(",", 1)
    return decode_b64(encoded)


def decode_image_candidate(node: object) -> bytes | None:
    if isinstance(node, dict):
        if node.get("type") == "rgba_bytes" and isinstance(node.get("base64"), str):
            width = node.get("width")
            height = node.get("height")
            if isinstance(width, int) and isinstance(height, int) and width > 0 and height > 0:
                return decode_rgba_raw(node["base64"], width, height)
        if "image" in node and isinstance(node["image"], dict):
            return decode_image_candidate(node["image"])
        if isinstance(node.get("base64"), str):
            return decode_b64(node["base64"])
        if isinstance(node.get("data_url"), str):
            return decode_data_url(node["data_url"])
        for key in ("url", "image_url", "download_url", "preview_url", "src"):
            value = node.get(key)
            if isinstance(value, str) and value.startswith(("http://", "https://")):
                response = requests.get(value, timeout=REQUEST_TIMEOUT_SECONDS)
                response.raise_for_status()
                return response.content

    if isinstance(node, str):
        if node.startswith("data:image/"):
            return decode_data_url(node)
        if node.startswith(("http://", "https://")):
            response = requests.get(node, timeout=REQUEST_TIMEOUT_SECONDS)
            response.raise_for_status()
            return response.content

    return None


def direction_from_path(path: str) -> str | None:
    lowered = path.lower()
    for direction in DIRECTIONS:
        if direction in lowered:
            return direction
    return None


def extract_direction_images(payload: object) -> dict[str, bytes]:
    results: dict[str, bytes] = {}

    def walk(node: object, path: str = "") -> None:
        direction = direction_from_path(path)
        image_bytes = decode_image_candidate(node)
        if direction is not None and image_bytes is not None and direction not in results:
            results[direction] = image_bytes
            return
        if isinstance(node, dict):
            for key, value in node.items():
                next_path = f"{path}.{key}" if path else str(key)
                walk(value, next_path)
        elif isinstance(node, list):
            for index, value in enumerate(node):
                walk(value, f"{path}[{index}]")

    walk(payload)
    return results


def normalize_image_bytes(image_bytes: bytes, size: int) -> bytes:
    image = Image.open(io.BytesIO(image_bytes)).convert("RGBA")
    bbox = image.getbbox()
    if bbox is not None:
        image = image.crop(bbox)

    if image.width == 0 or image.height == 0:
        image = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    else:
        scale = min(size / image.width, size / image.height)
        resized_width = max(1, int(round(image.width * scale)))
        resized_height = max(1, int(round(image.height * scale)))
        image = image.resize((resized_width, resized_height), Image.NEAREST)

        canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        offset_x = (size - resized_width) // 2
        offset_y = size - resized_height
        canvas.alpha_composite(image, (offset_x, offset_y))
        image = canvas

    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


def compute_combined_bbox(images: list[Image.Image], width: int, height: int) -> tuple[int, int, int, int]:
    bbox_left = width - 1
    bbox_top = height - 1
    bbox_right = 0
    bbox_bottom = 0
    found_pixels = False

    for image in images:
        bbox = image.getbbox()
        if bbox is None:
            continue
        found_pixels = True
        left, top, right, bottom = bbox
        bbox_left = min(bbox_left, left)
        bbox_top = min(bbox_top, top)
        bbox_right = max(bbox_right, right - 1)
        bbox_bottom = max(bbox_bottom, bottom - 1)

    if not found_pixels:
        return 0, 0, max(0, width - 1), max(0, height - 1)
    return bbox_left, bbox_top, bbox_right, bbox_bottom


def parse_direction_frame_label(label: str) -> tuple[str | None, int | None]:
    match = re.match(r"^(South|North|East|West)(?:\s+(\d+))?\Z", label.strip())
    if not match:
        return None, None
    direction_label = match.group(1)
    frame_text = match.group(2)
    return direction_label, int(frame_text) if frame_text else None


def image_sort_key(label: str, fallback_index: int) -> tuple[int, int, int, int]:
    direction_label, frame_index = parse_direction_frame_label(label)
    if direction_label is None:
        return (1, 999, 999, fallback_index)
    direction_priority = DIRECTION_SORT_ORDER.get(direction_label, 999)
    frame_priority = frame_index if frame_index is not None else 0
    return (0, direction_priority, frame_priority, fallback_index)


def order_labeled_images(images: list[tuple[str, bytes]]) -> list[tuple[str, bytes]]:
    if len(images) <= 1:
        return list(images)

    labeled = []
    recognized_count = 0
    for index, (label, image_bytes) in enumerate(images):
        direction_label, _frame_index = parse_direction_frame_label(label)
        if direction_label is not None:
            recognized_count += 1
        labeled.append((image_sort_key(label, index), (label, image_bytes)))

    if recognized_count < 2:
        return list(images)

    labeled.sort(key=lambda item: item[0])
    return [item for _sort_key, item in labeled]


@dataclass
class GenerationResult:
    character_id: str
    static_images: list[tuple[str, bytes]]
    walk_images: list[tuple[str, bytes]]
    create_usage: dict | None
    animate_usage: dict | None
    warnings: list[str]


class PixelLabClient:
    def __init__(self, token: str):
        self.token = token
        self._fresh_characters: set[str] = set()  # A first animation may safely use the sole animation folder in a new character's export.

    def _headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "Content-Type": "application/json",
        }

    def _post(self, endpoint: str, payload: dict) -> tuple[object, dict | None]:
        url = f"{PIXELLAB_API_BASE_URL.rstrip('/')}/{endpoint}"
        response = requests.post(url, headers=self._headers(), json=payload, timeout=REQUEST_TIMEOUT_SECONDS)
        if not response.ok:
            try:
                body_text = json.dumps(response.json(), indent=2)
            except Exception:
                body_text = response.text
            raise RuntimeError(
                f"PixelLab POST {endpoint} failed with HTTP {response.status_code}. Response body:\n{body_text}"
            )
        body = response.json()
        if isinstance(body, dict) and "data" in body:
            usage = body.get("usage")
            return body["data"], usage
        return body, None

    def _get(self, endpoint: str) -> object:
        url = f"{PIXELLAB_API_BASE_URL.rstrip('/')}/{endpoint}"
        response = requests.get(url, headers=self._headers(), timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        body = response.json()
        if isinstance(body, dict) and "data" in body:
            return body["data"]
        return body

    def poll_job(self, job_id: str) -> dict:
        for _attempt in range(BACKGROUND_JOB_MAX_POLLS):
            job_data = self._get(f"background-jobs/{job_id}")
            if isinstance(job_data, dict):
                status = str(job_data.get("status", "")).strip().lower()
                if status == "completed":
                    return job_data
                if status in ("failed", "error", "cancelled", "canceled"):
                    raise RuntimeError(f"Background job {job_id} failed with status: {status}")
            time.sleep(BACKGROUND_JOB_POLL_SECONDS)
        raise RuntimeError(f"Background job {job_id} timed out after {BACKGROUND_JOB_MAX_POLLS} polls.")

    def create_character_4dir(
        self,
        description: str,
        size: int,
        outline: str,
        shading: str,
        detail: str,
        view: str,
        seed: int | None,
    ) -> tuple[str, dict | None]:
        payload = {
            "description": description,
            "image_size": {"width": size, "height": size},
            "outline": outline,
            "shading": shading,
            "detail": detail,
            "view": view,
        }
        if seed is not None:
            payload["seed"] = seed

        data, usage = self._post("create-character-with-4-directions", payload)
        self.write_debug({"endpoint": "create-character-with-4-directions", "payload": payload, "data": data, "usage": usage})

        job_id = None
        character_id = None
        if isinstance(data, dict):
            job_id = data.get("background_job_id")
            character_id = data.get("character_id")

        if job_id:
            job_result = self.poll_job(job_id)
            self.write_debug({"endpoint": f"background-jobs/{job_id}", "payload": {}, "data": job_result, "usage": None})
            if not character_id:
                output = job_result.get("last_response") or job_result.get("output")
                if isinstance(output, dict):
                    character_id = output.get("character_id")
                if not character_id:
                    character_id = job_result.get("character_id")

        if not character_id:
            raise RuntimeError("PixelLab did not return a character_id from create-character-with-4-directions.")
        self._fresh_characters.add(character_id)
        return character_id, usage

    def fetch_character_direction_images(self, character_id: str) -> dict[str, bytes]:
        character_data = self._get(f"characters/{character_id}")
        self.write_debug({"endpoint": f"characters/{character_id}", "payload": {}, "data": character_data, "usage": None})
        images = extract_direction_images(character_data)
        if len(images) == len(DIRECTIONS):
            return images

        zip_url = f"{PIXELLAB_API_BASE_URL.rstrip('/')}/characters/{character_id}/zip"
        response = requests.get(zip_url, headers=self._headers(), timeout=REQUEST_TIMEOUT_SECONDS)
        response.raise_for_status()
        images = {}
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            for name in archive.namelist():
                direction = direction_from_path(name)
                if direction and name.lower().endswith(".png") and direction not in images:
                    images[direction] = archive.read(name)
        self.write_debug(
            {
                "endpoint": f"characters/{character_id}/zip",
                "payload": {},
                "data": {"files": sorted(images.keys()), "character_id": character_id},
                "usage": None,
            }
        )
        return images

    def animate_character_walk(
        self,
        character_id: str,
        action_description: str,
        frame_count: int,
        idle_images: dict[str, bytes] | None = None,
    ) -> tuple[dict[str, list[bytes]], dict | None]:
        try:
            return self._animate_character_walk_managed(character_id, action_description, frame_count)
        except RuntimeError as error:
            # PixelLab (Sep 2026) routed /animate-character to a body-less handler that answers 422 before any work or charge.
            has_idle = idle_images is not None and all(direction in idle_images for direction in DIRECTIONS)
            if not has_idle or not str(error).startswith("PixelLab POST animate-character failed with HTTP 422."):
                raise  # Other failures (credits, auth, rate limits) must still surface unchanged.
            return self.animate_walk_from_frames(idle_images, action_description, frame_count), None  # Animate each idle direction directly instead.

    def animate_walk_from_frames(
        self,
        idle_images: dict[str, bytes],
        action_description: str,
        frame_count: int,
    ) -> dict[str, list[bytes]]:
        """Animate each direction's idle image with animate-with-text-v3 (no stored character animation needed)."""
        jobs: dict[str, str] = {}
        for direction in DIRECTIONS:
            payload = {
                "first_frame": {"type": "base64", "base64": base64.b64encode(idle_images[direction]).decode("ascii"), "format": "png"},
                "action": action_description,
                "frame_count": frame_count,
                "no_background": True,
            }
            data, _usage = self._post("animate-with-text-v3", payload)  # Submit all four first so PixelLab works on them in parallel.
            job_id = data.get("background_job_id") if isinstance(data, dict) else None
            if not isinstance(job_id, str) or not job_id:
                raise RuntimeError("PixelLab did not return a background_job_id from animate-with-text-v3.")
            jobs[direction] = job_id
        frames: dict[str, list[bytes]] = {}
        for direction, job_id in jobs.items():
            job_result = self.poll_job(job_id)
            output = job_result.get("last_response") or job_result.get("output") or {}
            images = output.get("images", []) if isinstance(output, dict) else []
            decoded = [image for image in (decode_image_candidate(node) for node in images) if image]  # Accept base64, data URL or hosted-URL frames.
            if len(decoded) == frame_count + 1:
                decoded = decoded[1:]  # Drop the echoed reference pose if PixelLab includes it, matching keep_first_frame=False.
            frames[direction] = decoded
        return frames  # Callers validate the per-direction frame counts themselves.

    def _animate_character_walk_managed(
        self,
        character_id: str,
        action_description: str,
        frame_count: int,
    ) -> tuple[dict[str, list[bytes]], dict | None]:
        animation_name = "lidoll-walk-" + uuid.uuid4().hex
        first_animation = character_id in self._fresh_characters
        self._fresh_characters.discard(character_id)
        payload = {
            "character_id": character_id,
            "mode": "v3",
            "action_description": action_description,
            "frame_count": frame_count,
            "keep_first_frame": False,  # V3 otherwise stores the reference plus eight generated frames, producing nine.
            "animation_name": animation_name,
            "directions": list(DIRECTIONS),
        }
        data, usage = self._post("animate-character", payload)
        self.write_debug({"endpoint": "animate-character", "payload": payload, "data": data, "usage": usage})

        job_id = None
        job_ids: list[str] = []
        requested_directions: list[str] = []
        animation_keys = {animation_name}

        def output_for(job):
            output = job.get("last_response") or job.get("output") or job
            if isinstance(output, dict):
                for key in ("animation_id", "animation_name"):
                    if isinstance(output.get(key), str):
                        animation_keys.add(output[key])
            return output  # Current jobs expose last_response; older responses may still use output.

        def finish(frames):
            if all(len(frames[d]) == frame_count for d in DIRECTIONS):
                return frames, usage
            stored = self._fetch_character_walk_frames(character_id, animation_keys, first_animation)
            for direction in DIRECTIONS:
                if len(frames[direction]) != frame_count and stored[direction]:
                    frames[direction] = stored[direction]
            return frames, usage  # Completed managed jobs may return storage metadata rather than embedded images.
        if isinstance(data, dict):
            if isinstance(data.get("background_job_id"), str):
                job_id = data["background_job_id"]
            if isinstance(data.get("background_job_ids"), list):
                job_ids = [str(value) for value in data["background_job_ids"] if isinstance(value, str) and value]
            if isinstance(data.get("directions"), list):
                requested_directions = [str(value).lower() for value in data["directions"] if isinstance(value, str)]

        if job_ids:
            combined = {direction: [] for direction in DIRECTIONS}
            for index, direction_job_id in enumerate(job_ids):
                job_result = self.poll_job(direction_job_id)
                self.write_debug(
                    {
                        "endpoint": f"background-jobs/{direction_job_id}",
                        "payload": {},
                        "data": job_result,
                        "usage": None,
                    }
                )
                animation_data = output_for(job_result)
                expected_direction = requested_directions[index] if index < len(requested_directions) else None
                extracted = self._extract_walk_frames(animation_data, expected_direction)
                for direction, frames in extracted.items():
                    if frames:
                        combined[direction].extend(frames)
            return finish(combined)

        if job_id:
            job_result = self.poll_job(job_id)
            self.write_debug({"endpoint": f"background-jobs/{job_id}", "payload": {}, "data": job_result, "usage": None})
            return finish(self._extract_walk_frames(output_for(job_result)))

        return finish(self._extract_walk_frames(data))

    def _fetch_character_walk_frames(self, character_id: str, animation_keys: set[str], first_animation: bool) -> dict[str, list[bytes]]:
        url = f"{PIXELLAB_API_BASE_URL.rstrip('/')}/characters/{character_id}/zip"
        for attempt in range(5):
            response = requests.get(url, headers=self._headers(), timeout=REQUEST_TIMEOUT_SECONDS)
            if response.status_code != 423 or attempt == 4:
                response.raise_for_status()
                break
            time.sleep(BACKGROUND_JOB_POLL_SECONDS)  # Export can briefly lag completed jobs; retry downloads, never paid generation.
        groups: dict[str, dict[str, list[tuple[int, str]]]] = {}
        with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
            for name in archive.namelist():
                parts = name.replace("\\", "/").split("/")
                if "animations" not in parts:
                    continue
                index = parts.index("animations")
                if len(parts) != index + 4 or parts[index + 2] not in DIRECTIONS:
                    continue
                match = re.fullmatch(r"frame[_-]?(\d+)\.png", parts[-1], re.IGNORECASE)
                if not match:
                    continue
                group = groups.setdefault(parts[index + 1], {d: [] for d in DIRECTIONS})
                group[parts[index + 2]].append((int(match.group(1)), name))
            selected = [key for key in groups if key in animation_keys]
            if not selected and first_animation and len(groups) == 1:
                selected = list(groups)  # Only a newly created character can fall back to an otherwise unnamed sole animation.
            if len(selected) != 1:
                return {d: [] for d in DIRECTIONS}
            return {d: [archive.read(name) for _, name in sorted(groups[selected[0]][d])] for d in DIRECTIONS}
        # Read animation frames only: rotations, diagonal directions and other animations cannot leak into the strip.

    def _extract_walk_frames(self, animation_data: object, expected_direction: str | None = None) -> dict[str, list[bytes]]:
        results: dict[str, list[bytes]] = {direction: [] for direction in DIRECTIONS}

        if isinstance(animation_data, dict):
            for direction in DIRECTIONS:
                for key in (direction, direction.capitalize(), direction.upper()):
                    frames_node = animation_data.get(key)
                    if isinstance(frames_node, list):
                        for frame_node in frames_node:
                            frame_bytes = decode_image_candidate(frame_node)
                            if frame_bytes:
                                results[direction].append(frame_bytes)
                        break

            if not any(results.values()):
                flat_frames_node = animation_data.get("frames") or animation_data.get("images") or []
                if isinstance(flat_frames_node, list):
                    flat_bytes = []
                    for frame_node in flat_frames_node:
                        frame_bytes = decode_image_candidate(frame_node)
                        if frame_bytes:
                            flat_bytes.append(frame_bytes)
                    if flat_bytes and expected_direction in results:
                        results[expected_direction] = flat_bytes  # Each managed background job belongs to one direction, not four slices.
                    elif flat_bytes and len(flat_bytes) % len(DIRECTIONS) == 0:
                        frames_per_direction = max(1, len(flat_bytes) // len(DIRECTIONS))
                        for index, direction in enumerate(DIRECTIONS):
                            start = index * frames_per_direction
                            end = (index + 1) * frames_per_direction
                            results[direction] = flat_bytes[start:end]

            if not any(results.values()) and expected_direction in results:
                results[expected_direction] = self._extract_flat_frames(animation_data)
                return results  # Metadata-only per-direction jobs use the authenticated character export after all jobs finish.

            if not any(results.values()):
                zip_url = None
                for key in ("download_url", "url", "zip_url"):
                    value = animation_data.get(key)
                    if isinstance(value, str) and value.startswith("http"):
                        zip_url = value
                        break
                if zip_url:
                    response = requests.get(zip_url, timeout=REQUEST_TIMEOUT_SECONDS)
                    response.raise_for_status()
                    with zipfile.ZipFile(io.BytesIO(response.content)) as archive:
                        for name in archive.namelist():
                            direction = direction_from_path(name)
                            if direction and name.lower().endswith(".png"):
                                results[direction].append(archive.read(name))

        return results

    def _extract_flat_frames(self, node: object) -> list[bytes]:
        frames: list[bytes] = []

        if isinstance(node, dict):
            for key in ("frames", "images", "animation_frames", "output_frames"):
                value = node.get(key)
                if isinstance(value, list):
                    for item in value:
                        image_bytes = decode_image_candidate(item)
                        if image_bytes:
                            frames.append(image_bytes)
                    if frames:
                        return frames

            for value in node.values():
                nested = self._extract_flat_frames(value)
                if nested:
                    return nested

        elif isinstance(node, list):
            for item in node:
                image_bytes = decode_image_candidate(item)
                if image_bytes:
                    frames.append(image_bytes)
            if frames:
                return frames
            for item in node:
                nested = self._extract_flat_frames(item)
                if nested:
                    return nested

        return frames

    def write_debug(self, payload: dict) -> None:
        try:
            with open(DEBUG_RESPONSE_PATH, "w", encoding="utf-8") as handle:
                json.dump(payload, handle, indent=2, ensure_ascii=True, default=str)
        except OSError:
            pass


