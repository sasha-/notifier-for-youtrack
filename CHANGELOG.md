# Changelog

## 1.4.1 – 2026-11-17
- Renamed to **Notifier for YouTrack**; added "not affiliated with JetBrains" notice.
- Fixed version comparison in the upgrade step (1.10 is now correctly newer than 1.3).
- Repository layout for GitHub: `extension/`, packaging script, check and release workflows, privacy policy.

## 1.4.0
- "Star" renamed to **Watch / Stop watching** (it's YouTrack's star; helpdesk view doesn't display it).
- Read/unread is now a toggle in the popup; in notification-center mode it also updates YouTrack.

## 1.3.1
- Watch verifies the result and falls back to the `star <login>` command; failures show as an error.

## 1.3.0
- **Notification-center mode** (default): mirrors YouTrack's 🔔 bell via `/api/inbox`, with two-way read sync.
- Activity-query mode kept as an option.

## 1.2.x
- Popup and options follow the system light/dark theme.
- Star uses the same API call as YouTrack's star icon.

## 1.1.0
- Mark read and Star buttons on notifications; per-item read state.

## 1.0.0
- First version: activity polling with desktop notifications, popup list, badge.
