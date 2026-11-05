const fs = require('node:fs');
const path = require('node:path');
const lock = require('../package-lock.json');
const root = path.resolve(__dirname, '..');
const sections = ['RenderHop third-party notices\n\nApplication source: MIT (see LICENSE). Third-party code retains its original license.\n\nRuntime is NOT redistributed by this repository: use the installed Arch electron43.\nElectron license: /usr/lib/electron43/LICENSE\nChromium and bundled third-party notices: /usr/lib/electron43/LICENSES.chromium.html\nUpstream: https://github.com/electron/electron/tree/v43.8.7\n'];
for (const [dir, pkg] of Object.entries(lock.packages || {})) {
  if (!dir) continue;
  const location = path.join(root, dir);
  if (!fs.existsSync(location)) { sections.push(`${dir} @ ${pkg.version}: optional platform package not installed (${pkg.license || 'see upstream license'}). ${pkg.resolved || ''}\n`); continue; }
  const files = fs.readdirSync(location).filter(n => /^(licen[sc]e|copying|notice)(\.|$|-)/i.test(n) && fs.statSync(path.join(location, n)).isFile());
  sections.push(`\n${dir} @ ${pkg.version} — declared ${pkg.license || 'see package'}\n${pkg.resolved || ''}\n`);
  for (const name of files) sections.push(`${name}:\n${fs.readFileSync(path.join(location, name), 'utf8')}\n`);
}
fs.writeFileSync(path.join(root, 'THIRD_PARTY_NOTICES.txt'), sections.join('\n').replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trimEnd() + '\n');
