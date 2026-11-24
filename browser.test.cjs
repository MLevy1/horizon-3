const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { once } = require('node:events');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');

async function until(read) {
  for (let i = 0; i < 160; i++) {
    const result = await read();
    if (result) return result;
    await delay(50);
  }
  throw Error('Browser state timed out.');
}

test('Atlas and Explorer share probe values and restore a downloaded cube after reload', async () => {
  const chrome = process.env.HORIZON_CHROME ??
    (process.platform === 'win32' ? 'C:/Program Files/Google/Chrome/Application/chrome.exe' : 'chromium');
  const parent = await fs.realpath(process.env.HORIZON_TMP ?? os.tmpdir());
  const dir = await fs.realpath(await fs.mkdtemp(path.join(parent, 'horizon-roadmap-v0-')));
  const browser = spawn(chrome, ['--headless=new', '--no-first-run', '--remote-debugging-port=0',
    '--user-data-dir=' + dir, 'about:blank'], { windowsHide: true, stdio: 'ignore' });
  const exited = new Promise(resolve => {
    browser.once('exit', resolve);
    browser.once('error', resolve);
  });
  let socket;
  try {
    const port = await until(async () => {
      if (!browser.pid || browser.exitCode !== null) throw Error('Could not start Chrome: ' + chrome);
      return (await fs.readFile(path.join(dir, 'DevToolsActivePort'), 'utf8')
        .catch(() => '')).split('\n')[0].trim();
    });
    const sockets = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
    socket = new WebSocket(sockets.find(s => s.type === 'page').webSocketDebuggerUrl);
    await once(socket, 'open');
    const pending = new Map(), errors = [];
    let serial = 0;
    socket.onmessage = ({ data }) => {
      const message = JSON.parse(data);
      if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails);
      if (!message.id) return;
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(Error(message.error.message));
      else resolve(message.result);
    };
    const send = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++serial;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
    async function evaluate(expression) {
      const { result, exceptionDetails } = await send('Runtime.evaluate', { expression, returnByValue: true });
      if (exceptionDetails) throw Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
      return result.value;
    }
    async function navigate() {
      await send('Page.navigate', { url: pathToFileURL(path.join(__dirname, 'index.html')).href });
      await until(() => evaluate("document.querySelector('#world-id')?.textContent"));
    }
    await send('Runtime.enable');
    await send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: dir });
    await navigate();
    const read = id => evaluate("document.getElementById(" + JSON.stringify(id) + ").textContent");
    const click = id => evaluate("document.getElementById(" + JSON.stringify(id) + ").click()");
    const image = () => evaluate("document.querySelector('canvas').toDataURL().slice(-20000)");
    const planet = await image();
    const initial = await read('sample');
    await click('pilot');
    assert.equal(await read('sample'), initial);
    assert.notEqual(await image(), planet);
    const pilot = await image();
    await click('explorer');
    assert.equal(await read('sample'), initial);
    assert.notEqual(await image(), pilot);
    const bare = await image();
    await click('place');
    assert.equal(await read('status'), 'Cube placed.');
    const anchor = await read('structure');
    await click('right');
    await click('closer');
    assert.equal(await read('structure'), anchor);
    assert.equal(await read('sample'), initial);
    await click('export');
    const filename = (await read('world-id')) + '-overlay.json';
    const file = path.join(dir, filename);
    const overlay = await until(() => fs.readFile(file, 'utf8').catch(() => ''));
    assert.equal(JSON.parse(overlay).structures.length, 1);

    await navigate();
    assert.equal(await read('structure'), 'Open Explorer to place a cube.');
    const { root } = await send('DOM.getDocument');
    const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#overlay-file' });
    await send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await until(async () => (await read('status')) === 'Overlay loaded.');
    assert.equal(await read('structure'), anchor);
    assert.equal(await read('sample'), initial);
    assert.notEqual(await image(), bare);
    assert.deepEqual(errors, []);
  } finally {
    socket?.close();
    browser.kill();
    await exited;
    if (path.dirname(dir) === parent && path.basename(dir).startsWith('horizon-roadmap-v0-')) {
      await fs.rm(dir, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }).catch(() => {});
    }
  }
});
