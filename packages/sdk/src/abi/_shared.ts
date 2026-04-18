/**
 * Shared ABI fragment: InEuint* / InEaddress input tuple.
 *
 *   tuple(uint256 ctHash, uint8 securityZone, uint8 utype, bytes signature)
 */
export const inEncryptedTuple = {
  type: 'tuple' as const,
  components: [
    { name: 'ctHash', type: 'uint256' as const },
    { name: 'securityZone', type: 'uint8' as const },
    { name: 'utype', type: 'uint8' as const },
    { name: 'signature', type: 'bytes' as const },
  ],
}
