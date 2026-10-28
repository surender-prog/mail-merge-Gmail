# mail-merge-Gmail

Send thousands of personalised emails from any Gmail or Google Workspace account.

This repo has two parts:

| Folder | What it is |
| --- | --- |
| [`extension/`](extension) | **Chrome extension**: full mail merge with tracking, follow-ups, scheduling and analytics. Works with any Gmail account. |
| [`src/`](src) | Simple Google Apps Script version that runs inside one Google Sheet. |
| [`server/`](server) | Optional Supabase function for open and click tracking. |

## Chrome extension features

- **Deep personalisation**: `{{column}}` fields from Google Sheets or CSV in the subject and body, with fallbacks (`{{name|there}}`) and varied wording (`{Hi|Hello}`).
- **Rich editor**: fonts, sizes, colours, lists, links and images, plus HTML source editing. You can also import your own HTML template or use a Gmail draft (its attachments and inline images are included).
- **Google Sheets data**: per-row **Cc**, **Bcc** and **attachments** (Google Drive links) columns. Each send's status is written back to a `Merge status` column.
- **Open and click tracking**: shows who opened, how many times, and which links they clicked (requires `server/`).
- **Automated follow-ups**: sent in the same thread after N days, with conditions: *no reply*, *not opened*, *opened*, *opened but no click*. Follow-ups stop when someone replies.
- **Scheduling**: send at a chosen time, with a delay between emails and a daily limit (up to 1,500/day on Workspace).
- **Campaign analytics**: delivery, open, click and reply rates, plus bounces, unsubscribes and errors. Includes a per-recipient table and CSV export.
- **Unsubscribe handling**: adds an unsubscribe link and `List-Unsubscribe` header. Anyone who unsubscribes is skipped automatically.
- **Any account**: a **Mail Merge** button appears in every Gmail tab. Each account signs in separately and its emails are sent from that account.

Recipients receive individual emails and never see each other.

## Install (developer mode)

1. **Create Google OAuth credentials**
   - In [Google Cloud Console](https://console.cloud.google.com/), create a project.
   - Enable the **Gmail API**, **Google Sheets API** and **Google Drive API**.
   - Configure the **OAuth consent screen** with the scopes `gmail.send`, `gmail.readonly`, `spreadsheets` and `drive.readonly`. Add your accounts as test users.
2. In `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, select `extension/`, and copy the extension ID.
3. Create an **OAuth client ID** of type *Web application* with this redirect URI: `https://<extension-id>.chromiumapp.org/`
4. Put the client ID into `extension/config.js` and reload the extension.
5. (Optional) Deploy `server/` and set `TRACKING_URL` in `config.js`.

Open Gmail and click **✉ Mail Merge** (bottom right), or click the extension icon.

## Rolling out to all users

- **Any Gmail user**: publish to the Chrome Web Store. Before more than 100 users can sign in, Google must verify the OAuth app. `gmail.readonly` is a restricted scope, so this includes a security assessment.
- **Your Google Workspace domain**: in the Admin console, mark the OAuth app as **Trusted** (Security → API controls). Then force-install the extension for everyone (Devices → Chrome → Apps & extensions). No Google verification is needed for internal apps.

## Limitations

- Scheduled sends and follow-ups run from the extension, so **Chrome must be running** for them to go out. Missed sends catch up when Chrome starts again.
- Open tracking depends on images loading. Apple Mail Privacy Protection and image proxies can inflate or hide opens.
