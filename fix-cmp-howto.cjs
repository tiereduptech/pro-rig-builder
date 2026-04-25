const fs = require('fs');
const p = 'src/App.jsx';
let s = fs.readFileSync(p, 'utf8');

const old = `      {q:'Can I compare across retailers?',a:'Yes, we show current pricing for each part across Amazon, Best Buy, Newegg, B&H, and Antonline. The lowest in-stock price wins.'}
    ]
  }
};`;

const neu = `      {q:'Can I compare across retailers?',a:'Yes, we show current pricing for each part across Amazon, Best Buy, Newegg, B&H, and Antonline. The lowest in-stock price wins.'}
    ],
    howTo: [
      'Pick category: CPU, GPU, motherboard, RAM, storage, etc.',
      'Select Part A from the dropdown.',
      'Select Part B (must be same category).',
      'Click "Compare" to see all specs and prices side-by-side.',
      'Review benchmarks, current deals, and which retailer has the best in-stock price.'
    ]
  }
};`;

if (!s.includes(old)) {
  console.log('MISS - cmp anchor not found');
  process.exit(1);
}

s = s.replace(old, neu);
fs.writeFileSync(p, s);
console.log('Added howTo to cmp tool');
