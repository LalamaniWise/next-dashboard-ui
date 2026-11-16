"""One-time login to the school's YouTube channel. Prints a refresh token.

    python youtube_auth.py

Reads YOUTUBE_CLIENT_ID and YOUTUBE_CLIENT_SECRET from ai/service/.env (or
asks for them), opens Google's sign-in page in your browser, and prints the
YOUTUBE_REFRESH_TOKEN line to add to ai/service/.env.

Sign in with the Google account that owns (or manages) the school's channel.
The token only allows uploading videos (scope youtube.upload).
"""

import os

from google_auth_oauthlib.flow import InstalledAppFlow

from config import load_env_file
from youtube_upload import SCOPES, TOKEN_URI


def main():
    load_env_file()
    client_id = os.environ.get("YOUTUBE_CLIENT_ID") or input("OAuth client ID: ").strip()
    client_secret = os.environ.get("YOUTUBE_CLIENT_SECRET") or input("OAuth client secret: ").strip()
    flow = InstalledAppFlow.from_client_config(
        {"installed": {
            "client_id": client_id,
            "client_secret": client_secret,
            "auth_uri": "https://accounts.google.com/o/oauth2/auth",
            "token_uri": TOKEN_URI,
            "redirect_uris": ["http://localhost"],
        }},
        scopes=SCOPES,
    )
    # prompt=consent makes Google return a refresh token even if you have
    # signed in before
    creds = flow.run_local_server(port=0, access_type="offline", prompt="consent",
                                  open_browser=True)
    if not creds.refresh_token:
        raise SystemExit("Google didn't return a refresh token. Run this again.")
    print("\nAdd this line to ai/service/.env (keep it secret):\n")
    print(f"YOUTUBE_REFRESH_TOKEN={creds.refresh_token}\n")


if __name__ == "__main__":
    main()
