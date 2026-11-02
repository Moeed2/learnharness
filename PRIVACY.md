# LearnHarness privacy note

LearnHarness is a personal learning app. It runs on your own devices and has no LearnHarness server.

## Google Drive sync

If you turn on sync in Settings → Sync, the app asks Google for access to:

- `drive.appdata`, a hidden folder in your own Google Drive that only this app can see. The app cannot read or change any of your other Drive files.
- `openid` and `email`, so the app can tell which Google account is connected and show its email address in Settings.

Your learning data (documents, notes, chats, learning progress and settings) is copied between your devices through that hidden folder. It goes straight from your device to Google's servers, and nobody else receives it.

Your sign-in tokens, API keys and passwords stay on the device where you entered them, and they are never synced.

## Removing access

- **One device:** Settings → Sync → Disconnect removes the sign-in from that device.
- **Every device:** remove the app at <https://myaccount.google.com/connections>. Google lets you delete the hidden app data from that page.

## Contact

Open an issue at <https://github.com/Moeed2/learnharness/issues>.
