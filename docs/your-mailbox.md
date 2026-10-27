# Your mailbox

[← Back to the README](../README.md)

Whichever way you run it, the app reads reports from a mailbox over IMAP. Sign in, open **Admin → Mailboxes**, and add it. Two things to set up first:

<details>
<summary><b>Point your domains at the mailbox</b></summary>

<br>

Each domain publishes a DMARC record. Start in monitoring mode:

```
_dmarc.example.com.  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@reports.example.net"
```

If the reporting mailbox is on a **different domain** than the domain being reported on, the receiving side requires a one-time authorization record on the mailbox's domain, for each reported domain ([RFC 7489 §7.1](https://datatracker.ietf.org/doc/html/rfc7489#section-7.1)):

```
example.com._report._dmarc.reports.example.net.  TXT  "v=DMARC1"
```

A wildcard record (`*._report._dmarc.reports.example.net`) covers every domain at once if you manage many.

</details>

<details>
<summary><b>Mailbox notes (Gmail, Fastmail, Zoho, Microsoft 365)</b></summary>

<br>

Use an app-specific password wherever your provider offers one. To check a mailbox independently of this project, run `python3 scripts/test-imap.py`: it logs in, lists the exact folder names, and counts messages.

- **Gmail / Google Workspace:** `imap.gmail.com`, port 993. Needs 2-step verification and an app password.
- **Fastmail:** `imap.fastmail.com`, port 993, with an app password.
- **Zoho Mail:** `imap.zoho.com` for personal accounts, `imappro.zoho.com` for custom-domain accounts. IMAP must be enabled **both** in the user's mail settings **and** in the Zoho admin console. Log in with the account's **primary** address, not an alias.
- **Microsoft 365 / Outlook.com:** password-based IMAP is no longer offered, so this does not connect directly. The [upstream project documents a DavMail proxy](https://github.com/cry-inc/dmarc-report-viewer/tree/master/ms-365) as a workaround.

Folder names are case-sensitive. Reports are often filtered into a subfolder; enter its name in the Folder field.

</details>
