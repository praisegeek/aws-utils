const path = require('path');
const fs = require('fs');
const http = require('http');
const qs = require('querystring');
const { launch } = require('./index');
const log = require('logdown')('dynamodb-emulator:deamon');

const pidPath = path.join(__dirname, '.pid');
// eslint-disable-next-line

const getHash = () => {
  const content = fs.readFileSync(__filename);
  return require('crypto')
    .createHash('md5')
    .update(content)
    .digest('hex');
};

const launchedVersion = getHash();

let globalEmulator = null;
let resolvedGlobalEmulator = null;
let server = null;
let lastHandle = 0;
const handles = new Set();

async function getEmulator(opts) {
  if (globalEmulator) {
    return globalEmulator;
  }

  // if the emulator stops then this process should also close.
  globalEmulator = launch(opts);
  let emu;
  try {
    emu = await globalEmulator;
  } catch (err) {
    if (err) {
      log.error(err);
      server.close();
    }
  }
  resolvedGlobalEmulator = emu;
  emu.proc.once('exit', () => {
    server.close();
  });
  return emu;
}

function handleHandshake() {
  const currentVersion = getHash();
  if (currentVersion !== launchedVersion) {
    process.nextTick(() => server.close());
    log.error('version mismatch', {
      currentVersion,
      launchedVersion,
    });
    return JSON.stringify({
      status: 'version-mismatch',
      launchedVersion,
      currentVersion,
    });
  }

  return JSON.stringify({ status: 'success' });
}

async function handleLaunch(opts) {
  const emulator = await getEmulator(opts);
  // eslint-disable-next-line
  const handle = lastHandle++;
  handles.add(handle);
  log.info('success', {
    url: emulator.url,
    port: emulator.port,
    handle,
  });
  return JSON.stringify({
    status: 'success',
    pid: process.pid,
    url: emulator.url,
    port: emulator.port,
    handle,
  });
}

async function handleFree(opts) {
  const handle = parseInt(opts.handle, 10);
  handles.delete(handle);
  log.info('remaining handles', handles.size);
  if (handles.size === 0) {
    log.info('no handles closing server');
    server.close(() => {
      process.exit();
    });
  }
}

async function requestHandler(req, res) {
  res.writeHead(200);
  log.info('request', req.url);

  const [pathPartRaw, query] = req.url.split('?');
  const pathPart = pathPartRaw.trim();
  const opts = qs.parse(query);
  log.info('route', pathPart, opts);

  switch (pathPart) {
    case '/handshake':
      return res.end(handleHandshake());
    case '/launch':
      return res.end(await handleLaunch(opts));
    case '/free':
      res.end(JSON.stringify(opts));
      return handleFree(opts);
    default:
      log.error('Unknown route:', pathPart);
      return res.end(
        JSON.stringify({ status: 'error', message: 'Unknown path', pathPart }),
      );
  }
}

const [, , hash] = process.argv;

const pidFile = path.join(pidPath, `${hash}.pid`);
try {
  fs.writeFileSync(
    pidFile,
    JSON.stringify({
      pid: process.pid,
      version: require('./package.json').version,
    }),
  );
} catch (err) {
  console.error('Failed to write to pid file');
  console.error(err);
  process.exit();
}
// XXX: Very important to use relative here to not exceed max path
// limits for unix socket bind.
const unixSocket = path.relative(process.cwd(), path.join(pidPath, hash));
server = http.createServer();
server.on('request', requestHandler);
server.listen(unixSocket);

function cleanup() {
  server.close();
  try {
    fs.unlinkSync(pidFile);
    fs.unlinkSync(unixSocket);
    // eslint-disable-next-line
  } catch (err) {
    // we don't care if there was an error in this case.
    // keep cleaning up!
  }
  if (resolvedGlobalEmulator) {
    // already closed.
    if (resolvedGlobalEmulator.proc.exitCode != null) {
      log.info('cleaning up already closed emulator');
      process.exit();
    }
    log.info('cleaning up - terminating emulator');
    resolvedGlobalEmulator.proc.kill();
    resolvedGlobalEmulator.proc.once('exit', () => {
      process.exit();
    });
  } else {
    process.exit();
  }
}

// ensure we cleanup after ourselves on exit.
process.once('beforeExit', cleanup);
process.once('SIGTERM', cleanup);
