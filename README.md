# mail-merge-Gmail

Send personalised emails from a Google Sheet using a Gmail draft as the template.

## Setup

1. Create a Google Sheet. In row 1 add the headers `Recipient` and `Email Sent`, plus any other columns you want to use as fields (e.g. `First name`, `Company`).
2. In the Sheet open **Extensions → Apps Script**, replace `Code.gs` with [`src/Code.gs`](src/Code.gs), and save.
3. Reload the Sheet. A **Mail Merge** menu appears.

Or deploy with [clasp](https://github.com/google/clasp): copy `.clasp.json.example` to `.clasp.json`, set your script ID, then run `clasp push`.

## Usage

1. In Gmail, create a **draft** with a unique subject. Use `{{Column Name}}` placeholders in the subject and body, e.g. `Hi {{First name}}`. Attachments and inline images are included.
2. Fill one row per recipient in the Sheet and leave `Email Sent` blank.
3. **Mail Merge → Send Test to Me** to preview the first row in your inbox.
4. **Mail Merge → Send Emails** and enter the draft subject.

The `Email Sent` column records a timestamp or the error. Rows that already have a value are skipped, so you can re-run safely.

## Limits

Gmail daily quota applies: about 100 recipients/day for consumer accounts, 1,500 for Google Workspace.
