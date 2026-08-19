// Spec parser for Amazon case listings, split out of dataforseo-enrich-cases.js
// so its rules can be tested against real listing shapes without the script's
// paid API calls and env-var preflight running first.
//
//
// The rule this parser exists to enforce: NEVER match across a boundary that
// separates one product's spec from another's, or one label's value from the
// next label.
//
// The old parser joined title, description, spec body and A+ content into a
// single string and regexed the blob. Two things went wrong on live listings,
// and both shipped wrong numbers to the site (corrected in #36):
//
//   1. WRONG PRODUCT. A+ content carries a COMPARISON TABLE — one label, then
//      that spec for this product AND up to six others:
//
//        Max GPU Length   420mm(16.54")   410mm (16.14")   400mm(15.75")  ...
//
//      Flattened, "GPU Length" sits next to whichever number happens to follow,
//      and B0GDXM372W published 420mm off a column belonging to a $74.99 case
//      while it is a $99.99 one. Which column is the listing is NOT knowable
//      from position: of the 91 responses this run collected, the product's own
//      ASIN could be located in its comparison table only 10 times, and the
//      table's column count matched its ASIN count only 16 times. So these rows
//      are refused outright rather than guessed at.
//
//   2. WRONG LABEL. Values bound backwards across a line break to the NEXT
//      label:
//
//        Fan Support        Top: 3x 120mm ... - Rear: 1x 120mm
//        Radiator Support   Top: 240mm / 280mm / 360mm - Side: ...
//
//      joined to "... Rear: 1x 120mm \n Radiator Support ...", so
//      /(\d{3})mm\s*Radiator/ read the REAR FAN size and B0CGFTBVCD published
//      120mm radiator support for a case that takes 360mm.
//
// So: the listing is split into UNITS, each of which is attributable to this
// product and to one label, and patterns run inside a unit and never across
// two. A unit is one of
//
//   { label, value }  a spec row — a body key/value pair, or an A+ line that
//                     splits into exactly two cells on a run of 2+ spaces.
//   { text }          free prose — the title, the description, or an A+ line
//                     that does not split at all.
//
// An A+ line that splits into THREE OR MORE cells is dropped. That is the
// comparison-table shape, and it is also the multi-column marketing block, and
// nothing in either can be attributed to a single product-and-label pair.
// Sparse beats confidently wrong.
const RAD_SIZES = [120, 140, 240, 280, 360, 420, 480];

function splitUnits(item) {
  const units = [];
  const bodyKV = {};
  // Every source is split on newlines before it becomes a unit. The description
  // field carries embedded \n and packs one spec per line:
  //   "CPU Cooler Max Height: 160mm\nVGA Card Max Length: 370mm"
  // Left whole, /(\d{3})mm\s*VGA/ reads the COOLER height as the card clearance
  // — the same backwards bind as the A+ case, inside a single field.
  const pushText = (str) => {
    for (const line of String(str).split(/\r?\n/)) {
      const t = line.trim();
      if (t) units.push({ text: t });
    }
  };
  if (item.title) pushText(item.title);
  if (item.description) pushText(item.description);

  for (const section of (item.product_information || [])) {
    // Body pairs are this product's own spec table: already one label, one value.
    if (section?.body && typeof section.body === 'object') {
      for (const [k, v] of Object.entries(section.body)) {
        bodyKV[k.toLowerCase()] = String(v);
        for (const line of String(v).split(/\r?\n/)) {
          if (line.trim()) units.push({ label: k, value: line.trim() });
        }
      }
    }
    for (const c of (section?.contents || [])) {
      for (const row of (c?.rows || [])) {
        if (!row?.text) continue;
        for (const line of row.text.split(/\r?\n/)) {
          const cells = line.trim().split(/\s{2,}/).filter(Boolean);
          if (cells.length === 1) units.push({ text: cells[0] });
          else if (cells.length === 2) units.push({ label: cells[0], value: cells[1] });
          // >= 3 cells: comparison table or multi-column block. Unattributable.
        }
      }
    }
  }
  return { units, bodyKV };
}

// The only tokens allowed between a spec's NAME and its NUMBER. Anything else —
// notably , / & + and any other word — means the number belongs to the next
// spec, not this one: "Supports 320mm GPU & 240mm Radiator" is a 320mm card
// clearance, and a bridge that steps over "&" reads it as 240.
const BRIDGE = '(?:\\s*(?:cards?|max(?:imum)?|clearance|length|height|support(?:s|ed)?|size|up\\s*to|in\\s*length|of|is|to|[:\\-–]))*\\s*';

// Every NNNmm in a string, minus the ones that are a fan spec rather than a
// clearance: "3x 120mm" and "2 x 140mm" count fans, so the size is a FAN size.
function sizesIn(str) {
  const out = [];
  const re = /(?<!\d\s?[xX]\s?)\b(\d{2,3})\s*-?\s*mm\b/gi;
  let m;
  while ((m = re.exec(str)) !== null) out.push(parseInt(m[1], 10));
  return out;
}

// A clearance stated as a range — "280mm - 415mm", "290-345mm" — is the span a
// card can be depending on configuration. The USABLE number is the top of it.
// Taking the bottom is how B0D7BNK6CB published 280mm for a 415mm case.
const clearanceFrom = (str) => {
  const sizes = sizesIn(str);
  return sizes.length ? Math.max(...sizes) : null;
};

const labelIs = (unit, re) => unit.label != null && re.test(unit.label);

function parseSpecs(item) {
  const specs = {};
  if (!item) return specs;
  const { units, bodyKV } = splitUnits(item);

  for (const u of units) {
    const body = u.value != null ? u.value : u.text;

    // ─── Max GPU Length ──
    if (specs.maxGPU == null) {
      let v = null;
      // Labelled row: "Max GPU Length | 280mm - 415mm"
      if (labelIs(u, /\b(?:GPU|Graphics\s*Cards?|VGA)\b/i) && !labelIs(u, /PSU|Cooler|Fan|Radiator/i)) {
        v = clearanceFrom(body);
      } else {
        //   "Supports up to 340 mm GPU", "GPU Clearance: 365mm", "GPUs up to 415mm"
        //
        //   The bridge between the word and the number allows only "up to" and a
        //   connector word. It must NOT cross , / & + — those start the next
        //   spec, and a lazy [^.;|\n]{0,28} bridge reads "320mm GPU & 240mm Rad"
        //   as a 240mm card clearance.
        let m = body.match(/(?<!\d\s?[xX]\s?)(\d{3})\s*-?\s*mm\s*(?:GPU|Graphics\s*Cards?|VGA)/i);
        if (m) v = parseInt(m[1], 10);
        else {
          m = body.match(new RegExp('(?:GPU|Graphics\\s*Cards?|VGA)s?' + BRIDGE + '(\\d{3})\\s*-?\\s*mm(?:\\s*[-–]\\s*(\\d{3})\\s*mm)?', 'i'));
          if (m) v = Math.max(...[m[1], m[2]].filter(Boolean).map(Number));
        }
      }
      if (v != null && v >= 150 && v <= 600) specs.maxGPU = v;
    }

    // ─── Max Cooler Height ──
    if (specs.maxCooler == null) {
      let v = null;
      if (labelIs(u, /\bCooler\b/i) && !labelIs(u, /GPU|PSU|Radiator|Water|AIO|Liquid/i)) {
        v = clearanceFrom(body);
      } else {
        // Head must name a CPU/air cooler. "Liquid cooling up to 240mm" is a
        // radiator, and 240 clears the height bound, so it would land as a
        // cooler height if the head were just /cool/.
        const m = body.match(new RegExp('(?:Max(?:imum)?\\s*(?:CPU\\s*)?(?:Air\\s*)?Cooler|CPU\\s*Cool(?:er|ing)s?|Air\\s*Cool(?:er|ing)s?)' + BRIDGE + '(\\d{2,3})\\s*-?\\s*mm', 'i'));
        if (m) v = parseInt(m[1], 10);
      }
      if (v != null && v >= 40 && v <= 250) specs.maxCooler = v;
    }

    // ─── Fans Included ──
    //   Only phrasing that says the fans SHIP WITH the case. Amazon's
    //   "Number of Fans" body field is not that — on B07T4W3BMH it reads 9 for a
    //   case whose own title ends "(Fans are sold separately)", because it counts
    //   fan MOUNTS. Reading it would be a new wrong field on 50+ rows.
    if (specs.fans_inc == null) {
      const m = body.match(/(\d{1,2})\s*x\s*Pre[-\s]?Installed\s*Fans?/i)
             || body.match(/Pre[-\s]?Install(?:ed)?\s*(\d{1,2})\s*(?:x\s*\d+mm)?\s*(?:ARGB\s*|RGB\s*|PWM\s*|Infinity\s*Mirror\s*)*fans?/i)
             || body.match(/(\d{1,2})\s*(?:x\s*\d+\s*mm\s*)?(?:ARGB\s*|RGB\s*|PWM\s*|Infinity\s*Mirror\s*|Fans?\s*)*Pre[-\s]?Installed\b/i)
             || body.match(/Includes?\s*(\d{1,2})\s*(?:x\s*\d+mm\s*)?(?:ARGB\s*|RGB\s*|PWM\s*)*fans?/i);
      if (m) {
        const v = parseInt(m[1], 10);
        if (v >= 0 && v <= 15) specs.fans_inc = v;
      }
    }

    // ─── Radiator Support ──
    //   ARRAY OF INTEGERS, not "240mm,360mm". The AIO/Radiator filter in
    //   src/App.jsx reads `Array.isArray(p.rads) ? p.rads : []` and buckets
    //   anything else as "None", so a string here is a field the filter cannot
    //   read — coverage on paper, an empty filter on the site.
    if (specs.rads == null) {
      let found;
      if (labelIs(u, /Radiator|\bAIO\b|Water\s*Cool|Liquid\s*Cool/i)) {
        // The whole value belongs to this label: "Top: 240mm / 280mm / 360mm - Rear: 120mm"
        found = sizesIn(body);
      } else {
        // Free prose: the size must sit against the word, and must not be the
        // count-prefixed fan size that sizesIn() already rejects.
        found = [];
        const re = /(?<!\d\s?[xX]\s?)\b(\d{3})\s*-?\s*mm\s*(?:AIO\s*)?(?:Radiator|rad\b)/gi;
        let m;
        while ((m = re.exec(body)) !== null) found.push(parseInt(m[1], 10));
      }
      const sizes = [...new Set(found.filter(n => RAD_SIZES.includes(n)))].sort((a, b) => a - b);
      if (sizes.length) specs.rads = sizes;
    }
  }

  // ─── Drive Bays from structured body ──
  if (bodyKV['internal bays quantity']) {
    const n = parseInt(bodyKV['internal bays quantity']);
    if (n) {
      // We don't know 2.5 vs 3.5 from this field alone, but Hard Disk Form Factor tells us
      const form = bodyKV['hard disk form factor'] || '';
      if (/3\.5/.test(form)) specs.drive35 = n;
      else if (/2\.5/.test(form)) specs.drive25 = n;
    }
  }

  return specs;
}

export { parseSpecs, splitUnits, sizesIn, clearanceFrom, RAD_SIZES };
