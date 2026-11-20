"""Files a teacher attaches to a video: a PDF or a picture to teach from."""

import base64
import io
import os
import secrets

# Pictures are shrunk to this longest side, which Claude reads without loss
IMAGE_EDGE = 1568
PDF = "application/pdf"
IMAGE_FORMATS = {"image/png": "PNG", "image/jpeg": "JPEG", "image/webp": "WEBP"}


def clean_image(data: bytes, media_type: str) -> bytes:
    """Upright, smaller JPEG without the photo's metadata."""
    from PIL import Image, ImageOps

    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format != IMAGE_FORMATS[media_type]:
                raise ValueError
            picture = ImageOps.exif_transpose(image).convert("RGBA")
    except Exception:  # noqa: BLE001 - Pillow raises many kinds for a bad file
        raise ValueError("That picture can't be read. Use a PNG, JPG or WebP image.") from None
    picture.thumbnail((IMAGE_EDGE, IMAGE_EDGE))
    flat = Image.new("RGB", picture.size, "white")
    flat.paste(picture, mask=picture.getchannel("A"))
    out = io.BytesIO()
    flat.save(out, "JPEG", quality=85)
    return out.getvalue()


def save_source(data: bytes, media_type: str, folder: str) -> dict:
    """Check an uploaded file and keep it until its job has run."""
    if media_type == PDF:
        if not data.startswith(b"%PDF-"):
            raise ValueError("That file isn't a real PDF.")
        kept_type, extension = PDF, ".pdf"
    else:
        data = clean_image(data, media_type)
        kept_type, extension = "image/jpeg", ".jpg"
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, secrets.token_hex(16) + extension)
    with open(path, "wb") as fh:
        fh.write(data)
    return {"path": path, "mediaType": kept_type}


def load_source(source) -> dict | None:
    if not source:
        return None
    with open(source["path"], "rb") as fh:
        data = base64.b64encode(fh.read()).decode("ascii")
    return {"media_type": source["mediaType"], "data": data}


def remove_source(source) -> None:
    if source and os.path.exists(source["path"]):
        os.remove(source["path"])
