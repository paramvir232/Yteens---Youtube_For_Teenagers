#!/usr/bin/env node
/**
 * Why can the phone not reach the backend?
 *
 *     npm run netcheck
 *
 * Every failure mode here looks identical from the device - a request that hangs and
 * then fails with no useful error - so guessing between them is slow. This prints the
 * facts: which addresses this machine has, what is listening and on which interface,
 * whether the USB tunnel is up, and the exact URL to use for each transport.
 *
 * It reads no .env and prints no secrets.
 */
const os = require('os');
const net = require('net');
const http = require('http');
const { execFileSync } = require('child_process');

const API_PORT = Number(process.env.PORT || 3000);
const TRANSCRIPT_PORT = 8000;
const METRO_PORTS = [8081, 8082];

/** Pure: every non-internal IPv4 address, with its interface name. */
function lanAddresses(interfaces = os.networkInterfaces()) {
  const found = [];
  for (const [name, addrs] of Object.entries(interfaces)) {
    for (const addr of addrs || []) {
      if (addr.family === 'IPv4' && !addr.internal) found.push({ name, address: addr.address });
    }
  }
  return found;
}

/** Is something accepting connections on this host:port? */
const probe = (port, host = '127.0.0.1', timeout = 1200) =>
  new Promise((resolve) => {
    const socket = new net.Socket();
    const done = (ok) => { socket.destroy(); resolve(ok); };
    socket.setTimeout(timeout);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
    socket.connect(port, host);
  });

/**
 * Is this actually Metro, or just something on the port?
 *
 * An open socket on 8081 proves only that a process is listening. On this machine 8081
 * is Jenkins, and reporting that as "metro reachable" would send someone looking in
 * entirely the wrong place. Metro answers /status with `packager-status:running`.
 */
const isMetro = (port, timeout = 1200) =>
  new Promise((resolve) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/status', timeout }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve(body.includes('packager-status:running')));
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => { req.destroy(); resolve(false); });
  });

const quiet = (file, args) => {
  try {
    return execFileSync(file, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
};

/** Pure: does `adb reverse --list` output contain a tunnel for this port? */
function hasReverse(adbListOutput, port) {
  if (!adbListOutput) return false;
  // Compared token by token, not with includes(): a substring test for tcp:3000
  // also matches tcp:30000, and would report a tunnel that is not there.
  const wanted = `tcp:${port}`;
  return adbListOutput
    .split('\n')
    .some((line) => line.trim().split(/\s+/).includes(wanted));
}

async function main() {
  const addresses = lanAddresses();

  console.log('\nNetcheck\n');

  console.log('  Addresses on this machine');
  if (addresses.length === 0) {
    console.log('    none - no network interface is up. Only the USB tunnel can work.');
  }
  for (const { name, address } of addresses) {
    console.log(`    ${address.padEnd(16)} ${name}`);
  }
  console.log('');

  console.log('  Listening');
  const metroPorts = [];
  for (const port of METRO_PORTS) {
    if (await isMetro(port)) metroPorts.push(port);
  }

  const targets = [
    ['backend', API_PORT],
    ['transcript service', TRANSCRIPT_PORT],
  ];
  for (const port of METRO_PORTS) {
    targets.push([metroPorts.includes(port) ? 'metro' : 'something else (not metro)', port]);
  }

  for (const [label, port] of targets) {
    const onLoopback = await probe(port, '127.0.0.1');
    let onLan = false;
    for (const { address } of addresses) {
      if (await probe(port, address)) { onLan = true; break; }
    }

    if (!onLoopback && !onLan) {
      console.log(`    not running  ${label} :${port}`);
    } else if (onLoopback && !onLan && addresses.length > 0) {
      // The classic: a service bound to 127.0.0.1 is invisible to the phone over Wi-Fi.
      // It still works over `adb reverse`, which connects from this machine's side.
      console.log(`    LOOPBACK ONLY ${label} :${port}  - unreachable over Wi-Fi, fine over adb reverse`);
    } else {
      console.log(`    reachable    ${label} :${port}`);
    }
  }
  console.log('');

  const devices = quiet('adb', ['devices']);
  const reverses = quiet('adb', ['reverse', '--list']);
  const deviceLines = (devices || '')
    .split('\n')
    .slice(1)
    .filter((l) => l.trim() && !l.startsWith('*'));

  console.log('  USB');
  if (devices === null) {
    console.log('    adb not on PATH - the USB transport is unavailable');
  } else if (deviceLines.length === 0) {
    console.log('    no device attached');
  } else {
    console.log(`    device attached: ${deviceLines[0].trim()}`);
    console.log(
      hasReverse(reverses, API_PORT)
        ? `    tunnel UP    the phone's localhost:${API_PORT} reaches this machine`
        : `    tunnel DOWN  run:  adb reverse tcp:${API_PORT} tcp:${API_PORT}`
    );
  }
  console.log('');

  const firewall = quiet('netsh', ['advfirewall', 'firewall', 'show', 'rule', 'name=Yteens backend 3000']);
  console.log('  Windows Firewall');
  console.log(
    firewall && !/No rules match/i.test(firewall)
      ? '    inbound rule for 3000 exists'
      : '    no inbound rule for 3000 - needed for Wi-Fi, not for adb reverse:\n' +
        '      netsh advfirewall firewall add rule name="Yteens backend 3000" dir=in action=allow protocol=TCP localport=3000'
  );
  console.log('');

  console.log('  What to put in the frontend .env');
  console.log(`    over USB   EXPO_PUBLIC_API_URL=http://localhost:${API_PORT}`);
  for (const { address, name } of addresses) {
    // Virtual adapters (VirtualBox, Hyper-V, WSL) show up here too and are NOT the
    // address the phone can reach. The interface name is the only way to tell.
    const hint = /wi-?fi|wlan|wireless/i.test(name) ? '  <- the phone can reach this one' : '';
    console.log(`    over Wi-Fi EXPO_PUBLIC_API_URL=http://${address}:${API_PORT}   (${name})${hint}`);
  }
  console.log('    or leave it unset in development - the app derives the host from Metro.');
  console.log('\n  Metro reads .env only at startup. Restart it after any change.\n');
}

if (require.main === module) {
  main().catch((err) => {
    console.error('netcheck failed:', err.message);
    process.exit(1);
  });
}

module.exports = { lanAddresses, hasReverse };
