# Slack Custom Emoji Bulk Downloader

A [Violentmonkey](https://violentmonkey.github.io/) userscript that downloads every custom emoji in a Slack workspace as a single zip file. Each file is named after the emoji (`:party-parrot:` → `party-parrot.gif`) and has the correct extension for its real image type.

## Install

1. Install Violentmonkey in Firefox (other browsers and userscript managers that support `GM_xmlhttpRequest` should also work).
2. Open the Violentmonkey dashboard, create a new script, and paste in the contents of [`slack-emoji-download.user.js`](slack-emoji-download.user.js). Alternatively, drag the file into the browser and confirm the install.

## Use

1. Sign in to Slack in the browser and open `https://<workspace>.slack.com/customize/emoji`.
2. Click the **Download all emoji** button in the bottom-right corner.
3. Wait while the button shows progress. When it's done, the browser saves `<workspace>-slack-emoji.zip`.

## What's in the zip

| Path | Contents |
| --- | --- |
| `emoji/<name>.<ext>` | One image per custom emoji |
| `emoji.json` | Name, file name and source URL for each emoji |
| `aliases.json` | Each alias and the emoji it points to |
| `failures.json` | Emoji that couldn't be downloaded (only present if any failed) |

## How it works

- **Emoji list:** the customize page only renders the rows on screen, so the script doesn't read the HTML. It calls Slack's `emoji.adminList` API, 100 emoji per page, using the session token already on the page and your existing login cookies.
- **Names:** files are named from the emoji's name, not its image URL. Some URLs don't match the name, for example when an emoji was imported from elsewhere.
- **File types:** the extension comes from the image's first bytes (GIF, PNG, JPEG or WebP). It falls back to the URL's extension only if the type isn't recognised.
- **Downloads:** images are fetched 6 at a time. Rate limits and failed requests are retried with increasing delays.
- **Zip:** built inside the script with no external libraries. Images are stored without compressing them again, since they're already compressed.

## Configuration

Edit the constants at the top of the script:

| Constant | Default | Meaning |
| --- | --- | --- |
| `PAGE_SIZE` | `100` | Emoji fetched per API page |
| `CONCURRENCY` | `6` | Images downloaded in parallel |
| `MAX_RETRIES` | `5` | Retries per request before giving up |
| `INCLUDE_ALIAS_FILES` | `false` | When `true`, also writes a copy of the image under each alias name |

## Permissions

The script runs only on `https://*.slack.com/customize/emoji*`. It makes requests only to your workspace's own Slack domain (for the API) and to `emoji.slack-edge.com` (for the images). Image requests are sent without cookies. Nothing is sent anywhere else.
