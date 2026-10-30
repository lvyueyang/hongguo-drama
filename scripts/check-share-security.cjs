const assert = require('node:assert/strict');
const http = require('node:http');
const zlib = require('node:zlib');
const dns = require('node:dns');
const axios = require('axios');
const { resolveSeriesId } = require('../src/native/hongguo');

async function main() {
  const original = axios.get;
  const calls = [];
  axios.get = async (url, options) => {
    calls.push({ url, options });
    return { status: 200, headers: {}, data: '{"series_id":"123"}', config: { url } };
  };
  try {
    for (const input of ['data:' + '/'.repeat(4096), 'file:///etc/hosts', 'ftp://example.com/a',
      'javascript:alert(1)', '//example.com/a', 'https://user:secret@example.com/',
      'x'.repeat(8193), 'https://example.com/' + 'x'.repeat(4096), '1'.repeat(31), {},
      'http://127.0.0.1/', 'http://2130706433/', 'http://0x7f000001/', 'http://10.0.0.1/',
      'http://169.254.169.254/', 'http://[::ffff:127.0.0.1]/', 'http://[fd00::1]/', 'http://nas.local/',
      'http://127.0.0.1/player/12345678', 'http://nas.local/?series_id=12345678',
      'https://user:secret@example.com/detail?series_id=12345678']) {
      calls.length = 0;
      await assert.rejects(resolveSeriesId(input));
      assert.equal(calls.length, 0, 'invalid input must never reach axios');
    }
    assert.equal(await resolveSeriesId(' 1234567890 '), '1234567890');
    calls.length = 0;
    assert.equal(await resolveSeriesId('https://hongguoduanju.com/player/7673067074104593432'), '7673067074104593432');
    assert.equal(await resolveSeriesId('https://hongguoduanju.com/detail?series_id=7673067074104593432'), '7673067074104593432');
    assert.equal(await resolveSeriesId('https://hongguoduanju.com/detail?series_id=1234567%38'), '12345678');
    assert.equal(await resolveSeriesId('看这里 http://127.0.0.1/private series_id=12345678'), '12345678');
    assert.equal(await resolveSeriesId('https://user:secret@example.com/path series_id=12345678'), '12345678');
    assert.equal(await resolveSeriesId('series_id=999 看剧 https://hongguoduanju.com/detail?series_id=1234567%38'), '999', 'an explicit ID outside URLs needs no URL request or validation');
    assert.equal(await resolveSeriesId('看剧点这里 https://example.com/share/abc ，series_id=7673067074104593432'), '7673067074104593432');
    assert.equal(calls.length, 0, 'a series id already present in the URL or share text must not need a network request');
    calls.length = 0;
    for (const input of ['not_series_id=1234567', 'not_video_series_id=1234567', 'series_id=' + '1'.repeat(31), 'series_id=123456789012345678901234567890abc']) {
      await assert.rejects(resolveSeriesId(input), undefined, input);
      assert.equal(calls.length, 0, 'invalid or unrelated keys must not trigger a request');
    }
    assert.equal(await resolveSeriesId('series_id=' + '1'.repeat(30)), '1'.repeat(30));
    assert.equal(await resolveSeriesId('video_series_id=1234567890'), '1234567890');
    assert.equal(await resolveSeriesId('"series_id":"1234567890"'), '1234567890');
    assert.equal(calls.length, 0);
    calls.length = 0;
    assert.equal(await resolveSeriesId('推荐好剧，点击 https://example.com/share/abc 观看全集'), '123');
    assert.equal(calls[0].url, 'https://example.com/share/abc');
    const options = calls[0].options;
    assert.equal(options.maxRedirects, 0);
    assert.equal(options.responseType, 'text');
    assert.ok(options.maxContentLength > 0 && options.maxContentLength <= 2 * 1024 * 1024);
    assert.ok(options.signal instanceof AbortSignal);

    for (const location of ['data:text/plain,123', 'file:///tmp/test', 'https://user:secret@example.com/',
      'https://example.com/' + 'x'.repeat(4096), 'http://127.0.0.1/private', '//192.168.1.1/private',
      'http://[::ffff:10.0.0.1]/', 'http://localhost./', 'http://127.0.0.1/player/12345678',
      'https://user:secret@example.com/detail?series_id=12345678']) {
      calls.length = 0;
      axios.get = async url => { calls.push(url); return { status: 302, headers: { location }, data: '' }; };
      await assert.rejects(resolveSeriesId('https://example.com/short'));
      assert.equal(calls.length, 1, 'invalid redirect must not be requested');
    }
    calls.length = 0;
    axios.get = async url => {
      calls.push(url);
      return url.endsWith('/short') ? { status: 302, headers: { location: '/player/456' }, data: '' }
        : (() => { throw new Error('target page unavailable'); })();
    };
    assert.equal(await resolveSeriesId('https://example.com/short'), '456');
    assert.deepEqual(calls, ['https://example.com/short'], 'a safe redirect with an ID must not fetch the target page');
    calls.length = 0;
    axios.get = async url => { calls.push(url); return { status: 302, headers: { location: '/loop' }, data: '' }; };
    await assert.rejects(resolveSeriesId('https://example.com/loop'));
    assert.ok(calls.length <= 6, 'redirect chain must be bounded');
    axios.get = async () => ({ status: 200, headers: {}, data: '{"series_id":"789"}' });
    assert.equal(await resolveSeriesId('https://example.com/?schemeParams=%ZZ'), '789');
    axios.get = async () => ({ status: 200, headers: {}, data: '{"series_id":"' + '1'.repeat(31) + '"}' });
    await assert.rejects(resolveSeriesId('https://example.com/'));
  } finally { axios.get = original; }

  const body = zlib.gzipSync(Buffer.from('{"series_id":"123","padding":"' + 'x'.repeat(2 * 1024 * 1024) + '"}'));
  let reachedServer = false;
  const server = http.createServer((req, res) => {
    reachedServer = true;
    res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
    res.end(body);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  axios.get = (url, options) => original(url, { ...options, proxy: false });
  try {
    await assert.rejects(resolveSeriesId(`http://127.0.0.1:${server.address().port}/`));
    assert.equal(reachedServer, false, 'private literal must never reach the local server');
    const originalLookup = dns.lookup;
    dns.lookup = (_hostname, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]);
    try {
      await assert.rejects(resolveSeriesId(`http://share.example:${server.address().port}/`));
      assert.equal(reachedServer, false, 'private DNS must be rejected before opening a socket');
    } finally { dns.lookup = originalLookup; }
    // An explicitly configured local proxy remains supported; it serves only this offline fixture.
    axios.get = (url, options) => original(url, { ...options,
      proxy: { protocol: 'http', host: '127.0.0.1', port: server.address().port } });
    await assert.rejects(resolveSeriesId('http://share.example/gzip'), /加载失败/);
    assert.equal(reachedServer, true, 'response limit must be tested against the local server');
  } finally {
    axios.get = original;
    await new Promise(resolve => server.close(resolve));
  }
  const originalLookup = dns.lookup;
  let records = [{ address: '8.8.8.8', family: 4 }];
  const connected = [];
  dns.lookup = (_hostname, _options, callback) => callback(null, records);
  const lookup = options => new Promise((resolve, reject) => {
    assert.equal(typeof options.lookup, 'function', 'share requests must validate socket DNS');
    options.lookup(new URL(options.url).hostname, { all: true }, (error, addresses) => error ? reject(error) : resolve(addresses));
  });
  try {
    // Synthetic responses use the supported official short-link and player URL shapes, without live traffic.
    axios.get = async (url, options) => {
      await lookup({ ...options, url }); connected.push(url);
      return url.includes('v.fqnovel.com')
        ? { status: 302, headers: { location: 'https://hongguoduanju.com/player/7123456789012345678' }, data: '' }
        : { status: 200, headers: {}, data: '<html>official player fixture</html>' };
    };
    assert.equal(await resolveSeriesId('分享短剧 https://v.fqnovel.com/fixture/'), '7123456789012345678');
    assert.equal(connected.length, 1);
    for (const answers of [[{ address: '192.168.1.1', family: 4 }],
      [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }],
      [{ address: '::ffff:127.0.0.1', family: 6 }]]) {
      records = answers; connected.length = 0;
      await assert.rejects(resolveSeriesId('https://v.fqnovel.com/fixture/'));
      assert.equal(connected.length, 0);
    }
    for (const location of ['/rebound', 'https://redirect.example/private']) {
      records = [{ address: '8.8.8.8', family: 4 }]; connected.length = 0;
      axios.get = async (url, options) => {
        await lookup({ ...options, url }); connected.push(url);
        records = [{ address: '127.0.0.1', family: 4 }];
        return { status: 302, headers: { location }, data: '' };
      };
      await assert.rejects(resolveSeriesId('https://share.example/start'));
      assert.equal(connected.length, 1, 'redirect and rebound DNS must be checked before each connection');
    }
  } finally { axios.get = original; dns.lookup = originalLookup; }
  // 5.0 起 axios 属于 SDK 包（依赖收敛到 packages/sdk），版本以 SDK 的声明为准。
  const sdkAxios = require('../packages/sdk/package.json').dependencies.axios;
  assert.equal(require('axios/package.json').version, sdkAxios, 'installed axios must match the SDK pin');
  console.log('Share security: input, private destinations, redirects, socket DNS/rebinding, official URL fixtures, gzip limit and dependency checks passed');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
