"""Upload a video to the school's YouTube channel (resumable upload)."""

import http.client
import random
import socket
import time

SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]
TOKEN_URI = "https://oauth2.googleapis.com/token"
EDUCATION = "27"
CHUNK = 8 * 1024 * 1024
MAX_RETRIES = 8
RETRY_STATUS = {500, 502, 503, 504}
RETRY_ERRORS = (http.client.IncompleteRead, http.client.ResponseNotReady, ConnectionError,
                socket.timeout, TimeoutError, OSError)


def credentials(settings):
    from google.oauth2.credentials import Credentials
    return Credentials(
        token=None,
        refresh_token=settings.youtube_refresh_token,
        token_uri=TOKEN_URI,
        client_id=settings.youtube_client_id,
        client_secret=settings.youtube_client_secret,
        scopes=SCOPES,
    )


def upload_body(title, description, language, settings):
    return {
        "snippet": {
            "title": title,
            "description": description,
            "categoryId": EDUCATION,
            "defaultLanguage": language,
            "defaultAudioLanguage": language,
        },
        "status": {
            "privacyStatus": settings.youtube_privacy,
            "selfDeclaredMadeForKids": settings.made_for_kids,
            "embeddable": True,
        },
    }


def upload(path, title, description, language, settings, sleep=time.sleep):
    """Returns (video id, privacy status YouTube actually gave it)."""
    from googleapiclient.discovery import build
    from googleapiclient.errors import HttpError
    from googleapiclient.http import MediaFileUpload

    youtube = build("youtube", "v3", credentials=credentials(settings), cache_discovery=False)
    request = youtube.videos().insert(
        part="snippet,status",
        body=upload_body(title, description, language, settings),
        media_body=MediaFileUpload(path, mimetype="video/mp4", chunksize=CHUNK, resumable=True),
    )

    response, retries = None, 0
    while response is None:
        try:
            _, response = request.next_chunk()
            continue
        except HttpError as err:
            if err.resp.status not in RETRY_STATUS:
                raise
            problem = err
        except RETRY_ERRORS as err:
            problem = err
        retries += 1
        if retries > MAX_RETRIES:
            raise RuntimeError(f"YouTube upload kept failing: {problem}")
        # Back off and carry on from the last chunk YouTube received
        sleep(min(64, 2 ** retries) * random.uniform(0.5, 1))

    if "id" not in response:
        raise RuntimeError(f"YouTube upload failed: {response}")
    return response["id"], response.get("status", {}).get("privacyStatus")
