export interface AuthPayload {
  sub: string;
  userId: string;
  walletAddress: string;
  walletProvider: string;
  role: 'investor' | 'issuer';
  email?: string;
  exp: number;
  iat: number;
  iss: string;
  /**
   * OAuth-style scope claim. Present on tokens minted via the device-code
   * ceremony (Wave 4 P3 ADR-3); absent on legacy SIWE access tokens, which
   * `withScope(...)` middleware treats as "all scopes" for backwards
   * compatibility with the existing dashboard surface.
   */
  scope?: string[];
}
