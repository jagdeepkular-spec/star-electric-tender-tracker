# Star Electric — Tender Tracker

Railway tender register for Star Electric Company. A single static page: no
server, no build step, no login.

**Live site:** https://jagdeepkular-spec.github.io/star-electric-tender-tracker/

## What it does

- Register of railway tenders with railway, product, item code, tender quantity,
  our rank, split clause, expected quantity, tender value, days since tabulation,
  agent, status and final quantity received
- **Split clause** — set a clause like `60:40`, `70:30` or `50:30:20` on any
  tender. **Expected quantity** is then our rank's share of the tender quantity;
  with no clause, L1 is expected to take the whole order and anyone below it
  nothing. **Tender value** is the tender quantity at our rate, and the figure
  beside the expected quantity is that share's value
- Click a tender number to expand its consignees, with our rate and line value
  per consignee
- **Open** shows that tender's financial tabulation PDF
- Drop Railway financial-tabulation PDFs on the upload box to add or refresh
  tenders — the PDF is parsed **in the browser**, consignee by consignee
- Assign an agent, mark Order Received / Not Received, delete a tender
- Export the register as CSV, or as `data.json`

## How the data works

`data.json` in this repository **is** the database. Every device reads it
through the GitHub API on load, so it always sees the newest commit.

### Sharing changes between devices

Turn on sharing once per device:

1. Create a **fine-grained personal access token**
   (GitHub → Settings → Developer settings → Personal access tokens →
   Fine-grained tokens), with **Repository access: only this repository** and
   **Permissions → Contents: Read and write**. Give it an expiry.
2. In the tracker, click **Sharing…** in the sidebar and paste the token.

From then on, every edit on that device — status, agent, split clause, final
quantity, deletions and PDF imports — is committed straight back to
`data.json`, so it appears on every other device. Imported tabulation PDFs are
committed to `pdfs/` as well, so **Open** works everywhere, not just on the
device that imported them.

The token is stored only in that browser's local storage and is sent only to
github.com. Click **Sharing…** again to turn it off and remove the token.

Without a token the tracker still works and still shows everyone's committed
data — edits just stay in that browser until you either turn sharing on or use
**Export data.json** and commit the file by hand.

Two devices editing at once is handled: if someone commits first, the save is
retried against their version rather than overwriting it.

## Files

| File | Purpose |
|---|---|
| `index.html` | The whole application |
| `pdfparse.js` | PDF reader and tabulation parser, written from scratch — no libraries |
| `data.json` | The tender register |
| `pdfs/` | Financial tabulation PDFs, one per tender |

## The PDF parser

`pdfparse.js` reads the Railway tabulation PDFs with no external library:
PDF object parsing, Flate decompression via the browser's `DecompressionStream`,
Identity-H CID fonts, ToUnicode CMaps, and line reconstruction from glyph
positions. It then pulls out the tender, the item, and each consignee with our
rank and rate.

It was validated field by field against the original register: tender number,
railway, product, item code, quantity, rank, tabulation date, and every
consignee's name, quantity, rank and rate.
