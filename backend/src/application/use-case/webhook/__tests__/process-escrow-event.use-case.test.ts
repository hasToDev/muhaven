import { describe, it, expect, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { ProcessEscrowEventUseCase } from '../process-escrow-event.use-case.js';
import { MemoryEscrowRepository } from '../../../../infrastructure/repository/memory/memory-escrow.repository.js';
import { MemoryEscrowEventRepository } from '../../../../infrastructure/repository/memory/memory-escrow-event.repository.js';
import { MemoryYieldRecordRepository } from '../../../../infrastructure/repository/memory/memory-yield-record.repository.js';
import { MemoryUserRepository } from '../../../../infrastructure/repository/memory/memory-user.repository.js';
import { Escrow } from '../../../../domain/escrow/model/escrow.js';
import { Currency } from '../../../../domain/escrow/model/currency.js';
import { EscrowStatus } from '../../../../domain/escrow/model/escrow-status.enum.js';
import { User } from '../../../../domain/auth/model/user.js';
import { YieldRecord } from '../../../../domain/yield-history/model/yield-record.js';

const TX_HASH = '0xabc123txhash';
const ESCROW_ID = 'escrow-42';
const BENEFICIARY = '0xBeneficiary1234567890abcdef';
const TOKEN_ADDRESS = '0xToken1234567890abcdef';

function makeEscrow(status: EscrowStatus, txHash?: string, onChainId?: string, distributionId?: number): Escrow {
  return new Escrow({
    id: randomUUID(),
    publicId: randomUUID(),
    userId: randomUUID(),
    type: distributionId != null ? 'yield-distribution' : 'payment',
    amount: 100,
    currency: new Currency({ type: 'crypto', code: 'USDC' }),
    status,
    walletId: '0xwallet',
    txHash,
    onChainEscrowId: onChainId,
    distributionId,
    tokenAddress: distributionId != null ? TOKEN_ADDRESS : undefined,
    beneficiary: distributionId != null ? BENEFICIARY : undefined,
    createdAt: new Date(),
  });
}

function makeUser(walletAddress: string): User {
  return new User({
    id: randomUUID(),
    walletAddress,
    walletProvider: 'zerodev',
    role: 'investor',
    createdAt: new Date(),
  });
}

describe('ProcessEscrowEventUseCase', () => {
  let useCase: ProcessEscrowEventUseCase;
  let escrowRepo: MemoryEscrowRepository;
  let escrowEventRepo: MemoryEscrowEventRepository;
  let yieldRecordRepo: MemoryYieldRecordRepository;
  let userRepo: MemoryUserRepository;

  beforeEach(() => {
    escrowRepo = new MemoryEscrowRepository();
    escrowEventRepo = new MemoryEscrowEventRepository();
    yieldRecordRepo = new MemoryYieldRecordRepository();
    userRepo = new MemoryUserRepository();
    useCase = new ProcessEscrowEventUseCase(escrowRepo, escrowEventRepo, yieldRecordRepo, userRepo);
  });

  describe('EscrowCreated event', () => {
    it('updates a PROCESSING escrow to ON_CHAIN and sets onChainEscrowId', async () => {
      const escrow = makeEscrow(EscrowStatus.PROCESSING, TX_HASH);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowCreated', block_number: '100' },
      ]);

      const updated = await escrowRepo.findByTxHash(TX_HASH);
      expect(updated!.status).toBe(EscrowStatus.ON_CHAIN);
      expect(updated!.onChainEscrowId).toBe(ESCROW_ID);
    });

    it('does not update an escrow that is not in PROCESSING status', async () => {
      const escrow = makeEscrow(EscrowStatus.PENDING, TX_HASH);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowCreated', block_number: '100' },
      ]);

      const notUpdated = await escrowRepo.findByTxHash(TX_HASH);
      expect(notUpdated!.status).toBe(EscrowStatus.PENDING);
    });

    it('buffers the event when no matching escrow is found', async () => {
      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowCreated', block_number: '100' },
      ]);

      const buffered = await escrowEventRepo.findByTxHash(TX_HASH);
      expect(buffered).not.toBeNull();
      expect(buffered!.escrowId).toBe(ESCROW_ID);
      expect(buffered!.eventType).toBe('EscrowCreated');
    });

    it('buffers event when escrow exists but is not PROCESSING', async () => {
      const escrow = makeEscrow(EscrowStatus.ON_CHAIN, TX_HASH);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowCreated', block_number: '100' },
      ]);

      const buffered = await escrowEventRepo.findByTxHash(TX_HASH);
      expect(buffered).not.toBeNull();
    });
  });

  describe('EscrowSettled event', () => {
    it('updates an ON_CHAIN escrow to SETTLED', async () => {
      const escrow = makeEscrow(EscrowStatus.ON_CHAIN, undefined, ESCROW_ID);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowSettled', block_number: '200' },
      ]);

      const updated = await escrowRepo.findByOnChainId(ESCROW_ID);
      expect(updated!.status).toBe(EscrowStatus.SETTLED);
    });

    it('does nothing when no escrow matches the escrow_id', async () => {
      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: 'unknown-escrow', event_type: 'EscrowSettled', block_number: '200' },
      ]);
    });

    it('does not update escrow that is not in ON_CHAIN status', async () => {
      const escrow = makeEscrow(EscrowStatus.SETTLED, undefined, ESCROW_ID);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowSettled', block_number: '200' },
      ]);

      const unchanged = await escrowRepo.findByOnChainId(ESCROW_ID);
      expect(unchanged!.status).toBe(EscrowStatus.SETTLED);
    });
  });

  describe('EscrowRedeemed event', () => {
    it('updates a SETTLED escrow to REDEEMED', async () => {
      const escrow = makeEscrow(EscrowStatus.SETTLED, undefined, ESCROW_ID);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowRedeemed', block_number: '300' },
      ]);

      const updated = await escrowRepo.findByOnChainId(ESCROW_ID);
      expect(updated!.status).toBe(EscrowStatus.REDEEMED);
    });

    it('does nothing when no escrow matches the escrow_id', async () => {
      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: 'unknown-escrow', event_type: 'EscrowRedeemed', block_number: '300' },
      ]);
    });

    it('updates an ON_CHAIN escrow directly to REDEEMED', async () => {
      const escrow = makeEscrow(EscrowStatus.ON_CHAIN, undefined, ESCROW_ID);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowRedeemed', block_number: '300' },
      ]);

      const updated = await escrowRepo.findByOnChainId(ESCROW_ID);
      expect(updated!.status).toBe(EscrowStatus.REDEEMED);
    });

    it('does not update escrow in PROCESSING or other ineligible status', async () => {
      const escrow = makeEscrow(EscrowStatus.PROCESSING, undefined, ESCROW_ID);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowRedeemed', block_number: '300' },
      ]);

      const unchanged = await escrowRepo.findByOnChainId(ESCROW_ID);
      expect(unchanged!.status).toBe(EscrowStatus.PROCESSING);
    });
  });

  describe('Yield record lifecycle', () => {
    it('creates a pending YieldRecord when EscrowCreated has distribution context', async () => {
      const user = makeUser(BENEFICIARY);
      await userRepo.save(user);

      await useCase.execute([
        {
          tx_hash: TX_HASH,
          escrow_id: ESCROW_ID,
          event_type: 'EscrowCreated',
          block_number: '100',
          distribution_id: 1,
          beneficiary: BENEFICIARY,
          token_address: TOKEN_ADDRESS,
        },
      ]);

      // Escrow should be created
      const escrow = await escrowRepo.findByOnChainId(ESCROW_ID);
      expect(escrow).not.toBeNull();
      expect(escrow!.status).toBe(EscrowStatus.ON_CHAIN);
      expect(escrow!.distributionId).toBe(1);
      expect(escrow!.beneficiary).toBe(BENEFICIARY);

      // Yield record should be created
      const yields = await yieldRecordRepo.findByDistributionId(1);
      expect(yields).toHaveLength(1);
      expect(yields[0].status).toBe('pending');
      expect(yields[0].userId).toBe(user.id);
      expect(yields[0].escrowId).toBe(escrow!.id);
      expect(yields[0].tokenAddress).toBe(TOKEN_ADDRESS);
    });

    it('creates YieldRecord for pre-existing distribution escrow', async () => {
      const escrow = makeEscrow(EscrowStatus.PROCESSING, TX_HASH, undefined, 5);
      await escrowRepo.save(escrow);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowCreated', block_number: '100' },
      ]);

      const updated = await escrowRepo.findByTxHash(TX_HASH);
      expect(updated!.status).toBe(EscrowStatus.ON_CHAIN);

      // Yield record should be created since escrow has distributionId
      const yields = await yieldRecordRepo.findByDistributionId(5);
      expect(yields).toHaveLength(1);
      expect(yields[0].status).toBe('pending');
      expect(yields[0].escrowId).toBe(escrow.id);
    });

    it('does not create YieldRecord when beneficiary user not found', async () => {
      await useCase.execute([
        {
          tx_hash: TX_HASH,
          escrow_id: ESCROW_ID,
          event_type: 'EscrowCreated',
          block_number: '100',
          distribution_id: 1,
          beneficiary: '0xUnknownWallet',
          token_address: TOKEN_ADDRESS,
        },
      ]);

      // Should be buffered, not created
      const yields = await yieldRecordRepo.findByDistributionId(1);
      expect(yields).toHaveLength(0);
    });

    it('marks YieldRecord claimable when EscrowSettled fires for distribution escrow', async () => {
      // Set up: escrow ON_CHAIN with distributionId + linked yield record
      const escrow = makeEscrow(EscrowStatus.ON_CHAIN, undefined, ESCROW_ID, 3);
      await escrowRepo.save(escrow);

      const yieldRecord = new YieldRecord({
        id: randomUUID(),
        userId: escrow.userId,
        distributionId: 3,
        escrowId: escrow.id,
        tokenAddress: TOKEN_ADDRESS,
        status: 'pending',
        createdAt: new Date(),
      });
      await yieldRecordRepo.save(yieldRecord);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowSettled', block_number: '200' },
      ]);

      const updated = await yieldRecordRepo.findByEscrowId(escrow.id);
      expect(updated!.status).toBe('claimable');
    });

    it('marks YieldRecord claimed when EscrowRedeemed fires for distribution escrow', async () => {
      // Set up: escrow SETTLED with distributionId + linked yield record (claimable)
      const escrow = makeEscrow(EscrowStatus.SETTLED, undefined, ESCROW_ID, 3);
      await escrowRepo.save(escrow);

      const yieldRecord = new YieldRecord({
        id: randomUUID(),
        userId: escrow.userId,
        distributionId: 3,
        escrowId: escrow.id,
        tokenAddress: TOKEN_ADDRESS,
        status: 'claimable',
        createdAt: new Date(),
      });
      await yieldRecordRepo.save(yieldRecord);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowRedeemed', block_number: '300' },
      ]);

      const updated = await yieldRecordRepo.findByEscrowId(escrow.id);
      expect(updated!.status).toBe('claimed');
      expect(updated!.claimedAt).toBeDefined();
    });

    it('skips duplicate distribution EscrowCreated on re-processing (idempotency)', async () => {
      const user = makeUser(BENEFICIARY);
      await userRepo.save(user);

      const event = {
        tx_hash: TX_HASH,
        escrow_id: ESCROW_ID,
        event_type: 'EscrowCreated' as const,
        block_number: '100',
        distribution_id: 1,
        beneficiary: BENEFICIARY,
        token_address: TOKEN_ADDRESS,
      };

      // Process once
      await useCase.execute([event]);
      // Process again (simulating crash recovery)
      await useCase.execute([event]);

      // Should only have one escrow and one yield record
      const yields = await yieldRecordRepo.findByDistributionId(1);
      expect(yields).toHaveLength(1);
    });

    it('marks YieldRecord claimed when EscrowRedeemed fires for ON_CHAIN distribution escrow', async () => {
      // Set up: escrow ON_CHAIN (never settled) with distributionId + linked yield record
      const escrow = makeEscrow(EscrowStatus.ON_CHAIN, undefined, ESCROW_ID, 3);
      await escrowRepo.save(escrow);

      const yieldRecord = new YieldRecord({
        id: randomUUID(),
        userId: escrow.userId,
        distributionId: 3,
        escrowId: escrow.id,
        tokenAddress: TOKEN_ADDRESS,
        status: 'pending',
        createdAt: new Date(),
      });
      await yieldRecordRepo.save(yieldRecord);

      await useCase.execute([
        { tx_hash: TX_HASH, escrow_id: ESCROW_ID, event_type: 'EscrowRedeemed', block_number: '300' },
      ]);

      const updatedEscrow = await escrowRepo.findByOnChainId(ESCROW_ID);
      expect(updatedEscrow!.status).toBe(EscrowStatus.REDEEMED);

      const updatedYield = await yieldRecordRepo.findByEscrowId(escrow.id);
      expect(updatedYield!.status).toBe('claimed');
      expect(updatedYield!.claimedAt).toBeDefined();
    });

    it('handles multiple EscrowCreated events from same processBatch tx', async () => {
      const user1 = makeUser('0xInvestor1');
      const user2 = makeUser('0xInvestor2');
      await userRepo.save(user1);
      await userRepo.save(user2);

      await useCase.execute([
        {
          tx_hash: TX_HASH,
          escrow_id: 'esc-1',
          event_type: 'EscrowCreated',
          block_number: '100',
          distribution_id: 1,
          beneficiary: '0xInvestor1',
          token_address: TOKEN_ADDRESS,
        },
        {
          tx_hash: TX_HASH,
          escrow_id: 'esc-2',
          event_type: 'EscrowCreated',
          block_number: '100',
          distribution_id: 1,
          beneficiary: '0xInvestor2',
          token_address: TOKEN_ADDRESS,
        },
      ]);

      const yields = await yieldRecordRepo.findByDistributionId(1);
      expect(yields).toHaveLength(2);

      const escrow1 = await escrowRepo.findByOnChainId('esc-1');
      const escrow2 = await escrowRepo.findByOnChainId('esc-2');
      expect(escrow1).not.toBeNull();
      expect(escrow2).not.toBeNull();
      expect(escrow1!.beneficiary).toBe('0xInvestor1');
      expect(escrow2!.beneficiary).toBe('0xInvestor2');
    });
  });

  it('processes multiple events in sequence', async () => {
    const esc1 = makeEscrow(EscrowStatus.PROCESSING, '0xtx1');
    const esc2 = makeEscrow(EscrowStatus.ON_CHAIN, undefined, 'esc-2');
    await escrowRepo.save(esc1);
    await escrowRepo.save(esc2);

    await useCase.execute([
      { tx_hash: '0xtx1', escrow_id: 'esc-1', event_type: 'EscrowCreated', block_number: '100' },
      { tx_hash: '0xtx2', escrow_id: 'esc-2', event_type: 'EscrowSettled', block_number: '101' },
    ]);

    const updated1 = await escrowRepo.findByTxHash('0xtx1');
    expect(updated1!.status).toBe(EscrowStatus.ON_CHAIN);

    const updated2 = await escrowRepo.findByOnChainId('esc-2');
    expect(updated2!.status).toBe(EscrowStatus.SETTLED);
  });
});
