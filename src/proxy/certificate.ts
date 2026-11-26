/**
 * Certificate management for TLS interception
 *
 * The Riot Client connects to deceive-localhost.molenzwiebel.xyz (which resolves to 127.0.0.1),
 * so the chat proxy serves the valid certificate for that domain published by upstream Deceive.
 * A self-signed certificate is only used as a fallback when it cannot be downloaded.
 */

import forge from 'node-forge';
import { X509Certificate } from 'crypto';
import { lookup } from 'dns/promises';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { getDataDir } from '../config/config.js';
import { logger } from '../utils/logger.js';
import packageJson from '../../package.json' with { type: 'json' };
import { LOCALHOST_DOMAIN } from './constants.js';

export { LOCALHOST_DOMAIN };
const CERTIFICATE_URL = 'https://mln.cx/deceive/localhost.pfx';
const MIN_VALIDITY_MS = 20 * 24 * 60 * 60 * 1000;

const CACHED_PFX_FILENAME = 'localhostCert.pfx';
const CERT_FILENAME = 'deceive-cert.pem';
const KEY_FILENAME = 'deceive-key.pem';

export interface CertificateResult {
  certificate: string;
  privateKey: string;
  /** Whether this is the trusted certificate for LOCALHOST_DOMAIN (false for the self-signed fallback) */
  trusted: boolean;
}

let cachedCertificate: CertificateResult | null = null;

/**
 * Convert a PKCS#12 bundle with an empty password to PEM.
 * The certificates are ECDSA, which node-forge cannot parse into objects,
 * so the raw ASN.1 from each bag is re-encoded instead.
 */
export function pfxToPem(pfx: Buffer): { certificate: string; privateKey: string } {
  const asn1 = forge.asn1.fromDer(forge.util.createBuffer(pfx.toString('binary')));
  const p12 = forge.pkcs12.pkcs12FromAsn1(asn1, '');

  const certBags = p12.getBags({ bagType: forge.pki.oids.certBag })[forge.pki.oids.certBag] ?? [];
  const keyBag =
    p12.getBags({ bagType: forge.pki.oids.pkcs8ShroudedKeyBag })[
      forge.pki.oids.pkcs8ShroudedKeyBag
    ]?.[0] ?? p12.getBags({ bagType: forge.pki.oids.keyBag })[forge.pki.oids.keyBag]?.[0];

  if (certBags.length === 0 || !keyBag) {
    throw new Error('PFX does not contain a certificate and private key');
  }

  const certificate = certBags
    .map((bag) => {
      const der = bag.cert
        ? forge.asn1.toDer(forge.pki.certificateToAsn1(bag.cert)).getBytes()
        : forge.asn1.toDer(bag.asn1).getBytes();
      return forge.pem.encode({ type: 'CERTIFICATE', body: der });
    })
    .join('');

  const privateKey = keyBag.key
    ? forge.pki.privateKeyToPem(keyBag.key)
    : forge.pki.privateKeyInfoToPem(keyBag.asn1);

  return { certificate, privateKey };
}

/**
 * Expiry date of the first (leaf) certificate in a PEM chain
 */
function getExpiry(certificatePem: string): Date {
  return new Date(new X509Certificate(certificatePem).validTo);
}

/**
 * Load the cached certificate, if it is still valid
 */
function loadCachedPfx(path: string): { result: CertificateResult; expiry: Date } | null {
  if (!existsSync(path)) return null;
  try {
    const pem = pfxToPem(readFileSync(path));
    const expiry = getExpiry(pem.certificate);
    if (expiry.getTime() <= Date.now()) {
      logger.debug(`Cached certificate expired ${expiry.toISOString()}`);
      return null;
    }
    return { result: { ...pem, trusted: true }, expiry };
  } catch (err) {
    logger.debug(
      `Failed to load cached certificate: ${err instanceof Error ? err.message : String(err)}`
    );
    return null;
  }
}

async function downloadPfx(path: string): Promise<CertificateResult> {
  logger.info('Downloading chat proxy certificate...');
  const response = await fetch(CERTIFICATE_URL, {
    headers: { 'User-Agent': `Deceive/${packageJson.version}` },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  const pfx = Buffer.from(await response.arrayBuffer());
  const pem = pfxToPem(pfx);

  mkdirSync(getDataDir(), { recursive: true });
  writeFileSync(path, pfx);
  logger.debug(`Certificate valid until ${getExpiry(pem.certificate).toISOString()}`);
  return { ...pem, trusted: true };
}

/**
 * Generate a self-signed certificate for TLS interception
 */
function generateSelfSigned(): CertificateResult {
  logger.info('Generating new self-signed certificate...');

  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = '01';
  cert.validity.notBefore = new Date();
  cert.validity.notAfter = new Date();
  cert.validity.notAfter.setFullYear(cert.validity.notBefore.getFullYear() + 10);

  const attrs = [
    { name: 'commonName', value: 'League Deceiver CA' },
    { name: 'countryName', value: 'US' },
    { name: 'organizationName', value: 'League Deceiver' },
  ];

  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: true },
    { name: 'keyUsage', keyCertSign: true, digitalSignature: true, keyEncipherment: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 2, value: 'localhost' },
        { type: 2, value: LOCALHOST_DOMAIN },
        { type: 7, ip: '127.0.0.1' },
      ],
    },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  return {
    certificate: forge.pki.certificateToPem(cert),
    privateKey: forge.pki.privateKeyToPem(keys.privateKey),
    trusted: false,
  };
}

function getSelfSigned(): CertificateResult {
  const dataDir = getDataDir();
  const certPath = join(dataDir, CERT_FILENAME);
  const keyPath = join(dataDir, KEY_FILENAME);

  if (existsSync(certPath) && existsSync(keyPath)) {
    logger.debug('Loading existing self-signed certificate');
    return {
      certificate: readFileSync(certPath, 'utf-8'),
      privateKey: readFileSync(keyPath, 'utf-8'),
      trusted: false,
    };
  }

  const generated = generateSelfSigned();
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(certPath, generated.certificate);
  writeFileSync(keyPath, generated.privateKey);
  logger.info(`Certificate generated and saved to ${certPath}`);
  return generated;
}

/**
 * Load the trusted localhost certificate (cached or downloaded), falling back to self-signed.
 * Must be called once at startup before getCertificate().
 */
export async function loadCertificate(): Promise<CertificateResult> {
  const pfxPath = join(getDataDir(), CACHED_PFX_FILENAME);

  const cached = loadCachedPfx(pfxPath);
  if (cached && cached.expiry.getTime() - Date.now() >= MIN_VALIDITY_MS) {
    logger.debug(`Using cached certificate, valid until ${cached.expiry.toISOString()}`);
    cachedCertificate = cached.result;
    return cachedCertificate;
  }

  try {
    cachedCertificate = await downloadPfx(pfxPath);
  } catch (err) {
    if (cached) {
      // Refreshing failed, but the cached certificate still works for now
      logger.warn(
        `Unable to refresh the chat proxy certificate (${err instanceof Error ? err.message : String(err)}). ` +
          `Using the cached certificate, valid until ${cached.expiry.toISOString()}.`
      );
      cachedCertificate = cached.result;
      return cachedCertificate;
    }
    logger.warn(
      `Unable to download the chat proxy certificate (${err instanceof Error ? err.message : String(err)}). ` +
        'Check your network connection or whether a new version is available. ' +
        'Falling back to a self-signed certificate, which recent Riot Client versions may reject.'
    );
    cachedCertificate = getSelfSigned();
  }
  return cachedCertificate;
}

/**
 * Get the loaded certificate (self-signed if loadCertificate() has not been called)
 */
export function getCertificate(): CertificateResult {
  cachedCertificate ??= getSelfSigned();
  return cachedCertificate;
}

/**
 * Check that LOCALHOST_DOMAIN resolves to 127.0.0.1, which some DNS setups block
 */
export async function localhostDomainResolves(): Promise<boolean> {
  try {
    const addresses = await lookup(LOCALHOST_DOMAIN, { all: true });
    return addresses.some((entry) => entry.address === '127.0.0.1');
  } catch {
    return false;
  }
}
