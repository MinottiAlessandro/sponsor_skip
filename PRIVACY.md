# Privacy Policy for sponsor_skip

**Effective date:** July 13, 2026

sponsor_skip (the "Extension") detects and skips in-video sponsor segments on
YouTube. This policy explains what information the Extension handles, why it is
needed, where it is stored, and when it is shared.

## Summary

- Sponsor detection runs on the user's device by default.
- The Extension does not operate an analytics, advertising, telemetry, or
  developer data-collection service.
- YouTube captions are processed in memory and are not persistently stored by
  the Extension.
- Detection results, preferences, and limited interaction records are stored
  locally in the user's browser.
- SponsorBlock lookups occur when SponsorBlock integration is enabled. Voting
  and segment submission occur only after an explicit user action.
- Additional model files may be downloaded from Hugging Face after the user
  grants the optional permission.
- The optional Ollama mode sends transcript text only to the local endpoint
  selected by the user.

## Information the Extension handles

### Website content

To identify sponsor segments, the Extension handles the current YouTube video's:

- video ID and title;
- caption text, language, and timing information; and
- detected or community-provided segment categories and timestamps.

Caption text is processed in memory by the on-device model and is not saved in
Chrome storage. If the user enables the optional Ollama detector, the video
title, language, and caption text are sent to the Ollama endpoint configured by
the user instead of the bundled detector.

### Web history

The Extension locally caches the video ID, title, detection result, source,
segment timestamps, analysis time, and date for YouTube videos it analyzes. This
cache exists only to avoid repeating the same analysis and to show the result in
the popup.

The Extension does not read Chrome's general browsing-history database and does
not monitor websites other than the YouTube pages covered by its manifest.

### User activity and preferences

The Extension stores locally:

- skip mode, enabled categories, language, theme, confidence, countdown, device,
  model selection, and other Extension settings;
- edited or manually added segment boundaries;
- SponsorBlock vote state and user-confirmed submissions;
- dismissed false positives, limited to the 200 most recent records;
- model download and compatibility state; and
- whether one-time interface hints have already been shown.

This information is used only to provide the Extension's functionality. It is
not used for behavioral analytics, advertising, or profiling.

### SponsorBlock identity

The first time a user votes on or submits a SponsorBlock segment, the Extension
generates a random private SponsorBlock user ID and stores it locally. This ID is
not obtained from, or connected by the Extension to, the user's Google account,
name, or email address. It is sent to SponsorBlock only when required to process
a vote or submission and acts as the user's SponsorBlock contribution
credential.

## Network requests and data sharing

### YouTube

The Extension requests caption-track information and caption content directly
from YouTube for the video the user is watching. These requests are necessary to
provide sponsor detection. YouTube receives the normal request information
associated with accessing its service. The Extension does not send caption text
to the Extension developer.

### SponsorBlock

SponsorBlock integration is enabled by default and can be disabled in the
Extension's settings.

For a lookup, the Extension sends SponsorBlock only the first four hexadecimal
characters of the SHA-256 hash of the YouTube video ID, together with the
requested segment categories. SponsorBlock returns a group of possible records,
and the Extension performs the exact video-ID match locally. The full video ID is
not sent in this lookup request.

When the user explicitly votes on an existing SponsorBlock segment, the
Extension sends SponsorBlock the segment UUID, vote value, and private
SponsorBlock user ID.

When the user explicitly confirms a new segment submission, the Extension sends
SponsorBlock the full YouTube video ID, segment start and end times, segment
category, Extension version identifier, and private SponsorBlock user ID. This
information is necessary to add the segment to the public SponsorBlock database.

SponsorBlock requests use HTTPS. SponsorBlock processes information under its
own terms and policies. More information about the service is available at
https://sponsor.ajay.app/.

### Hugging Face and custom models

The Extension includes a default on-device model. After the user grants the
optional Hugging Face host permission, the Extension may retrieve model-catalog
metadata and may download an additional model selected by the user. Downloaded
files include model weights, tokenizer data, and model configuration data and
are stored in the browser's local cache.

The Extension does not send YouTube video IDs, titles, captions, detection
results, SponsorBlock identity, or Extension settings to Hugging Face. As with
ordinary web requests, Hugging Face receives standard connection information
such as the user's IP address and user agent. Hugging Face's privacy policy is
available at https://huggingface.co/privacy.

If the user enters a supported custom model location, the browser contacts that
user-selected host only after the required optional host permission is granted.

### Optional local Ollama endpoint

Ollama mode is an optional developer feature and is disabled by default. When
the user enables it, the Extension sends the current video's title, language,
and caption text to the Ollama endpoint configured by the user. The default
endpoint is on the user's own computer (`localhost`). A loopback endpoint may
use HTTP because the data does not leave the user's device.

### External links

Links to GitHub and Ko-fi open only when selected by the user. The Extension does
not attach captions, video information, or stored Extension data to those links.

## Local storage, retention, and deletion

Settings, cached video results, segment edits, false-positive records,
SponsorBlock contribution state, and the SponsorBlock user ID are stored using
Chrome's local Extension storage. Downloaded optional model files are stored in
the browser's Cache Storage. This data is not synchronized through a
sponsor_skip account, and the Extension developer cannot access it remotely.

Data remains on the device until it is cleared or the Extension is uninstalled:

- **Reset sponsor cache** removes cached per-video detection results and recent
  result/error records.
- **Delete** in the model manager removes the selected downloaded model files.
- Uninstalling the Extension removes its locally managed storage according to
  Chrome's extension-data handling.

## Data the Extension does not collect

The Extension does not intentionally collect:

- names, email addresses, Google account information, or contact details;
- health, financial, payment, or precise location information;
- passwords, YouTube authentication cookies, or form data;
- personal communications;
- advertising identifiers; or
- analytics, telemetry, crash reports, or browsing activity outside the
  Extension's disclosed YouTube functionality.

The Extension does not sell user data. It does not use or transfer user data for
advertising, profiling, creditworthiness, lending, or purposes unrelated to its
single purpose. Data is shared only as described above where necessary to
provide a user-facing feature or where the user explicitly initiates the action.

## Security

Remote requests initiated by the Extension use HTTPS. The only HTTP exception is
a user-configured loopback Ollama endpoint on the user's own device. Executable
JavaScript and WebAssembly dependencies are packaged with the Extension; the
Extension does not load remotely hosted JavaScript or WebAssembly.

## Chrome Web Store Limited Use

The use of information received from Google APIs will adhere to the Chrome Web
Store User Data Policy, including the Limited Use requirements.

## Changes to this policy

This policy may be updated when the Extension's functionality or data practices
change. Material changes will be reflected by updating the effective date and
the public policy before or with the corresponding Extension release.

## Contact

For privacy questions or requests, open an issue in the sponsor_skip repository:

https://github.com/MinottiAlessandro/sponsor_skip/issues
