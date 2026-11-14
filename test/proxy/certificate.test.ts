/**
 * Certificate generation tests
 */

import { describe, it, expect } from 'bun:test';
import forge from 'node-forge';
import { getCertificate, pfxToPem } from '../../src/proxy/certificate.js';

describe('Certificate', () => {
  it('should convert a passwordless PFX to PEM', () => {
    const { certificate, privateKey } = getCertificate();
    const p12 = forge.pkcs12.toPkcs12Asn1(
      forge.pki.privateKeyFromPem(privateKey),
      [forge.pki.certificateFromPem(certificate)],
      '',
      { algorithm: '3des' }
    );
    const pfx = Buffer.from(forge.asn1.toDer(p12).getBytes(), 'binary');

    const pem = pfxToPem(pfx);
    expect(pem.certificate.replace(/\r\n/g, '\n').trim()).toBe(
      certificate.replace(/\r\n/g, '\n').trim()
    );
    expect(pem.privateKey).toContain('PRIVATE KEY-----');
  });

  it('should generate a valid certificate', () => {
    const cert = getCertificate();

    expect(cert).toBeDefined();
    expect(cert.certificate).toContain('-----BEGIN CERTIFICATE-----');
    expect(cert.privateKey).toContain('-----BEGIN RSA PRIVATE KEY-----');
  });

  it('should mark the self-signed fallback as untrusted', () => {
    expect(getCertificate().trusted).toBe(false);
  });

  it('should return the same certificate on subsequent calls', () => {
    const cert1 = getCertificate();
    const cert2 = getCertificate();

    expect(cert1.certificate).toBe(cert2.certificate);
    expect(cert1.privateKey).toBe(cert2.privateKey);
  });
});
