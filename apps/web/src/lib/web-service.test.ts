import { describe, expect, it } from 'vitest';
import { assertPublic, isPrivateAddress } from './web-service';

describe('what the web tool may reach', () => {
  it('refuses private, loopback, link-local and metadata ranges', () => {
    for (const ip of ['10.1.2.3', '127.0.0.1', '169.254.169.254', '172.16.0.9', '192.168.1.1', '0.0.0.0', '100.64.0.1', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1']) {
      expect(isPrivateAddress(ip), ip).toBe(true);
    }
  });

  it('allows public addresses', () => {
    for (const ip of ['8.8.8.8', '93.184.216.34', '172.32.0.1', '2606:4700::1111']) {
      expect(isPrivateAddress(ip), ip).toBe(false);
    }
  });

  it('refuses other schemes and local names before any lookup', async () => {
    await expect(assertPublic(new URL('ftp://example.com/'))).rejects.toThrow('Only http and https');
    await expect(assertPublic(new URL('http://localhost:3000/'))).rejects.toThrow('not on the public internet');
    await expect(assertPublic(new URL('http://169.254.169.254/latest/meta-data'))).rejects.toThrow('not on the public internet');
    await expect(assertPublic(new URL('http://[::1]/'))).rejects.toThrow('not on the public internet');
  });
});
