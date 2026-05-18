const r = require('./catalog-build/reviews.json');
const amazonKeys = Object.entries(r).filter(([k, v]) =>
  Array.isArray(v.reviews) && v.reviews.some(x => x.source === 'amazon'));
console.log('Keys with at least one Amazon review: ' + amazonKeys.length);
console.log('');
for (const [k, v] of amazonKeys.slice(0, 3)) {
  console.log('KEY: ' + k + '  (' + v.reviews.length + ' reviews)');
  for (const rv of v.reviews) {
    console.log('  [' + rv.source + '] ' + rv.rating + '★  "' + (rv.title || '').slice(0, 40) +
      '"  by ' + rv.author + '  date=' + JSON.stringify(rv.date));
    console.log('       ' + (rv.comment || '').slice(0, 80).replace(/\n/g, ' ') + '...');
  }
  console.log('');
}
