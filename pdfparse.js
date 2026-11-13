/* Star Electric - Tender Tracker
 * Browser port of the tracker's PDF reader and tabulation parser.
 *
 * Reads Railway "Tabulation Statement of Financial Bids" PDFs
 * (wkhtmltopdf/Qt output: FlateDecode streams, Type0 Identity-H fonts with
 * ToUnicode CMaps). No external libraries: inflate comes from the browser's
 * own DecompressionStream.
 */
(function (global) {
  "use strict";

  function PdfError(msg) { this.name = "PdfError"; this.message = msg; }
  PdfError.prototype = Object.create(Error.prototype);

  /* ---------------------------------------------------------- byte helpers */

  function latin1(bytes) {
    var out = "", CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) {
      out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    }
    return out;
  }

  async function inflate(bytes) {
    // PDF FlateDecode is zlib-wrapped; fall back to raw deflate.
    for (var fmt of ["deflate", "deflate-raw"]) {
      try {
        var ds = new DecompressionStream(fmt);
        var buf = await new Response(
          new Blob([bytes]).stream().pipeThrough(ds)
        ).arrayBuffer();
        if (buf.byteLength) return new Uint8Array(buf);
      } catch (e) { /* try the next format */ }
    }
    // Trailing-byte damage is common; retry shrinking the tail.
    for (var trim = 1; trim <= 2 && trim < bytes.length; trim++) {
      try {
        var ds2 = new DecompressionStream("deflate");
        var b2 = await new Response(
          new Blob([bytes.subarray(0, bytes.length - trim)]).stream().pipeThrough(ds2)
        ).arrayBuffer();
        if (b2.byteLength) return new Uint8Array(b2);
      } catch (e) { /* keep trying */ }
    }
    return new Uint8Array(0);
  }

  /* --------------------------------------------------------- object layer */

  var OBJ_RE = /(?:^|[\r\n>\s])(\d+)\s+(\d+)\s+obj\b/g;

  function parseObjects(S) {
    var starts = [], m;
    OBJ_RE.lastIndex = 0;
    while ((m = OBJ_RE.exec(S)) !== null) {
      starts.push([parseInt(m[1], 10), m.index, OBJ_RE.lastIndex]);
      OBJ_RE.lastIndex = m.index + m[0].length;
    }
    var objs = {};
    for (var i = 0; i < starts.length; i++) {
      var num = starts[i][0], bodyStart = starts[i][2];
      var bodyEnd = (i + 1 < starts.length) ? starts[i + 1][1] : S.length;
      var body = S.slice(bodyStart, bodyEnd);
      var sm = /stream\r?\n/.exec(body);
      if (sm) {
        var raw = body.slice(sm.index + sm[0].length);
        var em = raw.lastIndexOf("endstream");
        if (em !== -1) raw = raw.slice(0, em);
        objs[num] = {
          dict: body.slice(0, sm.index),
          rawStart: bodyStart + sm.index + sm[0].length,
          rawLen: raw.length
        };
      } else {
        var e2 = body.indexOf("endobj");
        objs[num] = { dict: e2 !== -1 ? body.slice(0, e2) : body, rawStart: -1, rawLen: 0 };
      }
    }
    return objs;
  }

  function dictGet(d, key) {
    if (!d) return null;
    var m = new RegExp("/" + key + "\\b").exec(d);
    if (!m) return null;
    var rest = d.slice(m.index + m[0].length).replace(/^\s+/, "");
    if (rest[0] === "[") {
      var depth = 0;
      for (var i = 0; i < rest.length; i++) {
        if (rest[i] === "[") depth++;
        else if (rest[i] === "]") { depth--; if (!depth) return rest.slice(0, i + 1); }
      }
      return rest;
    }
    if (rest.slice(0, 2) === "<<") {
      var d2 = 0, j = 0;
      while (j < rest.length - 1) {
        var two = rest.slice(j, j + 2);
        if (two === "<<") { d2++; j += 2; continue; }
        if (two === ">>") { d2--; j += 2; if (!d2) return rest.slice(0, j); continue; }
        j++;
      }
      return rest;
    }
    var m2 = /^(\d+\s+\d+\s+R)/.exec(rest);
    if (m2) return m2[1];
    var m3 = /^(\/[^\s/[\]<>()]+|[-+]?[0-9.]+|true|false|null)/.exec(rest);
    return m3 ? m3[1] : null;
  }

  function resolve(objs, token) {
    for (var i = 0; i < 16; i++) {
      var m = /^\s*(\d+)\s+\d+\s+R\s*$/.exec(token || "");
      if (!m) return token;
      var e = objs[parseInt(m[1], 10)];
      if (!e) return "";
      token = e.dict;
    }
    return token;
  }

  function refsIn(token) {
    var out = [], re = /(\d+)\s+\d+\s+R/g, m;
    while ((m = re.exec(token || "")) !== null) out.push(parseInt(m[1], 10));
    return out;
  }

  async function streamBytes(objs, bytes, num) {
    var e = objs[num];
    if (!e || e.rawStart < 0) return new Uint8Array(0);
    var len = e.rawLen;
    var lenTok = resolve(objs, dictGet(e.dict, "Length"));
    var n = parseInt((lenTok || "").trim(), 10);
    if (n > 0 && n <= len) len = n;
    var raw = bytes.subarray(e.rawStart, e.rawStart + len);
    var filt = dictGet(e.dict, "Filter") || "";
    if (filt.indexOf("FlateDecode") >= 0) return await inflate(raw);
    return raw;
  }

  /* ------------------------------------------------------------ ToUnicode */

  var BFRANGE_ENTRY =
    /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(?:\[((?:\s*<[0-9A-Fa-f]*>)*)\s*\]|<([0-9A-Fa-f]+)>)/g;
  var BFCHAR_ENTRY = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]*)>/g;

  function utf16(hex) {
    if (hex.length % 2) hex += "0";
    var out = "";
    for (var i = 0; i + 3 < hex.length + 1; i += 4) {
      var piece = hex.substr(i, 4);
      if (piece.length < 4) break;
      out += String.fromCharCode(parseInt(piece, 16));
    }
    return out;
  }

  function parseCMap(S) {
    var out = {}, blocks, m;
    var bf = /beginbfchar([\s\S]*?)endbfchar/g;
    while ((blocks = bf.exec(S)) !== null) {
      BFCHAR_ENTRY.lastIndex = 0;
      while ((m = BFCHAR_ENTRY.exec(blocks[1])) !== null) {
        out[parseInt(m[1], 16)] = utf16(m[2]);
      }
    }
    var br = /beginbfrange([\s\S]*?)endbfrange/g;
    while ((blocks = br.exec(S)) !== null) {
      BFRANGE_ENTRY.lastIndex = 0;
      while ((m = BFRANGE_ENTRY.exec(blocks[1])) !== null) {
        var lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
        if (m[3] !== undefined) {
          var items = m[3].match(/<([0-9A-Fa-f]*)>/g) || [];
          for (var k = 0; k < items.length; k++) {
            out[lo + k] = utf16(items[k].slice(1, -1));
          }
        } else if (m[4] !== undefined) {
          var base = utf16(m[4]);
          if (base.length === 1) {
            var start = base.charCodeAt(0), span = Math.min(hi - lo + 1, 65536);
            for (var j = 0; j < span; j++) out[lo + j] = String.fromCharCode(start + j);
          } else out[lo] = base;
        }
      }
    }
    return out;
  }

  async function pageFonts(objs, bytes, resources) {
    var fonts = {};
    var fdict = resolve(objs, dictGet(resources, "Font")) || "";
    var re = /\/([A-Za-z0-9#.+-]+)\s+(\d+)\s+\d+\s+R/g, m;
    while ((m = re.exec(fdict)) !== null) {
      var fo = objs[parseInt(m[2], 10)];
      if (!fo) continue;
      var cmap = null;
      var tu = refsIn(dictGet(fo.dict, "ToUnicode"));
      if (tu.length) {
        cmap = parseCMap(latin1(await streamBytes(objs, bytes, tu[0])));
      } else {
        var ds = refsIn(dictGet(fo.dict, "DescendantFonts"));
        for (var i = 0; i < ds.length; i++) {
          var d = objs[ds[i]];
          if (!d) continue;
          var dr = refsIn(dictGet(d.dict, "ToUnicode"));
          if (dr.length) {
            cmap = parseCMap(latin1(await streamBytes(objs, bytes, dr[0])));
            break;
          }
        }
      }
      fonts[m[1]] = cmap;
    }
    return fonts;
  }

  /* ----------------------------------------------------- content streams */

  var TOKEN_RE = new RegExp(
    "(<[0-9A-Fa-f\\s]*>)" +            // 1 hex string
    "|(\\[)|(\\])" +                   // 2,3 array
    "|(/[^\\s/\\[\\]<>(){}]+)" +       // 4 name
    "|([-+]?\\d*\\.?\\d+)" +           // 5 number
    "|([A-Za-z'\"*][A-Za-z0-9'\"*]*)", // 6 operator
    "g");

  function mul(m, n) {
    return [
      m[0] * n[0] + m[1] * n[2],
      m[0] * n[1] + m[1] * n[3],
      m[2] * n[0] + m[3] * n[2],
      m[2] * n[1] + m[3] * n[3],
      m[4] * n[0] + m[5] * n[2] + n[4],
      m[4] * n[1] + m[5] * n[3] + n[5]
    ];
  }

  function decodeHex(tok, cmap) {
    var h = tok.replace(/\s/g, "").slice(1, -1);
    if (h.length % 2) h += "0";
    if (cmap) {
      var out = "", mapped = false;
      for (var i = 0; i + 3 < h.length + 1; i += 4) {
        var piece = h.substr(i, 4);
        if (piece.length < 4) break;
        var code = parseInt(piece, 16);
        if (Object.prototype.hasOwnProperty.call(cmap, code)) {
          mapped = true;
          out += cmap[code];
        }
      }
      // A run that maps to a space is still a space; some producers map the
      // space glyph to a control codepoint.
      if (mapped) return out.replace(/[\x00-\x1f]+/g, " ");
    }
    var s = "";
    for (var j = 0; j + 1 < h.length; j += 2) s += String.fromCharCode(parseInt(h.substr(j, 2), 16));
    return s;
  }

  function joinLine(parts) {
    parts.sort(function (a, b) { return a[0] - b[0]; });
    if (!parts.length) return "";
    var deltas = [];
    for (var i = 1; i < parts.length; i++) {
      var d = parts[i][0] - parts[i - 1][0];
      if (d > 0 && parts[i - 1][1].length) deltas.push(d / parts[i - 1][1].length);
    }
    var adv = 5;
    if (deltas.length) { deltas.sort(function (a, b) { return a - b; }); adv = deltas[deltas.length >> 1]; }
    if (!(adv > 0)) adv = 5;
    var out = "", prev = null;
    for (var k = 0; k < parts.length; k++) {
      var x = parts[k][0], text = parts[k][1];
      if (prev) {
        var gap = x - (prev[0] + prev[1].length * adv);
        if (gap > adv * 0.8 && !/ $/.test(out) && !/^ /.test(text)) out += " ";
      }
      out += text;
      prev = [x, text];
    }
    return out.replace(/\s+$/, "");
  }

  function pageText(content, fonts) {
    var runs = [], ctm = [1, 0, 0, 1, 0, 0], gstack = [];
    var tm = [1, 0, 0, 1, 0, 0], tlm = tm.slice(), leading = 0, font = null;
    var scrubbed = content.replace(/\((?:\\[\s\S]|[^()\\])*\)/g, "\u0000LIT\u0000");

    function place(text) {
      if (text) {
        var d = mul(tm, ctm);
        runs.push([Math.round(d[5] * 10) / 10, d[4], text]);
      }
    }

    var pending = [], m;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(scrubbed)) !== null) {
      if (m[1] !== undefined) { pending.push(["hex", m[1]]); continue; }
      if (m[2] !== undefined || m[3] !== undefined) { pending.push(["arr", m[0]]); continue; }
      if (m[4] !== undefined) { pending.push(["name", m[4]]); continue; }
      if (m[5] !== undefined) { pending.push(["num", m[5]]); continue; }
      var op = m[6];
      if (op === undefined) continue;
      var nums = [];
      for (var i = 0; i < pending.length; i++) if (pending[i][0] === "num") nums.push(parseFloat(pending[i][1]));

      if (op === "q") gstack.push(ctm.slice());
      else if (op === "Q") { if (gstack.length) ctm = gstack.pop(); }
      else if (op === "cm" && nums.length >= 6) ctm = mul(nums.slice(-6), ctm);
      else if (op === "Tf") {
        for (var n2 = pending.length - 1; n2 >= 0; n2--) {
          if (pending[n2][0] === "name") { font = fonts[pending[n2][1].slice(1)]; break; }
        }
      }
      else if (op === "BT") { tm = [1, 0, 0, 1, 0, 0]; tlm = tm.slice(); }
      else if (op === "Tm" && nums.length >= 6) { tm = nums.slice(-6); tlm = tm.slice(); }
      else if ((op === "Td" || op === "TD") && nums.length >= 2) {
        if (op === "TD") leading = -nums[nums.length - 1];
        tlm = mul([1, 0, 0, 1, nums[nums.length - 2], nums[nums.length - 1]], tlm);
        tm = tlm.slice();
      }
      else if (op === "TL" && nums.length) leading = nums[nums.length - 1];
      else if (op === "T*") { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); }
      else if (op === "Tj" || op === "'" || op === '"') {
        if (op !== "Tj") { tlm = mul([1, 0, 0, 1, 0, -leading], tlm); tm = tlm.slice(); }
        for (var h = pending.length - 1; h >= 0; h--) {
          if (pending[h][0] === "hex") { place(decodeHex(pending[h][1], font)); break; }
        }
      }
      else if (op === "TJ") {
        var parts = "";
        for (var p = 0; p < pending.length; p++) {
          if (pending[p][0] === "hex") parts += decodeHex(pending[p][1], font);
          else if (pending[p][0] === "num" && parseFloat(pending[p][1]) < -180) parts += " ";
        }
        place(parts);
      }
      pending = [];
    }

    if (!runs.length) return "";
    runs.sort(function (a, b) { return (b[0] - a[0]) || (a[1] - b[1]); });
    var lines = [], curY = null, buf = [];
    for (var r = 0; r < runs.length; r++) {
      if (curY === null || Math.abs(runs[r][0] - curY) > 1.2) {
        if (buf.length) lines.push(joinLine(buf));
        buf = []; curY = runs[r][0];
      }
      buf.push([runs[r][1], runs[r][2]]);
    }
    if (buf.length) lines.push(joinLine(buf));
    return lines.filter(function (l) { return l.trim(); }).join("\n");
  }

  async function extractText(arrayBuffer) {
    var bytes = new Uint8Array(arrayBuffer);
    var S = latin1(bytes);
    if (S.slice(0, 4) !== "%PDF") throw new PdfError("Not a PDF file");
    var objs = parseObjects(S);
    var nums = Object.keys(objs).map(Number).sort(function (a, b) { return a - b; });
    var pages = [];
    for (var i = 0; i < nums.length; i++) {
      var d = objs[nums[i]].dict;
      if (!/\/Type\s*\/Page\b(?!s)/.test(d)) continue;
      var res = dictGet(d, "Resources");
      if (res && /^\s*\d+\s+\d+\s+R\s*$/.test(res)) res = resolve(objs, res);
      var fonts = await pageFonts(objs, bytes, res || "");
      var content = "";
      var crefs = refsIn(dictGet(d, "Contents"));
      for (var c = 0; c < crefs.length; c++) {
        content += latin1(await streamBytes(objs, bytes, crefs[c])) + "\n";
      }
      if (content.trim()) pages.push(pageText(content, fonts));
    }
    if (!pages.length) throw new PdfError("No readable text found - the PDF may be a scanned image");
    return pages.join("\n");
  }

  /* ------------------------------------------------- tabulation parsing */

  var OUR_FIRM = "STAR ELECTRIC";
  var RE_TENDER = /Tender\s*No\s*[:.]?\s*([A-Z0-9/-]+)/i;
  var RE_RUNDATE = /Run\s*Date\s*\/?\s*Time\s*[:.]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i;
  var RE_CLOSING = /Closing\s*Date\s*\/?\s*Time\s*[:.]?\s*(\d{1,2}\/\d{1,2}\/\d{2,4})/i;
  var RE_ITEMLINE = /^\s*(\d{6,12})\s*\/\s*[YN]\s+([\d,]+\.?\d*)\s*$/;
  var RE_GOODS = /Goods\s*[:.]\s*(.+)$/;
  var RE_RAILWAY = /^\s*STORES\s*\/\s*(.+?)\s*$/i;
  var RE_CONSIGNEE = /Consignee\s*-\s*(.+?)\s+Qty-\s*([\d,]+\.?\d*)\s+\S+\s*\(([^)]*)\)/i;
  var RE_CONSIGNEE_LOOSE = /Consignee\s*-\s*(.+?)\s+Qty-\s*([\d,]+\.?\d*)/i;
  var RE_BASICRATE = /Basic\s*Rate\s*-\s*Rs\.?\s*([\d,]+\.?\d*)/i;
  var RE_RANK = /\(\s*(L\s*\d+)\s*\)/;

  function iso(dmy) {
    var m = /^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/.exec(dmy || "");
    if (!m) return "";
    var y = m[3].length === 2 ? "20" + m[3] : m[3];
    return y + "-" + ("0" + m[2]).slice(-2) + "-" + ("0" + m[1]).slice(-2);
  }
  function num(s) {
    var v = parseFloat(String(s).replace(/,/g, ""));
    return isNaN(v) ? null : v;
  }
  function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
  function isBidLine(l) { return RE_BASICRATE.test(l); }

  function parseTabulation(text) {
    var lines = text.split("\n").map(function (l) { return l.replace(/\s+$/, ""); });
    var joined = lines.join("\n");
    var warnings = [];

    var m = RE_TENDER.exec(joined);
    if (!m) throw new PdfError("No 'Tender No' found - this does not look like a financial tabulation");
    var tenderNumber = m[1].trim().replace(/^\/|\/$/g, "");

    var railway = "";
    for (var i = 0; i < Math.min(12, lines.length); i++) {
      var rm = RE_RAILWAY.exec(lines[i]);
      if (rm) { railway = clean(rm[1]); break; }
    }
    if (!railway) { railway = "Railway not identified"; warnings.push("Railway name not found in the PDF header"); }

    var rd = RE_RUNDATE.exec(joined), cd = RE_CLOSING.exec(joined);
    var tabDate = rd ? iso(rd[1]) : "";
    var closing = cd ? iso(cd[1]) : "";
    if (!tabDate) { tabDate = closing; if (tabDate) warnings.push("Run date not found; using the closing date"); }

    var itemCode = "", qty = 0;
    for (var a = 0; a < lines.length; a++) {
      var im = RE_ITEMLINE.exec(lines[a]);
      if (im) { itemCode = im[1]; qty = Math.round(num(im[2]) || 0); break; }
    }

    var product = "";
    for (var b = 0; b < lines.length; b++) {
      var gm = RE_GOODS.exec(lines[b]);
      if (gm) { product = clean(gm[1]); break; }
    }
    if (!product) warnings.push("Product description not found");

    var marks = [];
    for (var c = 0; c < lines.length; c++) {
      var cm = RE_CONSIGNEE.exec(lines[c]) || RE_CONSIGNEE_LOOSE.exec(lines[c]);
      if (cm) marks.push([c, cm]);
    }

    var consignees = [];
    for (var n = 0; n < marks.length; n++) {
      var idx = marks[n][0], cmt = marks[n][1];
      var end = (n + 1 < marks.length) ? marks[n + 1][0] : lines.length;
      var name = clean(cmt[1]);
      var nxt = (idx + 1 < lines.length) ? lines[idx + 1] : "";
      if (nxt.trim() && !isBidLine(nxt) && !RE_RANK.test(nxt) &&
          !RE_CONSIGNEE_LOOSE.test(nxt) && nxt.trim().length < 60) {
        name = clean(name + " " + nxt);
      }
      var block = lines.slice(idx, end);
      var starRate = null, starRank = "";
      for (var j = 0; j < block.length; j++) {
        if (block[j].toUpperCase().indexOf(OUR_FIRM) >= 0 && isBidLine(block[j])) {
          var br = RE_BASICRATE.exec(block[j]);
          if (br) starRate = num(br[1]);
          for (var k = j; k < Math.min(j + 6, block.length); k++) {
            var rk = RE_RANK.exec(block[k]);
            if (rk) { starRank = rk[1].replace(/\s/g, "").toUpperCase(); break; }
          }
          break;
        }
      }
      consignees.push({
        name: name, qty: Math.round(num(cmt[2]) || 0),
        star_rank: starRank, star_rate: starRate
      });
    }
    if (!consignees.length) warnings.push("No consignee blocks found");

    var rated = consignees.filter(function (x) { return x.star_rank; });
    if (!rated.length && consignees.length) warnings.push("Star Electric was not found among the bidders");

    function rankVal(r) { var mm = /^L(\d+)/.exec(r || ""); return mm ? parseInt(mm[1], 10) : 99; }
    var rank = "";
    rated.forEach(function (x) { if (!rank || rankVal(x.star_rank) > rankVal(rank)) rank = x.star_rank; });

    if (!qty && consignees.length) {
      qty = consignees.reduce(function (s, x) { return s + x.qty; }, 0);
    }

    return {
      tender_number: tenderNumber, railway: railway, product: product,
      item_code: itemCode, qty: qty, rank: rank, tab_date: tabDate,
      closing_date: closing, consignees: consignees, warnings: warnings
    };
  }

  async function parsePdfFile(arrayBuffer) {
    return parseTabulation(await extractText(arrayBuffer));
  }

  global.TenderPdf = {
    extractText: extractText,
    parseTabulation: parseTabulation,
    parsePdfFile: parsePdfFile,
    PdfError: PdfError
  };
})(window);
