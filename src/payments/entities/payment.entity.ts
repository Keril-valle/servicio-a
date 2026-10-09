export enum PaymentStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
}

export enum PaymentProvider {
  FAKE = 'FAKE',
  ONVO = 'ONVO',
}

export class Payment {
  id!: string;
  amount!: number;
  status!: PaymentStatus;
  provider!: PaymentProvider;
  externalPaymentId!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
