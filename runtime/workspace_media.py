"""Carry trusted VM screenshots through the kernel's native vision pipeline."""
import base64
import json


def computer_result(name, value):
    if not name.startswith('computer_') or not isinstance(value, dict) or value.get('isError'):
        return json.dumps(value, ensure_ascii=False)
    content = value.get('content')
    images = [part for part in content if isinstance(part, dict) and part.get('type') == 'image'] if isinstance(content, list) else []
    if not images:
        return json.dumps(value, ensure_ascii=False)
    # The shared Box bridge produces exactly one PNG per capture. Invalid media
    # must be an explicit error, never a huge base64 text result/spillover file.
    try:
        if len(images) != 1 or images[0].get('mimeType') != 'image/png':
            raise ValueError('unsupported screenshot envelope')
        data = images[0].get('data')
        if not isinstance(data, str) or len(data) > 32 * 1024 * 1024:
            raise ValueError('invalid screenshot size')
        raw = base64.b64decode(data, validate=True)
        if not raw.startswith(b'\x89PNG\r\n\x1a\n'):
            raise ValueError('invalid screenshot bytes')
        from agent.image_eviction_policy import image_dimensions_from_bytes
        from tools.computer_use.backend import CaptureResult
        from tools.computer_use.tool import _capture_response
        dimensions = image_dimensions_from_bytes(raw)
        if not dimensions or not all(0 < n <= 16384 for n in dimensions):
            raise ValueError('invalid screenshot dimensions')
    except (ValueError, TypeError):
        return json.dumps({'isError': True, 'error': 'VM screenshot payload is invalid; no other computer was used.'})
    note = '\n'.join(part['text'] for part in content if isinstance(part, dict) and part.get('type') == 'text' and isinstance(part.get('text'), str))
    # Reuse Hermes native/aux-vision routing, provider limits and private image
    # cache. This only renders the returned pixels; it never captures the Host.
    return _capture_response(CaptureResult(mode='vision', width=dimensions[0], height=dimensions[1],
        png_b64=data, png_bytes_len=len(raw), image_mime_type='image/png', note=note))
