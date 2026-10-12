export enum PaymentStatus {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  REJECTED = 'REJECTED',
  DEFERRED = 'DEFERRED',
}

export enum PaymentProvider {
  FAKE = 'FAKE',
  ONVO = 'ONVO',
}

export class Payment {
  id!: string;
  orderId!: string | null;
  amount!: number;
  status!: PaymentStatus;
  provider!: PaymentProvider;
  externalPaymentId!: string | null;
  createdAt!: string;
  updatedAt!: string;
}
