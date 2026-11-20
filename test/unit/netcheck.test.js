const { lanAddresses, hasReverse } = require('../../scripts/netcheck');

/**
 * The two pure parts of the network diagnostic.
 *
 * This tool exists because every way the phone can fail to reach the backend looks
 * identical from the device - a request that hangs, then fails with no useful error. A
 * diagnostic that reports something wrong is worse than none at all, so the parsing is
 * pinned here.
 */

describe('lanAddresses', () => {
  it('ignores loopback, which the phone can never reach', () => {
    const found = lanAddresses({
      'Loopback Pseudo-Interface 1': [{ family: 'IPv4', address: '127.0.0.1', internal: true }],
      'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.4', internal: false }],
    });
    expect(found).toEqual([{ name: 'Wi-Fi', address: '192.168.1.4' }]);
  });

  it('ignores IPv6', () => {
    const found = lanAddresses({
      'Wi-Fi': [
        { family: 'IPv6', address: 'fe80::1', internal: false },
        { family: 'IPv4', address: '192.168.1.4', internal: false },
      ],
    });
    expect(found).toHaveLength(1);
  });

  it('keeps the interface name, which is the only way to spot a virtual adapter', () => {
    // A VirtualBox or WSL adapter looks exactly like a real one here, and giving its
    // address to the phone produces a connection that times out for no visible reason.
    const found = lanAddresses({
      'Ethernet 4': [{ family: 'IPv4', address: '192.168.56.1', internal: false }],
      'Wi-Fi': [{ family: 'IPv4', address: '192.168.1.4', internal: false }],
    });
    expect(found.map((f) => f.name)).toEqual(['Ethernet 4', 'Wi-Fi']);
  });

  it('survives an interface with no addresses', () => {
    expect(lanAddresses({ 'Disconnected': undefined, 'Empty': [] })).toEqual([]);
  });
});

describe('hasReverse', () => {
  const listing = 'KF85KRA6USKB75PR tcp:3000 tcp:3000\nKF85KRA6USKB75PR tcp:8081 tcp:8081\n';

  it('finds a tunnel for the port', () => {
    expect(hasReverse(listing, 3000)).toBe(true);
    expect(hasReverse(listing, 8081)).toBe(true);
  });

  it('does not find one that is absent', () => {
    expect(hasReverse(listing, 9999)).toBe(false);
  });

  it('treats no adb output as no tunnel', () => {
    // adb missing from PATH returns null rather than throwing; that must read as "down",
    // not as a crash.
    expect(hasReverse(null, 3000)).toBe(false);
    expect(hasReverse('', 3000)).toBe(false);
  });

  it('does not match a port that merely shares digits', () => {
    expect(hasReverse('host tcp:30000 tcp:30000', 3000)).toBe(false);
  });
});
