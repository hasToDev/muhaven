import { randomUUID } from 'crypto';
import type { IEscrowRepository } from '../../../domain/escrow/repository/escrow.repository.js';
import type { IEscrowEventRepository } from '../../../domain/escrow/events/repository/escrow-event.repository.js';
import type { IYieldRecordRepository } from '../../../domain/yield-history/repository/yield-record.repository.js';
import type { IUserRepository } from '../../../domain/auth/repository/user.repository.js';
import { EscrowEvent, type EscrowEventType } from '../../../domain/escrow/events/model/escrow-event.js';
import { Escrow } from '../../../domain/escrow/model/escrow.js';
import { Currency } from '../../../domain/escrow/model/currency.js';
import { EscrowStatus } from '../../../domain/escrow/model/escrow-status.enum.js';
import { YieldRecord } from '../../../domain/yield-history/model/yield-record.js';

export interface EscrowEventPayload {
  tx_hash: string;
  escrow_id: string;
  event_type: EscrowEventType;
  block_number: string;
  message_hash?: string;
  amount?: string;
  // Distribution context (set by poller when detected)
  distribution_id?: number;
  beneficiary?: string;
  token_address?: string;
}

export class ProcessEscrowEventUseCase {
  constructor(
    private readonly escrowRepository: IEscrowRepository,
    private readonly escrowEventRepository: IEscrowEventRepository,
    private readonly yieldRecordRepository: IYieldRecordRepository,
    private readonly userRepository: IUserRepository,
  ) {}

  async execute(events: EscrowEventPayload[]): Promise<void> {
    for (const event of events) {
      if (event.event_type === 'EscrowCreated') {
        await this.handleEscrowCreated(event);
      } else if (event.event_type === 'EscrowSettled') {
        await this.handleEscrowSettled(event);
      } else if (event.event_type === 'EscrowRedeemed') {
        await this.handleEscrowRedeemed(event);
      }
    }
  }

  private async handleEscrowCreated(event: EscrowEventPayload): Promise<void> {
    const escrow = await this.escrowRepository.findByTxHash(event.tx_hash);

    if (escrow && escrow.status === EscrowStatus.PROCESSING) {
      escrow.markAsOnChain();
      escrow.onChainEscrowId = event.escrow_id;
      await this.escrowRepository.update(escrow);

      // Create yield record if this is a distribution escrow
      if (escrow.distributionId != null) {
        await this.createYieldRecord(escrow);
      }
      return;
    }

    // Distribution escrow from poller — no pre-existing DB record
    if (event.distribution_id != null && event.beneficiary) {
      await this.handleDistributionEscrowCreated(event);
      return;
    }

    const bufferedEvent = new EscrowEvent({
      txHash: event.tx_hash,
      escrowId: event.escrow_id,
      eventType: event.event_type,
      blockNumber: event.block_number,
      createdAt: new Date().toISOString(),
      ttl: Math.floor(Date.now() / 1000) + 86400,
      messageHash: event.message_hash,
      amount: event.amount,
    });

    await this.escrowEventRepository.save(bufferedEvent);
  }

  private async handleDistributionEscrowCreated(event: EscrowEventPayload): Promise<void> {
    // Idempotency: skip if already processed (crash recovery / duplicate delivery)
    const existing = await this.escrowRepository.findByOnChainId(event.escrow_id);
    if (existing) {
      return;
    }

    const user = await this.userRepository.findByWalletAddress(event.beneficiary!);
    if (!user) {
      // Buffer event — user may register later
      const bufferedEvent = new EscrowEvent({
        txHash: `${event.tx_hash}:${event.escrow_id}`,
        escrowId: event.escrow_id,
        eventType: event.event_type,
        blockNumber: event.block_number,
        createdAt: new Date().toISOString(),
        ttl: Math.floor(Date.now() / 1000) + 86400,
        messageHash: event.message_hash,
        amount: event.amount,
      });
      await this.escrowEventRepository.save(bufferedEvent);
      return;
    }

    const escrowId = randomUUID();
    const escrow = new Escrow({
      id: escrowId,
      publicId: randomUUID(),
      userId: user.id,
      type: 'yield-distribution',
      amount: 0, // Encrypted — actual amount unknown
      currency: new Currency({ type: 'crypto', code: 'PUSDC' }),
      status: EscrowStatus.ON_CHAIN,
      walletId: event.beneficiary!,
      onChainEscrowId: event.escrow_id,
      txHash: event.tx_hash,
      distributionId: event.distribution_id,
      tokenAddress: event.token_address,
      beneficiary: event.beneficiary,
      createdAt: new Date(),
    });

    await this.escrowRepository.save(escrow);
    await this.createYieldRecord(escrow);
  }

  private async handleEscrowSettled(event: EscrowEventPayload): Promise<void> {
    const escrow = await this.escrowRepository.findByOnChainId(event.escrow_id);

    if (escrow && escrow.status === EscrowStatus.ON_CHAIN) {
      escrow.markAsSettled();
      await this.escrowRepository.update(escrow);

      // Mark linked yield record as claimable
      if (escrow.distributionId != null) {
        const yieldRecord = await this.yieldRecordRepository.findByEscrowId(escrow.id);
        if (yieldRecord) {
          await this.yieldRecordRepository.updateStatus(yieldRecord.id, 'claimable');
        }
      }
    }
  }

  private async handleEscrowRedeemed(event: EscrowEventPayload): Promise<void> {
    const escrow = await this.escrowRepository.findByOnChainId(event.escrow_id);

    // Accept both SETTLED and ON_CHAIN — some escrow contracts go directly
    // from created to redeemed without a separate "settled" event
    if (escrow && (escrow.status === EscrowStatus.SETTLED || escrow.status === EscrowStatus.ON_CHAIN)) {
      escrow.markAsRedeemed();
      await this.escrowRepository.update(escrow);

      // Mark linked yield record as claimed
      if (escrow.distributionId != null) {
        const yieldRecord = await this.yieldRecordRepository.findByEscrowId(escrow.id);
        if (yieldRecord) {
          await this.yieldRecordRepository.updateStatus(yieldRecord.id, 'claimed', new Date());
        }
      }
    }
  }

  private async createYieldRecord(escrow: Escrow): Promise<void> {
    const yieldRecord = new YieldRecord({
      id: randomUUID(),
      userId: escrow.userId,
      distributionId: escrow.distributionId!,
      escrowId: escrow.id,
      tokenAddress: escrow.tokenAddress ?? '',
      status: 'pending',
      createdAt: new Date(),
    });

    await this.yieldRecordRepository.save(yieldRecord);
  }
}
