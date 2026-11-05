import { test } from 'node:test';
import assert from 'node:assert/strict';
import { allowedURL, normalizeAddress } from '../src/protocol';
test('rejects privileged navigation and normalizes user addresses', () => {
  for (const s of ['file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,test', 'chrome://flags']) assert.throws(() => allowedURL(s));
  assert.equal(allowedURL('https://example.com/a'), 'https://example.com/a');
  assert.equal(normalizeAddress('example.com'), 'https://example.com/');
  assert.match(normalizeAddress('跃显 浏览器'), /^https:\/\/www.google.com\/search\?q=/);
  assert.equal(allowedURL('about:blank'), 'about:blank');
});
