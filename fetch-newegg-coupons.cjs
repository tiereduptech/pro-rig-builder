#!/usr/bin/env node
/**
 * fetch-newegg-coupons.cjs — Pulls active Newegg coupons from Rakuten
 * Coupon Feed API and writes them to src/data/newegg-coupons.json.
 */
const fs = require('fs');
const path = require('path');
const { XMLParser } = require('fast-xml-parser');

const TOKEN = process.env.RAKUTEN_WEB_SERVICES_TOKEN;
const NEWEGG_MID = '44583';
const OUTPUT = path.join(__dirname, 'src', 'data', 'newegg-coupons.json');

if (!TOKEN) { console.error('Missing RAKUTEN_WEB_SERVICES_TOKEN'); process.exit(1); }

(async () => {
  const url = `https://couponfeed.linksynergy.com/coupon?token=${TOKEN}&mid=${NEWEGG_MID}`;
  console.log('Fetching:', url.replace(TOKEN, '***'));
  
  const res = await fetch(url, { headers: { 'Accept': 'application/xml' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  
  const xml = await res.text();
  console.log(`Received ${xml.length} bytes`);
  
  const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_' });
  const parsed = parser.parse(xml);
  
  // Coupon Feed wraps coupons in <couponfeed><link>...</link></couponfeed>
  let links = parsed?.couponfeed?.link || parsed?.links?.link || [];
  if (!Array.isArray(links)) links = [links];
  
  console.log(`Found ${links.length} raw entries`);
  
  const now = Date.now();
  const coupons = [];
  
  for (const l of links) {
    if (!l) continue;
    
    // Extract fields (Rakuten Coupon Feed schema)
    const code = String(l.couponcode || l.promotioncode || '').trim();
    const description = String(l.offerdescription || l.description || '').trim();
    const startDate = l.offerstartdate || null;
    const endDate = l.offerenddate || null;
    const clickUrl = String(l.clickurl || l.url || '').trim();
    const restrictions = String(l.couponrestriction || l.restrictions || '').trim();
    const category = String(l.categories?.category || l.category || '').trim();
    const promotionType = String(l.promotiontypes?.promotiontype || l.promotiontype || '').trim();
    const advertiserName = String(l.advertisername || 'Newegg').trim();
    
    if (!description && !code) continue;
    
    // Filter to active (not expired)
    if (endDate) {
      const endMs = Date.parse(endDate);
      if (!isNaN(endMs) && endMs < now) continue;
    }
    
    coupons.push({
      code: code || null,
      description,
      startDate, endDate,
      clickUrl,
      restrictions: restrictions || null,
      category: category || null,
      promotionType: promotionType || null,
      advertiser: advertiserName
    });
  }
  
  console.log(`Active coupons: ${coupons.length}`);
  
  const output = {
    generatedAt: new Date().toISOString(),
    merchant: 'Newegg',
    mid: NEWEGG_MID,
    count: coupons.length,
    coupons
  };
  
  fs.writeFileSync(OUTPUT, JSON.stringify(output, null, 2));
  console.log(`Wrote ${path.relative(__dirname, OUTPUT)}`);
  
  // Print sample
  if (coupons.length > 0) {
    console.log('\nSample coupons:');
    coupons.slice(0, 3).forEach((c, i) => {
      console.log(`  ${i+1}. ${c.code || '(no code)'} - ${c.description.substring(0, 80)}`);
    });
  }
})().catch(e => { console.error('Error:', e.message); process.exit(1); });
