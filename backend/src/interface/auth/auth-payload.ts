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
}
