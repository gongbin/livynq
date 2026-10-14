import { createHash, randomBytes } from 'node:crypto';

/** HTTP-style Basic / Digest (MD5, RFC 2617 / 7616 subset) authentication, shared by RTSP and snapshots. */

export interface Challenge {
  scheme: 'basic' | 'digest';
  params: Record<string, string>;
}

/** Picks Digest over Basic when a server offers both. */
export function parseChallenges(headers: string[]): Challenge | undefined {
  const parsed = headers.map((h): Challenge | undefined => {
    const m = /^\s*(\w+)\s*(.*)$/s.exec(h);
    if (!m) return undefined;
    const scheme = m[1]!.toLowerCase();
    if (scheme !== 'basic' && scheme !== 'digest') return undefined;
    const params: Record<string, string> = {};
    for (const p of m[2]!.matchAll(/(\w+)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^,\s]+))/g)) params[p[1]!.toLowerCase()] = p[2] ?? p[3] ?? '';
    return { scheme, params };
  });
  return parsed.find((c) => c?.scheme === 'digest') ?? parsed.find((c) => c?.scheme === 'basic');
}

const md5 = (s: string) => createHash('md5').update(s).digest('hex');

export class Authenticator {
  readonly #username: string;
  readonly #password: string;
  #challenge: Challenge | undefined;
  #nc = 0;

  constructor(username = '', password = '') {
    this.#username = username;
    this.#password = password;
  }

  get hasCredentials(): boolean {
    return this.#username !== '' || this.#password !== '';
  }

  /** Remembers the server's challenge; returns false when there is nothing new to try. */
  accept(challengeHeaders: string[]): boolean {
    const c = parseChallenges(challengeHeaders);
    if (!c || !this.hasCredentials) return false;
    const stale = c.params.stale?.toLowerCase() === 'true';
    const retry = !this.#challenge || stale || c.params.nonce !== this.#challenge.params.nonce || c.scheme !== this.#challenge.scheme;
    this.#challenge = c;
    this.#nc = 0;
    return retry;
  }

  header(method: string, uri: string): string | undefined {
    const c = this.#challenge;
    if (!c) return undefined;
    if (c.scheme === 'basic') return `Basic ${Buffer.from(`${this.#username}:${this.#password}`).toString('base64')}`;
    const { realm = '', nonce = '', opaque, qop, algorithm } = c.params;
    const ha1 = md5(`${this.#username}:${realm}:${this.#password}`);
    const ha2 = md5(`${method}:${uri}`);
    const parts = [`username="${this.#username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`];
    if (qop && qop.split(',').map((q) => q.trim()).includes('auth')) {
      const nc = (++this.#nc).toString(16).padStart(8, '0');
      const cnonce = randomBytes(8).toString('hex');
      parts.push(`response="${md5(`${ha1}:${nonce}:${nc}:${cnonce}:auth:${ha2}`)}"`, 'qop=auth', `nc=${nc}`, `cnonce="${cnonce}"`);
    } else parts.push(`response="${md5(`${ha1}:${nonce}:${ha2}`)}"`);
    if (opaque !== undefined) parts.push(`opaque="${opaque}"`);
    if (algorithm) parts.push(`algorithm=${algorithm}`);
    return `Digest ${parts.join(', ')}`;
  }
}

/** Digest response a server expects (fake servers in tests). */
export function digestResponse(user: string, realm: string, password: string, method: string, uri: string, nonce: string): string {
  return md5(`${md5(`${user}:${realm}:${password}`)}:${nonce}:${md5(`${method}:${uri}`)}`);
}
