export enum OrderStatus {
  PENDING_PAYMENT = 'PENDING_PAYMENT',
  PAID = 'PAID',
  PAYMENT_REJECTED = 'PAYMENT_REJECTED',
}

export class Pedido {
  id!: string;
  product!: string;
  amount!: number;
  status!: OrderStatus;
  createdAt!: string;
  updatedAt!: string;
}
