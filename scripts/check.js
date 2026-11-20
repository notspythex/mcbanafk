'use strict';
// Quick pre-flight: node scripts/check.js  (or: npm run check)
const major = Number(process.versions.node.split('.')[0]);
console.log(`Node.js ${process.versions.node}: ${major >= 22 ? 'OK' : 'TOO OLD (need >= 22)'}`);
for (const m of ['mineflayer', 'express', 'socket.io']) {
  try { console.log(`${m} ${require(`${m}/package.json`).version}: installed`); } catch { console.log(`${m}: MISSING (run npm install)`); process.exitCode = 1; }
}
const { load } = require('../src/config');
const { errors, warnings } = load();
warnings.forEach((w) => console.log(`config warning: ${w}`));
if (errors.length) { errors.forEach((e) => console.log(`config error: ${e}`)); process.exitCode = 1; } else console.log('config.json: valid');
if (major < 22) process.exitCode = 1;
