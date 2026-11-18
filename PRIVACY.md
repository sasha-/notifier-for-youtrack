# Privacy Policy – Notifier for YouTrack

_Last updated: 17 November 2026_

Notifier for YouTrack ("the extension") is a browser extension that shows desktop notifications for your
YouTrack notification center. This policy explains what data it handles.

## Summary

- The extension has **no servers** of its own and **no analytics, tracking or advertising**.
- It communicates **only with the YouTrack instance you configure**.
- Everything it stores stays **in your browser** on your device.
- Nothing is sold or shared with anyone.

## What the extension stores (locally, in `chrome.storage`)

| Data | Why |
|---|---|
| Your YouTrack URL and permanent token | To call your YouTrack's API on your behalf |
| Your settings (mode, search query, interval, options) | To run the way you configured it |
| Your YouTrack login and display name | To recognise your own changes and mentions of you |
| Up to 50 recent notification items (issue ID and title, a short text snippet, link, read/watch state) | To show the popup list and badge |
| IDs of notifications already shown | To avoid showing the same notification twice |

The token is stored in `chrome.storage.local`, which is **not** synced to your Google account. Temporary data
about on-screen notifications is kept in `chrome.storage.session` and cleared when the browser closes.

## What it sends, and where

Requests go **only** to the YouTrack URL you enter, authenticated with your token:

- reading your notification center or issue activity,
- marking notifications read/unread,
- starring/unstarring (watching) issues when you click **Watch**,
- reading your own user profile (login and name).

Chrome asks for your permission to access that one host when you save the settings. The extension cannot
access any other website.

## Removing your data

Clearing the settings or removing the extension deletes all of the above from your browser. To revoke access
on the YouTrack side, delete the token in YouTrack (Profile → Account Security → Tokens).

## Permissions

| Permission | Why |
|---|---|
| `notifications` | Show desktop notifications |
| `alarms` | Check for new notifications on a schedule |
| `storage` | Save your settings and the recent-items list |
| Host access to your YouTrack URL (requested at setup) | Talk to your YouTrack's API |

## Contact

Questions or concerns: open an issue in this project's GitHub repository.
