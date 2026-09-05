#!/usr/bin/env node
// Runs the real classifier (background.js, unmodified) against eval/cases.json
// and prints how many outcomes matched. Costs one Sonnet call per case.
//
//   node eval/run.js            # run every case
//   node eval/run.js --dry-run  # print the cases and exit, no API calls

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const cases = JSON.parse(fs.readFileSync(path.join(__dirname, 'cases.json'), 'utf8'));

if (process.argv.includes('--dry-run')) {
  for (const c of cases) console.log(`${c.id.padEnd(18)} expect ${c.expect.join('|')}`);
  console.log(`${cases.length} cases, ${cases.length} classifier calls if run`);
  process.exit(0);
}

const configPath = path.join(root, 'config.js');
if (!fs.existsSync(configPath)) {
  console.error('config.js is missing. Copy config.example.js and add a key.');
  process.exit(1);
}

// background.js expects the extension's globals. Give it exactly the ones it
// touches and nothing else, so the code under test is the shipped file.
const sandbox = {
  console, fetch, AbortController, setTimeout, clearTimeout, JSON, Promise, Error, String,
  importScripts() {},
  chrome: { runtime: { onMessage: { addListener() {} } }, storage: { local: {} } },
};
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(configPath, 'utf8'), sandbox, { filename: 'config.js' });
// ANTHROPIC_API_KEY in the environment wins over the key in config.js.
if (process.env.ANTHROPIC_API_KEY) {
  vm.runInContext(`FRICTION_CONFIG.apiKey = ${JSON.stringify(process.env.ANTHROPIC_API_KEY)}`, sandbox);
}
vm.runInContext(fs.readFileSync(path.join(root, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });

// Top level const declarations do not land on the context object, so read
// them back out of the script scope instead.
const { classify, config } = vm.runInContext('({ classify, config: FRICTION_CONFIG })', sandbox);

(async () => {
  let passed = 0;
  const rows = [];
  for (const c of cases) {
    const payload = { message: c.message, context: c.context || [], recentFriction: c.recentFriction || null };
    let got;
    try {
      got = (await classify(payload)).outcome;
    } catch (err) {
      got = `error:${err.message}`;
    }
    const ok = c.expect.includes(got);
    if (ok) passed += 1;
    rows.push({ id: c.id, expect: c.expect.join('|'), got, ok });
    console.log(`${ok ? 'ok  ' : 'MISS'} ${c.id.padEnd(18)} expect ${c.expect.join('|').padEnd(10)} got ${got}`);
  }
  console.log(`\n${passed}/${cases.length} matched, model ${config.classifyModel}, effort ${config.classifyEffort}`);
  const out = path.join(__dirname, 'last-run.json');
  fs.writeFileSync(out, JSON.stringify({ ranAt: new Date().toISOString(), model: config.classifyModel, passed, total: cases.length, rows }, null, 2));
  process.exit(passed === cases.length ? 0 : 1);
})();
