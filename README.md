# Star Electric — Tender Tracker

Railway tender register for Star Electric Company. A single static page: no
server, no build step, no login.

**Live site:** https://jagdeepkular-spec.github.io/star-electric-tender-tracker/

## What it does

- Register of railway tenders with railway, product, item code, quantity, our
  rank, days since tabulation, agent, status and final quantity
- Click a tender number to expand its consignees, with our rate and line value
  per consignee
- **Open** shows that tender's financial tabulation PDF
- Drop Railway financial-tabulation PDFs on the upload box to add or refresh
  tenders — the PDF is parsed **in the browser**, consignee by consignee
- Assign an agent, mark Order Received / Not Received, delete a tender
- Export the register as CSV, or as `data.json`

## How the data works

`data.json` is the shared starting point, loaded by every device.

Edits you make in the browser (status, agent, final quantity, imports,
deletions) are kept in that browser's local storage, so they do **not**
automatically appear on your other devices. To make changes the shared copy:

1. **Export data.json**
2. Commit the downloaded file over `data.json` in this repository

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
